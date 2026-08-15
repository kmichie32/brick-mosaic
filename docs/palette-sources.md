# Palette RGB — where the numbers come from — 2026-08-14

`src/palette.js` says its RGB values are "published approximations." This is
what happens when you check them against the other published sources.

## Method

Two public references, joined to the palette and compared in CIELAB (ΔE76):

- **Rebrickable** `colors.csv`, joined by color name.
- **LDraw** `LDConfig.ldr`, joined on the LEGO color id that LDConfig carries in
  a comment above each `!COLOUR` line.

## Rebrickable is not an independent check

43 of 46 colors are **byte-identical** to ours. That isn't agreement, it's a
shared ancestor — our values came from this lineage. The three that drift are
worth a look only because a typo would show up the same way:

| | ours | Rebrickable | ΔE |
| --- | --- | --- | --- |
| Very Light Bluish Gray | `#E6E3DA` | `#E6E3E0` | 3.1 |
| Lavender | `#C9CAE2` | `#E1D5ED` | 6.7 |
| Medium Lavender | `#A06EB9` | `#AC78BA` | 6.5 |

## LDraw disagrees, and by a lot

Across the 45 colors both lists share:

- **Mean ΔE 13.0.**
- **40 of 45 differ by more than ΔE 5**, which is plainly visible side by side.
- Only two match exactly: Dark Brown and Medium Lavender.

Worst offenders: Dark Pink (31.1), Sand Red (28.6), Lavender (25.8), Green
(20.0), Medium Orange (20.0), Bright Light Yellow (19.8).

**Why this matters more than the raw number suggests.** The two closest colors
*within* this palette are ΔE 4.80 apart (Light Gray / Light Bluish Gray) and the
next pair is 7.10. The disagreement between two reputable public sources is
roughly **twice the spacing between neighbouring bricks in the palette**. So
which reference you trust can change which brick a pixel maps to. Quantization
accuracy is capped by this, not by the algorithm.

Neither source is measured. LDraw's values are tuned to look right when rendered
under lighting; the BrickLink/Rebrickable lineage are flat web swatches. They
are two different guesses at two different questions, and nothing here can
adjudicate between them.

**Do not "fix" the palette against LDraw.** That swaps one unmeasured guess for
another and changes the output of every design. The only thing that settles it
is photographing real bricks — which is exactly what the ~$15 calibration order
in the plan is for. This finding raises its value: it is not a nice-to-have
polish step, it is the ceiling on preview accuracy.

## Two ID bugs found and fixed

`legoId` had been populated from LDraw's `CODE` column instead of the LEGO id,
twice. Both ship into the shopping-list CSV via `exports.js`:

| | was | now | |
| --- | --- | --- | --- |
| Purple | 22 | **104** | LDraw code 22. LEGO 22 is Medium Reddish Violet — a real but unrelated color, so the wrong value resolved to something and looked correct. |
| Medium Nougat | 84 | **312** | LDraw code 84. Our hex is byte-identical to that row, which is how the mechanism was confirmed. |

`blId` — the id that actually matters, since it is what `<COLOR>` carries into
BrickLink — was checked separately and is correct for all 46 (see
`bricklink-validation.md`: 15/15 verified by upload, all 46 confirmed to exist
as part 3024). `test/palette.test.mjs` now pins both id sets.

## What is still open

Measuring real bricks. Cheapest version, before spending anything: print the
build sheet, lay any bricks you already own on their swatches, and note which
ones are visibly off. That costs a sheet of paper and tests the colors you
actually have.
