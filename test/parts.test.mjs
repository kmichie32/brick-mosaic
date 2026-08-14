import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMosaic, renderToRGBA, toGridMap, partKindAt, EMPTY, EMPTY_CODE } from '../src/mosaic.js';
import { PART_KINDS, FINISH_PRESETS, resolveFinish, DEFAULT_FINISH } from '../src/parts.js';
import { ovalOutline } from '../src/outline.js';
import { toShoppingListCSV, toBuildMapCSV, verifyBuildMap } from '../src/exports.js';
import { toWantedListXML, analyzeBuild, estimateCost } from '../src/sourcing.js';
import { buildPrintSheetHTML } from '../src/printsheet.js';

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

/** Dark subject on a plain wall — separates cleanly. */
const photo = generate(160, 160, (x, y) =>
  Math.hypot(x - 80, y - 80) < 52 ? [30, 28, 34] : [214, 206, 194]);

const withOutline = (finish) => buildMosaic(photo, {
  cols: 40, rows: 40, dither: 'none', sharpen: 0,
  background: { remove: true, backdrop: 'white', outline: ovalOutline() },
  finish,
});

// --- finish resolution ------------------------------------------------------

test('resolveFinish tolerates partial and unknown input', () => {
  assert.deepEqual(resolveFinish(undefined), DEFAULT_FINISH);
  assert.deepEqual(resolveFinish({ subject: 'tile' }), { subject: 'tile', background: 'plate' });
  assert.deepEqual(resolveFinish({ subject: 'nonsense', background: 'none' }),
    { subject: 'plate', background: 'none' });
});

test('every finish preset names real part kinds', () => {
  for (const p of FINISH_PRESETS) {
    assert.ok(p.id && p.name && p.blurb, `incomplete preset ${p.id}`);
    assert.ok(PART_KINDS[p.finish.subject], `${p.id}: bad subject kind`);
    assert.ok(PART_KINDS[p.finish.background], `${p.id}: bad background kind`);
  }
});

test('a plain mosaic is unaffected by any of this', () => {
  const plain = buildMosaic(photo, { cols: 40, rows: 40, dither: 'none', sharpen: 0 });
  assert.equal(plain.totalBricks, 40 * 40);
  assert.equal(plain.studs, 40 * 40);
  for (const i of plain.indices) assert.notEqual(i, EMPTY);
  for (const e of plain.bom) assert.equal(e.part.kind, 'plate');
});

// --- texture ----------------------------------------------------------------

test('a textured finish splits the BOM by part, not just color', () => {
  const m = withOutline({ subject: 'plate', background: 'tile' });
  const kinds = new Set(m.bom.map((e) => e.part.kind));
  assert.deepEqual([...kinds].sort(), ['plate', 'tile']);

  // Same piece count as an all-plate build: texture costs nothing extra.
  const plain = withOutline({ subject: 'plate', background: 'plate' });
  assert.equal(m.totalBricks, plain.totalBricks);
  assert.equal(m.bom.reduce((s, e) => s + e.count, 0), plain.totalBricks);
});

test('subject cells are plates and background cells are tiles', () => {
  const m = withOutline({ subject: 'plate', background: 'tile' });
  for (let i = 0; i < m.indices.length; i++) {
    assert.equal(partKindAt(m, i), m.subject[i] ? 'plate' : 'tile');
  }
});

test('tiles render without studs, plates with them', () => {
  const studded = renderToRGBA(withOutline({ subject: 'plate', background: 'plate' }), { cellSize: 10 });
  const mixed = renderToRGBA(withOutline({ subject: 'plate', background: 'tile' }), { cellSize: 10 });
  // Same size, but the background pixels differ because the studs are gone.
  assert.equal(studded.data.length, mixed.data.length);
  let differing = 0;
  for (let i = 0; i < studded.data.length; i++) if (studded.data[i] !== mixed.data[i]) differing++;
  assert.ok(differing > 0, 'tiles rendered identically to plates');
});

test('the wanted list carries each line its own part id', () => {
  const m = withOutline({ subject: 'plate', background: 'tile' });
  const xml = toWantedListXML(m);
  assert.ok(xml.includes('<ITEMID>3024</ITEMID>'), 'plates missing');
  assert.ok(xml.includes('<ITEMID>3070b</ITEMID>'), 'tiles missing');
  const qty = [...xml.matchAll(/<MINQTY>(\d+)<\/MINQTY>/g)].reduce((s, [, n]) => s + Number(n), 0);
  assert.equal(qty, m.totalBricks);
});

// --- no background ----------------------------------------------------------

test('subject-only leaves the background empty and unbought', () => {
  const m = withOutline({ subject: 'plate', background: 'none' });

  assert.ok(m.totalBricks < m.studs, 'nothing was left empty');
  let empties = 0;
  for (let i = 0; i < m.indices.length; i++) {
    if (m.indices[i] === EMPTY) { empties++; assert.equal(m.subject[i], 0); }
    else assert.equal(m.subject[i], 1);
  }
  assert.equal(m.totalBricks + empties, m.studs);

  // Nothing in the bill of materials is a background piece.
  for (const e of m.bom) assert.equal(e.part.kind, 'plate');
  assert.equal(m.bom.reduce((s, e) => s + e.count, 0), m.totalBricks);
});

test('subject-only is dramatically cheaper than a full background', () => {
  const full = withOutline({ subject: 'plate', background: 'plate' });
  const only = withOutline({ subject: 'plate', background: 'none' });
  assert.ok(only.totalBricks < full.totalBricks * 0.75,
    `expected a big saving: ${only.totalBricks} vs ${full.totalBricks}`);
  assert.ok(estimateCost(only, 0.06).total < estimateCost(full, 0.06).total);
});

test('empty studs render transparent rather than as a color', () => {
  const m = withOutline({ subject: 'plate', background: 'none' });
  const img = renderToRGBA(m, { cellSize: 8 });
  // Top-left corner is background, so it must be fully transparent.
  assert.equal(img.data[3], 0, 'empty stud was painted opaque');
  // The centre is subject, so it must be opaque.
  const mid = ((img.height >> 1) * img.width + (img.width >> 1)) * 4;
  assert.equal(img.data[mid + 3], 255, 'subject stud was transparent');
});

test('empty studs survive the build map round trip', () => {
  const m = withOutline({ subject: 'plate', background: 'none' });
  const map = toBuildMapCSV(m);
  assert.ok(map.includes(`"${EMPTY_CODE}"`), 'empty code missing from the map');
  const { ok, reason } = verifyBuildMap(m, map);
  assert.equal(ok, true, reason ?? '');
});

test('the grid map marks empty studs distinctly', () => {
  const m = withOutline({ subject: 'plate', background: 'none' });
  const grid = toGridMap(m);
  assert.equal(grid[0][0], EMPTY_CODE);
  assert.notEqual(grid[20][20], EMPTY_CODE);
});

test('the shopping list omits empty studs entirely', () => {
  const m = withOutline({ subject: 'plate', background: 'none' });
  const csv = toShoppingListCSV(m);
  assert.equal(csv.includes(EMPTY_CODE), false, 'empty studs leaked into the shopping list');
  const total = csv.trim().split('\n').slice(1)
    .map((l) => Number(l.split(',').pop().replace(/"/g, '')))
    .reduce((s, v) => s + v, 0);
  assert.equal(total, m.totalBricks);
});

test('the print sheet leaves empty studs blank', () => {
  const m = withOutline({ subject: 'plate', background: 'none' });
  const html = buildPrintSheetHTML(m);
  assert.ok(html.includes('class="empty'), 'no blank cells on the sheet');
  assert.equal(html.includes(`>${EMPTY_CODE}<`), false, 'empty code was printed as a brick');
});

test('feasibility figures use bricks bought, not grid positions', () => {
  const m = withOutline({ subject: 'plate', background: 'none' });
  const a = analyzeBuild(m);
  assert.equal(a.lots, m.bom.length);
  // Baseplates still cover the whole grid — the frame doesn't shrink.
  assert.equal(a.baseplates.total, 4);
  assert.equal(estimateCost(m, 0.05).pieces, m.totalBricks * 0.05);
});
