/**
 * Renders the social preview card (og:image) to assets/og-image.png.
 *
 *   node scripts/ogimage.mjs
 *
 * The card shows the actual transformation — source photo on the left, the
 * quantized mosaic on the right — and both panels come from the real pipeline
 * rather than being drawn by hand. So the preview always shows what the tool
 * genuinely outputs, and regenerating it re-runs the same quantizer.
 *
 * 1200x630 is the size every platform crops from.
 *
 * There is no font rasteriser here and pulling one in for a two-word wordmark
 * would cost more than the card is worth, so FONT below is a 5x7 bitmap. An
 * earlier version drew grey bars where the words go, which read as a broken
 * loading skeleton rather than a design.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildMosaic, renderToRGBA } from '../src/mosaic.js';
import { encodePNG } from './png.mjs';

const W = 1200, H = 630;
const OUT = resolve(new URL('../assets/og-image.png', import.meta.url).pathname);

const BG    = [251, 247, 240];   // --paper
const INK   = [36, 31, 26];      // --ink
const MUTED = [111, 100, 89];    // --muted
const BRAND = [216, 52, 43];     // --brand

/** 5x7 bitmap, uppercase only — every glyph this card actually needs. */
const FONT = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
};

const img = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
const px = (x, y, [r, g, b]) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const p = (y * W + x) * 4;
  img.data[p] = r; img.data[p + 1] = g; img.data[p + 2] = b; img.data[p + 3] = 255;
};
const rect = (x, y, w, h, c) => {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) px(i, j, c);
};
const roundRect = (x, y, w, h, r, c) => {
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const dx = Math.min(i, w - 1 - i), dy = Math.min(j, h - 1 - j);
      if (dx < r && dy < r && Math.hypot(r - dx, r - dy) > r) continue;
      px(x + i, y + j, c);
    }
  }
};

/** Draw text at `scale` px per font pixel. Returns the width drawn. */
function text(str, x, y, scale, color) {
  let cx = x;
  for (const ch of str.toUpperCase()) {
    const glyph = FONT[ch] ?? FONT[' '];
    glyph.forEach((row, ry) => {
      [...row].forEach((on, rx) => {
        if (on === '#') rect(cx + rx * scale, y + ry * scale, scale, scale, color);
      });
    });
    cx += 6 * scale;               // 5 wide + 1 of tracking
  }
  return cx - x;
}

rect(0, 0, W, H, BG);

// A subject with clear light/dark separation, so the quantized panel reads as
// a mosaic at card size instead of mush.
const SRC = 360;
const scene = { width: SRC, height: SRC, data: new Uint8ClampedArray(SRC * SRC * 4) };
for (let y = 0; y < SRC; y++) {
  for (let x = 0; x < SRC; x++) {
    const t = y / SRC;
    let r = 58 + t * 120, g = 108 + t * 96, b = 176 - t * 26;   // sky
    const d = Math.hypot(x - SRC * 0.5, y - SRC * 0.56);
    if (d < SRC * 0.3) {                                        // sunlit sphere
      const nz = Math.sqrt(Math.max(0, 1 - (d / (SRC * 0.3)) ** 2));
      const lit = Math.max(0, ((SRC * 0.5 - x) * 0.4 + (SRC * 0.56 - y) * 0.5) / (SRC * 0.3) + nz * 0.85);
      r = 46 + lit * 205; g = 30 + lit * 150; b = 24 + lit * 120;
    }
    const hill = SRC * 0.84 + Math.sin(x / 30) * SRC * 0.03;
    if (y > hill) { r = 30; g = 62; b = 48; }
    const p = (y * SRC + x) * 4;
    scene.data[p] = r; scene.data[p + 1] = g; scene.data[p + 2] = b; scene.data[p + 3] = 255;
  }
}

const GRID = 30, CELL = 9;
const mosaic = buildMosaic(scene, { cols: GRID, rows: GRID, dither: 'floyd-steinberg' });
const tile = renderToRGBA(mosaic, { cellSize: CELL });
const PANEL = GRID * CELL;                       // both panels are square, same size

/** Nearest-neighbour blow-up of the source to match the mosaic panel. */
function sourcePanel(size) {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    const sy = Math.floor((y * SRC) / size);
    for (let x = 0; x < size; x++) {
      const sx = Math.floor((x * SRC) / size);
      const s = (sy * SRC + sx) * 4, d = (y * size + x) * 4;
      out[d] = scene.data[s]; out[d + 1] = scene.data[s + 1]; out[d + 2] = scene.data[s + 2];
    }
  }
  return out;
}
const src = sourcePanel(PANEL);

// --- layout ----------------------------------------------------------------
const PAD = 16;                                   // white frame around a panel
const GAP = 84;                                   // room for the arrow between
const totalW = (PANEL + PAD * 2) * 2 + GAP;
const x0 = Math.round((W - totalW) / 2);
const y0 = 250;

const drawPanel = (x, pixels) => {
  roundRect(x, y0, PANEL + PAD * 2, PANEL + PAD * 2, 20, [255, 255, 255]);
  for (let y = 0; y < PANEL; y++) {
    for (let i = 0; i < PANEL; i++) {
      const s = (y * PANEL + i) * 4;
      px(x + PAD + i, y0 + PAD + y, [pixels[s], pixels[s + 1], pixels[s + 2]]);
    }
  }
};
drawPanel(x0, src);
drawPanel(x0 + PANEL + PAD * 2 + GAP, tile.data);

// Arrow between the two panels: shaft plus a triangular head.
const ax = x0 + PANEL + PAD * 2 + 22;
const ay = y0 + (PANEL + PAD * 2) / 2;
rect(ax, ay - 3, 26, 6, MUTED);
for (let i = 0; i < 15; i++) rect(ax + 26 + i, ay - 15 + i, 1, 30 - i * 2, MUTED);

// --- wordmark --------------------------------------------------------------
const S = 7;                                       // font scale for the title
const title = 'BRICK MOSAIC';
const titleW = title.length * 6 * S - S;
const brickW = 74;
const blockW = brickW + 26 + titleW;
const bx = Math.round((W - blockW) / 2);
const by = 92;

// The header brick, same proportions as the one in the app.
roundRect(bx + 9, by + 2, 18, 13, 5, BRAND);
roundRect(bx + 46, by + 2, 18, 13, 5, BRAND);
roundRect(bx, by + 14, brickW, 50, 10, BRAND);
rect(bx, by + 52, brickW, 12, [188, 40, 32]);

text(title, bx + brickW + 26, by + 16, S, INK);

const sub = 'PHOTO IN  BUILDABLE BRICKS OUT';
const subW = sub.length * 6 * 3 - 3;
text(sub, Math.round((W - subW) / 2), by + 82, 3, MUTED);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, encodePNG(img));
console.log(`${W}x${H} -> ${OUT}  (${mosaic.bom.length} colors, ${mosaic.totalBricks} bricks)`);
