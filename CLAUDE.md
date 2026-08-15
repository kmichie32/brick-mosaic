# Brick Mosaic — working notes

Turns a photo into a buildable brick mosaic: a preview, a bill of materials, and
the files you order and build from. Aimed at families and hobbyists, not
engineers. Read `README.md` for the reasoning behind each decision; this file is
the short version plus the things that are easy to break.

## Commands

```bash
npm test        # 120 tests, node:test, no dependencies
npm run serve   # dev server on :5173 — see the caching note below
npm run preview # renders preview.png in Node: source | flat | dithered
```

Two front ends over one pipeline:
- `index.html` — the product. Four steps: photo → frame → look → build list.
- `harness.html` — every knob exposed, live timings, mean ΔE. For tuning, not humans.

**Always use `npm run serve`, never `python3 -m http.server`.** Python sends no
cache headers, so browsers cache the ES modules and you end up testing stale
code while the page looks updated. `scripts/serve.mjs` sends `no-store`. This
wasted real time before it was fixed.

## Architecture

Everything in `src/` is plain ES modules with **no DOM access**, so the same code
runs in the browser and in Node. That is what makes the test suite possible and
keeps the client-vs-server decision open. Don't reach for `document` in `src/`.

| Module | Job |
| --- | --- |
| `color.js` | sRGB transfer function, CIELAB, ΔE |
| `palette.js` | 46 solid brick colors with BrickLink + LEGO IDs |
| `mosaic.js` | The pipeline: downsample → tone → background → quantize → BOM |
| `backdrop.js` | Automatic subject/background separation, replacement backdrops |
| `outline.js` | Hand-drawn outline: closed loops, even-odd fill |
| `trace.js` | Sobel edge map, magnetic snap, resample, smooth |
| `parts.js` | Plate / tile / no-brick per region |
| `sizing.js` | Studs ↔ inches, baseplate tiling, size presets |
| `sourcing.js` | Feasibility checks, palette simplification, Wanted List XML |
| `exports.js` | CSVs, and the round-trip proof the map rebuilds the preview |
| `printsheet.js` | True-size printable sheets with a calibration bar |

## Things that look wrong but are deliberate

Each of these was arrived at from a real failure. Changing one back will
reintroduce a bug that took a while to find.

- **Dither strength defaults to 0.55, not 1.0.** Full strength pushes chromatic
  error into flat areas and speckles a clear sky with magenta.
- **Uniform areas are not dithered at all** (`flatGuard`). Dithering a painted
  wall doesn't prevent banding — there is no band — it manufactures a
  checkerboard. This *raises* per-cell ΔE while looking much better, so **ΔE is
  not a quality metric here.**
- **Empty studs are `indices[i] === EMPTY` (-1)**, not a color. They aren't
  counted, aren't bought, and print blank.
- **The BOM is keyed by color *and* part.** A textured design needs the same
  color as both a plate and a tile — two separate lots to order.
- **`buildMosaic` throws on non-finite tone options.** A `NaN` used to sail
  through, poison every cell, and render the whole mosaic as palette index 0 —
  a silently blank picture. Fail loudly instead.
- **A failed background separation leaves the photo completely untouched.** A
  canvas of pure backdrop is the worst output this code can produce.

## The separation problem (read before touching `backdrop.js`)

Automatic subject/background separation is the hardest part and has failed three
distinct ways. The current guards exist for specific photos:

1. A subject **filling a corner** made its own color "background" and the flood
   ran away across the frame.
2. A **tuxedo cat**: the white bib owns the centre, so the *black fur* reads as a
   minority there and slips in as background. The flood enters from the bottom
   edge, where the body runs out of frame, and erases him.

For (2), two plausible fixes failed and are worth not retrying:
- *Exclude colors that dominate the centre* — the bib dominates, not the fur.
- *Flood each candidate alone, reject ones reaching the middle* — alone the fur
  reaches 0% of the centre; the bib blocks it. Yet wall + fur + cabinet together
  cover 78% where individually they cover 21/27/12%. **The damage is emergent
  from the combination**, so no per-color test predicts it.

What works is checking the **outcome**: a photo has one subject, so a correct
mask leaves one coherent island. That failure left twelve. `foregroundIslands()`
is the guard.

**The product answer is the traced outline, not a better heuristic.** Automatic
detection is a starting guess; the user draws. Keep it that way.

## Verified vs. assumed

Verified in tests: the exported build map reconstructs the preview pixel for
pixel; print cells are exactly `STUD_MM`; quantities always sum to the piece
count; empty studs never leak into the shopping list.

**Not yet verified against reality** — flag these before anyone spends money:
- **Palette RGB values** are published approximations, not measured bricks, and
  this is now quantified — see `docs/palette-sources.md`. Rebrickable is 43/46
  byte-identical to us (same ancestor, not a check). LDraw disagrees by **mean
  ΔE 13.0**, with 40 of 45 shared colors over ΔE 5. That's about twice the
  spacing between the palette's own closest neighbours (4.80), so **the source
  you trust can change which brick a pixel maps to** — preview accuracy is
  capped here, not by the algorithm. **Don't re-point the palette at LDraw**;
  that trades one unmeasured guess for another and changes every design. Only
  photographing real bricks settles it.
- **Cart totals.** Costs come from price-guide averages, never from a real cart,
  so per-seller shipping is still unmodelled.

Validated against BrickLink on 2026-08-14 — see `docs/bricklink-validation.md`:
- **The Wanted List XML imports.** Uploaded to the real page: it parsed, and all
  **15/15 color ids** resolved to the colors named in `<REMARKS>`. The upload
  page wants XML *pasted*, not a file — which is why the build list leads with a
  copy button and offers download second. Don't reverse that.
- **Part-color availability** is no longer assumed. All 46 colors exist as 1×1
  plate (3024), and supply dwarfs what a mosaic needs.
- **`$0.06`/piece is a bad estimate, not a slightly-off one.** Real prices run
  $0.02–$0.27 depending on color. It happens to land within 20% on a typical
  design because the overestimate on common colors cancels the underestimate on
  scarce ones. It also ignores shipping, which is per-seller and material.
- **Sourcing it yourself costs ~2.5× a prepackaged kit.** Brick Me sells the
  identical 15×15, 2304-brick design for $59.99 including baseplates and
  instructions; the same thing on BrickLink is ~$140–165. They manufacture
  LEGO-compatible bricks in bulk, this buys genuine LEGO secondhand at
  marketplace retail — a supply-chain gap, not a sourcing mistake. **Never imply
  this route saves money.** The build list is framed inventory-first ("check what
  you already have", *then* price the rest) for exactly this reason. What's
  actually true: free if you own the bricks, genuine LEGO, your choice of parts,
  the photo never leaves the browser, and sizes nobody sells.
- **The palette contains a price trap.** It carries the pre-2004 grays *and*
  their modern replacements. Light Gray/Light Bluish Gray (ΔE 4.80) and Dark
  Gray/Dark Bluish Gray (ΔE 7.10) are the two closest pairs in the whole
  palette, and the legacy half costs 5–7× more. Quantization has no cost input,
  so the choice between them turns on a difference no one can see. Left alone
  deliberately: every fix changes output for every design.

## Testing

`node:test`, no framework, no dependencies. Tests are named as claims about
behaviour and carry a comment explaining *why* when the reasoning isn't obvious.

When a test fails after a deliberate change, work out whether the test or the
code is wrong — several here encode trades that were reconsidered on purpose,
and at least one previously "failing" test turned out to be testing a scenario
that didn't represent the case it claimed to (a bare band across the bottom of
frame is a floor, not shoulders).
