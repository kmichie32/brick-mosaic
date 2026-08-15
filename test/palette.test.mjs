import test from 'node:test';
import assert from 'node:assert/strict';

import { PALETTE, paletteFromCodes, GRAYSCALE_CODES } from '../src/palette.js';

// These ids are not decoration: exports.js writes both into the shopping-list
// CSV, and blId is what toWantedListXML emits as <COLOR>. A wrong one sends
// someone to the wrong brick, so they get pinned here.

test('every color has a distinct code, BrickLink id and LEGO id', () => {
  for (const key of ['code', 'blId', 'legoId']) {
    const seen = new Map();
    for (const c of PALETTE) {
      assert.ok(!seen.has(c[key]),
        `${key} ${c[key]} is shared by ${seen.get(c[key])} and ${c.name}`);
      seen.set(c[key], c.name);
    }
  }
});

test('legoId holds a LEGO color id, not an LDraw code', () => {
  // Two entries were populated from LDraw's `CODE` column instead of its
  // LEGOID comment. Purple was the nasty one: LDraw code 22 collides with a
  // real but unrelated LEGO color (22 is Medium Reddish Violet), so the wrong
  // value still resolved to something and looked fine.
  const byCode = Object.fromEntries(PALETTE.map((c) => [c.code, c]));
  assert.equal(byCode.PUR.legoId, 104, 'Purple is LEGO 104 (Bright Violet)');
  assert.equal(byCode.MNG.legoId, 312, 'Medium Nougat is LEGO 312');
});

test('every color carries a well-formed hex value', () => {
  for (const c of PALETTE) {
    assert.match(c.hex, /^#[0-9A-F]{6}$/i, `${c.name} has a malformed hex`);
    for (const ch of ['r', 'g', 'b']) {
      assert.ok(Number.isInteger(c[ch]) && c[ch] >= 0 && c[ch] <= 255,
        `${c.name} has a bad ${ch} channel`);
    }
  }
});

test('paletteFromCodes reindexes so indices stay contiguous', () => {
  // Indices address the palette array directly, so a subset that kept its
  // original indices would read past the end of itself.
  const sub = paletteFromCodes(GRAYSCALE_CODES);
  assert.equal(sub.length, GRAYSCALE_CODES.length);
  sub.forEach((c, i) => assert.equal(c.index, i));
});
