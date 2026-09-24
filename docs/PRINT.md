# Print sheets

Rendering a card gives you a PNG. Printing one gives you a card you can sleeve —
but only if it comes off the printer at exactly the size it was designed at. The
print sheet builder lays finished cards out on a real page, at their true
physical size, with guides to cut along.

Open it from **Print** in the top bar or with `Ctrl/⌘ + P`.

---

## What it does

Nothing in the print sheet builder touches the card you are editing. It takes
images that are already rendered, paints them onto a page-sized canvas, and
writes the result out. That is the whole design: a sheet cannot corrupt a
project, because it never opens one.

## 1 · What to print

**The current card, repeated.** Renders the card on screen once and fills the
page with it. Useful for playtest copies of a single card, and for checking your
printer's scaling before committing to a set.

**A folder in `workspace/exports`.** Every image in the folder, in name order.
This is the other half of the batch generator: render a set with **Batch** into
`exports/my-set`, then lay `my-set` out here. Sets larger than one page run onto
as many pages as they need.

**Repeat each card by its deck quantity.** A batch run with a quantity column
leaves a `deck.json` beside its images saying how many of each card the deck
wants (see [`BATCH.md`](BATCH.md)). The dialog finds it on its own and says so:
*deck.json in this folder asks for 60 cards from 23 designs*. Untick the box to
print one of each instead. A folder with no list is simply one of each, which is
what every folder used to be.

One image is decoded once and painted as many times as the list asks, so a
sixty-card deck costs no more to lay out than twenty-three separate cards did.

## 2 · Page

| Setting | What it means |
| --- | --- |
| **Paper** | A4, US Letter, US Legal, A3 or Tabloid. |
| **Orientation** | Portrait or landscape. Landscape often fits one more column. |
| **Margin** | Millimetres of blank paper around the block of cards. Most home printers cannot print closer than about 5 mm to the edge. |
| **Gap** | Millimetres between neighbouring cards. Zero butts them together, which fits the most cards and gives you one cut line to follow between each pair. |
| **Bleed** | Millimetres of artwork that your source images carry *beyond* the trim line. See below. |
| **Cut guides** | Crop marks, full-page cut lines, or nothing. |
| **Resolution** | The sheet's own pixel density. 300 dpi is right for almost everything; 600 dpi doubles the file size and only helps if your cards were designed above 300 dpi. |

The line under these controls tells you how many cards fit before you render
anything:

```
3 × 3 = 9 cards per A4 (210 × 297 mm) · each 2.50 × 3.50 in · sheet 2480 × 3508 px
```

### Card size comes from the card, not from this dialog

A card's physical size is its pixel size divided by its dpi. A 750 × 1050 px
card at 300 dpi is 2.5 × 3.5 inches; a 1500 × 2100 px card at 600 dpi is the
same 2.5 × 3.5 inches. Set the dpi correctly in **Card Setup** and the sheet
follows automatically — there is nothing to configure twice.

If the card does not fit the page at all, the dialog says so instead of
producing a sheet with one card on it.

### Bleed

If your card art runs off the edge of the card — a full-bleed illustration, a
frame that reaches the border — a tiny misalignment when cutting leaves a white
sliver. The usual answer is to design the card slightly oversized and cut inside
it.

Set **Bleed** to the number of millimetres your images carry beyond the trim
line. Each card is then drawn that much larger than its slot, spilling into the
gutter, while the cut guides stay on the trim line. Cutting on the guides
removes the bleed and leaves artwork right to the edge.

Bleed forces the gap to at least twice the bleed, so neighbouring cards cannot
print over each other.

### Cut guides

**Crop marks in the margins** put a short tick in the page margin at every cut
line, above, below and to each side of the block. Lay a ruler between a pair of
ticks and cut. Nothing is ever drawn on a card — with the usual zero gap, a mark
next to one card's edge would be a mark on top of its neighbour.

**Full-page cut lines** draw each cut all the way across the page, over the
cards. Easier to follow under a guillotine, but the line is printed on the paper
you are cutting through.

**No guides** is for sending a sheet to a print shop that adds its own marks.

## 3 · Card backs

A deck needs two sides. **Both sides** decides how the second one gets onto
paper.

**Single-sided** is the default and behaves exactly as it always has: fronts
only, one page per pageful of cards.

**Double-sided** writes a back page after every front page. The backs are laid
out mirrored about the page's centre line, because that is what the sheet of
paper does when the printer turns it over — so back 1 lands behind front 1 once
the page has been flipped.

**Gutterfold** puts fronts and backs on one side of one page, either side of a
fold, with the backs upside down. Fold the sheet along the dashed line, glue the
halves together and cut. It costs you half the cards per sheet and it needs no
duplex printer, and the two sides line up perfectly every time, which is why a
lot of print-and-play designs ship this way.

### Where the backs come from

**Backs from** is a folder under `workspace/exports`, the same place the fronts
come from:

- **A folder holding one image** gives every card that back. This is the usual
  case — most games have a single card back. Export your back card once and
  point at the folder it landed in.
- **A folder holding one image per card** gives each card its own back, paired
  with the fronts in the order the files are listed — so a batch run named
  `001-…`, `002-…` pairs with a back folder named the same way.

Any other count is refused rather than guessed at, because a set where one card
quietly lost its back is worse than a set that would not build.

### Printer flips on

This is the setting that goes wrong, and the symptom is unmistakable: every card
comes out carrying the back that belongs to the card on the opposite side of the
page.

Duplex printers turn the paper about one of two axes, and which one decides
which way the backs have to be mirrored:

| Setting | Mirror | Use when |
| --- | --- | --- |
| **Long edge** | Left to right | The default for portrait duplex, and what most printers do unless told otherwise. |
| **Short edge** | Top to bottom | Your driver calls it "flip on short edge", "tablet" or "calendar" binding. |

If the backs land on the wrong cards, this is the only setting to change.

### Back shift

No consumer duplex printer lands the second pass exactly on the first; a
millimetre or two of drift is normal and it is a property of the machine, not of
the file. **Back shift X** and **Back shift Y** move every back page by that
much, in millimetres, so you can cancel it out.

To measure it: print one sheet double-sided, hold it up to a window, and read
off how far the backs sit from the fronts. Positive X moves the backs right;
positive Y moves them down. The correction is the same on every sheet you ever
print on that machine, so it is worth writing down.

Gutterfold needs neither of these settings — a fold cannot drift.

## 4 · Output

**PDF** writes one file containing every page, and is the format to use if you
are going to print the sheets yourself. A PDF states its page size in points, so
"print at 100%" — sometimes called "actual size" — means something definite.
Pages are stored as JPEG at high quality.

**PNG** writes one file per page, losslessly. Use it when something downstream
wants images, or when you want to inspect a sheet pixel by pixel. Double-sided
sets name the pair `…-sheet-01.png` and `…-sheet-01-back.png`; gutterfold sheets
are named `…-sheet-01-fold.png`.

**Number the sheets in the bottom margin** prints the project name, the sheet
number and which side it is in the corner of each page. Twelve loose sheets of a
double-sided set are unpairable without it, which is why turning on a back mode
turns this on too. It prints in the page margin and never on a card.

Both land in `workspace/exports/print/` when the local server is running, and in
your browser's downloads folder otherwise.

---

## Printing it

The one thing that matters:

> **Print at 100% / Actual size. Never "Fit to page" or "Shrink oversized
> pages".**

Every scaling option in a print dialog defaults to on, and every one of them
will make your cards the wrong size. Print a single sheet first and measure a
card with a ruler before running the rest.

Paper matters more than most people expect. 200–300 gsm card stock goes through
most inkjets and laser printers and feels approximately right; ordinary paper
glued back to back works too and is what most print-and-play designs assume.

### Printing a double-sided set

1. Build the sheets as a **PDF**, so the page size is stated.
2. Print pages 1 and 2 only, double-sided, at 100%.
3. Hold the sheet up to the light. If the backs are on the wrong cards, change
   **Printer flips on** and try again. If they are on the right cards but a
   little out of register, measure the offset and put it in **Back shift**.
4. Once one sheet is right, print the rest. Nothing about the correction changes
   between sheets.

A gutterfold set skips all of that: print, fold on the dashed line, glue, cut.

---

## Under the hood

- `web/js/core/printSheet.js` — page geometry and composition. Knows about
  inches, pages and grids; knows nothing about cards, slots or Fabric.
  `planSheet()` returns `backSlots` alongside `slots` when a back mode is on;
  a back slot is its front mirrored about the page centre line, which is the
  fold line too, so gutterfold and short-edge duplex share the arithmetic.
  `expandByQuantity()` repeats a design by its count, and `parseDeck()` reads a
  `deck.json` — keeping only each entry's own file name, so a list can never
  name a file outside the folder it was found in.
- `web/js/core/pdf.js` — a small PDF writer, one JPEG per page. It exists
  because the standard-library-only rule leaves no room for a PDF dependency,
  and because an image cannot state its physical size.
- `web/js/ui/printPanel.js` — the dialog.

No server endpoint was added: `/api/list` already finds the images, `/api/read`
already reads the deck list and `/api/export` already writes files into
`workspace/exports`.
