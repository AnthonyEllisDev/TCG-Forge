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

## 3 · Output

**PDF** writes one file containing every page, and is the format to use if you
are going to print the sheets yourself. A PDF states its page size in points, so
"print at 100%" — sometimes called "actual size" — means something definite.
Pages are stored as JPEG at high quality.

**PNG** writes one file per page, losslessly. Use it when something downstream
wants images, or when you want to inspect a sheet pixel by pixel.

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

---

## What it does not do yet

**Card backs.** Fronts are the useful half, and duplex printing needs more than
a second image: the page order has to be mirrored so back 1 lands behind front
1, and there has to be a way to nudge the backs a millimetre or two to absorb
the drift every duplex printer has. The geometry is already in `planSheet()`, so
this is the obvious next increment.

**Gutterfold layouts**, where a sheet is folded down the middle so fronts and
backs meet without duplex printing at all.

---

## Under the hood

- `web/js/core/printSheet.js` — page geometry and composition. Knows about
  inches, pages and grids; knows nothing about cards, slots or Fabric.
- `web/js/core/pdf.js` — a small PDF writer, one JPEG per page. It exists
  because the standard-library-only rule leaves no room for a PDF dependency,
  and because an image cannot state its physical size.
- `web/js/ui/printPanel.js` — the dialog.

No server endpoint was added: `/api/list` already finds the images and
`/api/export` already writes files into `workspace/exports`.
