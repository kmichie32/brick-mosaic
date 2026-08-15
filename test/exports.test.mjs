import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMosaic, renderToRGBA } from '../src/mosaic.js';
import { paletteFromCodes, GRAYSCALE_CODES, PALETTE } from '../src/palette.js';
import {
  toShoppingListCSV, toBuildMapCSV, parseBuildMapCSV, verifyBuildMap,
} from '../src/exports.js';
import { buildPrintSheetHTML, pageLayout, studsPerPage } from '../src/printsheet.js';
import { ovalOutline } from '../src/outline.js';
import { STUD_MM } from '../src/sizing.js';

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

const photo = generate(200, 240, (x, y) => {
  const t = y / 240;
  const s = Math.sin(x / 17) * 24;
  return [40 + t * 200 + s, 60 + t * 150 - s * 0.4, 150 - t * 90 + s * 0.6];
});

// --- the round trip that matters --------------------------------------------

test('the exported build map reconstructs the mosaic exactly', () => {
  // The whole point: if someone follows the downloaded file brick by brick,
  // do they get the picture we showed them? Nothing else proves this, because
  // the preview and the export are generated from the same object in memory.
  const m = buildMosaic(photo, { cols: 48, rows: 60, dither: 'floyd-steinberg' });
  const { ok, reason } = verifyBuildMap(m, toBuildMapCSV(m));
  assert.equal(ok, true, reason ?? '');
});

test('a build map round-trips through render, pixel for pixel', () => {
  const m = buildMosaic(photo, { cols: 32, rows: 40, dither: 'floyd-steinberg' });
  const parsed = parseBuildMapCSV(toBuildMapCSV(m), m.palette);

  const original = renderToRGBA(m, { cellSize: 6, studs: false });
  const rebuilt = renderToRGBA(
    { ...m, indices: parsed.indices }, { cellSize: 6, studs: false });

  assert.equal(original.data.length, rebuilt.data.length);
  for (let i = 0; i < original.data.length; i++) {
    if (original.data[i] !== rebuilt.data[i]) {
      assert.fail(`pixel byte ${i} differs: ${original.data[i]} vs ${rebuilt.data[i]}`);
    }
  }
});

test('verifyBuildMap reports where a corrupted map diverges', () => {
  const m = buildMosaic(photo, { cols: 16, rows: 16 });
  const lines = toBuildMapCSV(m).split('\n');
  // Corrupt one cell: row 5, column 3.
  const parts = lines[5].split(',');
  const wrong = m.palette.find((c) => c.code !== parts[3].replace(/"/g, ''));
  parts[3] = `"${wrong.code}"`;
  lines[5] = parts.join(',');

  const { ok, reason } = verifyBuildMap(m, lines.join('\n'));
  assert.equal(ok, false);
  assert.match(reason, /row 5, column 3/);
});

test('build map survives a restricted palette', () => {
  const m = buildMosaic(photo, {
    cols: 24, rows: 24, palette: paletteFromCodes(GRAYSCALE_CODES), dither: 'floyd-steinberg',
  });
  assert.equal(verifyBuildMap(m, toBuildMapCSV(m)).ok, true);
});

test('parseBuildMapCSV rejects malformed input rather than guessing', () => {
  const m = buildMosaic(photo, { cols: 8, rows: 8 });
  assert.throws(() => parseBuildMapCSV('', m.palette), /no rows/);
  assert.throws(
    () => parseBuildMapCSV('"Row","1","2"\n"1","WHT"', m.palette),
    /has 1 columns, expected 2/,
  );
  assert.throws(
    () => parseBuildMapCSV('"Row","1"\n"1","ZZZ"', m.palette),
    /unknown color code "ZZZ"/,
  );
});

// --- shopping list ----------------------------------------------------------

test('shopping list quantities match the bill of materials', () => {
  const m = buildMosaic(photo, { cols: 48, rows: 48, dither: 'floyd-steinberg' });
  const lines = toShoppingListCSV(m).trim().split('\n');
  assert.equal(lines.length - 1, m.bom.length);

  const total = lines.slice(1)
    .map((l) => Number(l.split(',').pop().replace(/"/g, '')))
    .reduce((s, v) => s + v, 0);
  assert.equal(total, m.totalBricks);
});

test('shopping list carries the part each line is actually built from', () => {
  // A textured finish needs the same color as both a plate and a tile, so the
  // part is a property of the BOM line, not an argument to the export.
  const m = buildMosaic(photo, {
    cols: 24, rows: 24, dither: 'floyd-steinberg',
    background: { remove: true, backdrop: 'white', outline: ovalOutline() },
    finish: { subject: 'plate', background: 'tile' },
  });
  const csv = toShoppingListCSV(m);
  assert.match(csv, /"3024"/, 'plates missing');
  assert.match(csv, /"3070b"/, 'tiles missing');
  // Every BOM line must appear with its own part id.
  for (const { color, part, count } of m.bom) {
    const row = csv.split('\n').find((l) => l.startsWith(`"${color.name}","${color.code}"`)
      && l.includes(`"${part.id}"`) && l.endsWith(`"${count}"`));
    assert.ok(row, `no row for ${color.name} / ${part.name} x${count}`);
  }
});

// --- print sheet ------------------------------------------------------------

test('print cells are exactly one stud, so 100% scale is 1:1', () => {
  const m = buildMosaic(photo, { cols: 20, rows: 20 });
  const html = buildPrintSheetHTML(m);
  // The load-bearing CSS: any change here silently breaks physical scale.
  assert.ok(html.includes(`width: ${STUD_MM}mm; height: ${STUD_MM}mm;`),
    'stud cells are not sized in mm at the stud pitch');
  assert.ok(html.includes('width: 100mm'), 'calibration bar missing');
  assert.match(html, /exactly 100&nbsp;mm/);
});

test('the sheet offers a way to print it, and hides that when printing', () => {
  // The sheet opens in a bare window with no browser chrome of its own, so
  // without a button there is nothing to click and no hint that the print
  // dialog is where "Save as PDF" lives.
  const m = buildMosaic(photo, { cols: 20, rows: 20 });
  const html = buildPrintSheetHTML(m);
  assert.match(html, /onclick="window\.print\(\)"/, 'no way to trigger printing');
  assert.match(html, /Save as PDF/, 'does not say where a PDF comes from');
  // A toolbar that printed itself onto page one would be a regression.
  assert.match(html, /@media print \{ \.toolbar \{ display: none !important; \} \}/);
});

test('the sheet says how many pages it will print', () => {
  const one = buildMosaic(photo, { cols: 20, rows: 24 });
  assert.match(buildPrintSheetHTML(one), /\b1 sheet\./, 'should not say "1 sheets"');

  const many = buildMosaic(photo, { cols: 96, rows: 96 });
  const total = pageLayout(many, 'letter').total;
  assert.match(buildPrintSheetHTML(many), new RegExp(`${total} sheets\\.`));
});

test('the sheet tiles across pages and covers every stud exactly once', () => {
  const m = buildMosaic(photo, { cols: 96, rows: 96 });
  const layout = pageLayout(m, 'letter');
  assert.ok(layout.total > 1, 'a 96-stud design must span multiple sheets');
  assert.equal(layout.across, Math.ceil(96 / layout.cols));
  assert.equal(layout.down, Math.ceil(96 / layout.rows));

  // Every cell appears on exactly one sheet.
  const covered = layout.across * layout.cols >= m.cols && layout.down * layout.rows >= m.rows;
  assert.ok(covered, 'page grid does not cover the design');

  const html = buildPrintSheetHTML(m);
  assert.equal((html.match(/class="sheet"/g) || []).length, layout.total);
  assert.match(html, new RegExp(`sheet 1 of ${layout.total}`));
});

test('a small design fits on a single sheet', () => {
  const m = buildMosaic(photo, { cols: 20, rows: 24 });
  assert.equal(pageLayout(m, 'letter').total, 1);
});

test('studsPerPage leaves room for chrome and never returns zero', () => {
  for (const paper of ['letter', 'a4']) {
    const s = studsPerPage(paper);
    assert.ok(s.cols > 0 && s.rows > 0);
    // Sanity: a Letter page is ~216mm wide, so at 8mm you get roughly 24 studs.
    assert.ok(s.cols >= 20 && s.cols <= 26, `${paper} cols ${s.cols}`);
  }
});

test('print sheet escapes the title and uses real palette hexes', () => {
  const m = buildMosaic(photo, { cols: 12, rows: 12 });
  const html = buildPrintSheetHTML(m, { title: 'Cat & <Dog>' });
  assert.ok(html.includes('Cat &amp; &lt;Dog&gt;'));
  assert.equal(html.includes('<Dog>'), false);
  for (const { color } of m.bom) assert.ok(html.includes(color.hex), `${color.hex} missing`);
});

test('every code printed on the sheet resolves in the legend', () => {
  const m = buildMosaic(photo, { cols: 30, rows: 30, dither: 'floyd-steinberg' });
  const html = buildPrintSheetHTML(m);
  const used = new Set([...m.indices].map((i) => m.palette[i].code));
  for (const code of used) {
    assert.ok(html.includes(`<b>${code}</b>`), `${code} is on the grid but not the legend`);
  }
});
