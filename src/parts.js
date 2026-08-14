/**
 * The physical part each stud is made from.
 *
 * Two reasons this exists beyond "1x1 plate":
 *
 *   - **Texture as definition.** Tiles are smooth and plates are studded. Using
 *     one for the subject and the other for the background reads as a real edge
 *     under raking light, for zero extra pieces. It's the cheapest way to get
 *     the "raised" look without doubling the piece count for a second layer.
 *   - **Not building the background at all.** A background is usually most of
 *     the bricks and most of the cost. `none` leaves those studs empty, so you
 *     buy the subject and nothing else.
 */

/** @typedef {'plate'|'tile'|'none'} PartKind */

export const PART_KINDS = {
  plate: { kind: 'plate', id: '3024',  name: '1×1 plate', studs: true,  blurb: 'Studs showing' },
  tile:  { kind: 'tile',  id: '3070b', name: '1×1 tile',  studs: false, blurb: 'Smooth, no studs' },
  none:  { kind: 'none',  id: null,    name: 'No brick',  studs: false, blurb: 'Left empty' },
};

/** Default: everything is a plate, which is what a plain mosaic has always been. */
export const DEFAULT_FINISH = { subject: 'plate', background: 'plate' };

/** Resolve a finish spec, tolerating partial or unknown input. */
export function resolveFinish(finish) {
  const pick = (v, fallback) => (PART_KINDS[v] ? v : fallback);
  return {
    subject: pick(finish?.subject, DEFAULT_FINISH.subject),
    background: pick(finish?.background, DEFAULT_FINISH.background),
  };
}

/** Presets offered in the UI. */
export const FINISH_PRESETS = [
  {
    id: 'all-plates',
    name: 'All studs',
    blurb: 'The classic look, one part to buy',
    finish: { subject: 'plate', background: 'plate' },
  },
  {
    id: 'texture',
    name: 'Textured',
    blurb: 'Smooth background, studded subject — adds definition for free',
    finish: { subject: 'plate', background: 'tile' },
  },
  {
    id: 'subject-only',
    name: 'Subject only',
    blurb: 'Skip the background entirely and buy far fewer bricks',
    finish: { subject: 'plate', background: 'none' },
  },
];
