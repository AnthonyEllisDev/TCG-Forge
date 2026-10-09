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
| where a layer marked **Only on this card** sits, its size, turn, opacity and colour | everything else about that layer |
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
| **Filter** box | show only the cards that match — see [Finding a card](#finding-a-card) |

Tiles show a thumbnail once a card has been on screen this session, and the
card's first words either way. Thumbnails are not saved in the project file:
they would be most of its size and all of the noise in a diff.

Undo history belongs to the card it was made on and starts afresh whenever you
switch — a step recorded on one card would otherwise put its words back on the
next.

Layers that are card fields cannot be put in a group: Card Fields, card
switching and batch runs look for fields among the card's top-level layers
only. Group the decoration around a field instead. A copied and pasted field
layer becomes a plain layer, the same as **Duplicate** makes.

Art slots now have a **Clear** button in Card Fields, which takes the artwork out
and puts back the layer it replaced (usually the dashed art box). Artwork
remembers that layer when it is placed (`tcgPlaceholder`); art placed before
0.7.0 gets a plain art box in its window instead.

## Finding a card

In a set of a hundred cards, Page Down is a slow way to reach the one you
want. The **Filter** box in the strip (or **/** from anywhere in the editor)
narrows the strip to the cards whose fields contain what you type:

| You type | Shows |
| --- | --- |
| `flying` | cards with "flying" in any field (case does not matter) |
| `flying dragon` | cards with both words, in any fields |
| `"draw a card"` | the words together, in that order |
| `type:sorcery` | cards whose *type* field contains "sorcery" — any field name works |
| `rules:{gem}` | an icon, written as it is in Card Fields |
| `art:wyrm` | cards whose artwork's file name contains "wyrm" |
| `#12` | the twelfth card in the strip |
| `has:changes` | cards with their own layer changes or art framing (below) |

A word with a colon that does not name a field (`10:30`) is searched as it is.

While a filter is on, **‹ / ›** and Page Up / Page Down step through the
matching cards only, and in the box **Enter** goes to the next match (Shift+Enter
the previous one), carrying on from the other end like a find. **Escape** in
the box clears it. The count beside the box says how many cards match.

The card on screen always stays in the strip; if it does not match, its tile
is faded so you can see it is only there to keep your place. It is matched by
what it shows now, so a word you have just typed into Card Fields counts.

A filter changes nothing in the project. The strip keeps its order, card
numbers still count the whole set, *Export → Every card* and *Print → Every
card* still take every card, and the filter is not saved with the project.

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

## A change for one card

Sometimes one card needs its own tweak: a long title that has to sit a little
lower, a set symbol turned to fit beside unusual art, a plate recoloured for a
special card. Select the layer and tick **Properties → Layer → Only on this
card**. From then on, moving, resizing, turning or fading that layer, or giving
it a plain fill colour, changes it on the card on screen only. Every other card
keeps the layout's version, and the Layers panel marks the layer **this card**
while this card is shown.

Untick the box to put the layer back as the rest of the set has it — the card's
change is dropped, not copied to the other cards. To change the layout's
version of a marked layer, do it from a card that has not marked it.

- A layer's words already belong to each card through its slot; its stacking
  order, font and effects stay with the layout.
- Artwork slots cannot be marked: the picture changes with every card already,
  and how it is framed is each card's own (below).
  Nor can layers inside a group, and grouping a marked layer hands it back to
  the layout first.
- **Duplicate** copies a card's changes along with its words. A copied or
  pasted *layer* is a new layer of the layout, as it looked when copied.
- Exporting or printing every card draws each card with its own changes. A
  spreadsheet run in the batch dialog draws the layout, whichever card is on
  screen.
- Only a plain fill colour can be a card's own. A layer with a gradient can
  still be moved, resized, turned or faded for one card, but a change to its
  fill is a change to the layout.

This is Magic Set Editor's *options specific to this card*, for layout rather
than style settings.

### Seeing and undoing a card's own changes

A card with its own layer changes or its own art framing is marked **own** on
its tile in the strip, and the tile's tooltip says what: "Own changes: 2
layers, framed art". `has:changes` in the filter shows just those cards — the
quick way to check a set before printing.

While such a card is on screen, **Card Fields** says so under the fields
("This card's own: 1 layer, framed art") with a **Reset to layout** button. It
puts every layer the card made its own back as the layout has it and the art
back to the plain fit, in one step that **Ctrl+Z** undoes. Nothing on the other
cards changes. A layer marked *Only on this card* but not yet moved counts as
the card's own too: the next nudge to it is the card's.

This is the "reset all changes" a design tool offers on a component instance,
for a card in a set.

## Framing a card's artwork

Each card keeps how its picture sits in the art window. Select the art layer
(**Card Fields → Select layer**) and drag it on the card to move it, or turn
it with the rotate handle; the **Zoom** slider under the art field enlarges it
inside the window, keeping the part of the picture you moved into view where
it is. **Refit** puts the picture back to the plain fit — the whole window
filled, the picture centred.

- The framing is the card's own: other cards, even ones showing the same
  picture, keep theirs. Choosing a new picture for the slot starts it at the
  plain fit.
- It is kept relative to the window, so it means the same thing on export at
  any resolution, and every card is drawn with its own framing by *Export →
  Every card*, printing every card and tabletop sheets.
- **Duplicate** copies it. Updating a card from a spreadsheet keeps it, unless
  the sheet gives the card a different picture.
- A spreadsheet run in the batch dialog draws each row's picture at the plain
  fit; framing belongs to cards in a project.
- Flipping, cropping (**Properties → Image**) and stretching the picture with
  a side handle are kept per card too. The **Zoom** slider keeps the
  proportions; a picture shrunk below the window with a corner handle is shown
  as it is, and the slider steps on from there.
- A card whose picture is missing from the workspace keeps its framing, and
  shows it again once the file is back.

This is the zoom-and-drag that Hearthcards and Card Conjurer give a card's art,
and Magic Set Editor's image slice, kept per card.

## When a picture goes missing

A card remembers its picture by where it is in the workspace —
`assets/art/wyrm.png`. Move that file into a subfolder, rename it, or open the
project on a computer where it is somewhere else, and the card names a file
that is not there. The project still opens: the art window shows the
template's art box, and the card keeps the path, so putting the file back
brings the picture back as it was framed.

While any card names a missing picture, **Card Fields** says so under the
fields ("2 pictures are missing (3 cards)") with a **Relink…** button. The
dialog lists each missing picture and the cards that use it, with a choice of
every picture in the asset library:

- A picture with exactly one file of the same name anywhere in the library
  has it chosen already — the usual case after tidying files into folders.
  Files of the same name, or the same name with another extension, are listed
  first; when there are two, which one is meant is left to you.
- **Relink** points every card naming each chosen picture at its new place at
  once, and the card on screen shows it straight away. How each card framed
  the picture is kept — it is the same picture, somewhere else.
- **Look again** reads the library again, for a file you have just put back
  or copied in by hand.

Relinking marks the project unsaved; save to keep it. Like an update from a
spreadsheet, it is not a step **Ctrl+Z** takes back — relink to the old name
if you need to. Only card artwork is listed: a frame or background that is
missing stops the project opening, and the message names the file.

This is the *Relink* of a desktop-publishing program's Links panel, which
also searches a folder for files of the same name.

## Filling a project from a spreadsheet

In the batch dialog, **Add rows as cards** turns every row into a card in this
project using the column mapping — without rendering anything, so it is
instant, and the set can then be edited card by card. Art cells are looked up
exactly as a batch run looks them up; a name that is not in the library leaves
that card's art slot empty and is named in the dialog.

The rows are added after the cards already there. Loading a template gives a
project of one card, so a fresh set from a spreadsheet is: load the template,
**Add rows as cards**, then delete the template's own card.

## The cards as a spreadsheet, and back

**Save as CSV** in the strip writes every card in the project to
`workspace/batch/<project-name>.csv` — one row per card, one column per slot,
plus `qty` for its copies (`copies` if the layout has a slot called `qty`) and
`_id`, the card's own id. Open it in Excel, Numbers, LibreOffice or Google
Sheets and edit a whole set at once: proof-read every rules text in one
column, renumber costs, rename art, change counts.

Bring it back with **Batch → pick the file → Add rows as cards**. A row whose
`_id` names a card in this project *updates that card* rather than adding
another:

- only the columns that are mapped change anything — a column left out of the
  sheet or set to *ignore* keeps each card's own value;
- a blank text or art cell empties that slot, just as it does for a new card;
- the card's per-card layer changes and its place in the strip are kept;
- the card on screen is redrawn with its new values.

A row without an `_id`, or with one this project does not have — a row typed in
by hand, a sheet from another project — becomes a new card. A row copied in the
spreadsheet carries its original's `_id`; the first of the two updates the
card, the copy becomes a card of its own. The dialog says how many cards were
updated and how many added.

Details worth knowing:

- **Icons are written as their names** (`{element-fire}`), which read in any
  spreadsheet and turn back into the icon on the way in.
- **Artwork is written as its workspace path.** A picture that lives only
  inside the project file (placed while the local server was down) has no
  path, so its cell is left blank and the toast says so. A blank cell does not
  clear such a picture when the sheet comes back; put a name or a path in the
  cell to replace it.
- **The file is UTF-8 with a byte-order mark**, which is what makes Excel read
  accented letters and `—` correctly.
- **Spreadsheets treat a cell starting with `=`, `+`, `-` or `@` as a
  formula.** Rules text like `+1/+1 until end of turn` comes through Excel or
  Sheets as an error unless that column is imported as text (LibreOffice and
  Sheets both offer this in their import dialog; in Excel use *Data → From
  Text/CSV*).
- **Leading and trailing spaces in a cell are trimmed** on the way in, as they
  are for every spreadsheet the batch dialog reads.
- Saving over a sheet that is already there asks first — it may hold edits not
  yet brought back — and keeps the replaced file once as a `.bak`. Without the
  local server the sheet is downloaded instead.

## Getting the cards out

- **Export → Every card in this project** renders each card into
  `workspace/exports/<project-name>/`, named `001-<first words>.png` and so on.
  That folder is then a source in the print dialog like any batch run.
- **Print → Every card in this project** lays the cards straight onto sheets,
  by their copies, without writing a folder first.

Both go through the batch renderer, so a card is drawn exactly as a spreadsheet
row with the same values would be. A numbered layer (`{n:3}/{total}`, see
[`TEMPLATES.md`](TEMPLATES.md#card-numbering)) counts cards in strip order, in
the editor and in both of these.

## The file

A project from 0.7.0 on is version 2 and carries two more keys:

```json
{
  "format": "tcgforge.project",
  "version": 2,
  "canvas": { "...": "the layout, showing the active card's words and art" },
  "cards": [
    { "id": "card_k3j9x2a", "values": { "title": "Ember Wyrm", "art": "assets/art/wyrm.png", "stats": "4 / 4" }, "qty": 3,
      "overrides": { "obj_m2k8a1q": { "left": 130, "top": 82, "angle": 5 } },
      "framing": { "art": { "zoom": 1.6, "x": 0.12, "y": -0.05 } } },
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
- `overrides` (0.11.0) is a card's own changes, keyed by the layer's `tcgId`,
  holding only what differs from the layout. Written only when a card has
  some; the `canvas` is always the layout without them. Like `qty`, it needs no
  new version: an older TCG Forge shows every card with the layout.
- `framing` (0.17.0) is how each art slot frames its picture: `zoom` over the
  plain fit, `x`/`y` moving its centre by a fraction of the window's width and
  height, and `angle` when it is turned; since 0.18.0 also `flipX`/`flipY`,
  `stretch` (height scale over width scale) and `crop` (`{x, y, w, h}` as
  fractions of the whole picture) when set. Written only for slots that differ
  from the plain fit and hold a picture; an older TCG Forge ignores it and
  shows the plain fit (and a 0.17.0 build ignores the newer keys).
- `canvas` is exactly what it was in version 1, so an older TCG Forge opens a
  version-2 file as its active card. (Saving it from that older version keeps
  only that card.)
- A card picture that is missing from the workspace when the file is opened
  no longer stops it opening: the slot shows its placeholder and the card
  keeps the path (0.18.0). Any other missing image — a frame, a background —
  still refuses the file, since nothing could stand in for it.
- A version-1 file has no `cards` and opens as a project of one card. Nothing is
  written back until you save, and saving writes version 2.
