/**
 * Visual smoke test: renders a synthetic "photo" through the pipeline and
 * writes a side-by-side PNG (source | flat quantization | Floyd-Steinberg).
 *
 *   node scripts/preview.mjs [grid] [out.png]
 */
import { writeFileSync } from 'node:fs';
import { buildMosaic, renderToRGBA } from '../src/mosaic.js';
import { encodePNG } from './png.mjs';

const GRID = Number(process.argv[2] || 64);
const OUT = process.argv[3] || 'preview.png';
const SRC = 512;
const CELL = 10;

/**
 * Synthetic scene chosen to stress the parts of the pipeline that matter:
 * a smooth sky gradient (banding), a shaded sphere in skin tones (the classic
 * hard case for a ~40 color palette), and hard-edged silhouettes.
 */
function scene(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  const put = (x, y, r, g, b) => {
    const p = (y * w + x) * 4;
    data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
  };

  for (let y = 0; y < h; y++) {
    const t = y / h;
    for (let x = 0; x < w; x++) {
      // Sky: deep blue at the top easing into a warm horizon.
      let r = 30 + t * 225;
      let g = 60 + t * 130;
      let b = 130 - t * 40;

      // Sun with a soft falloff.
      const sd = Math.hypot(x - w * 0.68, y - h * 0.34);
      if (sd < w * 0.09) { r = 255; g = 245; b = 200; }
      else if (sd < w * 0.26) {
        const k = 1 - (sd - w * 0.09) / (w * 0.17);
        r += (255 - r) * k * 0.8; g += (220 - g) * k * 0.7; b += (150 - b) * k * 0.4;
      }

      // Foreground sphere, skin-toned, lit from the upper left.
      const cx = w * 0.34, cy = h * 0.62, rad = w * 0.22;
      const dx = x - cx, dy = y - cy;
      const d = Math.hypot(dx, dy);
      if (d < rad) {
        const nz = Math.sqrt(Math.max(0, 1 - (d / rad) ** 2));
        const lit = Math.max(0, (-dx * 0.5 - dy * 0.5) / rad + nz * 0.8);
        r = 40 + lit * 215; g = 25 + lit * 165; b = 20 + lit * 140;
      }

      // Hills: hard silhouette edges against the gradient.
      const hill = h * 0.80 + Math.sin(x / 46) * h * 0.035 + Math.sin(x / 13) * h * 0.012;
      if (y > hill) { r = 22; g = 34; b = 30; }

      put(x, y, r, g, b);
    }
  }
  return { width: w, height: h, data };
}

/** Nearest-neighbour blow-up of the source, for a like-sized comparison panel. */
function upscaleSource(img, size) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    const sy = Math.floor((y * img.height) / size);
    for (let x = 0; x < size; x++) {
      const sx = Math.floor((x * img.width) / size);
      const s = (sy * img.width + sx) * 4;
      const d = (y * size + x) * 4;
      data[d] = img.data[s]; data[d + 1] = img.data[s + 1];
      data[d + 2] = img.data[s + 2]; data[d + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

function hstack(panels, gap = 12) {
  const height = Math.max(...panels.map((p) => p.height));
  const width = panels.reduce((s, p) => s + p.width, 0) + gap * (panels.length - 1);
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  let ox = 0;
  for (const p of panels) {
    for (let y = 0; y < p.height; y++) {
      for (let x = 0; x < p.width; x++) {
        const s = (y * p.width + x) * 4;
        const d = (y * width + ox + x) * 4;
        data[d] = p.data[s]; data[d + 1] = p.data[s + 1];
        data[d + 2] = p.data[s + 2]; data[d + 3] = 255;
      }
    }
    ox += p.width + gap;
  }
  return { width, height, data };
}

const src = scene(SRC, SRC);
const size = GRID * CELL;

const flat = buildMosaic(src, { cols: GRID, rows: GRID, dither: 'none' });
const dith = buildMosaic(src, { cols: GRID, rows: GRID, dither: 'floyd-steinberg' });

writeFileSync(
  OUT,
  encodePNG(
    hstack([
      upscaleSource(src, size),
      renderToRGBA(flat, { cellSize: CELL }),
      renderToRGBA(dith, { cellSize: CELL }),
    ]),
  ),
);

const report = (label, m) => {
  console.log(
    `${label.padEnd(16)} colors=${String(new Set(m.indices).size).padStart(2)}/${m.palette.length}` +
      `  meanDeltaE=${m.meanError.toFixed(2).padStart(5)}` +
      `  top3=${m.bom.slice(0, 3).map((e) => `${e.color.code}:${e.count}`).join(' ')}`,
  );
};

console.log(`grid ${GRID}x${GRID} (${flat.totalBricks} bricks)  ->  ${OUT}`);
report('flat', flat);
report('floyd-steinberg', dith);
