import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STUD_MM, BASEPLATE_STUDS, physicalSize, baseplateLayout,
  ASPECTS, SIZES, resolveGrid, formatInches,
} from '../src/sizing.js';

test('a 32x32 grid is exactly one baseplate, ~10 inches square', () => {
  const { wMm, wIn } = physicalSize(32, 32);
  assert.equal(wMm, 32 * STUD_MM);
  assert.equal(wMm, 256);
  assert.ok(Math.abs(wIn - 10.079) < 0.01, `got ${wIn}`);
  assert.deepEqual(baseplateLayout(32, 32), { across: 1, down: 1, total: 1 });
});

test('baseplate count rounds up -- a partial plate is still a whole purchase', () => {
  assert.deepEqual(baseplateLayout(33, 32), { across: 2, down: 1, total: 2 });
  assert.deepEqual(baseplateLayout(48, 48), { across: 2, down: 2, total: 4 });
  assert.deepEqual(baseplateLayout(96, 96), { across: 3, down: 3, total: 9 });
  assert.deepEqual(baseplateLayout(64, 51), { across: 2, down: 2, total: 4 });
});

test('the long edge always gets the tier stud count', () => {
  for (const aspect of ASPECTS) {
    for (const size of SIZES) {
      const { cols, rows } = resolveGrid(aspect, size.studs);
      assert.equal(Math.max(cols, rows), size.studs,
        `${aspect.id}/${size.id} -> ${cols}x${rows}`);
      assert.ok(Number.isInteger(cols) && Number.isInteger(rows));
      assert.ok(cols >= 1 && rows >= 1);
    }
  }
});

test('resolved grids keep the requested aspect ratio', () => {
  for (const aspect of ASPECTS) {
    const { cols, rows } = resolveGrid(aspect, 96);
    const want = aspect.w / aspect.h;
    assert.ok(Math.abs(cols / rows - want) < 0.02,
      `${aspect.id}: ${cols}/${rows} = ${(cols / rows).toFixed(3)}, want ${want}`);
  }
});

test('grids resolve to whole studs the pipeline will accept', () => {
  const { cols, rows } = resolveGrid(ASPECTS.find((a) => a.id === 'portrait'), 48);
  assert.deepEqual({ cols, rows }, { cols: 38, rows: 48 });
});

test('inch formatting stays readable at both ends of the range', () => {
  assert.equal(formatInches(32, 32), '10" × 10"');
  assert.equal(formatInches(96, 77), '30" × 24"');
  // Under 10 inches keeps one decimal rather than collapsing to a round number.
  assert.equal(formatInches(32, 26), '10" × 8.2"');
});

test('BASEPLATE_STUDS matches the stud math it is used with', () => {
  assert.equal(BASEPLATE_STUDS, 32);
  assert.equal(physicalSize(BASEPLATE_STUDS, 1).wMm, 256);
});
