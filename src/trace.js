/**
 * Tracing helpers: find the edges in a photo, and pull a roughly-drawn line
 * onto them.
 *
 * Nobody traces accurately with a fingertip on a phone, and nobody wants to.
 * The fix used by every serious selection tool is to let the drawn line be
 * approximate and snap it to the nearest real boundary — a magnetic lasso.
 *
 * This is the post-hoc variant: draw freely, then each point is pulled to the
 * strongest edge within a small radius. A live cost-minimising path (Photoshop's
 * actual algorithm) tracks the edge more tightly but fights the user when the
 * edge is weak or crossed by another one. Snapping after the fact keeps the
 * drawn shape as the source of truth and only tidies it, which is the right
 * balance when the output is 8mm squares.
 */

/**
 * Gradient magnitude of an image, as a normalised 0..1 field.
 *
 * Sobel over luminance. Colour edges that share a luminance (a red shirt on a
 * green wall) are invisible to this, but they're rare next to the everyday
 * case of a subject being lighter or darker than what's behind it.
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray|Uint8Array}} img
 * @returns {{w:number,h:number,data:Float64Array}}
 */
export function edgeMap(img) {
  const { width: w, height: h, data } = img;
  const luma = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) {
    luma[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
  }

  const out = new Float64Array(w * h);
  let peak = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = luma[i - w - 1], t = luma[i - w], tr = luma[i - w + 1];
      const l = luma[i - 1], r = luma[i + 1];
      const bl = luma[i + w - 1], b = luma[i + w], br = luma[i + w + 1];
      const gx = tl + 2 * l + bl - tr - 2 * r - br;
      const gy = tl + 2 * t + tr - bl - 2 * b - br;
      const m = Math.hypot(gx, gy);
      out[i] = m;
      if (m > peak) peak = m;
    }
  }
  // Normalise against this image's own strongest edge, so the snap threshold
  // means the same thing on a flat studio shot and a contrasty outdoor one.
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] /= peak;
  return { w, h, data: out };
}

/**
 * Pull each point onto the strongest nearby edge.
 *
 * @param {{x:number,y:number}[]} points  normalised 0..1
 * @param {{w:number,h:number,data:Float64Array}} edges
 * @param {{radius?:number, minStrength?:number, strength?:number}} [opts]
 *   radius       how far to look, in normalised units (0.02 ≈ 2% of the frame)
 *   minStrength  ignore edges weaker than this, so points in flat areas stay
 *                where they were drawn instead of being dragged into noise
 *   strength     0..1, how far to move toward the found edge
 */
export function snapToEdges(points, edges, { radius = 0.022, minStrength = 0.12, strength = 1 } = {}) {
  if (!edges || !points.length || strength <= 0) return points.map((p) => ({ ...p }));

  const { w, h, data } = edges;
  const rx = Math.max(1, Math.round(radius * w));
  const ry = Math.max(1, Math.round(radius * h));

  return points.map((p) => {
    const px = Math.round(p.x * w);
    const py = Math.round(p.y * h);

    let best = minStrength;
    let bx = -1, by = -1;
    let bestDist = Infinity;

    for (let y = Math.max(0, py - ry); y <= Math.min(h - 1, py + ry); y++) {
      for (let x = Math.max(0, px - rx); x <= Math.min(w - 1, px + rx); x++) {
        const v = data[y * w + x];
        if (v < best) continue;
        const d = Math.hypot(x - px, y - py);
        // Prefer a stronger edge, and among comparable ones the nearer.
        if (v > best + 1e-9 || d < bestDist) {
          best = v; bx = x; by = y; bestDist = d;
        }
      }
    }

    if (bx < 0) return { ...p };            // nothing convincing nearby
    const tx = (bx + 0.5) / w;
    const ty = (by + 0.5) / h;
    return { x: p.x + (tx - p.x) * strength, y: p.y + (ty - p.y) * strength };
  });
}

/**
 * Resample a path to roughly even spacing.
 *
 * A pointer stream is dense where the hand slowed down and sparse where it
 * moved fast, which makes snapping lumpy — dense stretches get pulled hard and
 * fast ones barely at all. Evening the spacing first makes the snap uniform.
 */
export function resamplePath(points, spacing = 0.01) {
  if (points.length < 2) return points.map((p) => ({ ...p }));

  const out = [{ ...points[0] }];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (seg === 0) continue;
    let t = spacing - carry;
    while (t <= seg) {
      out.push({ x: a.x + ((b.x - a.x) * t) / seg, y: a.y + ((b.y - a.y) * t) / seg });
      t += spacing;
    }
    carry = (carry + seg) % spacing;
  }
  const last = points[points.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last.x - tail.x, last.y - tail.y) > spacing / 4) out.push({ ...last });
  return out;
}

/** Light smoothing, to take the wobble out of a fingertip trace. */
export function smoothPath(points, passes = 1) {
  let pts = points.map((p) => ({ ...p }));
  for (let n = 0; n < passes; n++) {
    const next = pts.map((p, i) => {
      if (i === 0 || i === pts.length - 1) return { ...p };
      const a = pts[i - 1], b = pts[i + 1];
      return { x: (a.x + p.x * 2 + b.x) / 4, y: (a.y + p.y * 2 + b.y) / 4 };
    });
    pts = next;
  }
  return pts;
}
