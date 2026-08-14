/**
 * Brick color palette.
 *
 * 44 solid (opaque, non-transparent, non-metallic) LEGO colors that are widely
 * available as 1x1 plates/tiles on BrickLink. `code` is the short label printed
 * on the grid map; `legoId` is LEGO's own color ID; `blId` is the BrickLink
 * color ID (what you'd actually filter by when sourcing parts).
 *
 * !! RGB values are the commonly-published approximations of each color, not
 * measured values from physical bricks. They're good enough for matching, but
 * verify against BrickLink before shipping a BOM that people buy from.
 */

import { hexToRgb, rgbToLab } from './color.js';

/** @typedef {{code: string, name: string, hex: string, legoId: number, blId: number}} BrickColorSpec */

/** @type {BrickColorSpec[]} */
const SPECS = [
  // Neutrals
  { code: 'WHT', name: 'White',                hex: '#FFFFFF', legoId: 1,   blId: 1   },
  // The palette's only low-chroma color in the L*80-97 band. Without it the
  // nearest match for a plain wall, an overcast sky, or white fur in shadow is
  // Lavender or Sand Green at delta-E 10-16 -- which is why those surfaces came
  // out speckled lilac and sage. With it, the same targets land under delta-E 4.
  { code: 'VLG', name: 'Very Light Bluish Gray', hex: '#E6E3DA', legoId: 208, blId: 99 },
  { code: 'LBG', name: 'Light Bluish Gray',    hex: '#A0A5A9', legoId: 194, blId: 86  },
  { code: 'DBG', name: 'Dark Bluish Gray',     hex: '#6C6E68', legoId: 199, blId: 85  },
  { code: 'LGR', name: 'Light Gray',           hex: '#9BA19D', legoId: 2,   blId: 9   },
  { code: 'DGR', name: 'Dark Gray',            hex: '#6D6E5C', legoId: 27,  blId: 10  },
  { code: 'BLK', name: 'Black',                hex: '#05131D', legoId: 26,  blId: 11  },

  // Reds / pinks
  { code: 'RED', name: 'Red',                  hex: '#C91A09', legoId: 21,  blId: 5   },
  { code: 'DRD', name: 'Dark Red',             hex: '#720E0F', legoId: 154, blId: 59  },
  { code: 'SRD', name: 'Sand Red',             hex: '#D67572', legoId: 153, blId: 58  },
  { code: 'COR', name: 'Coral',                hex: '#FF698F', legoId: 353, blId: 220 },
  { code: 'BPK', name: 'Bright Pink',          hex: '#E4ADC8', legoId: 222, blId: 104 },
  { code: 'DPK', name: 'Dark Pink',            hex: '#C870A0', legoId: 221, blId: 47  },
  { code: 'MAG', name: 'Magenta',              hex: '#923978', legoId: 124, blId: 71  },

  // Oranges / yellows / tans
  { code: 'ORA', name: 'Orange',               hex: '#FE8A18', legoId: 106, blId: 4   },
  { code: 'DOR', name: 'Dark Orange',          hex: '#A95500', legoId: 38,  blId: 68  },
  { code: 'MOR', name: 'Medium Orange',        hex: '#FFA70B', legoId: 105, blId: 31  },
  { code: 'BLO', name: 'Bright Light Orange',  hex: '#F8BB3D', legoId: 191, blId: 110 },
  { code: 'YEL', name: 'Yellow',               hex: '#F2CD37', legoId: 24,  blId: 3   },
  { code: 'BLY', name: 'Bright Light Yellow',  hex: '#FFF03A', legoId: 226, blId: 103 },
  { code: 'TAN', name: 'Tan',                  hex: '#E4CD9E', legoId: 5,   blId: 2   },
  { code: 'DTN', name: 'Dark Tan',             hex: '#958A73', legoId: 138, blId: 69  },
  { code: 'LNG', name: 'Light Nougat',         hex: '#F6D7B3', legoId: 283, blId: 90  },
  { code: 'NOU', name: 'Nougat',               hex: '#D09168', legoId: 18,  blId: 28  },
  { code: 'MNG', name: 'Medium Nougat',        hex: '#AA7D55', legoId: 84,  blId: 150 },
  { code: 'RBR', name: 'Reddish Brown',        hex: '#582A12', legoId: 192, blId: 88  },
  { code: 'DBR', name: 'Dark Brown',           hex: '#352100', legoId: 308, blId: 120 },

  // Greens
  { code: 'LIM', name: 'Lime',                 hex: '#BBE90B', legoId: 119, blId: 34  },
  { code: 'YGR', name: 'Yellowish Green',      hex: '#DFEEA5', legoId: 326, blId: 158 },
  { code: 'OLV', name: 'Olive Green',          hex: '#9B9A5A', legoId: 330, blId: 155 },
  { code: 'BGR', name: 'Bright Green',         hex: '#4B9F4A', legoId: 37,  blId: 36  },
  { code: 'GRN', name: 'Green',                hex: '#237841', legoId: 28,  blId: 6   },
  { code: 'DGN', name: 'Dark Green',           hex: '#184632', legoId: 141, blId: 80  },
  { code: 'SGR', name: 'Sand Green',           hex: '#A0BCAC', legoId: 151, blId: 48  },
  { code: 'DTQ', name: 'Dark Turquoise',       hex: '#008F9B', legoId: 107, blId: 39  },

  // Blues
  { code: 'MAZ', name: 'Medium Azure',         hex: '#36AEBF', legoId: 322, blId: 156 },
  { code: 'DAZ', name: 'Dark Azure',           hex: '#078BC9', legoId: 321, blId: 153 },
  { code: 'BLB', name: 'Bright Light Blue',    hex: '#9FC3E9', legoId: 212, blId: 105 },
  { code: 'MBL', name: 'Medium Blue',          hex: '#5A93DB', legoId: 102, blId: 42  },
  { code: 'BLU', name: 'Blue',                 hex: '#0055BF', legoId: 23,  blId: 7   },
  { code: 'DBL', name: 'Dark Blue',            hex: '#0A3463', legoId: 140, blId: 63  },
  { code: 'SBL', name: 'Sand Blue',            hex: '#6074A1', legoId: 135, blId: 55  },

  // Purples
  { code: 'LAV', name: 'Lavender',             hex: '#C9CAE2', legoId: 325, blId: 154 },
  { code: 'MLV', name: 'Medium Lavender',      hex: '#A06EB9', legoId: 324, blId: 157 },
  { code: 'PUR', name: 'Purple',               hex: '#81007B', legoId: 22,  blId: 24  },
  { code: 'DPU', name: 'Dark Purple',          hex: '#3F3691', legoId: 268, blId: 89  },
];

/**
 * @typedef {BrickColorSpec & {
 *   r: number, g: number, b: number,
 *   L: number, A: number, B: number,
 *   index: number
 * }} BrickColor
 */

/** Full palette, with RGB and LAB precomputed. @type {BrickColor[]} */
export const PALETTE = SPECS.map((spec, index) => {
  const [r, g, b] = hexToRgb(spec.hex);
  const [L, A, B] = rgbToLab(r, g, b);
  return { ...spec, r, g, b, L, A, B, index };
});

/** Grayscale-only subset -- useful for testing and for monochrome portraits. */
export const GRAYSCALE_CODES = ['WHT', 'LBG', 'DBG', 'BLK'];

/** Build a working palette from a list of color codes. */
export function paletteFromCodes(codes) {
  const wanted = new Set(codes);
  return PALETTE.filter((c) => wanted.has(c.code)).map((c, index) => ({ ...c, index }));
}
