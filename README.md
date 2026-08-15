# Brick Mosaic

Photo in → brick-color grid out, plus the shopping list to actually build it.

```bash
npm test              # 131 tests, no dependencies
npm run preview       # renders preview.png: source | flat | dithered
npm run serve         # http://localhost:5173
```

Two front ends over the same pipeline:

- **`index.html`** — the real thing. A four-step flow: choose a photo → frame it
  (drag/zoom, three shapes, four sizes) → pick a look → build list. Four style
  presets do the color work; the brightness/contrast/punch sliders are folded
  away under "Fine-tune" for anyone who wants them.
- **`harness.html`** — every knob exposed, live timings, mean ΔE. For tuning the
  pipeline, not for humans choosing a photo of their dog.

Zero dependencies, zero build step. Everything under `src/` is plain ES modules
with no DOM access, so the same code runs in the browser and in Node — which
keeps the client-side-vs-backend decision open rather than forcing it now.

## The pipeline

| Step | File | Notes |
| --- | --- | --- |
| Crop + area-average downsample | `src/mosaic.js` → `downsampleLinear` | Separable box filter with fractional edge coverage |
| Tone adjustments | `src/mosaic.js` → `applyAdjustments` | Brightness / contrast / saturation |
| Quantize to palette | `src/mosaic.js` → `quantize` | Nearest neighbour by CIE76 ΔE in CIELAB |
| Floyd–Steinberg dithering | same | Serpentine scan, adjustable strength |
| Grid map + BOM | `toGridMap`, `buildBOM` | Color codes per cell; counts per color |
| Preview render | `renderToRGBA` | Raw RGBA + drawn studs; works in Node and browser |
| Size + baseplates | `src/sizing.js` | Studs ↔ inches, baseplate tiling, aspect/size presets |
| Background swap | `src/backdrop.js` | Stud-resolution segmentation + replacement backdrops |
| Subject outline | `src/outline.js` | Freehand loops, even-odd, drawn on the photo |
| Parts + finish | `src/parts.js` | Plate / tile / no-brick per region |
| Trace helpers | `src/trace.js` | Sobel edge map, magnetic snap, resample, smooth |
| Sourcing | `src/sourcing.js` | Feasibility checks, palette simplification, Wanted List export |
| Exports + verification | `src/exports.js` | CSVs, and the round-trip proof the map rebuilds the preview |
| 1:1 build sheet | `src/printsheet.js` | True-size printable sheets with a calibration bar |

```js
import { buildMosaic, toGridMap } from './src/mosaic.js';

const mosaic = buildMosaic(imageData, {
  cols: 48, rows: 48,
  dither: 'floyd-steinberg',
});
mosaic.bom;        // [{ color: {name, code, blId, hex}, count }, ...] most-used first
mosaic.meanError;  // mean ΔE between target color and chosen brick
toGridMap(mosaic); // rows of color codes, e.g. [['DBG','BLK',...], ...]
```

## Decisions made while building this

**Averaging happens in linear light, not on sRGB bytes.** Averaging gamma-encoded
values darkens gradients and muddies skin tones. The extra transfer-function
round trip is cheap and the difference is visible.

**Palette matching happens in CIELAB, never RGB.** As specified in the brief —
`test/pipeline.test.mjs` pins this with a mid-teal case where the two disagree.

**Default dither strength is 0.55, not the textbook 1.0.** Full-strength
Floyd–Steinberg against a ~45 color palette pushes strongly chromatic error into
flat regions: a clear sky comes out speckled with magenta and pink. A strength
sweep at 0.4 / 0.55 / 0.7 / 0.85 / 1.0 put the break just past 0.55 — below that
gradients stay clean, above it the speckle takes over. Note that mean ΔE *rises*
with dithering (per-cell error goes up while the local *average* gets closer to
the target), so ΔE alone is a misleading quality metric here — it's reported for
comparing settings, not for judging dithering on or off.

**Serpentine scan order.** Always sweeping left-to-right leaves directional
streaks in large flat areas.

**Dithering is edge-aware** (`detailProtect`, default 0.85). A per-cell detail
map — local luminance range at grid scale — scales each cell's outgoing error
by `(1 − protect × detail)`. Flat regions (sky, skin) keep full blending;
lettering and hard edges quantize cleanly instead of collecting speckle. Race
bibs and shirt logos were the motivating case. Paired with a **stud-scale
unsharp mask** (`sharpen`, default 0.3) applied to the downsampled grid, so it
crispens exactly the edges bricks can represent, and is a no-op in flat areas.

**Text has a physical floor no algorithm moves:** a letter needs ~5 studs of
height to read at all, ~10 to read well. Below that, the fix is a tighter crop
or a bigger grid, not better processing.

**Uniform areas are not dithered** (`flatGuard`, default on). A 3×3 window can't
tell a painted wall from a gentle sky gradient — both look flat locally — so
flatness is measured over a radius-4 window, where the gradient accumulates
several luma units and the wall accumulates nothing. Dithering a genuinely
uniform surface doesn't prevent banding (there is no band); it manufactures a
two-color checkerboard. On a test wall this took the stud-to-stud switch rate
from **0.95 to 0.05** while the gradient control kept dithering normally. The
trade is deliberate and pinned in tests: dithering a solid block averages
*closer* to the target color, but reads as texture at 1×1-plate scale and costs
extra color lots to buy. `flatGuard: false` restores the classic behavior.

**Chromatic dither error is stripped in near-neutral areas** (`neutralGuard`).
The error is split into luminance and chroma; only the chroma part is damped,
scaled by how saturated the cell is. Without it, white fur and grey walls
collect teal and sage speckle as saturated palette entries get recruited to
cancel a tiny color offset. Skin and sky (saturation ~0.25–0.4) are untouched.

**The palette had no light neutral grey**, which turned out to matter more than
any algorithm tweak. In the L\* 80–97 band the least-saturated option was
Lavender (chroma 13), so a plain wall's nearest match was lilac or sage at
ΔE 10–16 — visibly wrong, and the real reason backgrounds came out speckled.
Adding **Very Light Bluish Gray** (BrickLink 99) drops those same targets to
ΔE 2–7. Worth remembering that a palette gap can masquerade as a dithering bug.

**Shadow lift is weighted toward darks** (`shadows`). Plain gamma raises
midtones and highlights too, washing a light background to near-white while
you're only trying to open up a black subject. The lift is scaled by `(1 - t)`,
which pins the white point.

**Alpha is composited over white** during downsampling, so PNGs with
transparency don't produce black fringes.

**Framing is pan-and-zoom inside a fixed frame,** not draggable crop handles.
The frame's aspect is already decided by the shape you picked, so handles would
only let you fight it. The crop rect is computed from the pan/zoom and handed to
`buildMosaic` as a `crop` — the photo is never re-encoded.

## Palette

46 solid, widely-available LEGO colors in `src/palette.js`, each with a 3-letter
grid code, LEGO color ID, and BrickLink color ID for sourcing.

⚠️ **The RGB values are published approximations, not measurements from physical
bricks** — and the published sources disagree with each other by more than this
palette's own colors are spaced apart. Cross-checked against LDraw on
2026-08-14: **mean ΔE 13.0**, with 40 of 45 shared colors over ΔE 5, while the
two closest colors *within* the palette are ΔE 4.80 apart. Rebrickable is not an
independent check — 43 of 46 are byte-identical to ours, because that is where
ours came from.

So the reference you trust can change which brick a pixel maps to, and preview
accuracy is capped there rather than by anything in `mosaic.js`. Don't re-point
the palette at LDraw; that swaps one unmeasured guess for another and changes
every design. Only photographing real bricks settles it. Full numbers in
`docs/palette-sources.md`.

## Background replacement

Toggle it on in step 3, then pick a backdrop (six solids, two fades, a
spotlight). Every backdrop is built from real palette colors, so the result
stays buildable and the bill of materials stays honest.

**No ML model, no dependency, ~2ms.** The usual hard part of background removal
is matting — hair, fur, motion blur, semi-transparent edges. None of that
survives downsampling to a 48-stud grid, where one stud is a whole tuft of fur.
Working on the already-downsampled cell grid turns segmentation into a flood
fill in LAB space.

Two details that make it hold up:

- **Hysteresis on the second pass.** A stud straddling the subject's outline is
  a physical average of fur and wall, so it matches neither and survives as a
  grey halo. A second fill at ~1.9× the tolerance, growing *only* outward from
  confirmed background, absorbs the boundary without handing that slack to the
  whole image.

Connectivity is what keeps a wall-colored patch *inside* the subject from being
erased — it never touches the frame edge, so the fill can't reach it.

### Finish: texture, and not building the background

`src/parts.js` gives the subject and the background their own part:

- **All studs** — plates everywhere. The classic look, one part to buy.
- **Textured** — plates on the subject, tiles on the background. Identical piece
  count, but smooth-against-studded reads as a real edge under raking light.
  This is the cheap way to get the "raised" look without a second layer, which
  would roughly double the pieces in the raised region.
- **Subject only** — `none` for the background. Those studs hold no brick, so
  they aren't counted, aren't bought, and print blank on the build sheet. On a
  typical portrait this is a **60% cut** in pieces, because the background is
  most of the mosaic and most of the cost.

`indices[i] === EMPTY` (-1) marks a stud with no brick. The BOM is keyed by
color *and* part, because a textured design needs the same color as both a plate
and a tile and those are two separate lots to order.

### The outline is the real control

Automatic detection is a *starting guess*, not the answer. `src/outline.js`
traces an editable outline from the detected mask and the user drags it —
"Adjust the outline" above the preview. That turns an unpredictable heuristic
into something that works every time, because the fallback is always "move the
line yourself."

You draw it directly on the photo. An outline is a list of closed loops in
normalised frame space (x and y both 0..1 regardless of aspect), filled with the
**even-odd rule** — so a loop drawn inside an existing one punches a hole. That
means "trace round the cat, then trace round the litter box beside it" needs no
separate add/erase mode: the second loop simply cuts. The raw pointer stream is
simplified with Ramer–Douglas–Peucker, which keeps the corners that carry the
shape and drops the hundreds of points that don't.

An earlier version stored a centre plus 16 radii. Every handle position was
guaranteed valid and inside/outside was O(1), but it could only describe star
shapes — and it could not exclude a bar behind the subject or a box beside it,
which is exactly what people want to remove. Arbitrary loops cost a real
point-in-polygon test and win that.

A drawn outline is treated as an instruction and is never `suspect`; automatic
detection only supplies the starting shape.

**Snap to edges** is the thing that makes tracing on a phone viable. `src/trace.js`
builds a Sobel gradient map of the crop, normalised against that image's own
strongest edge so one threshold works for a flat studio shot and a contrasty
outdoor one. Each drawn point is then pulled to the strongest edge within ~2% of
the frame — but only if it clears a minimum strength, so points in flat areas
stay where they were put instead of being dragged into noise. On a deliberately
sloppy trace this halves the error.

It snaps *after* the stroke rather than live. A live cost-minimising path tracks
edges more tightly but fights you when the edge is weak or crossed by another —
and when the output is 8mm squares, the drawn shape should stay the source of
truth. Points are resampled to even spacing first (a pointer stream is dense
where the hand slowed and sparse where it moved fast, which makes snapping
lumpy) and lightly smoothed after.

**Tracing doesn't have to be one motion.** Strokes accumulate into an open
draft: lift, reposition, carry on. The shape closes when you press Finish or end
a stroke near where you began. Undo and redo step through strokes, not just
whole shapes. One finger draws; two fingers pinch and pan; the wheel zooms on
desktop — the standard drawing-app mapping, and the only way to get in close
enough to trace an ear.

### Why auto-detection needed three guards

The first version erased a black cat entirely. Three compounding causes, each
now fixed and pinned by a regression test:

1. **The subject filled a corner.** Corner sampling made its own fur a
   "background" color and the fill ran away across the frame. Background is now
   defined as what sits at the edge *and is not what's in the middle* — but only
   when a color both dominates the centre **and** is a minority at the border.
   "Dominates the centre" alone throws away the real background whenever the
   subject sits low in frame, which is most portraits.
2. **The fill wandered inward.** Tolerance is now scaled by distance from
   centre (`CENTRE_TIGHTEN`): full at the frame edge where backgrounds live,
   half in the middle where subjects live.
3. **Hysteresis was too generous** at 1.9×, now 1.35× — enough to absorb the
   one-stud outline where subject and background average together, not enough to
   let the fill walk into the subject.

If the fill still runs away, tolerance is tightened and retried; if it still
covers more than 88% the result is marked `suspect`, and `buildMosaic` leaves
the photo **completely untouched**. A canvas of pure backdrop is the worst
output this code can produce, so it is never shipped.

### Failing safe

Three guards decide a mask is wrong and leave the photo **completely untouched**:
coverage over 88%, the middle of the frame swallowed, or — the one that took
longest to find — **the subject coming out in pieces**.

That last guard exists because of a real photo: a tuxedo cat against a wall,
with a dark wood cabinet down one side. His white bib owns the centre of the
frame, so his *black fur* reads as a minority there — under 20% — and slipped
through as "background" even though it is the animal. The flood then entered
from the bottom edge, where his body runs out of frame, and erased him.

Two plausible-sounding fixes failed first, and both are worth remembering:

- *"Exclude colors that dominate the centre."* The bib dominates the centre, not
  the fur. Statistics about **where a color appears** can't see this.
- *"Flood with each candidate alone and reject the ones that reach the middle."*
  Alone, the fur reaches 0% of the centre sample — the bib is in the way. Yet
  wall + fur + cabinet together cover 78% where individually they cover
  21/27/12%. **The damage is emergent from the combination**, so no per-color
  test can predict it.

What does work is checking the outcome. A photo has one subject; a correct mask
leaves **one** coherent island, and this failure left **twelve**. Fragmentation
is the signature, and it's cheap to measure.

Honest limits: automatic detection finds backgrounds that are reasonably uniform
and connected to the frame edge. It will not separate someone from a bookshelf —
that's what the draggable outline is for, and when detection declines the UI
says so and points at it.

## Proving the preview matches the bricks

The expensive way to find out whether a design works is to order 2,300 pieces
and build it. Three cheaper checks, in order of cost:

**Free — the build map round-trips.** The preview and the exported CSV are
generated from the same object in memory, so agreeing with each other proves
nothing. `verifyBuildMap()` parses the exported file back, rebuilds the grid,
and asserts it renders pixel-for-pixel identical to the preview. That answers
"if someone follows this file brick by brick, do they get the picture we showed
them?" It runs in the test suite, and again in the app before the download is
handed over — a mismatch blocks the download rather than shipping bad
instructions.

**A sheet of paper — the 1:1 build sheet.** `src/printsheet.js` prints the
design at exactly `STUD_MM` per cell, so at 100% scale the paper *is* the
finished piece's true size. Hold it against the wall to check the size decision
before buying anything, and lay any bricks you already own on the printed
swatches to compare colors. Every page carries a 100mm calibration bar, because
printers silently apply "fit to page" and a few percent of shrink would quietly
invalidate all of it.

**~$15 — a color calibration order.** The palette's RGB values are published
approximations, and that is the largest remaining source of preview-vs-reality
error. Buying one 1×1 plate in each of the ~15 colors a design actually uses,
photographing them against a grey card, and correcting `src/palette.js` fixes it
permanently and costs a fraction of a full build. Do this before the first real
order, not after.

Only then is a full build worth it — and a Small (32×32, ~1,000 pieces, one
baseplate) validates the map, the physical look, and the mounting at a quarter
of the cost of a Medium.

## Ordering

**Wanted List XML** is the one that matters — it's the format behind
`bricklink.com/v2/wanted/upload.page`, and BrickOwl imports it too. One upload
instead of 20 manual color searches, then let the cart optimizer pick sellers.
Also exports PNG, shopping list CSV, and build map CSV. Quantities assume 1×1
plates (part 3024); `toWantedListXML` takes a `partId` for tiles (3070b).

`CONDITION` is deliberately omitted from the XML: pinning it to New roughly
halves available lots and raises the price, and for a mosaic that gets framed,
used pieces are fine.

### Feasibility, not vibes

`analyzeBuild()` checks the things that bite *after* the boxes arrive:

- **Baseplates don't interlock.** They have no tubes underneath. Any multi-plate
  design needs a backing board or connecting plates below — this surprises
  people at exactly the wrong moment.
- **The long tail.** A color used 6 times is still a full lot: a seller minimum,
  a shipping charge, another package. Flagged with what share of the mosaic
  those colors actually represent.
- **Single-color demand over ~1000**, which can clear out one seller.
- **Total piece count over ~8000**, which is a bigger time commitment than
  people expect.

`buildBuyableMosaic()` acts on the long tail: it drops rare colors from the
palette and **re-runs the whole pipeline** rather than reassigning orphaned
cells, so dithering compensates with the colors that remain. It iterates,
because removing colors redistributes their cells and can push a previously-fine
color under the threshold. Typical result on a photo:

| Size | Grid | Colors → simplified | Long tail as % of build |
| --- | --- | --- | --- |
| Small | 32×32 | 22 → 12 | 7.3% |
| Medium | 48×48 | 23 → 15 | 4.3% |
| Large | 64×64 | 27 → 20 | 1.0% |
| Huge | 96×96 | 28 → 23 | 0.4% |

Smaller builds benefit most — at 32×32, ten of the twenty-two colors are 7% of
the mosaic and half the ordering hassle.

**No price or stock data is hardcoded anywhere.** It's live, per-seller, and
changes daily; a baked-in number would be wrong within a week in a way that
costs someone money. `estimateCost()` takes the rate as an argument, and the UI
labels its default as a placeholder to check.

## Not built yet

- **PDF build map.** The CSV works but isn't something you'd print and follow on
  the floor. `toGridMap()` and `buildBOM()` are the inputs when you want it.
- **Plate-seam overlay.** The build list says how many baseplates and how they
  tile, but the preview doesn't draw the seams.
- **Rotate / straighten** in the framing step — currently pan and zoom only.
- Perceptual refinements worth trying: CIEDE2000 instead of CIE76, and
  restricting the palette to colors the user actually has in stock.

## Verified against reality, and what still isn't

Checked on 2026-08-14 — see `docs/bricklink-validation.md`:

- ✅ **The Wanted List XML imports.** Uploaded to the real BrickLink page: it
  parsed, and all **15/15 color ids** resolved to the colors named in
  `<REMARKS>`. The upload page wants the XML *pasted*, not a file, which is why
  the build list leads with a copy button and offers download second.
- ✅ **Part-color availability is no longer assumed.** All 46 colors exist as
  1×1 plate (3024), and listed supply dwarfs what a mosaic needs — the scarcest
  color in a test design had ~21,000 listed against a need of 38.
- ⚠️ **`$0.06`/piece is a bad estimate, not a slightly-off one.** Real prices run
  $0.02–$0.27 by color. It lands within 20% on a typical design only because the
  overestimate on common colors cancels the underestimate on scarce ones.
- ⚠️ **The palette carries a price trap.** It has the pre-2004 grays *and* their
  modern replacements. Light Gray/Light Bluish Gray (ΔE 4.80) and Dark Gray/Dark
  Bluish Gray (ΔE 7.10) are the two closest pairs in the whole palette, and the
  legacy half costs 5–7× more. Quantization has no cost input, so the choice
  turns on a difference nobody can see.
- ❌ **Palette RGB values** remain unmeasured (see Palette, above). This is now
  the largest open item.

### This is not cheaper than buying a kit

Brick Me sells a 2×2-baseplate kit at 15"×15" and **2,304 bricks** — identical
to the Medium preset, piece for piece — for **$59.99**, including baseplates and
printed instructions. Sourcing the same design on BrickLink runs **~$140–165**
($112.59 in plates + $20–37 in baseplates + shipping). **DIY is ~2.5× the kit.**

The gap is structural: they manufacture LEGO-compatible bricks in bulk at about
$0.026/piece all-in, while this route buys genuine LEGO secondhand at ~$0.049
before baseplates. No cart optimization closes it, so **never pitch this as
saving money.** What is actually true: free if you already own the bricks,
genuine LEGO, your choice of parts and palette, the photo never leaves the
browser, and sizes nobody sells. The build list is framed inventory-first for
exactly this reason.

## Open questions this prototype has bearing on

- **Client-side vs. backend.** At 128×128 the full pipeline runs in ~40 ms in the
  browser on a downscaled source. Performance is not a reason to need a backend;
  protecting the algorithm or gating monetization would be.
- **Palette choice.** The palette is a single data file with no logic attached, so
  swapping to a Bricklink-sourced or generic-brand palette is a data change, not a
  code change.
