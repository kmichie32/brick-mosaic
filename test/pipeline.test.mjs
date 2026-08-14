import test from 'node:test';
import assert from 'node:assert/strict';

import { rgbToLab, srgbToLinear, linearToSrgb, deltaE76Sq } from '../src/color.js';
import { PALETTE, paletteFromCodes, GRAYSCALE_CODES } from '../src/palette.js';
import { buildMosaic, downsampleLinear, toGridMap, renderToRGBA } from '../src/mosaic.js';

/** Solid-color RGBA image. */
function solid(w, h, [r, g, b]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

/** Image built from a per-pixel callback returning [r,g,b] or [r,g,b,a]. */
function generate(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a = 255] = fn(x, y);
      const p = (y * w + x) * 4;
      data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = a;
    }
  }
  return { width: w, height: h, data };
}

// --- color space ------------------------------------------------------------

test('sRGB <-> linear round-trips', () => {
  for (const v of [0, 0.01, 0.04045, 0.2, 0.5, 0.9, 1]) {
    assert.ok(Math.abs(linearToSrgb(srgbToLinear(v)) - v) < 1e-9);
  }
});

test('LAB reference values match known conversions', () => {
  const [wl, wa, wb] = rgbToLab(255, 255, 255);
  assert.ok(Math.abs(wl - 100) < 0.01, `white L=${wl}`);
  assert.ok(Math.abs(wa) < 0.01 && Math.abs(wb) < 0.01);

  const [kl] = rgbToLab(0, 0, 0);
  assert.ok(Math.abs(kl) < 0.01, `black L=${kl}`);

  // Pure sRGB red: L*≈53.24, a*≈80.09, b*≈67.20
  const [rl, ra, rb] = rgbToLab(255, 0, 0);
  assert.ok(Math.abs(rl - 53.24) < 0.05, `red L=${rl}`);
  assert.ok(Math.abs(ra - 80.09) < 0.05, `red a=${ra}`);
  assert.ok(Math.abs(rb - 67.2) < 0.05, `red b=${rb}`);
});

// --- palette ----------------------------------------------------------------

test('palette entries are unique and well-formed', () => {
  const codes = new Set();
  const hexes = new Set();
  for (const c of PALETTE) {
    assert.match(c.code, /^[A-Z]{3}$/, `bad code ${c.code}`);
    assert.match(c.hex, /^#[0-9A-F]{6}$/, `bad hex ${c.hex} for ${c.name}`);
    assert.ok(!codes.has(c.code), `duplicate code ${c.code}`);
    assert.ok(!hexes.has(c.hex), `duplicate hex ${c.hex} (${c.name})`);
    codes.add(c.code);
    hexes.add(c.hex);
  }
  assert.ok(PALETTE.length >= 40, `expected ~40 colors, got ${PALETTE.length}`);
  PALETTE.forEach((c, i) => assert.equal(c.index, i));
});

test('paletteFromCodes reindexes contiguously', () => {
  const p = paletteFromCodes(GRAYSCALE_CODES);
  assert.equal(p.length, 4);
  p.forEach((c, i) => assert.equal(c.index, i));
});

// --- downsampling -----------------------------------------------------------

test('area average of a solid image is that color', () => {
  const img = solid(64, 64, [200, 100, 50]);
  const cells = downsampleLinear(img, 7, 5); // deliberately non-integer ratio
  for (let i = 0; i < cells.length; i += 3) {
    assert.ok(Math.abs(linearToSrgb(cells[i]) * 255 - 200) < 0.5);
    assert.ok(Math.abs(linearToSrgb(cells[i + 1]) * 255 - 100) < 0.5);
    assert.ok(Math.abs(linearToSrgb(cells[i + 2]) * 255 - 50) < 0.5);
  }
});

test('area average is a true mean, not a point sample', () => {
  // Vertical 1px stripes: black, white, black, white...
  // A point sampler collapsing 2px -> 1px returns pure black or pure white.
  // A true area average returns mid-gray (in linear light, 0.5 -> sRGB ~188).
  const img = generate(64, 8, (x) => (x % 2 === 0 ? [0, 0, 0] : [255, 255, 255]));
  const cells = downsampleLinear(img, 8, 1);
  for (let i = 0; i < cells.length; i += 3) {
    assert.ok(Math.abs(cells[i] - 0.5) < 1e-6, `linear mean was ${cells[i]}`);
  }
});

test('fractional coverage: 3 source px -> 2 cells splits the middle pixel', () => {
  const img = generate(3, 1, (x) => [[0, 0, 0], [255, 255, 255], [0, 0, 0]][x]);
  const cells = downsampleLinear(img, 2, 1);
  // Cell 0 covers px0 fully + half of px1 -> (0*1 + 1*0.5)/1.5 = 1/3 linear.
  assert.ok(Math.abs(cells[0] - 1 / 3) < 1e-9, `got ${cells[0]}`);
  assert.ok(Math.abs(cells[3] - 1 / 3) < 1e-9, `got ${cells[3]}`);
});

test('crop restricts the sampled region', () => {
  // Left half red, right half blue. Crop to the right half -> all blue.
  const img = generate(40, 10, (x) => (x < 20 ? [255, 0, 0] : [0, 0, 255]));
  const cells = downsampleLinear(img, 4, 2, { x: 20, y: 0, width: 20, height: 10 });
  for (let i = 0; i < cells.length; i += 3) {
    assert.ok(cells[i] < 0.01, 'red channel should be ~0');
    assert.ok(cells[i + 2] > 0.99, 'blue channel should be ~1');
  }
});

test('alpha composites over white', () => {
  const img = generate(8, 8, () => [0, 0, 0, 0]); // fully transparent
  const cells = downsampleLinear(img, 2, 2);
  for (let i = 0; i < cells.length; i++) assert.ok(Math.abs(cells[i] - 1) < 1e-9);
});

// --- quantization -----------------------------------------------------------

test('solid palette colors quantize back to themselves', () => {
  for (const c of PALETTE) {
    const m = buildMosaic(solid(16, 16, [c.r, c.g, c.b]), { cols: 2, rows: 2 });
    assert.equal(
      m.palette[m.indices[0]].code,
      c.code,
      `${c.name} matched ${m.palette[m.indices[0]].name}`,
    );
    assert.ok(m.meanError < 1e-6);
  }
});

test('LAB matching beats RGB matching on a known failure case', () => {
  // Mid-tone teal. Nearest-in-RGB and nearest-in-LAB disagree here; LAB is the
  // one that matches what the eye picks.
  const target = [60, 140, 140];
  const m = buildMosaic(solid(8, 8, target), { cols: 1, rows: 1 });
  const labPick = m.palette[m.indices[0]];

  let rgbPick = PALETTE[0];
  let bestRgb = Infinity;
  for (const c of PALETTE) {
    const d = (c.r - target[0]) ** 2 + (c.g - target[1]) ** 2 + (c.b - target[2]) ** 2;
    if (d < bestRgb) { bestRgb = d; rgbPick = c; }
  }

  const [tl, ta, tb] = rgbToLab(...target);
  const labErr = Math.sqrt(deltaE76Sq(tl, ta, tb, labPick.L, labPick.A, labPick.B));
  const rgbErr = Math.sqrt(deltaE76Sq(tl, ta, tb, rgbPick.L, rgbPick.A, rgbPick.B));
  assert.ok(labErr <= rgbErr, `LAB pick should never be perceptually worse`);
});

test('restricted palette is respected', () => {
  const gray = paletteFromCodes(GRAYSCALE_CODES);
  const img = generate(64, 64, (x, y) => [x * 4, y * 4, 128]);
  const m = buildMosaic(img, { cols: 16, rows: 16, palette: gray });
  const used = new Set([...m.indices].map((i) => m.palette[i].code));
  for (const code of used) assert.ok(GRAYSCALE_CODES.includes(code));
});

// --- dithering --------------------------------------------------------------

test('dithering uses more distinct colors on a gradient than flat quantization', () => {
  const img = generate(256, 64, (x) => {
    const t = x / 255;
    return [40 + t * 180, 30 + t * 160, 60 + t * 120];
  });
  const flat = buildMosaic(img, { cols: 48, rows: 12, dither: 'none' });
  const dithered = buildMosaic(img, { cols: 48, rows: 12, dither: 'floyd-steinberg' });

  const distinct = (m) => new Set(m.indices).size;
  assert.ok(
    distinct(dithered) > distinct(flat),
    `dither=${distinct(dithered)} flat=${distinct(flat)}`,
  );
});

const avgColor = (m) => {
  let r = 0, g = 0, b = 0;
  for (const i of m.indices) { r += m.palette[i].r; g += m.palette[i].g; b += m.palette[i].b; }
  const n = m.indices.length;
  return [r / n, g / n, b / n];
};
const distTo = (target) => (c) =>
  Math.hypot(c[0] - target[0], c[1] - target[1], c[2] - target[2]);

test('dithering lowers average color error where there is variation to dither', () => {
  // A gentle gradient straddling palette entries: error diffusion should mix
  // neighbours so the *average* lands closer to the source than flat matching.
  const img = generate(64, 64, (x, y) => [118 + (x + y) / 24, 93 + (x + y) / 30, 68 + (x + y) / 40]);
  const target = [118 + 63 / 24 / 2 * 2, 93 + 63 / 30, 68 + 63 / 40];

  const flat = buildMosaic(img, { cols: 16, rows: 16, dither: 'none' });
  const dith = buildMosaic(img, { cols: 16, rows: 16, dither: 'floyd-steinberg' });

  const err = distTo(target);
  assert.ok(err(avgColor(dith)) < err(avgColor(flat)),
    `dith=${err(avgColor(dith)).toFixed(2)} flat=${err(avgColor(flat)).toFixed(2)}`);
});

test('a uniform area is rendered solid, not checkerboarded', () => {
  // The deliberate trade the flat guard makes. Dithering a genuinely uniform
  // surface would average *closer* to the target color, but at 1x1-plate scale
  // it reads as manufactured texture rather than a blend -- and it costs extra
  // color lots to buy. A painted wall should come out as one color.
  const target = [120, 95, 70];
  const img = solid(64, 64, target);
  const m = buildMosaic(img, { cols: 16, rows: 16, dither: 'floyd-steinberg' });
  assert.equal(new Set(m.indices).size, 1, `expected 1 color, got ${new Set(m.indices).size}`);
});

test('flatGuard:false restores classic dithering of a uniform block', () => {
  // The old behaviour is still reachable, and still does what it always did:
  // trade a busier surface for a better average color match.
  const target = [120, 95, 70];
  const img = solid(64, 64, target);
  const flat = buildMosaic(img, { cols: 16, rows: 16, dither: 'none' });
  const dith = buildMosaic(img, {
    cols: 16, rows: 16, dither: 'floyd-steinberg', flatGuard: false,
  });

  assert.ok(new Set(dith.indices).size > 1, 'expected dithering without the flat guard');
  const err = distTo(target);
  assert.ok(err(avgColor(dith)) < err(avgColor(flat)),
    `dith=${err(avgColor(dith)).toFixed(2)} flat=${err(avgColor(flat)).toFixed(2)}`);
});

test('ditherStrength 0 is identical to no dithering', () => {
  const img = generate(128, 128, (x, y) => [x * 2, y * 2, 100]);
  const a = buildMosaic(img, { cols: 32, rows: 32, dither: 'none' });
  const b = buildMosaic(img, { cols: 32, rows: 32, dither: 'floyd-steinberg', ditherStrength: 0 });
  assert.deepEqual([...a.indices], [...b.indices]);
});

// --- adjustments ------------------------------------------------------------

test('brightness and saturation move the result in the expected direction', () => {
  const img = generate(64, 64, (x, y) => [x * 3, y * 3, 128]);
  const lum = (m) => {
    let s = 0;
    for (const i of m.indices) s += m.palette[i].L;
    return s / m.indices.length;
  };
  const base = buildMosaic(img, { cols: 16, rows: 16 });
  const bright = buildMosaic(img, { cols: 16, rows: 16, brightness: 40 });
  const dark = buildMosaic(img, { cols: 16, rows: 16, brightness: -40 });
  assert.ok(lum(bright) > lum(base) && lum(base) > lum(dark));

  const chroma = (m) => {
    let s = 0;
    for (const i of m.indices) s += Math.hypot(m.palette[i].A, m.palette[i].B);
    return s / m.indices.length;
  };
  const flatSat = buildMosaic(img, { cols: 16, rows: 16, saturation: 0 });
  assert.ok(chroma(flatSat) < chroma(base));
});

// --- outputs ----------------------------------------------------------------

test('BOM totals equal the stud count and codes are legend-resolvable', () => {
  const img = generate(200, 150, (x, y) => [x, y, (x + y) % 256]);
  const m = buildMosaic(img, { cols: 48, rows: 36, dither: 'floyd-steinberg' });
  const total = m.bom.reduce((s, e) => s + e.count, 0);
  assert.equal(total, 48 * 36);
  assert.equal(total, m.totalBricks);
  for (const e of m.bom) {
    assert.ok(e.count > 0);
    assert.ok(e.color.name && e.color.blId > 0);
  }
  // Sorted most-used first.
  for (let i = 1; i < m.bom.length; i++) assert.ok(m.bom[i - 1].count >= m.bom[i].count);
});

test('grid map dimensions and codes line up with the mosaic', () => {
  const img = generate(80, 40, (x, y) => [x * 3, 255 - y * 6, 90]);
  const m = buildMosaic(img, { cols: 20, rows: 10 });
  const map = toGridMap(m);
  assert.equal(map.length, 10);
  assert.equal(map[0].length, 20);
  assert.equal(map[3][7], m.palette[m.indices[3 * 20 + 7]].code);
});

test('renderToRGBA produces an opaque image of the right size', () => {
  const m = buildMosaic(solid(32, 32, [200, 30, 30]), { cols: 8, rows: 4 });
  const out = renderToRGBA(m, { cellSize: 10 });
  assert.equal(out.width, 80);
  assert.equal(out.height, 40);
  for (let i = 3; i < out.data.length; i += 4) assert.equal(out.data[i], 255);
});

test('rejects invalid grid dimensions and empty palettes', () => {
  const img = solid(8, 8, [0, 0, 0]);
  assert.throws(() => buildMosaic(img, { cols: 0, rows: 4 }), /positive integers/);
  assert.throws(() => buildMosaic(img, { cols: 4.5, rows: 4 }), /positive integers/);
  assert.throws(() => buildMosaic(img, { cols: 4, rows: 4, palette: [] }), /palette is empty/);
});

test('rejects non-finite tone options instead of rendering a blank mosaic', () => {
  // Regression: `undefined / 100` reached `shadows`, poisoned every cell with
  // NaN, and made nearestBrick's comparison false for every candidate -- so the
  // whole picture came out as palette index 0. It must throw, not go white.
  const img = generate(32, 32, (x, y) => [x * 8, y * 8, 120]);
  for (const key of ['shadows', 'brightness', 'contrast', 'saturation', 'sharpen',
                     'ditherStrength', 'detailProtect', 'neutralGuard']) {
    assert.throws(
      () => buildMosaic(img, { cols: 8, rows: 8, [key]: NaN }),
      new RegExp(`${key} must be a finite number`),
      `${key} = NaN should throw`,
    );
    assert.throws(
      () => buildMosaic(img, { cols: 8, rows: 8, [key]: undefined / 100 }),
      /must be a finite number/,
      `${key} = undefined/100 should throw`,
    );
  }
});

test('a poisoned pipeline cannot silently collapse to one color', () => {
  // The symptom that made the bug invisible: every cell agreeing on index 0.
  // A healthy build of a varied image must use more than one color.
  const img = generate(64, 64, (x, y) => [x * 4, 255 - y * 4, (x * y) % 256]);
  const m = buildMosaic(img, { cols: 16, rows: 16, dither: 'floyd-steinberg' });
  assert.ok(new Set(m.indices).size > 1, 'mosaic collapsed to a single color');
  for (const i of m.indices) assert.ok(Number.isInteger(i) && i >= 0 && i < m.palette.length);
});

test('upscaling (grid larger than source) still produces a full grid', () => {
  const img = generate(10, 10, (x, y) => [x * 25, y * 25, 128]);
  const m = buildMosaic(img, { cols: 32, rows: 32 });
  assert.equal(m.indices.length, 32 * 32);
  for (const i of m.indices) assert.ok(i >= 0 && i < m.palette.length);
});
