/**
 * Turning stud counts into things a person can picture: inches on the wall,
 * and how many baseplates they need to buy.
 */

/** Stud pitch. LEGO's module is exactly 8mm, so this is not an approximation. */
export const STUD_MM = 8;

/** A standard baseplate is 32x32 studs (256mm / ~10.1in). */
export const BASEPLATE_STUDS = 32;

const MM_PER_INCH = 25.4;

/** Physical dimensions of a grid, in mm and inches. */
export function physicalSize(cols, rows) {
  const wMm = cols * STUD_MM;
  const hMm = rows * STUD_MM;
  return {
    wMm, hMm,
    wIn: wMm / MM_PER_INCH,
    hIn: hMm / MM_PER_INCH,
  };
}

/**
 * How the design tiles across baseplates. The last plate in each direction is
 * usually partial -- that's fine, you trim the design to it, but the buyer
 * still needs a whole plate.
 */
export function baseplateLayout(cols, rows) {
  const across = Math.ceil(cols / BASEPLATE_STUDS);
  const down = Math.ceil(rows / BASEPLATE_STUDS);
  return { across, down, total: across * down };
}

/** Aspect ratio choices offered in the UI. */
export const ASPECTS = [
  { id: 'square',    label: 'Square',    w: 1, h: 1 },
  { id: 'portrait',  label: 'Portrait',  w: 4, h: 5 },
  { id: 'landscape', label: 'Landscape', w: 5, h: 4 },
];

/**
 * Size tiers, expressed as studs along the long edge.
 *
 * The blurbs describe what will actually *read* at each size, not where the
 * finished piece goes on a wall. Detail scales with stud count, and people
 * consistently pick too small: a face needs roughly 30 studs across to show
 * eyes and a mouth, so a whole person in a 32-stud frame is a silhouette.
 */
export const SIZES = [
  { id: 'small',  label: 'Small',  studs: 32, blurb: 'Logos and bold shapes' },
  { id: 'medium', label: 'Medium', studs: 48, blurb: 'One face, filling the frame' },
  { id: 'large',  label: 'Large',  studs: 64, blurb: 'A face with real detail' },
  { id: 'huge',   label: 'Huge',   studs: 96, blurb: 'Two people, or fine detail' },
];

/**
 * Resolve an aspect + size tier into a stud grid.
 * The long edge gets the tier's stud count; the short edge is scaled to match.
 */
export function resolveGrid(aspect, sizeStuds) {
  const long = sizeStuds;
  if (aspect.w >= aspect.h) {
    return { cols: long, rows: Math.max(1, Math.round((long * aspect.h) / aspect.w)) };
  }
  return { cols: Math.max(1, Math.round((long * aspect.w) / aspect.h)), rows: long };
}

/** "15\" x 15\"" -- rounded the way a person would say it out loud. */
export function formatInches(cols, rows) {
  const { wIn, hIn } = physicalSize(cols, rows);
  const r = (v) => (v < 10 ? v.toFixed(1) : Math.round(v));
  return `${r(wIn)}" × ${r(hIn)}"`;
}
