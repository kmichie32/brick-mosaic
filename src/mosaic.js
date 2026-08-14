/**
 * The core pipeline: photo in -> brick-color grid out.
 *
 *   1. crop + area-average downsample to the stud grid (in linear light)
 *   2. tone adjustments (brightness / contrast / saturation)
 *   3. quantize each cell to the nearest palette color in CIELAB,
 *      optionally with Floyd-Steinberg error diffusion
 *   4. grid map + bill of materials
 *
 * Everything here is plain ES modules with no DOM dependency, so the same code
 * runs in the browser (Canvas ImageData) and in Node (tests, or a future
 * server-side render).
 */

import { srgbByteToLinear, linearToSrgb, linearRgbToLab, deltaE76Sq } from './color.js';
import { PALETTE } from './palette.js';
import { backgroundMask, applyBackdrop, backdropById } from './backdrop.js';
import { maskFromOutline } from './outline.js';
import { PART_KINDS, DEFAULT_FINISH, resolveFinish } from './parts.js';

/** `indices[i] === EMPTY` means this stud is deliberately left with no brick. */
export const EMPTY = -1;

/**
 * @typedef {{width: number, height: number, data: Uint8ClampedArray|Uint8Array}} RGBAImage
 */

/**
 * @typedef {Object} MosaicOptions
 * @property {number} cols            grid width in studs
 * @property {number} rows            grid height in studs
 * @property {import('./palette.js').BrickColor[]} [palette]
 * @property {'none'|'floyd-steinberg'} [dither]
 * @property {number} [ditherStrength] 0..1, fraction of error diffused.
 *   Defaults to 0.55. Textbook Floyd-Steinberg diffuses 100%, but against a
 *   palette this small that pushes strongly chromatic error into flat regions
 *   -- you get magenta and pink speckle scattered through a clear sky. Around
 *   0.5-0.6 still breaks up banding while keeping gradients clean.
 * @property {number} [brightness]    -100..100
 * @property {number} [contrast]      -100..100
 * @property {number} [saturation]    0..2 (1 = unchanged)
 * @property {number} [shadows]       0..1 gamma-based shadow lift (default 0).
 *   Opens up dark subjects — black fur, dark hair, night shots — where the
 *   palette's sparse dark end would otherwise crush everything to one black.
 * @property {boolean} [flatGuard]    default true. Suppress dithering where the
 *   image is genuinely uniform, so painted walls and studio backdrops come out
 *   as one solid color instead of a two-color checkerboard.
 * @property {number} [neutralGuard]  0..1 (default 1). Strip chromatic dither
 *   error in near-gray areas. Without it, white fur and grey walls collect
 *   teal and sage speckle.
 * @property {{remove: boolean, backdrop: string, tolerance?: number}} [background]
 *   Replace the photo's background with a chosen backdrop. See src/backdrop.js.
 * @property {number} [sharpen]       0..1, stud-scale unsharp mask (default 0.3).
 *   Applied to the downsampled grid, not the source photo, so it crispens
 *   exactly the edges the bricks can actually represent -- lettering, eyes,
 *   silhouettes. A no-op in flat regions (local mean equals the cell).
 * @property {number} [detailProtect] 0..1 (default 0.85). Scales dithering
 *   *down* in high-detail cells. Dithering is what makes gradients look
 *   photographic, but on lettering and hard edges the scattered correction
 *   pixels destroy legibility. 0 = classic uniform dithering everywhere.
 * @property {{x:number,y:number,width:number,height:number}} [crop] source-pixel crop rect
 */

/**
 * @typedef {Object} Mosaic
 * @property {number} cols
 * @property {number} rows
 * @property {Int32Array} indices     palette index per cell, row-major
 * @property {import('./palette.js').BrickColor[]} palette
 * @property {{color: import('./palette.js').BrickColor, count: number}[]} bom
 * @property {number} totalBricks
 * @property {number} meanError       mean delta-E (CIE76) between target and chosen brick
 */

// ---------------------------------------------------------------------------
// 1. Area-average downsample
// ---------------------------------------------------------------------------

/**
 * Box-filter taps mapping a source span onto `dstLen` output samples.
 * Handles fractional coverage at span edges, which is what separates a real
 * area average from "sample every Nth pixel".
 */
function boxTaps(srcOffset, srcLen, dstLen) {
  const scale = srcLen / dstLen;
  const taps = [];
  for (let i = 0; i < dstLen; i++) {
    const start = srcOffset + i * scale;
    const end = start + scale;
    const first = Math.floor(start);
    const last = Math.min(Math.ceil(end) - 1, srcOffset + srcLen - 1);
    const idx = [];
    const w = [];
    let total = 0;
    for (let s = first; s <= last; s++) {
      const coverage = Math.min(end, s + 1) - Math.max(start, s);
      if (coverage <= 0) continue;
      idx.push(s);
      w.push(coverage);
      total += coverage;
    }
    // Normalize so each output sample is a true weighted mean.
    for (let k = 0; k < w.length; k++) w[k] /= total;
    taps.push({ idx, w });
  }
  return taps;
}

/**
 * Downsample `img` (optionally cropped) to cols x rows.
 * Averaging is done in linear light, with any alpha composited over white.
 * @returns {Float64Array} cols*rows*3 linear-light RGB in 0..1
 */
export function downsampleLinear(img, cols, rows, crop) {
  const cx = Math.max(0, Math.round(crop?.x ?? 0));
  const cy = Math.max(0, Math.round(crop?.y ?? 0));
  const cw = Math.min(img.width - cx, Math.round(crop?.width ?? img.width));
  const ch = Math.min(img.height - cy, Math.round(crop?.height ?? img.height));

  const xTaps = boxTaps(cx, cw, cols);
  const yTaps = boxTaps(cy, ch, rows);

  // Horizontal pass: full source height, `cols` wide.
  const tmp = new Float64Array(ch * cols * 3);
  for (let y = 0; y < ch; y++) {
    const srcRow = (cy + y) * img.width;
    const dstRow = y * cols * 3;
    for (let i = 0; i < cols; i++) {
      const { idx, w } = xTaps[i];
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < idx.length; k++) {
        const p = (srcRow + idx[k]) * 4;
        const a = img.data[p + 3] / 255;
        const weight = w[k];
        // Composite over white in linear light.
        r += weight * (srgbByteToLinear(img.data[p]) * a + (1 - a));
        g += weight * (srgbByteToLinear(img.data[p + 1]) * a + (1 - a));
        b += weight * (srgbByteToLinear(img.data[p + 2]) * a + (1 - a));
      }
      tmp[dstRow + i * 3] = r;
      tmp[dstRow + i * 3 + 1] = g;
      tmp[dstRow + i * 3 + 2] = b;
    }
  }

  // Vertical pass: `cols` x `rows`.
  const out = new Float64Array(rows * cols * 3);
  for (let j = 0; j < rows; j++) {
    // yTaps indices are absolute source rows; tmp rows are relative to the crop.
    const { idx, w } = yTaps[j];
    const dstRow = j * cols * 3;
    for (let i = 0; i < cols; i++) {
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < idx.length; k++) {
        const p = (idx[k] - cy) * cols * 3 + i * 3;
        const weight = w[k];
        r += weight * tmp[p];
        g += weight * tmp[p + 1];
        b += weight * tmp[p + 2];
      }
      out[dstRow + i * 3] = r;
      out[dstRow + i * 3 + 1] = g;
      out[dstRow + i * 3 + 2] = b;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. Tone adjustments
// ---------------------------------------------------------------------------

/**
 * Apply brightness/contrast/saturation to sRGB values in 0..255 (in place).
 * Deliberately the familiar photo-editor formulas -- users expect these
 * sliders to behave the way every other app's do.
 */
function applyAdjustments(cells, { brightness = 0, contrast = 0, saturation = 1, shadows = 0 }) {
  // Shadow lift first, while the data still has its full range. A gamma curve
  // pins pure black and pure white and opens up everything between, which is
  // what a dark subject needs: the palette's dark end is sparse (Black sits at
  // L*7, the next step up is L*45), so unlifted shadow detail has nowhere to go.
  if (shadows !== 0) {
    const gamma = 1 / (1 + shadows);
    for (let i = 0; i < cells.length; i++) {
      const t = Math.min(1, Math.max(0, cells[i] / 255));
      // Weight the lift by (1 - t) so it targets darks. Plain gamma raises
      // midtones and highlights too, which washes a light background out to
      // near-white while you're only trying to open up a black subject.
      cells[i] = (t + (Math.pow(t, gamma) - t) * (1 - t)) * 255;
    }
  }

  if (brightness === 0 && contrast === 0 && saturation === 1) return cells;

  const c = contrast * 2.55;
  const cf = (259 * (c + 255)) / (255 * (259 - c));
  const bOffset = brightness * 2.55;

  for (let i = 0; i < cells.length; i += 3) {
    let r = cells[i];
    let g = cells[i + 1];
    let b = cells[i + 2];

    if (saturation !== 1) {
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = luma + (r - luma) * saturation;
      g = luma + (g - luma) * saturation;
      b = luma + (b - luma) * saturation;
    }

    cells[i] = cf * (r - 128) + 128 + bOffset;
    cells[i + 1] = cf * (g - 128) + 128 + bOffset;
    cells[i + 2] = cf * (b - 128) + 128 + bOffset;
  }
  return cells;
}

// ---------------------------------------------------------------------------
// 3. Quantization
// ---------------------------------------------------------------------------

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Nearest palette entry to an sRGB triple, measured in CIELAB. */
function nearestBrick(palette, r, g, b) {
  const [L, A, B] = linearRgbToLab(
    srgbByteToLinear(Math.round(clamp255(r))),
    srgbByteToLinear(Math.round(clamp255(g))),
    srgbByteToLinear(Math.round(clamp255(b))),
  );
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const d = deltaE76Sq(L, A, B, p.L, p.A, p.B);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return { index: best, error: Math.sqrt(bestDist) };
}

/** Per-cell relative luminance (sRGB weights, 0..255). */
function lumaGrid(cells, n) {
  const luma = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    luma[i] = 0.2126 * cells[i * 3] + 0.7152 * cells[i * 3 + 1] + 0.0722 * cells[i * 3 + 2];
  }
  return luma;
}

/**
 * Luminance range within a square window of the given radius, per cell.
 * Separable (horizontal pass then vertical), so cost is O(n·radius) rather
 * than O(n·radius²) — worth it at radius 4.
 */
function windowRange(luma, cols, rows, radius) {
  const n = cols * rows;
  const hMin = new Float64Array(n);
  const hMax = new Float64Array(n);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let lo = Infinity, hi = -Infinity;
      for (let d = -radius; d <= radius; d++) {
        const xx = Math.min(cols - 1, Math.max(0, x + d));
        const v = luma[y * cols + xx];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      hMin[y * cols + x] = lo;
      hMax[y * cols + x] = hi;
    }
  }

  const range = new Float64Array(n);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let lo = Infinity, hi = -Infinity;
      for (let d = -radius; d <= radius; d++) {
        const yy = Math.min(rows - 1, Math.max(0, y + d));
        const p = yy * cols + x;
        if (hMin[p] < lo) lo = hMin[p];
        if (hMax[p] > hi) hi = hMax[p];
      }
      range[y * cols + x] = hi - lo;
    }
  }
  return range;
}

/**
 * Per-cell "detail" score in 0..1: how much luminance structure sits in the
 * cell's 3x3 neighbourhood. 0 = flat (open sky), 1 = hard edge (lettering,
 * silhouettes, eyes). Computed at grid scale, so "detail" means detail the
 * bricks can actually represent. Exported for tests and the dev harness.
 */
export function detailMap(cells, cols, rows) {
  const n = cols * rows;
  // Normalised so a strong edge (navy text on a white bib) saturates to 1,
  // while a smooth gradient's few-luma-units-per-cell slope stays near 0.
  const RANGE_FULL = 80;
  const range = windowRange(lumaGrid(cells, n), cols, rows, 1);
  const detail = new Float64Array(n);
  for (let i = 0; i < n; i++) detail[i] = Math.min(1, range[i] / RANGE_FULL);
  return detail;
}

/**
 * Per-cell "is there anything here to dither?" score in 0..1.
 *
 * A 3x3 window can't tell a painted wall from a gentle sky gradient — both
 * look flat locally. Over a wider window they separate cleanly: the gradient
 * accumulates several luma units, the wall accumulates ~nothing. That matters
 * because dithering a genuinely uniform surface doesn't prevent banding (there
 * is no band), it just manufactures a two-color checkerboard out of nothing.
 *
 * 0 = uniform, leave it as one solid color. 1 = enough variation that
 * dithering is doing real work.
 */
export function flatnessMap(cells, cols, rows, { radius = 4, fullRange = 5 } = {}) {
  const n = cols * rows;
  const range = windowRange(lumaGrid(cells, n), cols, rows, radius);
  const gate = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = Math.min(1, range[i] / fullRange);
    gate[i] = t * t * (3 - 2 * t);   // smoothstep, so the transition isn't a visible seam
  }
  return gate;
}

/**
 * Unsharp mask at grid scale (in place): each cell is pushed away from its
 * 3x3 mean. Flat regions are untouched (cell equals its mean); edges gain
 * contrast, which snaps lettering and outlines onto more contrasting bricks.
 */
function sharpenCells(cells, cols, rows, amount) {
  if (amount <= 0) return cells;
  const src = Float64Array.from(cells);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let r = 0, g = 0, b = 0, count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(rows - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(cols - 1, Math.max(0, x + dx));
          const p = (yy * cols + xx) * 3;
          r += src[p]; g += src[p + 1]; b += src[p + 2];
          count++;
        }
      }
      const i = (y * cols + x) * 3;
      cells[i] += amount * (src[i] - r / count);
      cells[i + 1] += amount * (src[i + 1] - g / count);
      cells[i + 2] += amount * (src[i + 2] - b / count);
    }
  }
  return cells;
}

/** Saturation of an sRGB triple as (max - min) / 255, in 0..1. */
function saturation(r, g, b) {
  const hi = Math.max(r, g, b);
  const lo = Math.min(r, g, b);
  return (hi - lo) / 255;
}

/**
 * Quantize the cell grid to the palette.
 *
 * With dithering on, error is diffused in sRGB space (the classic
 * Floyd-Steinberg formulation) while the *match* is still made in LAB.
 * Serpentine scanning avoids the directional streaking you get from always
 * sweeping left-to-right.
 *
 * Three modifiers on top of textbook Floyd-Steinberg, each fixing a way it
 * misbehaves against a ~45 color palette:
 *
 *   detail/protect  — scale error down at edges, so lettering and outlines
 *                     quantize cleanly instead of collecting speckle.
 *   flat            — scale error down where the image is genuinely uniform.
 *                     Dithering a painted wall doesn't prevent banding (there
 *                     is no band), it invents a checkerboard.
 *   neutralGuard    — strip the *chromatic* part of the error in near-gray
 *                     areas, keeping the luminance part. Without it, white fur
 *                     and grey walls collect teal and sage dots as saturated
 *                     palette entries get pulled in to cancel tiny color error.
 */
function quantize(cells, cols, rows, palette, dither, opts) {
  const { strength, detail, protect, flat, neutralGuard } = opts;
  const indices = new Int32Array(cols * rows);
  const useDither = dither === 'floyd-steinberg';
  let errorSum = 0;

  // Above this saturation a cell keeps its full chromatic error. Skin and sky
  // (~0.25-0.4) stay essentially untouched; a warm-white wall or grey fur
  // (~0.08) gets its color error cut to roughly a quarter, which is what stops
  // saturated palette entries being recruited to cancel a tiny color offset.
  const CHROMA_FULL = 0.3;

  for (let y = 0; y < rows; y++) {
    const leftToRight = !useDither || y % 2 === 0;
    for (let n = 0; n < cols; n++) {
      const x = leftToRight ? n : cols - 1 - n;
      const cell = y * cols + x;
      const i = cell * 3;

      const r = cells[i];
      const g = cells[i + 1];
      const b = cells[i + 2];

      const { index, error } = nearestBrick(palette, r, g, b);
      indices[cell] = index;
      errorSum += error;

      if (!useDither) continue;

      let scale = strength;
      if (detail) scale *= 1 - protect * detail[cell];
      if (flat) scale *= flat[cell];
      if (scale <= 0) continue;

      const chosen = palette[index];
      let er = (r - chosen.r) * scale;
      let eg = (g - chosen.g) * scale;
      let eb = (b - chosen.b) * scale;

      if (neutralGuard > 0) {
        const keep = Math.min(1, saturation(r, g, b) / CHROMA_FULL);
        const damp = 1 - neutralGuard * (1 - keep);
        // Split the error into luminance and chroma, damp only the chroma.
        const eLuma = 0.2126 * er + 0.7152 * eg + 0.0722 * eb;
        er = eLuma + (er - eLuma) * damp;
        eg = eLuma + (eg - eLuma) * damp;
        eb = eLuma + (eb - eLuma) * damp;
      }

      const dx = leftToRight ? 1 : -1;
      const push = (px, py, w) => {
        if (px < 0 || px >= cols || py >= rows) return;
        const p = (py * cols + px) * 3;
        cells[p] += er * w;
        cells[p + 1] += eg * w;
        cells[p + 2] += eb * w;
      };
      push(x + dx, y, 7 / 16);
      push(x - dx, y + 1, 3 / 16);
      push(x, y + 1, 5 / 16);
      push(x + dx, y + 1, 1 / 16);
    }
  }

  return { indices, meanError: errorSum / (cols * rows) };
}

// ---------------------------------------------------------------------------
// Pipeline entry point
// ---------------------------------------------------------------------------

/**
 * Run the full pipeline.
 * @param {RGBAImage} img
 * @param {MosaicOptions} options
 * @returns {Mosaic}
 */
export function buildMosaic(img, options) {
  const {
    cols,
    rows,
    palette = PALETTE,
    dither = 'none',
    ditherStrength = 0.55,
    brightness = 0,
    contrast = 0,
    saturation = 1,
    shadows = 0,
    sharpen = 0.3,
    detailProtect = 0.85,
    flatGuard = true,
    neutralGuard = 1,
    background = null,
    finish = DEFAULT_FINISH,
    crop,
  } = options;

  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
    throw new Error(`cols/rows must be positive integers, got ${cols}x${rows}`);
  }
  if (!palette.length) throw new Error('palette is empty');

  // A NaN here used to sail straight through: it poisons every cell, then
  // nearestBrick's `d < bestDist` is false for every candidate, so all cells
  // silently fall back to palette index 0 and the whole mosaic renders as one
  // flat color. Fail loudly instead -- a caller passing `undefined / 100` is a
  // bug, and a blank picture is the worst possible way to report it.
  for (const [name, value] of Object.entries({
    ditherStrength, brightness, contrast, saturation, shadows, sharpen, detailProtect, neutralGuard,
  })) {
    if (!Number.isFinite(value)) {
      throw new Error(`${name} must be a finite number, got ${value}`);
    }
  }

  const linear = downsampleLinear(img, cols, rows, crop);

  // Back to sRGB 0..255 for the adjustment + dithering stages.
  const cells = new Float64Array(linear.length);
  for (let i = 0; i < linear.length; i++) cells[i] = linearToSrgb(linear[i]) * 255;

  applyAdjustments(cells, { brightness, contrast, saturation, shadows });
  sharpenCells(cells, cols, rows, sharpen);

  // Background swap happens before the detail/flat maps are built, so a solid
  // backdrop reads as flat and comes out as one clean color rather than dithered.
  let bg = null;
  if (background?.remove) {
    let mask, coverage, suspect;

    if (background.outline) {
      // A hand-drawn outline is an instruction, not a guess: use it as given.
      mask = maskFromOutline(background.outline, cols, rows);
      let covered = 0;
      for (let i = 0; i < mask.length; i++) covered += mask[i];
      coverage = covered / mask.length;
      suspect = false;
    } else {
      ({ mask, coverage, suspect } = backgroundMask(cells, cols, rows, {
        tolerance: background.tolerance ?? 16,
      }));
    }

    // A failed auto-separation leaves the photo untouched. Painting a backdrop
    // over a runaway mask deletes the subject, which is worse than doing nothing.
    if (!suspect) applyBackdrop(cells, cols, rows, mask, backdropById(background.backdrop));
    bg = { mask, coverage, suspect };
  }

  // These maps only matter when there's dithering to modulate.
  const dithering = dither === 'floyd-steinberg';
  const detail = dithering && detailProtect > 0 ? detailMap(cells, cols, rows) : null;
  const flat = dithering && flatGuard ? flatnessMap(cells, cols, rows) : null;

  const { indices, meanError } = quantize(cells, cols, rows, palette, dither, {
    strength: ditherStrength,
    detail,
    protect: detailProtect,
    flat,
    neutralGuard,
  });

  // Which studs are subject and which are background. Without a separation the
  // whole picture is "subject", so a plain mosaic is unaffected by any of this.
  const subject = new Uint8Array(cols * rows).fill(1);
  if (bg && !bg.suspect) {
    for (let i = 0; i < subject.length; i++) subject[i] = bg.mask[i] ? 0 : 1;
  }

  const resolved = resolveFinish(finish);
  // -1 means "no brick here". Cells left empty aren't bought, aren't counted,
  // and print blank on the build sheet.
  for (let i = 0; i < indices.length; i++) {
    const kind = subject[i] ? resolved.subject : resolved.background;
    if (kind === 'none') indices[i] = EMPTY;
  }

  let totalBricks = 0;
  for (let i = 0; i < indices.length; i++) if (indices[i] !== EMPTY) totalBricks++;

  return {
    cols,
    rows,
    indices,
    palette,
    subject,
    finish: resolved,
    bom: buildBOM(indices, palette, subject, resolved),
    totalBricks,
    studs: cols * rows,          // grid positions, whether or not they hold a brick
    meanError,
    background: bg,   // { mask, coverage, suspect } when a background was replaced
  };
}

// ---------------------------------------------------------------------------
// 4. Outputs
// ---------------------------------------------------------------------------

/** The part kind a given cell is built from. */
export function partKindAt(mosaic, i) {
  if (mosaic.indices[i] === EMPTY) return 'none';
  return mosaic.subject?.[i] ? mosaic.finish.subject : mosaic.finish.background;
}

/**
 * Brick counts, most-used first.
 *
 * Keyed by color *and* part: with a textured finish the same color can be
 * needed as both a plate and a tile, and those are two different things to buy.
 */
export function buildBOM(indices, palette, subject = null, finish = DEFAULT_FINISH) {
  const counts = new Map();
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    if (idx === EMPTY) continue;
    const kind = subject && !subject[i] ? finish.background : finish.subject;
    const key = `${idx}|${kind}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [idx, kind] = key.split('|');
      return { color: palette[Number(idx)], part: PART_KINDS[kind], count };
    })
    .sort((a, b) => b.count - a.count || a.color.name.localeCompare(b.color.name));
}

/** The code printed for a stud with no brick. */
export const EMPTY_CODE = '--';

/** Grid map as rows of color codes -- the basis of the printable build map. */
export function toGridMap(mosaic) {
  const out = [];
  for (let y = 0; y < mosaic.rows; y++) {
    const row = [];
    for (let x = 0; x < mosaic.cols; x++) {
      const idx = mosaic.indices[y * mosaic.cols + x];
      row.push(idx === EMPTY ? EMPTY_CODE : mosaic.palette[idx].code);
    }
    out.push(row);
  }
  return out;
}

/**
 * Render the mosaic to raw RGBA pixels (no DOM), so this works in Node and in
 * the browser via putImageData.
 * @param {Mosaic} mosaic
 * @param {{cellSize?: number, studs?: boolean, gridLines?: boolean}} [opts]
 * @returns {RGBAImage}
 */
export function renderToRGBA(mosaic, opts = {}) {
  const { cellSize = 12, studs = true, gridLines = false } = opts;
  const width = mosaic.cols * cellSize;
  const height = mosaic.rows * cellSize;
  const data = new Uint8ClampedArray(width * height * 4);

  const studR = cellSize * 0.3;
  const center = (cellSize - 1) / 2;

  for (let gy = 0; gy < mosaic.rows; gy++) {
    for (let gx = 0; gx < mosaic.cols; gx++) {
      const cell = gy * mosaic.cols + gx;
      const idx = mosaic.indices[cell];

      // An empty stud is genuinely nothing, so it renders transparent and the
      // page decides what shows through. Painting it a color would suggest a
      // brick you don't have to buy.
      if (idx === EMPTY) {
        for (let py = 0; py < cellSize; py++) {
          for (let px = 0; px < cellSize; px++) {
            const p = ((gy * cellSize + py) * width + gx * cellSize + px) * 4;
            data[p] = data[p + 1] = data[p + 2] = data[p + 3] = 0;
          }
        }
        continue;
      }

      const c = mosaic.palette[idx];
      // Tiles are smooth: no stud, and the flat top is what reads as texture
      // against a studded neighbour.
      const hasStud = studs && partKindAt(mosaic, cell) !== 'tile';

      for (let py = 0; py < cellSize; py++) {
        for (let px = 0; px < cellSize; px++) {
          let r = c.r, g = c.g, b = c.b;

          if (hasStud && cellSize >= 6) {
            const dx = px - center;
            const dy = py - center;
            const dist = Math.hypot(dx, dy);
            if (dist <= studR) {
              // Cheap top-left lit / bottom-right shaded sphere.
              const shade = ((-dx - dy) / (studR * 2)) * 46;
              const rim = dist > studR - 1 ? -18 : 0;
              r += shade + rim;
              g += shade + rim;
              b += shade + rim;
            }
          }
          if (gridLines && (px === 0 || py === 0)) {
            r *= 0.85; g *= 0.85; b *= 0.85;
          }

          const p = ((gy * cellSize + py) * width + gx * cellSize + px) * 4;
          data[p] = r;
          data[p + 1] = g;
          data[p + 2] = b;
          data[p + 3] = 255;
        }
      }
    }
  }
  return { width, height, data };
}
