/**
 * A hand-drawn outline around the subject.
 *
 * Automatic separation works when the background is plain and fails in ways
 * that are hard to predict. Rather than making the heuristic ever more clever,
 * this hands the user a line they can draw. The detected mask becomes a
 * *starting point* instead of the answer.
 *
 * An outline is a list of closed loops of points in normalised frame space
 * (x and y both 0..1 regardless of aspect), filled with the even-odd rule. That
 * matters: a loop drawn inside an existing one punches a hole. So "trace round
 * the cat, then trace round the litter box beside it" works without any special
 * add/subtract mode — the second loop simply cuts.
 *
 * An earlier version stored a centre plus 16 radii, which made every handle
 * position valid but could only describe star shapes. It could not exclude a
 * bar behind the subject or a box beside it, which is exactly what people want
 * to remove. Arbitrary loops cost a real point-in-polygon test and win that.
 */

const TAU = Math.PI * 2;

/** An outline with nothing in it keeps everything (no cutting applied). */
export const emptyOutline = () => ({ loops: [] });

/** A closed oval, used as the fallback when detection gives us nothing. */
export function ovalOutline({ cx = 0.5, cy = 0.5, rx = 0.38, ry = 0.42, points = 48 } = {}) {
  const loop = [];
  for (let i = 0; i < points; i++) {
    const a = (i / points) * TAU;
    loop.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
  }
  return { loops: [loop] };
}

/** Discard degenerate loops and clamp stray coordinates. */
export function normalizeOutline(outline) {
  const clamp = (v) => Math.min(1.5, Math.max(-0.5, Number(v)));
  const loops = (outline?.loops ?? [])
    .map((loop) => (loop ?? [])
      .filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y))
      .map((p) => ({ x: clamp(p.x), y: clamp(p.y) })))
    // Fewer than 3 points has no area — a stray tap, not a shape.
    .filter((loop) => loop.length >= 3);
  return { loops };
}

/**
 * Ray-casting point-in-polygon, accumulated across every loop with the even-odd
 * rule so nested loops alternate between keeping and cutting.
 */
export function isInside(outline, x, y) {
  let inside = false;
  for (const loop of outline.loops ?? []) {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const a = loop[i];
      const b = loop[j];
      if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/**
 * Rasterise to a background mask.
 * @returns {Uint8Array} 1 = outside the outline = background
 */
export function maskFromOutline(outline, cols, rows) {
  const o = normalizeOutline(outline);
  const mask = new Uint8Array(cols * rows);
  if (!o.loops.length) return mask;            // nothing drawn: keep everything
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      mask[y * cols + x] = isInside(o, (x + 0.5) / cols, (y + 0.5) / rows) ? 0 : 1;
    }
  }
  return mask;
}

// ---------------------------------------------------------------------------
// Seeding from a detected mask
// ---------------------------------------------------------------------------

/**
 * Ramer–Douglas–Peucker. A traced pixel boundary has one point per step, which
 * is far more than anyone wants to see or drag; this keeps the corners that
 * carry the shape and drops the rest.
 */
export function simplifyPath(points, tolerance = 0.006) {
  if (points.length < 3) return points.slice();

  const dist = (p, a, b) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
  };

  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let worst = 0;
    let at = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = dist(points[i], points[lo], points[hi]);
      if (d > worst) { worst = d; at = i; }
    }
    if (at !== -1 && worst > tolerance) {
      keep[at] = 1;
      stack.push([lo, at], [at, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Trace a starting loop around the detected subject.
 *
 * Deliberately a radial sweep rather than a true contour trace: the result is
 * a rough loop the user is expected to redraw or cut into anyway, and a radial
 * sweep can't produce the self-intersecting tangles that boundary-following
 * does on noisy stud-resolution masks.
 *
 * @param {Uint8Array} mask 1 = background, 0 = subject
 */
export function outlineFromMask(mask, cols, rows, { spokes = 64 } = {}) {
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (!mask[y * cols + x]) { sx += x; sy += y; n++; }
    }
  }
  if (n === 0 || n === cols * rows) return ovalOutline();

  const cx = (sx / n + 0.5) / cols;
  const cy = (sy / n + 0.5) / rows;
  const step = 1 / Math.max(cols, rows) / 2;

  const loop = [];
  for (let s = 0; s < spokes; s++) {
    const a = (s / spokes) * TAU;
    const dx = Math.cos(a), dy = Math.sin(a);
    let furthest = step * 2;
    for (let t = step; t <= 1.4; t += step) {
      const nx = cx + dx * t;
      const ny = cy + dy * t;
      if (nx < 0 || ny < 0 || nx >= 1 || ny >= 1) break;
      const gx = Math.min(cols - 1, Math.floor(nx * cols));
      const gy = Math.min(rows - 1, Math.floor(ny * rows));
      if (!mask[gy * cols + gx]) furthest = t;
    }
    const r = Math.min(1.4, furthest + step * 2);   // pad past the edge studs
    loop.push({ x: cx + dx * r, y: cy + dy * r });
  }
  return { loops: [simplifyPath(loop, 0.004)] };
}

/** Total point count, for UI that wants to say how complex the shape is. */
export const outlinePointCount = (outline) =>
  (outline?.loops ?? []).reduce((s, l) => s + l.length, 0);
