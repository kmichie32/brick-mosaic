/**
 * The files a builder actually works from.
 *
 * These live in a module rather than inline in the page for one reason: the
 * exported build map is the *only* thing standing between a preview on screen
 * and a person placing 2,304 bricks by hand. If it disagrees with the picture,
 * the build is wrong and nobody finds out until the end. Having it here means
 * it can be round-tripped in a test — parse the export back and prove it
 * reconstructs the mosaic exactly.
 */

import { toGridMap, EMPTY, EMPTY_CODE } from './mosaic.js';

/** RFC4180-ish: quote everything, double any embedded quotes. */
const cell = (v) => `"${String(v).replace(/"/g, '""')}"`;
const toCSV = (rows) => rows.map((r) => r.map(cell).join(',')).join('\n');

/** Split one CSV line, honouring quotes. */
function splitCSVLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

/**
 * Bill of materials: what to buy, by color *and* part. A textured finish needs
 * the same color as both a plate and a tile, which are two separate purchases.
 */
export function toShoppingListCSV(mosaic) {
  return toCSV([
    ['Color', 'Code', 'BrickLink color ID', 'LEGO color ID', 'Part', 'Part name', 'Quantity'],
    ...mosaic.bom.map(({ color, part, count }) =>
      [color.name, color.code, color.blId, color.legoId, part.id, part.name, count]),
  ]);
}

/** Build map: one row per stud row, a color code per column, `--` for empty. */
export function toBuildMapCSV(mosaic) {
  const grid = toGridMap(mosaic);
  const rows = [['Row', ...Array.from({ length: mosaic.cols }, (_, i) => i + 1)]];
  for (let y = 0; y < mosaic.rows; y++) rows.push([y + 1, ...grid[y]]);
  return toCSV(rows);
}

/**
 * Parse a build map back into palette indices.
 *
 * This is the verification path, not a convenience: it answers "if someone
 * follows this file exactly, do they get the picture we showed them?"
 *
 * @param {string} text
 * @param {import('./palette.js').BrickColor[]} palette
 * @returns {{cols: number, rows: number, indices: Int32Array}}
 */
export function parseBuildMapCSV(text, palette) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) throw new Error('build map has no rows');

  const byCode = new Map(palette.map((c, i) => [c.code, i]));
  byCode.set(EMPTY_CODE, EMPTY);
  const header = splitCSVLine(lines[0]);
  const cols = header.length - 1;
  const rows = lines.length - 1;
  const indices = new Int32Array(cols * rows);

  for (let y = 0; y < rows; y++) {
    const parts = splitCSVLine(lines[y + 1]);
    if (parts.length - 1 !== cols) {
      throw new Error(`row ${y + 1} has ${parts.length - 1} columns, expected ${cols}`);
    }
    for (let x = 0; x < cols; x++) {
      const code = parts[x + 1];
      const idx = byCode.get(code);
      if (idx === undefined) throw new Error(`row ${y + 1}: unknown color code "${code}"`);
      indices[y * cols + x] = idx;
    }
  }
  return { cols, rows, indices };
}

/**
 * Verify an exported build map reconstructs the mosaic exactly.
 * Returns the first mismatch rather than just a boolean, so a failure says
 * *where* the instructions diverge from the picture.
 */
export function verifyBuildMap(mosaic, csvText) {
  const parsed = parseBuildMapCSV(csvText, mosaic.palette);
  if (parsed.cols !== mosaic.cols || parsed.rows !== mosaic.rows) {
    return {
      ok: false,
      reason: `size mismatch: map is ${parsed.cols}x${parsed.rows}, mosaic is ${mosaic.cols}x${mosaic.rows}`,
    };
  }
  const codeOf = (idx) => (idx === EMPTY ? EMPTY_CODE : mosaic.palette[idx].code);
  for (let i = 0; i < mosaic.indices.length; i++) {
    if (parsed.indices[i] !== mosaic.indices[i]) {
      const x = i % mosaic.cols;
      const y = (i - x) / mosaic.cols;
      return {
        ok: false,
        reason: `row ${y + 1}, column ${x + 1}: map says ` +
          `${codeOf(parsed.indices[i])}, mosaic has ${codeOf(mosaic.indices[i])}`,
      };
    }
  }
  return { ok: true, reason: null };
}
