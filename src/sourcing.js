/**
 * Turning a mosaic into an order.
 *
 * Two jobs:
 *   1. Feasibility — does this bill of materials describe something a person
 *      can realistically buy and assemble? Piece counts are easy; the traps
 *      are the long tail of barely-used colors and the fact that baseplates
 *      don't connect to each other.
 *   2. Export — emit the Wanted List format the marketplaces import, so the
 *      shopping list is one upload rather than 20 manual searches.
 *
 * Deliberately contains no price or stock data. Those are live, per-seller,
 * and change daily; anything hardcoded here would be wrong within a week and
 * wrong in a way that costs someone money. `estimateCost` takes the
 * price-per-piece as an argument for that reason.
 */

import { PALETTE } from './palette.js';
import { buildMosaic } from './mosaic.js';
import { baseplateLayout } from './sizing.js';

/** BrickLink part IDs for the two parts a flat mosaic is normally built from. */
export const PARTS = {
  plate: { id: '3024', name: '1×1 plate', note: 'Studs visible — the classic mosaic look.' },
  tile:  { id: '3070b', name: '1×1 tile', note: 'Flat, stud-free finish. Usually pricier.' },
};

/**
 * Where these actually get bought. No affiliate links, no ranking by payout —
 * ordered by how well each fits this specific job.
 */
export const VENDORS = [
  {
    id: 'bricklink',
    name: 'BrickLink',
    url: 'https://www.bricklink.com/v2/wanted/upload.page',
    best: 'Best color range',
    detail:
      'The big secondhand marketplace. Every color below exists here, and it takes the ' +
      'Wanted List file directly — upload it, then let the cart optimizer pick sellers.',
    acceptsWantedList: true,
  },
  {
    id: 'brickowl',
    name: 'BrickOwl',
    url: 'https://www.brickowl.com/wanted_list',
    best: 'Good alternative',
    detail:
      'Smaller marketplace, same idea, often better shipping for non-US buyers. ' +
      'Also imports the BrickLink Wanted List format.',
    acceptsWantedList: true,
  },
  {
    id: 'pab',
    name: 'LEGO Pick a Brick',
    url: 'https://www.lego.com/pick-and-build/pick-a-brick',
    best: 'New parts, direct',
    detail:
      'Official and brand-new, but carries far fewer colors in 1×1 plate than BrickLink. ' +
      'Expect to substitute colors — check availability before committing to a design.',
    acceptsWantedList: false,
  },
];

// ---------------------------------------------------------------------------
// Feasibility
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} BuildWarning
 * @property {'info'|'caution'} level
 * @property {string} title
 * @property {string} detail
 */

/**
 * Sanity-check a mosaic as a *purchase and build*, not as an image.
 *
 * @param {import('./mosaic.js').Mosaic} mosaic
 * @param {{minCount?: number}} [opts] minCount = the count below which a color
 *   is "long tail": you pay a full lot's overhead (seller minimum, shipping,
 *   another package) for a handful of pieces nobody will notice.
 */
export function analyzeBuild(mosaic, { minCount = 20 } = {}) {
  const plates = baseplateLayout(mosaic.cols, mosaic.rows);
  const longTail = mosaic.bom.filter((e) => e.count < minCount);
  const longTailPieces = longTail.reduce((s, e) => s + e.count, 0);
  const biggest = mosaic.bom[0] ?? null;

  /** @type {BuildWarning[]} */
  const warnings = [];

  if (plates.total > 1) {
    warnings.push({
      level: 'caution',
      title: `${plates.total} baseplates won't clip together`,
      detail:
        `Standard baseplates have no tubes underneath, so they can't interlock. Mount the ` +
        `${plates.across}×${plates.down} grid on a backing board or frame, or build on regular ` +
        `plates joined from below instead.`,
    });
  }

  if (longTail.length > 0) {
    const pct = ((longTailPieces / mosaic.totalBricks) * 100).toFixed(1);
    warnings.push({
      level: 'caution',
      title: `${longTail.length} colors are used fewer than ${minCount} times`,
      detail:
        `They're ${pct}% of the mosaic but ${longTail.length} of ${mosaic.bom.length} separate ` +
        `lots to buy — often a seller minimum and shipping each. Merging them costs almost ` +
        `nothing visually.`,
    });
  }

  if (biggest && biggest.count > 1000) {
    warnings.push({
      level: 'info',
      title: `${biggest.count.toLocaleString()} pieces of ${biggest.color.name}`,
      detail:
        `Above about a thousand of one color you may clear out a single seller. Check ` +
        `available quantity before ordering, or plan on splitting across sellers.`,
    });
  }

  if (mosaic.totalBricks > 8000) {
    warnings.push({
      level: 'info',
      title: `${mosaic.totalBricks.toLocaleString()} pieces is a big build`,
      detail:
        `Placing them one at a time is a long project. Worth a smaller size for a first ` +
        `attempt unless you know what you're signing up for.`,
    });
  }

  return {
    lots: mosaic.bom.length,
    longTail,
    longTailPieces,
    baseplates: plates,
    warnings,
  };
}

/**
 * Cost estimate. Takes price-per-piece as an argument on purpose — real prices
 * depend on color, condition, seller and the day, so this is arithmetic the
 * caller supplies the rate for, not a quote.
 *
 * @param {import('./mosaic.js').Mosaic} mosaic
 * @param {number} pricePerPiece
 * @param {{shippingPerLot?: number}} [opts]
 */
export function estimateCost(mosaic, pricePerPiece, { shippingPerLot = 0 } = {}) {
  const pieces = mosaic.totalBricks * pricePerPiece;
  const shipping = mosaic.bom.length * shippingPerLot;
  return { pieces, shipping, total: pieces + shipping };
}

// ---------------------------------------------------------------------------
// Palette simplification
// ---------------------------------------------------------------------------

const reindex = (colors) => colors.map((c, index) => ({ ...c, index }));

/**
 * Rebuild the mosaic without its long-tail colors.
 *
 * Rather than reassigning stray cells after the fact, this drops the rare
 * colors from the palette and re-runs the whole pipeline. That lets dithering
 * compensate with the colors that remain, which looks markedly better than
 * snapping orphaned cells to a neighbour.
 *
 * Iterates, because removing colors redistributes their cells and can push a
 * previously-fine color below the threshold.
 *
 * @param {import('./mosaic.js').RGBAImage} img
 * @param {import('./mosaic.js').MosaicOptions} options
 * @param {{minCount?: number, minColors?: number, maxPasses?: number}} [opts]
 */
export function buildBuyableMosaic(img, options, { minCount = 20, minColors = 6, maxPasses = 4 } = {}) {
  let palette = options.palette ?? PALETTE;
  let mosaic = buildMosaic(img, { ...options, palette });

  const initialColors = new Set(mosaic.bom.map((e) => e.color.code)).size;
  const dropped = [];
  let passes = 0;

  for (let pass = 0; pass < maxPasses; pass++) {
    // The BOM is keyed by color *and* part, so a textured design lists the same
    // color twice. Rarity is a property of the color -- 15 plates plus 15 tiles
    // of one color is 30 of that color to source, not two rare lots.
    const byColor = new Map();
    for (const e of mosaic.bom) {
      byColor.set(e.color.code, {
        color: e.color,
        count: (byColor.get(e.color.code)?.count ?? 0) + e.count,
      });
    }
    const totals = [...byColor.values()].sort((a, b) => b.count - a.count);

    const rare = totals.filter((e) => e.count < minCount);
    if (rare.length === 0) break;

    let keep = totals.filter((e) => e.count >= minCount).map((e) => e.color);
    // Never simplify below a usable palette -- for a low-contrast photo the
    // threshold can otherwise eat almost everything.
    if (keep.length < minColors) keep = totals.slice(0, minColors).map((e) => e.color);
    if (keep.length >= palette.length) break;   // nothing left to remove

    dropped.push(...rare.map((e) => ({ color: e.color, count: e.count })));
    palette = reindex(keep);
    mosaic = buildMosaic(img, { ...options, palette });
    passes = pass + 1;
  }

  return { mosaic, dropped, passes, initialColors };
}

// ---------------------------------------------------------------------------
// Wanted List export
// ---------------------------------------------------------------------------

const xmlEscape = (s) =>
  String(s).replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

/**
 * BrickLink Wanted List XML. This is the format behind
 * bricklink.com/v2/wanted/upload.page, and BrickOwl imports it too.
 *
 * COLOR is the BrickLink color ID (not LEGO's), ITEMID is the part number,
 * MINQTY is how many you want. CONDITION is omitted deliberately: pinning it
 * to New roughly halves the available lots and raises the price, and for a
 * mosaic that gets glued or framed, used pieces are fine.
 *
 * @param {import('./mosaic.js').Mosaic} mosaic
 * @param {{partId?: string, notify?: boolean}} [opts]
 */
export function toWantedListXML(mosaic, { partId = null, notify = false } = {}) {
  const items = mosaic.bom.map(({ color, part, count }) =>
    [
      '  <ITEM>',
      '    <ITEMTYPE>P</ITEMTYPE>',
      // Each BOM line already knows its own part -- a textured design needs the
      // same color as both a plate and a tile. `partId` overrides for callers
      // that want the whole design in one part.
      `    <ITEMID>${xmlEscape(partId ?? part?.id ?? PARTS.plate.id)}</ITEMID>`,
      `    <COLOR>${color.blId}</COLOR>`,
      `    <MINQTY>${count}</MINQTY>`,
      `    <NOTIFY>${notify ? 'Y' : 'N'}</NOTIFY>`,
      `    <REMARKS>${xmlEscape(color.name)}</REMARKS>`,
      '  </ITEM>',
    ].join('\n'));

  return `<?xml version="1.0" encoding="UTF-8"?>\n<INVENTORY>\n${items.join('\n')}\n</INVENTORY>\n`;
}
