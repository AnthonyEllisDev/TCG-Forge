# Multi-card projects

A project can hold a whole set: one layout, and a list of cards that fill it in.
The strip under the canvas shows every card in the project; click one, or press
**Page Up** / **Page Down**, to put it on the canvas.

## One layout, many cards

A card is the values in its **Card Fields** — the words in each text slot and
the artwork in each art slot. Everything else is the layout, and every card
shares it. Move the frame, change the title font, add a set symbol: that is one
edit, and every card in the project has it.

This is the same split the batch generator already makes between a template and
a spreadsheet row, and the same one Magic Set Editor makes between a set's style
and its cards. It is also what keeps the file small: a card is a handful of
strings, not a copy of the canvas.

| Per card | Shared by every card |
| --- | --- |
| text in each slot | every layer without a slot |
| artwork in each art slot | the position, size, font and effects of slotted layers |
| | card size, dpi, corners and background |
| | which layers follow which field (`tcgShowIf`) — though whether a conditional layer is showing depends on the card, since it follows that card's fields |

A card stores *which* picture is in each art slot, not how it was cropped: art
is fitted to its slot's window when the card is shown, so a crop or nudge made
to one card's art is not stored with that card.

## The strip

| Control | What it does |
| --- | --- |
| **‹ / ›**, Page Up / Page Down | previous / next card |
| **+ Card** | an empty card after this one: every text slot blank, every art slot back to its placeholder |
| **Duplicate** | a copy of this card after it — the quickest way to start a card that shares most of its words (a footer, a type line) |
| **⇠ / ⇢** | move this card earlier or later in the list |
| **Delete** | remove this card, after asking. The last card cannot be deleted |
| **Copies** | how many of this card the deck wants — see below |

Tiles show a thumbnail once a card has been on screen this session, and the
card's first words either way. Thumbnails are not saved in the project file:
they would be most of its size and all of the noise in a diff.

Undo history belongs to the card it was made on and starts afresh whenever you
switch — a step recorded on one card would otherwise put its words back on the
next.

Art slots now have a **Clear** button in Card Fields, which takes the artwork out
and puts back the layer it replaced (usually the dashed art box). Artwork
remembers that layer when it is placed (`tcgPlaceholder`); art placed before
0.7.0 gets a plain art box in its window instead.

## Copies

A deck usually wants more than one of some cards. **Copies** in the strip sets
that number for the card on screen (1 to 999); a tile with more than one shows
`×3`, and the strip shows the deck's total whenever it is not simply one of
each.

A card with three copies is still one card: it is edited once, drawn once and
exported as one image. The count only matters where cards are laid out or
listed:

- **Print → Every card in this project** lays each card out as many times as its
  count. Untick *Repeat each card by its deck quantity* to print one of each.
- **Export → Every card in this project** writes a `deck.json` beside the images
  with each file's count, the same list a batch run with a quantity column
  writes — so printing that folder later gives the same deck. The list is
  rewritten on every export, including one where every card is back to one
  copy, so it can never describe counts the project no longer has.
- **Add rows as cards** takes each card's count from the batch dialog's
  *Quantity column*, if one is chosen.
- **Duplicate** copies the count; **+ Card** starts at one.

This is the same rule as 0.5.0's batch quantities: the count is expanded when
the page is laid out, never by drawing the card several times.

## Filling a project from a spreadsheet

In the batch dialog, **Add rows as cards** turns every row into a card in this
project using the column mapping — without rendering anything, so it is
instant, and the set can then be edited card by card. Art cells are looked up
exactly as a batch run looks them up; a name that is not in the library leaves
that card's art slot empty and is named in the dialog.

The rows are added after the cards already there. Loading a template gives a
project of one card, so a fresh set from a spreadsheet is: load the template,
**Add rows as cards**, then delete the template's own card.

## Getting the cards out

- **Export → Every card in this project** renders each card into
  `workspace/exports/<project-name>/`, named `001-<first words>.png` and so on.
  That folder is then a source in the print dialog like any batch run.
- **Print → Every card in this project** lays the cards straight onto sheets,
  by their copies, without writing a folder first.

Both go through the batch renderer, so a card is drawn exactly as a spreadsheet
row with the same values would be.

## The file

A project from 0.7.0 on is version 2 and carries two more keys:

```json
{
  "format": "tcgforge.project",
  "version": 2,
  "canvas": { "...": "the layout, showing the active card" },
  "cards": [
    { "id": "card_k3j9x2a", "values": { "title": "Ember Wyrm", "art": "assets/art/wyrm.png", "stats": "4 / 4" }, "qty": 3 },
    { "id": "card_p0q7m1c", "values": { "title": "Ashfall Ritual", "art": null, "stats": "" } }
  ],
  "activeCard": 0
}
```

- `values` maps slot ids to strings. An art slot holds a workspace path, a data
  URL (placed without the local server, or saved with **Embed images**), or
  `null` for "no art of its own".
- A slot a card has no value for is shown empty, never with the previous card's
  value.
- `qty` (0.8.0) is the card's copies. It is written only when it is more than
  one; a card without it is one copy, which is every card saved before 0.8.0.
  The file stays version 2 — an older TCG Forge ignores the key (and drops it
  if it saves the file).
- `canvas` is exactly what it was in version 1, so an older TCG Forge opens a
  version-2 file as its active card. (Saving it from that older version keeps
  only that card.)
- A version-1 file has no `cards` and opens as a project of one card. Nothing is
  written back until you save, and saving writes version 2.
