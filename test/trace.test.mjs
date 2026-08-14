import test from 'node:test';
import assert from 'node:assert/strict';

import { edgeMap, snapToEdges, resamplePath, smoothPath } from '../src/trace.js';

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

/** A dark disc on a light background — one clean circular edge. */
const disc = (w, h, cx, cy, r) =>
  generate(w, h, (x, y) => (Math.hypot(x - cx, y - cy) < r ? [30, 28, 34] : [214, 206, 194]));

// --- edge map ---------------------------------------------------------------

test('a flat image has no edges', () => {
  const e = edgeMap(generate(40, 40, () => [128, 128, 128]));
  for (const v of e.data) assert.equal(v, 0);
});

test('edges are strongest on the boundary and near zero away from it', () => {
  const e = edgeMap(disc(80, 80, 40, 40, 20));
  const at = (x, y) => e.data[y * e.w + x];

  assert.ok(at(60, 40) > 0.5, `boundary strength ${at(60, 40)}`);   // right edge of the disc
  assert.ok(at(40, 40) < 0.05, 'inside the disc should be flat');
  assert.ok(at(8, 8) < 0.05, 'the background should be flat');
});

test('edge strength is normalised per image', () => {
  // A low-contrast edge and a high-contrast one both peak at 1 in their own
  // image, so a single snap threshold works for both.
  const strong = edgeMap(generate(40, 40, (x) => (x < 20 ? [0, 0, 0] : [255, 255, 255])));
  const weak = edgeMap(generate(40, 40, (x) => (x < 20 ? [120, 120, 120] : [140, 140, 140])));
  assert.ok(Math.max(...strong.data) > 0.99);
  assert.ok(Math.max(...weak.data) > 0.99);
});

// --- snapping ---------------------------------------------------------------

test('a sloppy trace is pulled onto the real edge', () => {
  const size = 120, r = 34;
  const edges = edgeMap(disc(size, size, 60, 60, r));

  // Trace a circle deliberately 6px too big, all the way round.
  const sloppy = [];
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    sloppy.push({ x: (60 + Math.cos(a) * (r + 6)) / size, y: (60 + Math.sin(a) * (r + 6)) / size });
  }

  const snapped = snapToEdges(sloppy, edges, { radius: 0.09 });
  const errOf = (pts) => pts.reduce((s, p) => {
    const d = Math.hypot(p.x * size - 60, p.y * size - 60);
    return s + Math.abs(d - r);
  }, 0) / pts.length;

  assert.ok(errOf(snapped) < errOf(sloppy) / 2,
    `snap should halve the error: ${errOf(snapped).toFixed(2)} vs ${errOf(sloppy).toFixed(2)}`);
});

test('points in a flat area are left where they were drawn', () => {
  const edges = edgeMap(generate(80, 80, () => [180, 180, 180]));
  const pts = [{ x: 0.3, y: 0.3 }, { x: 0.6, y: 0.7 }];
  assert.deepEqual(snapToEdges(pts, edges), pts);
});

test('a weak texture does not drag points off course', () => {
  // Faint noise everywhere plus one real edge: points far from the real edge
  // must not be yanked toward whichever noise pixel happens to be strongest.
  const img = generate(100, 100, (x, y) =>
    x < 50 ? [40, 40, 40] : [200 + ((x * 7 + y * 3) % 4), 200, 200]);
  const edges = edgeMap(img);
  const far = [{ x: 0.85, y: 0.5 }];
  const out = snapToEdges(far, edges, { radius: 0.03, minStrength: 0.2 });
  assert.ok(Math.abs(out[0].x - 0.85) < 0.02, `drifted to ${out[0].x}`);
});

test('snap strength scales how far points move', () => {
  const size = 120, r = 34;
  const edges = edgeMap(disc(size, size, 60, 60, r));
  const pts = [{ x: (60 + r + 8) / size, y: 0.5 }];
  const half = snapToEdges(pts, edges, { radius: 0.1, strength: 0.5 })[0];
  const full = snapToEdges(pts, edges, { radius: 0.1, strength: 1 })[0];
  assert.ok(Math.abs(full.x - pts[0].x) > Math.abs(half.x - pts[0].x));
});

test('snapping never returns the same object references', () => {
  const edges = edgeMap(generate(20, 20, () => [10, 10, 10]));
  const pts = [{ x: 0.5, y: 0.5 }];
  const out = snapToEdges(pts, edges);
  out[0].x = 0.9;
  assert.equal(pts[0].x, 0.5, 'input was mutated');
});

test('snapping an empty path is harmless', () => {
  assert.deepEqual(snapToEdges([], edgeMap(generate(10, 10, () => [0, 0, 0]))), []);
});

// --- resampling and smoothing ------------------------------------------------

test('resamplePath evens out spacing', () => {
  // Dense at the start, sparse at the end — like a hand that slowed down.
  const pts = [];
  for (let i = 0; i < 20; i++) pts.push({ x: i * 0.002, y: 0 });
  pts.push({ x: 0.6, y: 0 });

  const out = resamplePath(pts, 0.02);
  const gaps = out.slice(1).map((p, i) => Math.hypot(p.x - out[i].x, p.y - out[i].y));
  const max = Math.max(...gaps);
  assert.ok(max < 0.021 + 1e-6, `largest gap ${max}`);
  assert.ok(out.length > 25, `expected a filled-in path, got ${out.length} points`);
  // Endpoints are preserved.
  assert.ok(Math.abs(out[0].x) < 1e-9);
  assert.ok(Math.abs(out.at(-1).x - 0.6) < 0.021);
});

test('resamplePath copes with duplicate points and tiny paths', () => {
  assert.equal(resamplePath([{ x: 0.1, y: 0.1 }]).length, 1);
  const dupes = resamplePath([{ x: 0.1, y: 0.1 }, { x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }], 0.05);
  assert.ok(dupes.length >= 2);
  for (const p of dupes) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
});

test('smoothPath reduces wobble but keeps the ends', () => {
  const zig = [];
  for (let i = 0; i < 21; i++) zig.push({ x: i / 20, y: i % 2 ? 0.02 : -0.02 });
  const smooth = smoothPath(zig, 3);

  const wobble = (pts) => pts.slice(1, -1)
    .reduce((s, p, i) => s + Math.abs(p.y - (pts[i].y + pts[i + 2].y) / 2), 0);
  assert.ok(wobble(smooth) < wobble(zig) / 2);
  assert.deepEqual(smooth[0], zig[0]);
  assert.deepEqual(smooth.at(-1), zig.at(-1));
});
