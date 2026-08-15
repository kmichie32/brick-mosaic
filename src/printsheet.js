/**
 * A build sheet printed at exact 1:1 scale.
 *
 * This is the cheapest way to close the gap between "a picture on a screen" and
 * "a thing made of bricks", because it can be checked before spending anything:
 *
 *   - printed at 100%, every cell is exactly one stud, so the sheet is the
 *     finished piece's true size — you can hold it against the wall
 *   - lay any bricks you already own on top and compare them to the printed
 *     swatch; that validates the palette's colors against reality for the cost
 *     of a sheet of paper
 *   - it doubles as the thing you actually build from, laid beside the baseplate
 *
 * Every page carries a 100mm calibration bar. Printers silently apply "fit to
 * page" and shrink by a few percent, which would quietly invalidate all of the
 * above — so the sheet says how to detect that.
 */

import { STUD_MM, BASEPLATE_STUDS } from './sizing.js';
import { EMPTY } from './mosaic.js';

/** Printable area after margins, in mm. */
const PAGES = {
  letter: { w: 215.9, h: 279.4, margin: 12 },
  a4:     { w: 210,   h: 297,   margin: 12 },
};

/** Vertical space reserved on each page for the header and legend. */
const CHROME_MM = 46;

/** How many studs fit on one page, given the paper. */
export function studsPerPage(paper = 'letter') {
  const p = PAGES[paper] ?? PAGES.letter;
  return {
    cols: Math.max(1, Math.floor((p.w - p.margin * 2) / STUD_MM)),
    rows: Math.max(1, Math.floor((p.h - p.margin * 2 - CHROME_MM) / STUD_MM)),
  };
}

/** How the mosaic is split across sheets. */
export function pageLayout(mosaic, paper = 'letter') {
  const per = studsPerPage(paper);
  const across = Math.ceil(mosaic.cols / per.cols);
  const down = Math.ceil(mosaic.rows / per.rows);
  return { ...per, across, down, total: across * down };
}

const esc = (s) => String(s).replace(/[<>&"]/g, (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/** Readable ink color for a code printed on top of a brick swatch. */
function inkFor(color) {
  const luma = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
  return luma > 140 ? '#1a1a1a' : '#ffffff';
}

/**
 * Render the whole build sheet as a self-contained HTML document.
 * @param {import('./mosaic.js').Mosaic} mosaic
 * @param {{paper?: 'letter'|'a4', title?: string}} [opts]
 */
export function buildPrintSheetHTML(mosaic, { paper = 'letter', title = 'Brick Mosaic' } = {}) {
  const page = PAGES[paper] ?? PAGES.letter;
  const layout = pageLayout(mosaic, paper);

  const sheets = [];
  let n = 0;
  for (let py = 0; py < layout.down; py++) {
    for (let px = 0; px < layout.across; px++) {
      n++;
      const x0 = px * layout.cols;
      const y0 = py * layout.rows;
      const x1 = Math.min(mosaic.cols, x0 + layout.cols);
      const y1 = Math.min(mosaic.rows, y0 + layout.rows);

      // Only the colors on this sheet, with their counts for this sheet.
      const counts = new Map();
      const rows = [];
      for (let y = y0; y < y1; y++) {
        const cells = [];
        for (let x = x0; x < x1; x++) {
          const idx = mosaic.indices[y * mosaic.cols + x];
          // Heavier rule where a baseplate ends, so seams are visible while building.
          const seam = [
            (x + 1) % BASEPLATE_STUDS === 0 ? 'sr' : '',
            (y + 1) % BASEPLATE_STUDS === 0 ? 'sb' : '',
          ].filter(Boolean).join(' ');

          if (idx === EMPTY) {
            // Left deliberately blank: nothing to place, nothing to buy.
            cells.push(`<td class="empty ${seam}"></td>`);
            continue;
          }
          const c = mosaic.palette[idx];
          counts.set(c.code, (counts.get(c.code) ?? 0) + 1);
          cells.push(
            `<td class="${seam}" style="background:${c.hex};color:${inkFor(c)}">${c.code}</td>`);
        }
        rows.push(`<tr><th class="rh">${y + 1}</th>${cells.join('')}</tr>`);
      }

      const colHeader = [];
      for (let x = x0; x < x1; x++) colHeader.push(`<th class="ch">${x + 1}</th>`);

      const legend = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([code, count]) => {
          const c = mosaic.palette.find((p) => p.code === code);
          return `<span class="lg"><i style="background:${c.hex}"></i>` +
            `<b>${code}</b> ${esc(c.name)} &times;${count}</span>`;
        }).join('');

      sheets.push(`
<section class="sheet">
  <header>
    <div>
      <strong>${esc(title)}</strong> &nbsp; sheet ${n} of ${layout.total}
      &nbsp;·&nbsp; rows ${y0 + 1}–${y1}, columns ${x0 + 1}–${x1}
      &nbsp;·&nbsp; full design ${mosaic.cols}&times;${mosaic.rows} studs
    </div>
    <div class="cal">
      <span class="bar"></span>
      <span>This bar must measure exactly 100&nbsp;mm. If it doesn't, reprint at
        100% scale — turn off "fit to page".</span>
    </div>
  </header>
  <table>
    <tr><th class="corner"></th>${colHeader.join('')}</tr>
    ${rows.join('\n')}
  </table>
  <footer>${legend}</footer>
</section>`);
    }
  }

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)} — build sheet</title>
<style>
  @page { size: ${paper}; margin: ${page.margin}mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #f4f1ea;
    font: 9pt/1.3 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #1a1a1a;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .sheet {
    width: ${page.w - page.margin * 2}mm;
    margin: 0 auto 8mm; padding: 0; background: #fff;
    page-break-after: always; break-after: page;
  }
  .sheet:last-child { page-break-after: auto; break-after: auto; }
  header { margin-bottom: 3mm; }
  header strong { font-size: 11pt; }
  .cal { display: flex; align-items: center; gap: 3mm; margin-top: 2mm; color: #6b6257; font-size: 7.5pt; }
  .bar { display: block; width: 100mm; height: 2.6mm; background: #1a1a1a; flex: none; }

  table { border-collapse: collapse; }
  td, th { padding: 0; margin: 0; }
  /* The load-bearing numbers: one cell is exactly one stud. */
  td {
    width: ${STUD_MM}mm; height: ${STUD_MM}mm;
    border: 0.12mm solid rgba(0,0,0,.28);
    /* 3 chars at 5pt is ~3.2mm inside an 8mm cell — small, but readable while
       you're bent over a baseplate, which is the whole job of this sheet. */
    font-size: 5pt; text-align: center; vertical-align: middle;
    font-family: ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: -0.02em;
  }
  td.empty { background: #fff; border-style: dashed; border-color: rgba(0,0,0,.18); }
  td.sr { border-right: 0.5mm solid #111; }
  td.sb { border-bottom: 0.5mm solid #111; }
  th.ch { width: ${STUD_MM}mm; font-size: 4.5pt; color: #6b6257; font-weight: 500; height: 4mm; }
  th.rh { width: 6mm; font-size: 4.5pt; color: #6b6257; font-weight: 500; text-align: right; padding-right: 0.8mm; }
  th.corner { width: 6mm; }

  footer { margin-top: 3mm; display: flex; flex-wrap: wrap; gap: 1mm 4mm; font-size: 7pt; }
  .lg { display: inline-flex; align-items: center; gap: 1.2mm; }
  .lg i { width: 3mm; height: 3mm; border: 0.15mm solid rgba(0,0,0,.35); display: inline-block; }
  @media screen { body { padding: 8mm 0; } .sheet { box-shadow: 0 2px 12px rgba(0,0,0,.15); padding: 6mm; } }

  /* The sheet opens in a bare window, so without this there is nothing to
     click and no hint that Cmd/Ctrl+P is the way to get a PDF out of it. */
  .toolbar {
    position: sticky; top: 0; z-index: 10;
    display: flex; align-items: center; gap: 4mm; flex-wrap: wrap;
    width: ${page.w - page.margin * 2}mm; margin: 0 auto 6mm;
    padding: 3mm 4mm; background: #fffdf9; border: 1px solid #e2dbcd;
    border-radius: 3mm; box-shadow: 0 2px 12px rgba(0,0,0,.10);
  }
  .toolbar button {
    font: inherit; font-weight: 700; font-size: 10pt; cursor: pointer;
    padding: 2.4mm 5mm; border: 0; border-radius: 2mm;
    background: #b6432f; color: #fff;
  }
  .toolbar .hint { color: #6b6257; font-size: 8pt; flex: 1 1 60mm; }
  @media print { .toolbar { display: none !important; } }
</style></head>
<body>
  <div class="toolbar">
    <button type="button" onclick="window.print()">Print / Save as PDF</button>
    <span class="hint">
      ${layout.total} sheet${layout.total === 1 ? '' : 's'}. To keep a copy, choose
      <strong>Save as PDF</strong> as the destination in the print dialog. Print at
      <strong>100% scale</strong> with "fit to page" off, then check the bar measures 100&nbsp;mm.
    </span>
  </div>
${sheets.join('')}</body></html>`;
}
