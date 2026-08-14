/**
 * Background removal and replacement, at stud resolution.
 *
 * The usual hard part of background removal is matting: hair, fur, motion blur,
 * semi-transparent edges. None of that survives downsampling to a 48-stud grid,
 * so this works on the already-downsampled cell grid where a single stud is a
 * whole tuft of fur. That turns a segmentation problem into a flood fill, and
 * means no model download, no dependency, and a few milliseconds of work.
 *
 * The trade is honest: this finds backgrounds that are *reasonably uniform and
 * connected to the frame edge*. A plain wall, a sky, a studio backdrop. It will
 * not separate someone from a bookshelf. `coverage` is returned so the UI can
 * tell when the result is implausible.
 */

import { rgbToLab, deltaE76Sq, srgbToLinear, linearToSrgb } from './color.js';
import { PALETTE } from './palette.js';

/**
 * How much looser the second, boundary-only pass is. Kept modest: this pass
 * exists to absorb the one-stud outline where subject and background average
 * together, not to give the fill licence to wander into the subject.
 */
const EDGE_SLACK = 1.35;

/**
 * Tolerance multiplier at the very centre of the frame, ramping to 1.0 at the
 * border. Subjects live in the middle and backgrounds live at the edge, so the
 * fill has to be more certain the further in it reaches.
 */
const CENTRE_TIGHTEN = 0.5;

/** A mask covering more than this is treated as a failed separation. */
const MAX_PLAUSIBLE_COVERAGE = 0.88;

/**
 * A photo has one subject. If the surviving foreground is shattered into more
 * islands than this, the fill has cut through the thing we were meant to keep.
 */
const MAX_SUBJECT_ISLANDS = 4;

/** Count foreground blobs big enough to be more than quantisation noise. */
function foregroundIslands(mask, cols, rows) {
  const seen = new Uint8Array(cols * rows);
  let islands = 0;
  for (let start = 0; start < cols * rows; start++) {
    if (mask[start] || seen[start]) continue;
    let size = 0;
    const queue = [start];
    seen[start] = 1;
    while (queue.length) {
      const i = queue.pop();
      size++;
      const x = i % cols;
      const y = (i - x) / cols;
      const push = (nx, ny) => {
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) return;
        const j = ny * cols + nx;
        if (mask[j] || seen[j]) return;
        seen[j] = 1;
        queue.push(j);
      };
      push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
    }
    if (size >= 3) islands++;
  }
  return islands;
}

/** Cheap agglomerative clustering over LAB samples: first cluster within tol wins. */
function cluster(lab, indices, tolerance) {
  const out = [];
  for (const idx of indices) {
    const L = lab[idx * 3], A = lab[idx * 3 + 1], B = lab[idx * 3 + 2];
    let hit = null;
    for (const c of out) {
      if (deltaE76Sq(L, A, B, c.L, c.A, c.B) < tolerance * tolerance) { hit = c; break; }
    }
    if (hit) {
      hit.count++;
      hit.L += (L - hit.L) / hit.count;   // running mean
      hit.A += (A - hit.A) / hit.count;
      hit.B += (B - hit.B) / hit.count;
    } else {
      out.push({ L, A, B, count: 1 });
    }
  }
  return out.sort((a, b) => b.count - a.count);
}

/** Indices around the frame's outer ring. */
function borderIndices(cols, rows) {
  const out = [];
  for (let x = 0; x < cols; x++) { out.push(x); out.push((rows - 1) * cols + x); }
  for (let y = 1; y < rows - 1; y++) { out.push(y * cols); out.push(y * cols + cols - 1); }
  return out;
}

/** Indices in the middle of the frame, where the subject almost always is. */
function centreIndices(cols, rows) {
  const x0 = Math.floor(cols * 0.3), x1 = Math.ceil(cols * 0.7);
  const y0 = Math.floor(rows * 0.3), y1 = Math.ceil(rows * 0.7);
  const out = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out.push(y * cols + x);
  return out;
}

/**
 * Decide which colors count as background.
 *
 * Sampling the border alone is not enough: subjects routinely fill a corner or
 * run off the bottom of frame, and then the subject's own color is admitted as
 * "background" and the flood eats the picture. The extra constraint that fixes
 * it is the centre — background is what sits at the edge *and is not what is in
 * the middle*. A black cat whose body reaches the bottom-right corner is
 * excluded because black also dominates the centre.
 *
 * @returns {{model: object[], ambiguous: boolean}}
 */
function backgroundCandidates(lab, cols, rows, tolerance) {
  const border = cluster(lab, borderIndices(cols, rows), tolerance);
  const borderTotal = border.reduce((s, c) => s + c.count, 0);
  // Colors that own a real share of the perimeter are worth considering.
  return border.filter((c) => c.count >= borderTotal * 0.12);
}

/**
 * Flood-fill the background inward from the frame edge.
 *
 * @param {Float64Array} cells cols*rows*3, sRGB 0..255
 * @param {{tolerance?: number}} [opts] tolerance is a CIE76 delta-E radius;
 *   bigger removes more.
 * @returns {{mask: Uint8Array, coverage: number}} mask[i] === 1 means background
 */
export function backgroundMask(cells, cols, rows, { tolerance = 16 } = {}) {
  const n = cols * rows;
  const lab = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const [L, A, B] = rgbToLab(cells[i * 3], cells[i * 3 + 1], cells[i * 3 + 2]);
    lab[i * 3] = L; lab[i * 3 + 1] = A; lab[i * 3 + 2] = B;
  }

  // Per-cell tolerance multiplier: 1.0 around the frame, CENTRE_TIGHTEN in the
  // middle. Chebyshev distance so the whole outer ring is treated as "edge".
  const halfW = Math.max(1, (cols - 1) / 2);
  const halfH = Math.max(1, (rows - 1) / 2);
  const weight = new Float64Array(n);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const d = Math.min(1, Math.max(Math.abs(x - halfW) / halfW, Math.abs(y - halfH) / halfH));
      weight[y * cols + x] = CENTRE_TIGHTEN + (1 - CENTRE_TIGHTEN) * d;
    }
  }

  const centre = centreIndices(cols, rows);

  /** Flood inward from the frame edge using exactly this set of colors. */
  const flood = (model, tol, slack = EDGE_SLACK) => {
    const mask = new Uint8Array(n);
    if (!model.length) return mask;

    const within = (i, scale) => {
      const limit = (tol * weight[i] * scale) ** 2;
      const L = lab[i * 3], A = lab[i * 3 + 1], B = lab[i * 3 + 2];
      for (const c of model) if (deltaE76Sq(L, A, B, c.L, c.A, c.B) < limit) return true;
      return false;
    };

    const grow = (queue, scale) => {
      while (queue.length) {
        const i = queue.pop();
        const x = i % cols;
        const y = (i - x) / cols;
        const push = (nx, ny) => {
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) return;
          const j = ny * cols + nx;
          if (mask[j] || !within(j, scale)) return;
          mask[j] = 1;
          queue.push(j);
        };
        push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
      }
    };

    // Pass 1, strict: seed from every edge cell that matches, then grow inward.
    // Connectivity keeps a wall-colored region in the middle of the frame from
    // being erased just because it resembles the wall.
    const queue = [];
    const seed = (i) => { if (!mask[i] && within(i, 1)) { mask[i] = 1; queue.push(i); } };
    for (let x = 0; x < cols; x++) { seed(x); seed((rows - 1) * cols + x); }
    for (let y = 0; y < rows; y++) { seed(y * cols); seed(y * cols + cols - 1); }
    grow(queue, 1);

    // Pass 2, hysteresis: a stud straddling the subject's outline is a physical
    // average of fur and wall, so it matches neither and survives pass 1 as a
    // grey halo. Grow once more with a little slack, but only outward from
    // confirmed background, so it's spent on the boundary not the whole image.
    if (slack > 1) {
      const edge = [];
      for (let i = 0; i < n; i++) if (mask[i]) edge.push(i);
      grow(edge, slack);
    }
    return mask;
  };

  const share = (mask, list) => list.reduce((s, i) => s + mask[i], 0) / list.length;

  /**
   * Pick the model.
   *
   * Statistics about *where a color appears* kept getting this wrong. A tuxedo
   * cat's white bib owns the middle of the frame, so his black fur reads as a
   * minority there — under 20% — and slipped through as "background" even
   * though it is the animal; the flood then entered from the bottom edge, where
   * his body runs out of frame, and erased him.
   *
   * What doesn't lie is what each color actually *does*. Flood with one color
   * at a time: real background hugs the edge and stops at the subject, while
   * the subject's own color pours into the interior. So the test is behavioural,
   * not statistical.
   */
  const chooseModel = (tol) => {
    const candidates = backgroundCandidates(lab, cols, rows, tol);
    if (!candidates.length) return [];

    // Measured without hysteresis: this is about where a color reaches on its
    // own merits, not how far the boundary pass can be stretched.
    const reach = new Map(
      candidates.map((c) => [c, share(flood([c], tol, 1), centre)]));

    const MAX_REACH = 0.12;
    const safe = candidates.filter((c) => reach.get(c) <= MAX_REACH);
    if (safe.length) return safe;

    // Everything reaches the middle — a subject well off-centre, or a scene
    // with no real background. Keep the least invasive rather than nothing, and
    // let the coverage guard below decide if even that is too much.
    return [candidates.reduce((a, b) => (reach.get(a) <= reach.get(b) ? a : b))];
  };

  const attempt = (tol) => {
    const model = chooseModel(tol);
    if (!model.length) return { mask: new Uint8Array(n), coverage: 0, ambiguous: true };
    const mask = flood(model, tol);
    let covered = 0;
    for (let i = 0; i < n; i++) covered += mask[i];
    return { mask, coverage: covered / n, ambiguous: false };
  };

  /**
   * Is this mask implausible?
   *
   * Coverage catches a fill that ate everything. Fragmentation catches the more
   * insidious case: a tuxedo cat against a wall, with a dark cabinet down one
   * side, where the flood slips through his black fur and leaves his white bib
   * stranded among a dozen scraps. Total coverage looks unremarkable there —
   * what gives it away is that the subject came out in pieces.
   */
  const implausible = (r) =>
    r.ambiguous
    || r.coverage > MAX_PLAUSIBLE_COVERAGE
    || share(r.mask, centre) > 0.6
    || foregroundIslands(r.mask, cols, rows) > MAX_SUBJECT_ISLANDS;

  // Tighten and retry before giving up: a smaller tolerance often stops the
  // leak that was joining subject to background.
  let result = attempt(tolerance);
  let used = tolerance;
  for (let i = 0; i < 2 && !result.ambiguous && implausible(result); i++) {
    used *= 0.55;
    result = attempt(used);
  }

  const failed = implausible(result);
  return {
    mask: failed ? new Uint8Array(n) : result.mask,
    coverage: failed ? 0 : result.coverage,
    tolerance: used,
    // `suspect` means: we could not separate subject from background. Callers
    // must not paint a backdrop on this.
    suspect: failed,
  };
}

// ---------------------------------------------------------------------------
// Backdrops
// ---------------------------------------------------------------------------

/**
 * Replacement backgrounds, all built from real palette colors so the result
 * stays buildable and the bill of materials stays honest.
 */
export const BACKDROPS = [
  { id: 'white',     name: 'White',       kind: 'solid',    code: 'WHT' },
  { id: 'softgrey',  name: 'Soft grey',   kind: 'solid',    code: 'VLG' },
  { id: 'black',     name: 'Black',       kind: 'solid',    code: 'BLK' },
  { id: 'navy',      name: 'Deep blue',   kind: 'solid',    code: 'DBL' },
  { id: 'red',       name: 'Red',         kind: 'solid',    code: 'RED' },
  { id: 'sand',      name: 'Sand',        kind: 'solid',    code: 'TAN' },
  { id: 'sky',       name: 'Sky fade',    kind: 'gradient', from: 'DBL', to: 'BLB' },
  { id: 'sunset',    name: 'Sunset fade', kind: 'gradient', from: 'DPU', to: 'MOR' },
  { id: 'spotlight', name: 'Spotlight',   kind: 'radial',   from: 'VLG', to: 'DBG' },
];

const byCode = (code) => {
  const c = PALETTE.find((p) => p.code === code);
  if (!c) throw new Error(`no palette color with code ${code}`);
  return c;
};

/** Blend two colors in linear light, like everything else in this pipeline. */
function mix(a, b, t) {
  const ch = (x, y) => linearToSrgb(srgbToLinear(x / 255) * (1 - t) + srgbToLinear(y / 255) * t) * 255;
  return [ch(a.r, b.r), ch(a.g, b.g), ch(a.b, b.b)];
}

/**
 * Paint the chosen backdrop into every masked cell, in place.
 * @param {Float64Array} cells
 * @param {Uint8Array} mask
 * @param {(typeof BACKDROPS)[number]} backdrop
 */
export function applyBackdrop(cells, cols, rows, mask, backdrop) {
  const solid = backdrop.kind === 'solid' ? byCode(backdrop.code) : null;
  const from = backdrop.from ? byCode(backdrop.from) : null;
  const to = backdrop.to ? byCode(backdrop.to) : null;

  const cx = (cols - 1) / 2;
  const cy = (rows - 1) / 2;
  const maxR = Math.hypot(cx, cy) || 1;

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (!mask[i]) continue;

      let rgb;
      if (solid) {
        rgb = [solid.r, solid.g, solid.b];
      } else if (backdrop.kind === 'gradient') {
        rgb = mix(from, to, rows > 1 ? y / (rows - 1) : 0);
      } else {
        rgb = mix(from, to, Math.min(1, Math.hypot(x - cx, y - cy) / maxR));
      }

      cells[i * 3] = rgb[0];
      cells[i * 3 + 1] = rgb[1];
      cells[i * 3 + 2] = rgb[2];
    }
  }
  return cells;
}

/** Look up a backdrop by id, defaulting to the first. */
export function backdropById(id) {
  return BACKDROPS.find((b) => b.id === id) ?? BACKDROPS[0];
}
