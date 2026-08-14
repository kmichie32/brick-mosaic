import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMosaic } from '../src/mosaic.js';
import { backgroundMask, applyBackdrop, BACKDROPS, backdropById } from '../src/backdrop.js';
import { PALETTE } from '../src/palette.js';

/** cells grid (cols*rows*3, sRGB 0..255) from a callback. */
function cellsFrom(cols, rows, fn) {
  const cells = new Float64Array(cols * rows * 3);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * cols + x) * 3;
      cells[i] = r; cells[i + 1] = g; cells[i + 2] = b;
    }
  }
  return cells;
}

function generate(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      const p = (y * w + x) * 4;
      data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

const WALL = [214, 206, 194];
const SUBJECT = [30, 28, 34];

/** A dark blob centred on a uniform wall. */
const blobAt = (cols, rows, cx, cy, rx, ry) => (x, y) => {
  const dx = (x - cx) / rx, dy = (y - cy) / ry;
  return dx * dx + dy * dy < 1 ? SUBJECT : WALL;
};

// --- masking ----------------------------------------------------------------

test('separates a centred subject from a uniform wall', () => {
  const cols = 40, rows = 40;
  const cells = cellsFrom(cols, rows, blobAt(cols, rows, 20, 20, 10, 12));
  const { mask, coverage } = backgroundMask(cells, cols, rows);

  // Wall corner is background; the middle of the subject is not.
  assert.equal(mask[0], 1, 'corner should be background');
  assert.equal(mask[20 * cols + 20], 0, 'subject centre should be foreground');
  // A 10x12 ellipse in a 40x40 grid is roughly a quarter of the area.
  assert.ok(coverage > 0.6 && coverage < 0.9, `coverage ${coverage}`);
});

test('a subject running off the bottom edge is still kept', () => {
  // The real portrait case is a mass in the middle that *extends* to the frame
  // base — a head with shoulders, a cat sitting at the bottom. It needs the
  // central mass: a bare band across the bottom with nothing above it is a
  // floor or a table, and removing that is correct, not a bug.
  const cols = 40, rows = 40;
  const cells = cellsFrom(cols, rows, (x, y) => {
    const dx = (x - 20) / 11, dy = (y - 17) / 12;
    if (dx * dx + dy * dy < 1) return SUBJECT;        // head, centred
    if (y > 24 && x > 9 && x < 31) return SUBJECT;    // shoulders, to the edge
    return WALL;
  });
  const { mask, suspect } = backgroundMask(cells, cols, rows);

  assert.equal(suspect, false, 'should have separated cleanly');
  assert.equal(mask[17 * cols + 20], 0, 'head was erased');
  assert.equal(mask[36 * cols + 20], 0, 'shoulders touching the bottom edge were erased');
  assert.equal(mask[0], 1, 'wall corner should still be background');
});

test('a subject filling a corner is not mistaken for background', () => {
  // Regression, and the worst failure this code had: a black cat whose body
  // reached the bottom-right corner made its own fur a "background" color, the
  // fill ran away across the whole frame, and the mosaic came back as nothing
  // but backdrop.
  const cols = 48, rows = 60;
  const CABINET = [92, 64, 44];
  const CHAIR = [150, 160, 185];
  const cells = cellsFrom(cols, rows, (x, y) => {
    if (x < 8 && y < 34) return CABINET;
    if (x < 10 && y > 48) return CHAIR;
    const dx = (x - 26) / 16, dy = (y - 32) / 27;
    if (dx * dx + dy * dy < 1) return SUBJECT;
    if (y > 46 && x > 12) return SUBJECT;             // body fills bottom-right
    return WALL;
  });
  const { mask, coverage } = backgroundMask(cells, cols, rows, { tolerance: 16 });

  let subject = 0, removed = 0;
  for (let i = 0; i < cols * rows; i++) {
    if (cells[i * 3] < 60) { subject++; if (mask[i]) removed++; }
  }
  assert.equal(removed, 0, `${removed}/${subject} subject cells were erased`);
  assert.ok(coverage < 0.7, `coverage ${coverage} — the fill ran away`);
});

test('an unseparable image removes nothing rather than erasing the subject', () => {
  // When subject and background can't be told apart, the honest answer is to
  // do nothing. A canvas of pure backdrop is the worst possible output.
  const cols = 32, rows = 32;
  const cells = cellsFrom(cols, rows, (x, y) => [
    (x * 37 + y * 11) % 256, (x * 17 + y * 53) % 256, (x * 91 + y * 7) % 256,
  ]);
  const { mask, coverage, suspect } = backgroundMask(cells, cols, rows, { tolerance: 16 });
  assert.equal(suspect, true);
  assert.equal(coverage, 0);
  assert.equal(mask.reduce((s, v) => s + v, 0), 0, 'a suspect mask must be empty');
});

test('buildMosaic leaves the photo alone when separation fails', () => {
  // Source is exactly grid-sized: downsampling a noise field at 3x would
  // average it into something smooth and separable, defeating the point.
  const img = generate(32, 32, (x, y) => [
    (x * 37 + y * 11) % 256, (x * 17 + y * 53) % 256, (x * 91 + y * 7) % 256,
  ]);
  const opts = { cols: 32, rows: 32, dither: 'floyd-steinberg' };
  const plain = buildMosaic(img, opts);
  const attempted = buildMosaic(img, {
    ...opts,
    background: { remove: true, backdrop: 'white', tolerance: 16 },
  });
  assert.equal(attempted.background.suspect, true);
  assert.deepEqual([...attempted.indices], [...plain.indices],
    'a failed separation must not alter the mosaic');
});

test('a subject-colored region enclosed by the subject is not erased', () => {
  // Connectivity is what earns this: a wall-colored patch *inside* the subject
  // never touches the frame edge, so the fill can't reach it.
  const cols = 40, rows = 40;
  const cells = cellsFrom(cols, rows, (x, y) => {
    const dx = (x - 20) / 13, dy = (y - 20) / 13;
    if (dx * dx + dy * dy >= 1) return WALL;
    return Math.hypot(x - 20, y - 20) < 4 ? WALL : SUBJECT;   // wall-colored eye
  });
  const { mask } = backgroundMask(cells, cols, rows);
  assert.equal(mask[20 * cols + 20], 0, 'enclosed wall-colored patch was wrongly removed');
});

test('tolerance controls how much is removed', () => {
  const cols = 40, rows = 40;
  // The background sweeps across a wide luminance range (L* ~58 to ~98), so
  // mid-gradient sits far from either corner cluster. A gentler ramp would not
  // discriminate: 40 RGB units near the top of the range is only ~7 L*, which
  // every tolerance in the UI's span absorbs.
  const cells = cellsFrom(cols, rows, (x, y) => {
    const dx = (x - 20) / 9, dy = (y - 20) / 9;
    if (dx * dx + dy * dy < 1) return SUBJECT;
    const v = 140 + x * 2.8;
    return [v, v - 8, v - 20];
  });
  const tight = backgroundMask(cells, cols, rows, { tolerance: 4 }).coverage;
  const loose = backgroundMask(cells, cols, rows, { tolerance: 30 }).coverage;
  assert.ok(loose > tight, `loose=${loose} tight=${tight}`);
});

test('an image with no distinct background does not erase everything', () => {
  // A busy scene: the fill should not run away across the whole frame.
  const cols = 32, rows = 32;
  const cells = cellsFrom(cols, rows, (x, y) => [
    (x * 37 + y * 11) % 256, (x * 17 + y * 53) % 256, (x * 91 + y * 7) % 256,
  ]);
  const { coverage } = backgroundMask(cells, cols, rows, { tolerance: 10 });
  assert.ok(coverage < 0.5, `runaway fill: coverage ${coverage}`);
});

// --- backdrops --------------------------------------------------------------

test('every backdrop references real palette colors', () => {
  const codes = new Set(PALETTE.map((c) => c.code));
  for (const b of BACKDROPS) {
    assert.ok(b.id && b.name && b.kind, `incomplete backdrop ${b.id}`);
    for (const key of ['code', 'from', 'to']) {
      if (b[key]) assert.ok(codes.has(b[key]), `${b.id}.${key} = ${b[key]} is not a palette color`);
    }
    if (b.kind === 'solid') assert.ok(b.code, `${b.id} needs a code`);
    else assert.ok(b.from && b.to, `${b.id} needs from/to`);
  }
});

test('a solid backdrop paints exactly the masked cells', () => {
  const cols = 20, rows = 20;
  const cells = cellsFrom(cols, rows, blobAt(cols, rows, 10, 10, 5, 5));
  const before = Float64Array.from(cells);
  const { mask } = backgroundMask(cells, cols, rows);
  applyBackdrop(cells, cols, rows, mask, backdropById('black'));

  const black = PALETTE.find((c) => c.code === 'BLK');
  for (let i = 0; i < cols * rows; i++) {
    if (mask[i]) {
      assert.equal(cells[i * 3], black.r);
      assert.equal(cells[i * 3 + 1], black.g);
      assert.equal(cells[i * 3 + 2], black.b);
    } else {
      assert.equal(cells[i * 3], before[i * 3], 'foreground cell was modified');
    }
  }
});

test('backdropById falls back rather than throwing', () => {
  assert.equal(backdropById('white').id, 'white');
  assert.ok(backdropById('nonexistent'));
});

// --- through the pipeline ---------------------------------------------------

test('buildMosaic swaps the background and reports coverage', () => {
  const img = generate(160, 160, (x, y) => {
    const dx = (x - 80) / 45, dy = (y - 80) / 50;
    return dx * dx + dy * dy < 1 ? SUBJECT : WALL;
  });
  const opts = { cols: 40, rows: 40, dither: 'floyd-steinberg' };

  const plain = buildMosaic(img, opts);
  assert.equal(plain.background, null);

  const swapped = buildMosaic(img, {
    ...opts,
    background: { remove: true, backdrop: 'navy' },
  });
  assert.ok(swapped.background.coverage > 0.4);

  // The backdrop color should now dominate the bill of materials.
  const navy = PALETTE.find((c) => c.code === 'DBL');
  const navyCount = swapped.bom.find((e) => e.color.code === 'DBL')?.count ?? 0;
  assert.ok(navyCount > swapped.totalBricks * 0.3,
    `expected lots of ${navy.name}, got ${navyCount}`);

  // And the stud count is still exactly right.
  assert.equal(swapped.bom.reduce((s, e) => s + e.count, 0), 40 * 40);
});

test('a solid backdrop quantizes to one color, not a dithered field', () => {
  const img = generate(160, 160, (x, y) => {
    const dx = (x - 80) / 40, dy = (y - 80) / 40;
    return dx * dx + dy * dy < 1 ? SUBJECT : WALL;
  });
  const m = buildMosaic(img, {
    cols: 40, rows: 40, dither: 'floyd-steinberg',
    background: { remove: true, backdrop: 'white' },
  });
  // Sample a corner block that is certainly backdrop.
  const codes = new Set();
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
    codes.add(m.palette[m.indices[y * m.cols + x]].code);
  }
  assert.deepEqual([...codes], ['WHT'], `corner was not solid: ${[...codes]}`);
});

/**
 * The real photo's layout: black cat with a big white bib dead centre, dark
 * wood cabinet down the left and into a corner, grey bin and couch at the
 * bottom, framed picture at the top, ears reaching the top edge, body running
 * out of frame at the bottom, and long pale whiskers crossing the wall.
 */
function tuxedoScene(cols, rows) {
  const WALLC = [181, 172, 164], CABINET = [74, 50, 32], BIN = [138, 140, 146];
  const COUCH = [168, 168, 164], FURC = [26, 25, 30], RUFFC = [238, 236, 231];
  return cellsFrom(cols, rows, (gx, gy) => {
    const fx = gx / cols, fy = gy / rows;
    if (fy < 0.05 && fx > 0.33 && fx < 0.73) return [246, 244, 240];   // picture frame
    if (fx < 0.21 && fy < 0.62) return CABINET;
    if (fx < 0.13 && fy > 0.62 && fy < 0.87) return BIN;

    const hdx = (fx - 0.55) / 0.27, hdy = (fy - 0.27) / 0.20;
    const ear = (ax, tilt) => {
      const t = (fy - 0.045) / 0.14;
      return t >= 0 && t <= 1 && Math.abs(fx - (ax + tilt * t)) < 0.055 * (1 - t * 0.85);
    };
    const bw = 0.20 + (fy - 0.36) * 0.62;
    const inCat = hdx * hdx + hdy * hdy < 1
      || (fy > 0.36 && Math.abs(fx - 0.53) < bw)
      || ear(0.38, 0.02) || ear(0.76, -0.02);

    if (!inCat) {
      // Whiskers: pale, and they reach well out across the wall.
      if (fy > 0.40 && fy < 0.58 && (fx < 0.30 || fx > 0.80)
          && Math.abs(((fx * 37 + fy * 11) % 0.06)) < 0.012) return [232, 230, 226];
      return fy > 0.84 ? COUCH : WALLC;
    }
    const rdx = (fx - 0.50) / 0.24, rdy = (fy - 0.60) / 0.19;
    if (rdx * rdx + rdy * rdy < 1) return RUFFC;
    if (fy > 0.36 && fy < 0.50 && Math.abs(fx - 0.53) < 0.055) return RUFFC;   // blaze
    return FURC;
  });
}

test("the real photo's layout separates without damaging the cat", () => {
  // Everything that made earlier versions fail, in one scene: the bib owns the
  // middle so the *fur* is a minority there, the cabinet owns a corner, the
  // ears touch the top and the body runs out of the bottom, so fur is a quarter
  // of the border ring.
  const cols = 48, rows = 74;
  const cells = tuxedoScene(cols, rows);
  const { mask, suspect, coverage } = backgroundMask(cells, cols, rows, { tolerance: 16 });

  assert.equal(suspect, false, 'should have separated');
  let fur = 0, removed = 0;
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const i = gy * cols + gx;
      const inCabinet = gx / cols < 0.21 && gy / rows < 0.62;
      if (cells[i * 3] < 60 && !inCabinet) { fur++; if (mask[i]) removed++; }
    }
  }
  assert.equal(removed, 0, `${removed}/${fur} of the cat was erased`);
  assert.ok(coverage > 0.2 && coverage < 0.6, `coverage ${coverage}`);
});

test('a mask that shreds the subject is declined', () => {
  // The signature the fragmentation guard exists for. Wall-coloured slits reach
  // the left and right edges and run straight through the subject, so the flood
  // enters along them and cuts it into a stack of bands. Total coverage looks
  // perfectly reasonable; what is wrong is that the subject came out in pieces.
  const cols = 40, rows = 40;
  const cells = cellsFrom(cols, rows, (x, y) => {
    const inSubject = x > 8 && x < 32 && y > 6 && y < 34;
    if (!inSubject) return WALL;
    return y % 3 === 0 ? WALL : SUBJECT;      // slits straight through, edge to edge
  });
  const { suspect, coverage, mask } = backgroundMask(cells, cols, rows, { tolerance: 16 });
  assert.equal(suspect, true, `expected a decline, got coverage ${coverage}`);
  assert.equal(mask.reduce((s, v) => s + v, 0), 0, 'a declined mask must be empty');
});
