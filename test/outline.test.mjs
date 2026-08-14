import test from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyOutline, ovalOutline, normalizeOutline, outlineFromMask,
  isInside, maskFromOutline, simplifyPath, outlinePointCount,
} from '../src/outline.js';
import { buildMosaic, EMPTY } from '../src/mosaic.js';
import { PALETTE } from '../src/palette.js';

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

/** A closed square loop, in normalised space. */
const square = (x0, y0, x1, y1) =>
  [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];

// --- shape basics -----------------------------------------------------------

test('an empty outline keeps everything', () => {
  const mask = maskFromOutline(emptyOutline(), 20, 20);
  assert.equal(mask.reduce((s, v) => s + v, 0), 0, 'nothing should be background');
});

test('a drawn loop keeps the inside and drops the outside', () => {
  const outline = { loops: [square(0.25, 0.25, 0.75, 0.75)] };
  assert.ok(isInside(outline, 0.5, 0.5));
  assert.ok(!isInside(outline, 0.05, 0.05));

  const mask = maskFromOutline(outline, 40, 40);
  assert.equal(mask[20 * 40 + 20], 0, 'centre should be subject');
  assert.equal(mask[0], 1, 'corner should be background');
  const bg = mask.reduce((s, v) => s + v, 0) / mask.length;
  // A half-width square covers a quarter of the frame, so ~75% is background.
  assert.ok(bg > 0.7 && bg < 0.8, `background share ${bg}`);
});

test('a second loop inside the first cuts a hole', () => {
  // This is the litter-box case: trace round the subject, then trace round the
  // thing beside it you don't want. Even-odd makes the second loop subtract
  // without any separate add/erase mode.
  const outline = {
    loops: [square(0.1, 0.1, 0.9, 0.9), square(0.4, 0.4, 0.6, 0.6)],
  };
  assert.ok(isInside(outline, 0.2, 0.2), 'outer ring should be kept');
  assert.ok(!isInside(outline, 0.5, 0.5), 'inner loop should be cut out');

  const mask = maskFromOutline(outline, 40, 40);
  assert.equal(mask[20 * 40 + 20], 1, 'hole should be background');
  assert.equal(mask[8 * 40 + 8], 0, 'ring should be subject');
});

test('two separate loops both keep their contents', () => {
  const outline = { loops: [square(0.05, 0.05, 0.3, 0.3), square(0.7, 0.7, 0.95, 0.95)] };
  assert.ok(isInside(outline, 0.17, 0.17));
  assert.ok(isInside(outline, 0.82, 0.82));
  assert.ok(!isInside(outline, 0.5, 0.5), 'the gap between them is background');
});

test('normalizeOutline drops degenerate loops and junk points', () => {
  const o = normalizeOutline({
    loops: [
      square(0.2, 0.2, 0.8, 0.8),
      [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }],                 // only 2 points
      [{ x: NaN, y: 0.5 }, { x: 0.5, y: undefined }, { x: 'a', y: 'b' }],
      null,
    ],
  });
  assert.equal(o.loops.length, 1, 'only the real loop should survive');
  for (const p of o.loops[0]) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
});

test('outline is independent of grid size', () => {
  const o = ovalOutline();
  const share = (m) => m.reduce((s, v) => s + v, 0) / m.length;
  assert.ok(Math.abs(share(maskFromOutline(o, 20, 20)) - share(maskFromOutline(o, 80, 80))) < 0.05);
});

// --- simplification ---------------------------------------------------------

test('simplifyPath keeps corners and drops redundant points', () => {
  // A straight run with a single corner: everything collinear should go.
  const path = [];
  for (let i = 0; i <= 20; i++) path.push({ x: i / 20, y: 0 });
  for (let i = 1; i <= 20; i++) path.push({ x: 1, y: i / 20 });

  const simple = simplifyPath(path, 0.01);
  assert.ok(simple.length < path.length / 3, `kept ${simple.length} of ${path.length}`);
  // The endpoints and the corner must survive.
  assert.deepEqual(simple[0], { x: 0, y: 0 });
  assert.deepEqual(simple.at(-1), { x: 1, y: 1 });
  assert.ok(simple.some((p) => Math.abs(p.x - 1) < 1e-9 && Math.abs(p.y) < 1e-9), 'corner lost');
});

test('simplifyPath leaves tiny paths alone', () => {
  assert.equal(simplifyPath([{ x: 0, y: 0 }, { x: 1, y: 1 }]).length, 2);
});

// --- seeding from a mask ----------------------------------------------------

test('outlineFromMask wraps the detected subject without clipping it', () => {
  const cols = 40, rows = 40;
  const mask = new Uint8Array(cols * rows).fill(1);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (Math.hypot(x - 20, y - 20) < 9) mask[y * cols + x] = 0;
    }
  }
  const o = outlineFromMask(mask, cols, rows);
  assert.equal(o.loops.length, 1);
  assert.ok(outlinePointCount(o) >= 3);

  const back = maskFromOutline(o, cols, rows);
  let clipped = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] === 0 && back[i] === 1) clipped++;
  assert.equal(clipped, 0, `${clipped} subject cells fell outside the traced outline`);
});

test('outlineFromMask falls back to an oval on an empty or full mask', () => {
  for (const m of [new Uint8Array(400).fill(1), new Uint8Array(400)]) {
    const o = outlineFromMask(m, 20, 20);
    assert.equal(o.loops.length, 1);
    assert.ok(outlinePointCount(o) > 8);
  }
});

// --- through the pipeline ---------------------------------------------------

test('a drawn outline overrides auto-detection, even on an unseparable photo', () => {
  const img = generate(32, 32, (x, y) => [
    (x * 37 + y * 11) % 256, (x * 17 + y * 53) % 256, (x * 91 + y * 7) % 256,
  ]);
  const m = buildMosaic(img, {
    cols: 32, rows: 32, dither: 'none', sharpen: 0,
    background: { remove: true, backdrop: 'white', outline: ovalOutline() },
  });
  assert.equal(m.background.suspect, false, 'a drawn outline is never suspect');

  const white = PALETTE.find((c) => c.code === 'WHT');
  for (const corner of [0, 31, 31 * 32, 31 * 32 + 31]) {
    assert.equal(m.palette[m.indices[corner]].code, white.code, 'corner is not backdrop');
  }
});

test('cutting a hole in the outline shows up in the mosaic', () => {
  const img = generate(64, 64, () => [30, 28, 34]);
  const opts = {
    cols: 32, rows: 32, dither: 'none', sharpen: 0,
    background: { remove: true, backdrop: 'white' },
  };
  const solid = buildMosaic(img, {
    ...opts, background: { ...opts.background, outline: { loops: [square(0.1, 0.1, 0.9, 0.9)] } },
  });
  const holed = buildMosaic(img, {
    ...opts,
    background: {
      ...opts.background,
      outline: { loops: [square(0.1, 0.1, 0.9, 0.9), square(0.4, 0.4, 0.6, 0.6)] },
    },
  });
  assert.ok(holed.background.coverage > solid.background.coverage,
    'cutting a hole should increase the background share');
  const centre = 16 * 32 + 16;
  assert.equal(holed.palette[holed.indices[centre]].code, 'WHT', 'hole is not backdrop');
});
