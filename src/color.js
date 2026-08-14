/**
 * Color-space math for the mosaic pipeline.
 *
 * Two things here matter for output quality:
 *  - Averaging/blending happens in LINEAR light, not gamma-encoded sRGB.
 *    Averaging sRGB bytes directly darkens gradients and muddies skin tones.
 *  - Palette matching happens in CIELAB, not RGB. Euclidean distance in RGB
 *    picks visually wrong bricks (it will happily swap a mid green for a
 *    mid blue because they're numerically close).
 */

// --- sRGB transfer function -------------------------------------------------

// The published pair 0.04045 / 0.0031308 are rounded and not exact inverses,
// which breaks the round-trip right at the knee. Derive the linear-side
// threshold from the sRGB-side one so the two branches meet exactly.
const SRGB_BREAK = 0.04045;
const LINEAR_BREAK = SRGB_BREAK / 12.92;

const LINEAR_LUT = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LINEAR_LUT[i] = c <= SRGB_BREAK ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** sRGB byte (0-255) -> linear-light float (0-1). Table-driven, hot path. */
export function srgbByteToLinear(v) {
  return LINEAR_LUT[v];
}

/** sRGB float (0-1) -> linear-light float (0-1). */
export function srgbToLinear(c) {
  return c <= SRGB_BREAK ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** linear-light float (0-1) -> sRGB float (0-1). */
export function linearToSrgb(c) {
  if (c <= 0) return 0;
  if (c >= 1) return 1;
  return c <= LINEAR_BREAK ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

// --- CIELAB (D65) -----------------------------------------------------------

// sRGB primaries -> XYZ, D65 reference white.
const Xn = 0.95047;
const Yn = 1.0;
const Zn = 1.08883;

const EPS = 216 / 24389;
const KAPPA = 24389 / 27;

function fLab(t) {
  return t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
}

/**
 * Linear-light RGB (0-1) -> CIELAB.
 * @returns {[number, number, number]} [L, a, b]
 */
export function linearRgbToLab(r, g, b) {
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / Xn;
  const y = (0.2126729 * r + 0.7151522 * g + 0.072175 * b) / Yn;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / Zn;

  const fx = fLab(x);
  const fy = fLab(y);
  const fz = fLab(z);

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** sRGB bytes (0-255) -> CIELAB. */
export function rgbToLab(r, g, b) {
  return linearRgbToLab(srgbToLinear(r / 255), srgbToLinear(g / 255), srgbToLinear(b / 255));
}

/**
 * Squared CIE76 delta-E. Squared because we only ever compare distances --
 * skipping the sqrt in the inner loop is free accuracy-neutral speed.
 */
export function deltaE76Sq(l1, a1, b1, l2, a2, b2) {
  const dl = l1 - l2;
  const da = a1 - a2;
  const db = b1 - b2;
  return dl * dl + da * da + db * db;
}

// --- hex helpers ------------------------------------------------------------

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

export function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
