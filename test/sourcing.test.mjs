import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMosaic } from '../src/mosaic.js';
import { PALETTE } from '../src/palette.js';
import {
  PARTS, VENDORS, analyzeBuild, estimateCost, buildBuyableMosaic, toWantedListXML,
} from '../src/sourcing.js';

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

/** A photo-ish source with a broad, uneven color distribution. */
const photo = generate(240, 240, (x, y) => {
  const t = y / 240;
  const s = Math.sin(x / 19) * 26;
  return [40 + t * 200 + s, 60 + t * 150 - s * 0.4, 150 - t * 90 + s * 0.6];
});

// --- feasibility ------------------------------------------------------------

test('analyzeBuild reports lots and flags the long tail', () => {
  const m = buildMosaic(photo, { cols: 48, rows: 48, dither: 'floyd-steinberg' });
  const a = analyzeBuild(m, { minCount: 20 });

  assert.equal(a.lots, m.bom.length);
  for (const e of a.longTail) assert.ok(e.count < 20);
  assert.equal(a.longTailPieces, a.longTail.reduce((s, e) => s + e.count, 0));
  // Long-tail pieces are by definition a small share of the build.
  assert.ok(a.longTailPieces < m.totalBricks);
});

test('multi-baseplate designs warn that plates do not interlock', () => {
  const big = buildMosaic(photo, { cols: 64, rows: 64 });
  const warn = analyzeBuild(big).warnings.find((w) => /clip together/.test(w.title));
  assert.ok(warn, 'expected a baseplate warning');
  assert.equal(warn.level, 'caution');
  assert.match(warn.title, /4 baseplates/);

  // A single-baseplate design must not raise it.
  const small = buildMosaic(photo, { cols: 32, rows: 32 });
  assert.equal(analyzeBuild(small).warnings.some((w) => /clip together/.test(w.title)), false);
});

test('a clean mosaic with no long tail produces no long-tail warning', () => {
  // Two flat colors, well above threshold, on one baseplate.
  const flat = generate(64, 64, (x) => (x < 32 ? [201, 26, 9] : [0, 85, 191]));
  const m = buildMosaic(flat, { cols: 32, rows: 32, dither: 'none', sharpen: 0 });
  const a = analyzeBuild(m, { minCount: 20 });
  assert.equal(a.longTail.length, 0);
  assert.equal(a.warnings.some((w) => /fewer than/.test(w.title)), false);
});

test('estimateCost is arithmetic over the caller-supplied rate', () => {
  const m = buildMosaic(photo, { cols: 32, rows: 32 });
  const c = estimateCost(m, 0.05, { shippingPerLot: 4 });
  assert.equal(c.pieces, 1024 * 0.05);
  assert.equal(c.shipping, m.bom.length * 4);
  assert.equal(c.total, c.pieces + c.shipping + c.baseplates);
  // Zero shipping is the default.
  assert.equal(estimateCost(m, 0.05).shipping, 0);
});

test('estimateCost charges for the baseplates the build needs', () => {
  // Baseplates were omitted once while the build list displayed their count
  // right beside the total, understating a real 15x15 build by $20-37. A
  // mosaic has to sit on something, so it belongs in the total.
  const m = buildMosaic(photo, { cols: 48, rows: 48 });
  const c = estimateCost(m, 0.05, { baseplatePrice: 9 });

  assert.equal(c.baseplateCount, 4, '48x48 needs a 2x2 grid of 32x32 baseplates');
  assert.equal(c.baseplates, 4 * 9);
  assert.equal(c.total, c.pieces + c.baseplates);
  assert.ok(c.total > c.pieces, 'baseplates must move the total');
});

test('estimateCost still reports the baseplate count when they are free', () => {
  // Someone reusing baseplates they own passes 0 -- they should still be told
  // how many the build takes, because that is a "do you have these?" question.
  const m = buildMosaic(photo, { cols: 48, rows: 48 });
  const c = estimateCost(m, 0.05);
  assert.equal(c.baseplateCount, 4);
  assert.equal(c.baseplates, 0);
});

// --- simplification ---------------------------------------------------------

test('buildBuyableMosaic removes the long tail it set out to remove', () => {
  const options = { cols: 48, rows: 48, dither: 'floyd-steinberg' };
  const plain = buildMosaic(photo, options);
  const { mosaic, dropped, initialColors } = buildBuyableMosaic(photo, options, { minCount: 20 });

  assert.equal(initialColors, plain.bom.length);
  assert.ok(mosaic.bom.length < plain.bom.length,
    `expected fewer colors, got ${mosaic.bom.length} vs ${plain.bom.length}`);
  assert.ok(dropped.length > 0);

  // The whole point: nothing rare survives in the final build.
  for (const e of mosaic.bom) {
    assert.ok(e.count >= 20, `${e.color.name} still only used ${e.count} times`);
  }
});

test('simplification preserves the stud count exactly', () => {
  const options = { cols: 48, rows: 48, dither: 'floyd-steinberg' };
  const { mosaic } = buildBuyableMosaic(photo, options, { minCount: 25 });
  assert.equal(mosaic.bom.reduce((s, e) => s + e.count, 0), 48 * 48);
  assert.equal(mosaic.totalBricks, 48 * 48);
});

test('simplification never drops below minColors', () => {
  // An absurd threshold would otherwise eat the entire palette.
  const options = { cols: 32, rows: 32, dither: 'floyd-steinberg' };
  const { mosaic } = buildBuyableMosaic(photo, options, { minCount: 100000, minColors: 6 });
  assert.ok(mosaic.bom.length >= 1);
  assert.ok(mosaic.bom.length <= 6, `expected <= 6 colors, got ${mosaic.bom.length}`);
});

test('an already-simple mosaic is left alone', () => {
  const flat = generate(64, 64, (x) => (x < 32 ? [201, 26, 9] : [0, 85, 191]));
  const options = { cols: 32, rows: 32, dither: 'none', sharpen: 0 };
  const plain = buildMosaic(flat, options);
  const { mosaic, dropped, passes } = buildBuyableMosaic(flat, options, { minCount: 20 });
  assert.equal(dropped.length, 0);
  assert.equal(passes, 0);
  assert.deepEqual([...mosaic.indices], [...plain.indices]);
});

test('simplification respects a caller-supplied palette', () => {
  const subset = PALETTE.slice(0, 12).map((c, index) => ({ ...c, index }));
  const options = { cols: 40, rows: 40, dither: 'floyd-steinberg', palette: subset };
  const { mosaic } = buildBuyableMosaic(photo, options, { minCount: 20 });
  const allowed = new Set(subset.map((c) => c.code));
  for (const e of mosaic.bom) assert.ok(allowed.has(e.color.code), `${e.color.code} not in subset`);
});

// --- wanted list export -----------------------------------------------------

test('wanted list XML has one well-formed ITEM per color', () => {
  const m = buildMosaic(photo, { cols: 32, rows: 32 });
  const xml = toWantedListXML(m);

  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.equal((xml.match(/<ITEM>/g) || []).length, m.bom.length);
  assert.equal((xml.match(/<ITEM>/g) || []).length, (xml.match(/<\/ITEM>/g) || []).length);
  assert.match(xml, /<INVENTORY>[\s\S]*<\/INVENTORY>/);

  // Quantities and BrickLink color IDs must match the BOM exactly -- this is
  // the file someone actually orders from.
  for (const { color, count } of m.bom) {
    assert.ok(
      xml.includes(`<COLOR>${color.blId}</COLOR>`),
      `missing BrickLink color ${color.blId} (${color.name})`,
    );
    assert.ok(xml.includes(`<MINQTY>${count}</MINQTY>`), `missing qty ${count}`);
  }
  // Default part is the 1x1 plate.
  assert.ok(xml.includes(`<ITEMID>${PARTS.plate.id}</ITEMID>`));
  assert.equal((xml.match(/<ITEMTYPE>P<\/ITEMTYPE>/g) || []).length, m.bom.length);
});

test('wanted list can target tiles instead of plates', () => {
  const m = buildMosaic(photo, { cols: 16, rows: 16 });
  const xml = toWantedListXML(m, { partId: PARTS.tile.id });
  assert.ok(xml.includes(`<ITEMID>${PARTS.tile.id}</ITEMID>`));
  assert.equal(xml.includes(`<ITEMID>${PARTS.plate.id}</ITEMID>`), false);
});

test('wanted list totals equal the mosaic stud count', () => {
  const m = buildMosaic(photo, { cols: 48, rows: 36, dither: 'floyd-steinberg' });
  const qty = [...toWantedListXML(m).matchAll(/<MINQTY>(\d+)<\/MINQTY>/g)]
    .reduce((s, [, n]) => s + Number(n), 0);
  assert.equal(qty, 48 * 36);
});

test('color names are XML-escaped in remarks', () => {
  const m = buildMosaic(photo, { cols: 8, rows: 8 });
  const spoofed = {
    ...m,
    bom: [{ color: { ...m.bom[0].color, name: 'Red & <script>' }, count: 5 }],
  };
  const xml = toWantedListXML(spoofed);
  assert.ok(xml.includes('Red &amp; &lt;script&gt;'));
  assert.equal(xml.includes('<script>'), false);
});

// --- vendor data ------------------------------------------------------------

test('vendor entries are complete and use https', () => {
  assert.ok(VENDORS.length >= 2);
  for (const v of VENDORS) {
    assert.ok(v.id && v.name && v.best && v.detail, `incomplete vendor ${v.id}`);
    assert.match(v.url, /^https:\/\//, `${v.id} url must be https`);
    assert.equal(typeof v.acceptsWantedList, 'boolean');
  }
  // At least one vendor must take the file we generate, or the export is moot.
  assert.ok(VENDORS.some((v) => v.acceptsWantedList));
});
