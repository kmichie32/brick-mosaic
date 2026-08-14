# BrickLink validation — 2026-08-14

Checked against BrickLink's public catalog and price guide. No account, no
upload: everything here is read-only public data for part **3024 (1×1 plate)**.

Test design: Medium (48×48 = 2304 studs), square, Floyd–Steinberg, simplify on
(`minCount: 20`). 19 colors quantized, 4 dropped, **15 colors** in the final BOM.

## What is now verified

**All 15 colors exist as 1×1 plate.** Every `<COLOR>` in the generated Wanted
List maps to a real BrickLink color that part 3024 is catalogued in.

**The XML is internally consistent.** `sum(MINQTY)` = 2304 = `totalBricks`, no
duplicate part/color lots, every id resolves to a palette entry whose name
matches its `<REMARKS>`.

**Supply is not a problem at this scale.** The scarcest color in the design
still has ~21,000 pieces listed against a need of 38.

**The upload works.** Round-tripped through
`bricklink.com/v2/wanted/upload.page` on 2026-08-14 with a logged-in account.
BrickLink parsed the XML, reached "Step 2 of 2: Verify", and resolved all 15
lots against part 3024. Every color name BrickLink rendered from the `<COLOR>`
id matched the name this code put in `<REMARKS>` — **15/15 color ids correct**.
Quantities came through intact and Condition was blank, as intended.

Note the upload page takes the XML **pasted into a textarea**, not a file. The
app's export button was download-only, which made the real flow worse than
copy-and-paste; `index.html` now leads with a copy button because of this.

## What is still NOT verified

**Palette RGB values.** Unchanged. Still published approximations, and now the
largest remaining source of preview-vs-reality error by some distance.

**Cart totals.** The $112.59 figure is built from price-guide averages, not
from an actual cart. Running BrickLink's optimizer against the uploaded list
would price it against real sellers and expose the shipping cost that the
per-piece model ignores entirely.

## Prices — the $0.06 placeholder

Per-piece, from the last 6 months of *actual sales* (quantity-weighted average):

| Color | BL id | Need | New | Used | Listed (new) |
| --- | --- | --- | --- | --- | --- |
| Black | 11 | 418 | $0.04 | $0.05 | 2,145,776 |
| Dark Tan | 69 | 287 | $0.04 | $0.05 | 597,253 |
| Dark Blue | 63 | 261 | $0.03 | $0.04 | 627,073 |
| Dark Bluish Gray | 85 | 257 | $0.04 | $0.05 | 2,679,264 |
| Nougat | 28 | 237 | $0.06 | $0.15 | 190,290 |
| Medium Nougat | 150 | 224 | $0.03 | $0.03 | 1,354,442 |
| **Sand Blue** | 55 | 221 | **$0.09** | **$0.26** | 171,357 |
| Light Nougat | 90 | 107 | $0.06 | $0.09 | 208,600 |
| Tan | 2 | 83 | $0.02 | $0.03 | 3,121,592 |
| Dark Purple | 89 | 48 | $0.05 | $0.07 | 163,618 |
| Dark Brown | 120 | 41 | $0.04 | $0.05 | 482,055 |
| Olive Green | 155 | 39 | $0.04 | $0.05 | 375,437 |
| **Dark Gray** | 10 | 38 | **$0.27** | **$0.22** | 21,717 |
| Reddish Brown | 88 | 22 | $0.04 | $0.04 | 926,452 |
| Dark Green | 80 | 21 | $0.03 | $0.04 | 936,619 |

Priced properly this design is **$112.59** in 1×1 plates, against **$138.24** at
a flat $0.06. So the placeholder is within ~20% — but by luck, not construction:

- It is wrong per-color by up to **9×** (Tan $0.02 → Dark Gray $0.27).
- It overestimates the common colors, which is what cancels the underestimate on
  the expensive ones. A design weighted toward the scarce end has no such luck.
- It ignores **shipping**, which is per-seller and real: 15 lots typically means
  3–6 sellers at $4–8 each. `estimateCost` already takes `shippingPerLot`; the
  UI passes nothing.

## Against buying a kit

Brick Me sells a 2×2-baseplate kit at 15"×15" and **2,304 bricks** — the same
size and the same piece count as this design, down to the brick. Their listed
variant price is **$59.99**, including bricks, transparent baseplates, a
separator tool and custom printed instructions.

Sourcing the identical thing on BrickLink:

| | |
| --- | --- |
| 2,304 × 1×1 plate, at real per-color prices | $112.59 |
| 4 × 32×32 baseplate (3811, ~$9.20 new / $5.08 used) | $20–37 |
| Shipping, single seller | ~$8–15 |
| **Total** | **~$140–165** |

**DIY costs roughly 2.3–2.7× the kit.** The reason is structural and no amount
of cart optimization fixes it: they sell LEGO-*compatible* bricks manufactured
in bulk, at about $0.026/piece all-in. This buys genuine LEGO secondhand, where
every 1×1 plate has been sorted, listed and stocked by a small seller who needs
a margin — about $0.049/piece before baseplates or shipping.

So **"cheaper than buying a kit" is not true and must not be implied anywhere in
the UI.** What is true: it's free if you already own the bricks, it's genuine
LEGO, you choose the parts and palette, the photo never leaves the browser, and
you can make sizes nobody sells. The build list is framed inventory-first for
this reason — check what you have, then price what's missing.

(Their other product lines start at $89.99, and this variant reads "sold out" on
the page while the Shopify variant data says $59.99. The conclusion holds at
either number.)

## The legacy gray trap

The palette carries **both** the pre-2004 grays and their modern replacements:

| Legacy | | Modern | | ΔE |
| --- | --- | --- | --- | --- |
| Light Gray (9) | $0.19 | Light Bluish Gray (86) | ~$0.04 | 4.80 |
| Dark Gray (10) | $0.27 | Dark Bluish Gray (85) | $0.04 | 7.10 |

Those are the **two closest color pairs in the entire 46-color palette** —
closer than any other pair, by a margin. The quantizer has no cost input, so
which one it picks is decided by a ΔE difference no one can see, and the wrong
pick costs 5–7× per piece.

This design hit it: it bought *both* Dark Bluish Gray (257 pieces, $0.04) and
Dark Gray (38 pieces, $0.27). Those 38 pieces are 9% of the parts cost for 1.6%
of the bricks, and they are visually interchangeable with the ones next to them.

Light Gray is also genuinely scarce as new stock — 102 lots, versus thousands
for the modern equivalent.

**Not fixed here.** The options — drop the legacy pair, weight quantization by
price, or warn in the build list — all change output for every design, so that
is a product decision rather than a cleanup.
