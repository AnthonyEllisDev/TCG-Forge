# Changelog

## 0.16.0 — deck sheets for virtual tabletops

- **Tabletop deck sheets.** A new **Tabletop** button lays a project's cards —
  or a folder a batch run left in `workspace/exports` — out as the grid
  Tabletop Simulator and similar tables import as a custom deck: up to ten
  across and seven down, the bottom-right slot kept for the face other players
  see while a card is in hand, at most 4096 px on a side (cards are scaled down
  to fit, never cropped). A deck of more than 69 cards becomes several sheets
  with the same card size. Copies are repeated as cards, from the strip's
  Copies box or a folder's `deck.json`; a card back from a folder fills the
  hidden slot and is written beside the sheets as `back.png`. The dialog lists
  each sheet's Width, Height and Number — what the table's import asks for —
  and a `tabletop.json` beside the sheets keeps them. See
  [`docs/TABLETOP.md`](docs/TABLETOP.md).

### Fixed

- **Exporting, printing or rendering while a card was still being shown** — a
  card switch waiting on its artwork — drew the card being left. *Export →
  Every card* and the batch preview then put that card back on screen under
  the other card's place in the list, and the next card switch saved it over
  the other card's words and picture. Every render now waits for the switch.
- **New during a card switch** finished the switch into the blank card: the
  last project's artwork on it, marked as saved.
- **Typing into Card Fields during a card switch** went onto the card being
  left and vanished when the switch finished. Keys are held for that moment.
- **A batch subfolder with a slash in it** (`Core Set/2`) wrote the images to
  `exports/2` — where `Promo/2` would overwrite them — and the per-card
  projects to `projects/core-set-2`, while the status line named a third
  place. The subfolder is now made into one name (`core-set-2`) used for all
  of them, and the status line shows it.
- **A batch run's per-card project files** picked up the artwork path of the
  card on screen when that card's picture could not be loaded, even for rows
  whose art cell was blank.

## 0.15.0 — finding a card in a big set

- **Filter the card strip.** A box beside the card count narrows the strip to
  the cards whose fields contain every word typed — `flying`, `"draw a card"`
  for words that belong together, `type:sorcery` to look in one field,
  `rules:{gem}` to find an icon, `art:wyrm` for a picture, `#12` for the
  twelfth card. ‹ / › and Page Up / Page Down then step through the matches
  only, Enter and Shift+Enter cycle through them from the box, Escape clears
  it and **/** jumps to it. The card on screen stays in the strip, faded, when
  it does not match, so you never lose your place. Filtering is a way of
  looking at the set, not a change to it: order, numbering, exports and prints
  are still the whole set, and nothing is saved. See
  [`docs/CARDS.md`](docs/CARDS.md#finding-a-card).

### Fixed

- **Loading a template or opening a project while a card was still being
  shown** — a card switch waiting on its artwork — finished the switch into
  the new layout: it showed the card being left, words and picture, marked as
  saved, and the next save wrote them into the project just opened. Both now
  wait for the switch to finish.
- **Copy and paste of a field layer kept the field**, so two layers shared one
  slot and the copy carried one card's words or art onto every card.
  Pasting now makes a plain layer, as Duplicate always has.
- **Grouping field layers took them out of Card Fields**, and the next card
  switch saved the card without its words and left them showing over the next
  card. Field layers can no longer be grouped; grouping the layers around them
  works as before.
- **Long batch file names lost their `.png`** — the server cut names at 120
  characters, extension included — and two cards whose names only differed
  past that point overwrote each other. Names are now cut before they are made
  unique, and the server keeps the extension when it shortens one.
- **The local server answered the body of a refused `POST` as a second
  request** (a `POST` outside `/api/`, or one whose `Content-Length` was not a
  number). It now closes the connection, as it already did for other refusals.

## 0.14.0 — bleed made from the card's edges

- **Bleed without redesigning the card.** Print shops trim inside what they
  print and ask for artwork that runs about 3 mm (⅛ in) past the edge. Export,
  Export → Every card and batch runs now take a **Bleed (mm)** amount: the card
  is rendered at its finished size with square corners, and its outermost
  strip is mirrored outwards to make the margin — the border, the frame or a
  full-bleed painting simply carries on. The dialog shows the size you will
  get (3 mm on a 750 × 1050 px card at 300 dpi is 820 × 1120 px).
- **Print sheets make the same bleed.** *Bleed comes from* in the print dialog
  chooses between *Mirrored from the card edges* (new, and the default) and
  *Already in the images*. The first suits every card designed at its finished
  size, which includes everything the print dialog draws itself; until now a
  bleed setting stretched those cards over the bleed, pushing the edge of the
  design past the cut line. See [`docs/PRINT.md`](docs/PRINT.md#bleed).

### Fixed

- **Exported images were a pixel or two off the card's size** — 749 or 751 px
  for a 750 px card, depending on the zoom at the time — so prints came out a
  hair too narrow or too wide. Exports are now exactly the card's size times
  the resolution.
- **Saving with *Embed images* on while switching cards could split the file
  between two cards**: its layout showed one card while it named the other as
  the one on screen, and reopening it put the first card's words over the
  second.
- **Art placed while a card switch was still loading its picture ended up
  beside it**, leaving two images in the slot and a stray one on every card.
  The new art now replaces whatever holds the slot.
- **A layout with a slot called `qty` lost its copy counts on the way back from
  a sheet.** The sheet writes the counts as `copies` in that case, but the batch
  dialog chose the `qty` column as the count. A column that feeds a slot is now
  the last choice for the count.
- **Save as template silently replaced a template of the same name** — and the
  name it suggests is the project's, so this was easy to do, shipped templates
  included. It now asks first, and *Cancel* goes back to the dialog as typed.
- **A card whose art cell held a `/files/…` URL was left out of an embedded
  project** without a word. Such a cell is now read as the workspace path it
  points at.
- **A font file with a `"` in its name never drew**, though it was listed (and,
  for an icon font, its icons appeared in the palette).
- **`tools/build_icon_font.py` refused to build when another font in the folder
  used U+F8FF**, saying only "No icons to build". New icons now take the lowest
  free code point, and the warnings that explain an empty build are printed.

## 0.13.0 — cards to a spreadsheet and back

- **Save as CSV.** A new button in the card strip writes every card in the
  project to `workspace/batch/<project>.csv`: one row per card, one column per
  slot, its copies, and its id. Icons are written by name (`{gem}`), artwork by
  its workspace path, and the file opens cleanly in Excel, Numbers,
  LibreOffice and Google Sheets.
- **…and back again.** Load that sheet in the batch dialog and **Add rows as
  cards** updates the same cards in place — only the mapped columns change, and
  each card keeps its per-card layer changes and its place in the strip. Rows
  without a matching id are added as new cards, as before. Proof-read a whole
  set's rules text in one column, change every cost at once, rebalance the
  counts. See [`docs/CARDS.md`](docs/CARDS.md#the-cards-as-a-spreadsheet-and-back).
- Spreadsheet columns whose names start with `_` are never matched to a slot.

### Fixed

- **Files with `%` in their names could not be opened, and saving could write
  to a different file.** The server decoded workspace paths a second time, so
  a project it listed as `set 100%41.json` was looked for as `set 100A.json`;
  such files could not be read or moved to the bin either.
- **Rebuilding the icon font could give a new icon a removed icon's code
  point**, so cards that used the removed icon silently showed the new one. A
  removed icon's code point now stays reserved (and comes back with the file),
  and the builder says so.
- **A second icon font drew its icons as the first font's.** Both started at
  U+E000, and the canvas draws a shared code point from whichever font comes
  first. The builder now starts a new font after the others in its folder, and
  the editor leaves out an icon whose code point another font already has,
  with a warning in the console.
- **The Icons palette could insert into a text box that was no longer on
  screen** — Properties → Text after the selection changed — so the click did
  nothing visible. It now falls back to the first Card Fields box.
- Workspace files are written exactly as sent, with no line-ending translation
  on Windows.

## 0.12.0 — icons in rules text

- **Icons sit in the text.** Type `{gem}`, `{element-fire}` or any icon's name
  in braces into Card Fields, a spreadsheet cell, Properties → Text or straight
  onto the card, and the symbol appears in the line of text — wrapping,
  shrinking with auto-fit and printing with the words around it. An **Icons**
  palette under Card Fields inserts one at the caret. A name that is not an
  icon is left as typed, so card-number and filename patterns are untouched.
  The sample spreadsheet now uses a few.
- **Your own icons are one command away.** `tools/build_icon_font.py` turns a
  folder of SVGs into a TrueType font (standard library only): filled shapes,
  round-capped strokes and transforms come through, and a rebuild keeps every
  icon's code point so saved cards never change symbol. The shipped
  `Forge-Icons.ttf` is built from the sample icons. Any icon font with named
  glyphs in the Private Use Area works the same way. See
  [`docs/ICONS.md`](docs/ICONS.md).
- **`--allow-host NAME`** lets a server started with `--host` answer to another
  name.
- Toasts are now read out by screen readers, and errors interrupt.

### Fixed

- **A project saved with *Embed images* while one of its pictures was missing
  could never be opened again.** The server's "not found" reply was embedded
  as the picture. A picture that cannot be read is now kept by its path, so the
  project opens again as soon as the file is back.
- **Library files with `#` or `?` in their names could not be placed**, shown or
  reopened — the name cut the address short. Files dropped into the asset
  folders by hand keep their own names, so this was easy to hit.
- **Artwork that would not load was forgotten after a save and reopen.** Its
  path was kept while the card was on screen, but after reopening the project,
  stepping to another card wrote "no art" over it.
- **"Also save an editable project file per card" overwrote projects of the
  same name without a backup.** It now keeps a `.bak`, as an ordinary save does.
- **Opening a dialog from the keyboard left the focus behind it** — on the
  button that opened it — for the Open and Batch dialogs, so Enter opened the
  dialog again.
- **Started with `--host 0.0.0.0`, the server answered to any name at all**,
  which let a web page reach it through its own DNS record. It now answers to
  addresses, this computer's name and `--allow-host` names only.
- **Two saves to the same file at the same moment could fail** with a spurious
  "not found", because both used the same temporary file.
- A request whose body was not a JSON object was answered with a server error
  instead of a plain refusal.

## 0.11.0 — changes for one card

- **A card can change a layer for itself.** Tick **Properties → Layer → Only on
  this card** and moving, resizing, turning, fading or recolouring that layer
  changes it on the card on screen only — a long title set a little lower, a
  badge turned to sit beside unusual art — while every other card keeps the
  layout. The Layers panel marks the layer **this card**; unticking the box puts
  it back as the rest of the set has it. Exporting and printing every card draw
  each card with its own changes, **Duplicate** copies them, and project files
  keep them beside the layout rather than in it, so older versions still open
  the layout. See [`docs/CARDS.md`](docs/CARDS.md#a-change-for-one-card).

### Fixed

- **Saving while a card was still switching saved the wrong card.** Stepping to
  a card whose artwork took a moment to load and pressing **Ctrl + S** at once
  wrote the card being left over the card being shown, and marked the project
  saved. Saving now waits for the switch to finish.
- **Undo pressed during a card switch left two pictures in one art slot**, and
  two undos pressed quickly could land on the wrong step and lose the steps
  after it. Undo and redo now take their turn one at a time and wait for a
  switch to finish.
- **Saving a new project under a name another project already had replaced
  that project without asking.** Two cards both left as *Untitled Card* was
  enough. The first save, and **Save As**, now ask before replacing a file.
- **A layer name typed in Properties was lost** if the next click was on another
  layer on the card. The name is now kept as you type.
- **Raising or lowering several layers at once** did nothing or swapped them,
  depending on the order they were picked in. They now move together as a
  block and keep their order.
- **A font from the library whose file name has a hyphen or underscore**
  (`Caladea-Bold.ttf`) was applied under a name the browser did not know, so
  the text stayed in the default face.

## 0.10.0 — card numbering

- **Cards can number themselves.** Give a text layer a pattern in
  **Properties → Text → Card numbering** — `{n:3}/{total}`, `No. {n} of {total}`
  — and it shows the card's place in the set: `007/060`. In the editor the set
  is the project's card list, so adding, deleting, reordering or switching cards
  renumbers at once; in a batch run, and when exporting or printing every card,
  each row is numbered in order, the same `{n}` its filename uses. `{n:3}` and
  `{total:3}` pad with zeros. While a pattern is set it owns the text: the layer
  cannot be typed into, and the Layers panel marks it `#`.
- **Classic Spell numbers its cards** in the bottom-right corner, and the sample
  spreadsheet no longer types `001`–`006` into its footer by hand.
- The mapping dropdowns in the batch dialog now say which column they are for,
  for screen readers.

### Fixed

- **Typing straight onto the card did not count as a change until you clicked
  away.** Until then the project read as saved, so **Open**, **New**, loading a
  template or closing the tab threw the typing away without asking.
- **The Properties Text box kept the old words after an edit made elsewhere.**
  Change a title in Card Fields (or on the card) with that layer selected, then
  type in the Text box, and the old title came back with your keystroke on the
  end. The box now follows every change.
- **Placing a background or texture left the Layers list out of order.** The
  new layer is sent to the back, but the list still showed it on top, so
  dragging a row there moved a different layer from the one dragged. Properties
  also showed the picture's size from before it was fitted to the card.
- **Locked layers could be moved and deleted from the keyboard.** Picking one in
  the Layers panel and pressing an arrow key or **Delete** moved or removed it;
  the align and distribute buttons moved it too. Locked layers are now left
  where they are, and **Delete** says why nothing happened.
- **A spreadsheet column set to *ignore* was matched again** the next time the
  batch dialog was opened, so its values went back onto every card.

## 0.9.0 — distribute

- **Distribute layers evenly.** Two new buttons at the end of the alignment
  group in the view toolbar, ⋯ and ⋮, space three or more selected layers so the
  gaps between them are equal — across the card or down it. The first layer
  stays where it is and the last ends where the furthest edge was, so a row of
  pips or icons of different widths lines up without measuring. The buttons are
  enabled once three layers are selected; **Alt + Shift + H** and
  **Alt + Shift + V** do the same from the keyboard. One undo step puts them
  back.
- The zoom readout in the view toolbar, which resets the zoom to 100% when
  clicked, can now be reached with **Tab** and used with **Enter** or **Space**.

### Fixed

- **An edit made while a project was saving was marked as saved.** Saving takes
  a moment, and the editor stays live during it; anything typed in that moment
  was not in the file, but the project was marked saved anyway, so New and Open
  would discard it without asking. The project now stays marked unsaved.
- **The export dialog's Cancel and the print dialog's Close could still be used
  while every card was being drawn.** 0.8.0 kept Escape and ✕ waiting for the
  drawing to finish, but the buttons closed the dialog at once, the run then put
  its snapshot over whatever was typed next, and a save pressed mid-run could
  write one card's words over another's. The buttons wait too now, and say why.
- **Escape during Preview first row closed the batch dialog** while the preview
  still held the canvas, so an edit made straight afterwards was wiped when the
  preview finished. The dialog waits for the preview.
- **A layer could not be renamed with a real double-click.** Picking the layer
  redrew the whole list between the two clicks, so the browser never saw a
  double-click; and clicking into the rename box to move the caret ended the
  rename. Selecting a layer now restyles the rows in place.
- **A picture imported from the Fonts tab disappeared.** It was written into
  `assets/fonts`, which only lists font files. It goes to `assets/art` now, and
  the message says where each file went.

## 0.8.0 — copies per card

- **Each card in a project says how many copies the deck wants.** The card
  strip has a **Copies** box for the card on screen; tiles with more than one
  show a `×3` badge, and the strip gives the deck's total when it is not simply
  one of each. A card is still one design, drawn once — the count is used where
  cards are laid out or listed:
  - **Print → Every card in this project** repeats each card by its count, with
    a checkbox to print one of each instead.
  - **Export → Every card in this project** writes a `deck.json` beside the
    images, so the exported folder prints as the same deck. It is rewritten on
    every export, so a list from an earlier export never outlives its counts.
  - **Add rows as cards** takes each card's count from the batch dialog's
    quantity column.
  - **Duplicate** copies the count along with the words.
- A card's count is saved as `qty` on its entry in `cards`, and only when it is
  more than one, so a set of singles saves exactly as before. Older files open
  with every card at one. See [`docs/CARDS.md`](docs/CARDS.md).
- Template rows, saved projects in the **Open** dialog, asset tiles and layer
  rows can now be reached with **Tab** and chosen with **Enter** or **Space**.
  The Open dialog's project list was not reachable from the keyboard at all.

### Fixed

- **Closing the export or print dialog while every card was being drawn threw
  away what was typed next.** The run borrows the canvas and puts it back when
  it finishes, so an edit made in between was overwritten, with nothing on the
  undo stack. Escape and ✕ now wait for the drawing to finish (the batch
  dialog's ask the run to stop and close once it has).
- **A blank art cell in a batch run used the picture on the card on screen.**
  Each row starts from the canvas as it is, and since 0.7.0 that canvas is one
  card of a project, with that card's art in it — so every row that left its art
  blank got that card's picture. A blank art cell now means the layout's own
  art window, as it always said it did, and as **Add rows as cards** already
  treated it.
- **Preview first row** pressed during a batch run unlocked the undo history
  under the run and put a spreadsheet row back on the canvas when it finished.
  Only one run can have the canvas at a time now, and the preview waits.
- Loading a template kept a note of artwork the previous project's card could
  not load, and saved that missing file's name into the new card.
- **Ctrl/⌘ + S** typed while the caret was still in the project-name box saved
  under the old name.
- The dialog's ✕ button now has an accessible name.

## 0.7.0 — multi-card projects

- **A whole set in one project.** A strip under the canvas lists every card in
  the project; click a card, or press **Page Up** / **Page Down**, to put it on
  the canvas. A card is the values in its Card Fields — its words and its
  artwork — and everything else is the layout, which every card shares, so
  moving the frame or changing a font is one edit for the whole set. **+ Card**
  adds an empty card, **Duplicate** a copy of the one on screen; cards can be
  moved along the list and deleted. Documented in
  [`docs/CARDS.md`](docs/CARDS.md).
- **Spreadsheet rows as cards.** The batch dialog's **Add rows as cards** adds
  every row to the project as a card you can go on editing, using the same
  column mapping and asset lookup as a batch run, without rendering anything.
- **Export every card** into `workspace/exports/<project>/`, and **print every
  card** straight onto sheets from the print dialog.
- **Clear** in Card Fields takes artwork out of a slot and puts the placeholder
  it replaced back.
- The project file is now version 2, with a `cards` list and `activeCard`.
  Version-1 projects open as a project of one card and are not rewritten until
  saved; `canvas` means the same in both, so an older version still opens a new
  file as its active card.

### Fixed

- **A project that failed to open could be saved over the one that was open.**
  Opening a file whose artwork had gone from the workspace showed an error, but
  the open card had already been resized and renamed after the file that never
  opened, and was still marked saved — so the next **Save** wrote that into the
  project that was open. A project or template that fails to load now leaves
  everything as it was.
- An undo pressed within a quarter of a second of an edit skipped that edit and
  went back to the one before, and the skipped edit could never be redone.
- A batch preview or run marked a project that had just been saved as unsaved,
  though the card is put back exactly as it was afterwards.
- A font size set in Properties on an auto-fit text layer was taken back the
  next time the text was edited. The size set there is now the size the layer
  fits to.
- **Replace…** on a picture that had not come in through an art slot kept the
  old picture's scale, so a small replacement for a large picture landed at a
  fraction of the size. It now takes the room the old picture had.
- In the print dialog, switching between double-sided and gutterfold ticked
  **Number the sheets** again after it had been unticked.

## 0.6.0 — conditional layers

- **Layers that follow a field**: any layer can now be tied to a field with
  **Properties → Layer → Show this layer**, and is then shown only while that
  field holds something — or, the other way round, only while it is empty. An
  empty spreadsheet cell now takes the ornament behind a field off the card as
  well as the words: the cost gem on a land, the power/toughness plate on a
  spell. It is worked out on every change, so the editor, the batch renderer,
  exports and print sheets all agree without being told. A conditional layer is
  marked `if cost` (or `unless cost`) in the Layers panel, and its visibility
  toggle is handed to the condition. Stored as `tcgShowIf` on the layer;
  documented in [`docs/TEMPLATES.md`](docs/TEMPLATES.md).
- The Classic Spell template has a cost gem and a stats plate that follow their
  fields, and the sample set's sorcery now leaves its stats blank to show it.
- Shipped templates refer to their images by workspace path rather than by a
  URL with the builder's port in it.

### Fixed

- Keyboard shortcuts reached through open dialogs. With focus on a dialog's
  button, **Delete** removed the layer selected behind it, the arrow keys nudged
  it, and **Ctrl/⌘ + O** or **B** swapped the dialog for another — leaving a
  confirmation unanswered or a print run writing into a dialog that had gone.
  The editor's keys now stand aside while a dialog is open.
- **Duplicate** and **copy/paste** of several layers at once put the copies
  hundreds of pixels off the card, because a multi-layer selection holds its
  members' positions relative to itself.
- Images inside a group were saved with the full address the browser had
  resolved, port included, so grouped artwork broke whenever the launcher came
  up on a different port — and **Embed images in project file** skipped them.
  Grouped images are now handled like every other image.
- Two batch rows that filled the filename pattern the same way — `{title}` over
  two printings of one card — wrote the same file twice. The first card was
  lost and the deck list counted the survivor for both. Repeated names now get
  `-2`, `-3` and so on within a run.
- The batch preview reported the default pattern's filename whatever pattern
  was typed.
- `POST /api/write` with the path `.` wrote a temporary file beside the
  workspace folder rather than inside it, and `/api/trash` would try to bin the
  whole workspace. The workspace root is no longer a path either will accept,
  and a failed write no longer leaves its temporary file behind.
- Panel headers could only be opened and closed with the mouse, so a panel left
  collapsed was out of reach from the keyboard. They are now focusable buttons
  that answer Enter and Space and report `aria-expanded`.

## 0.5.0 — deck quantities

- **Per-card quantities**: a batch file can now say how many of each card the
  deck wants. Point **Quantity column** at a column of counts — one called
  `qty`, `quantity`, `count`, `copies`, `number` or `amount` is picked up on its
  own — and the run writes a small `deck.json` beside the rendered images
  recording what it found. The print sheet builder finds that file by itself and
  lays out the right number of copies, so a deck is `4 ×` a card rather than four
  duplicated spreadsheet rows. Each card is still rendered once: the copies are
  made at lay-out time from one decoded image, which costs almost nothing. Untick
  **Repeat each card by its deck quantity** in the print dialog to go back to one
  of each; a folder with no list behaves exactly as it always did. Documented in
  [`docs/BATCH.md`](docs/BATCH.md) and [`docs/PRINT.md`](docs/PRINT.md). No new
  server endpoint.
- Where a folder of card backs holds one per design, the backs are repeated
  alongside the fronts, so "one back per card" still means one per design.
- The sample spreadsheet has a `qty` column, which makes its six cards eighteen.

### Fixed

- Loading a template after opening a project left **Save** aimed at that
  project's file. The top bar had already swapped to the template's name, so
  the next save quietly wrote the template over a project the user had not
  touched, with nothing on screen to suggest it was about to happen. Loading a
  template now starts an unsaved card, as **New** does.
- Reopening the batch dialog showed "No data loaded yet" and an empty column
  map while it still held the whole spreadsheet behind them — so **Render set**
  would render the previous file again, mapped onto slots the current card may
  no longer have. A reopened dialog now shows the data it is holding, and
  re-matches any column whose slot has gone.

## 0.4.0 — card backs

- **Card backs, duplex and gutterfold sheets**: the print sheet builder can now
  put a second side on the paper. **Double-sided** writes a back page after
  every front page, laid out mirrored about the page centre line so each back
  lands behind its own card once the printer turns the sheet over; **gutterfold**
  puts fronts and backs on one page either side of a dashed fold line, with the
  backs upside down, for anyone without a duplex printer. Backs come from a
  folder under `workspace/exports` — one image for the whole set, or one per
  card paired in file order. A **flip edge** setting covers both ways a printer
  can turn the paper, and a **back shift** in millimetres cancels the register
  drift every duplex printer has. Documented in
  [`docs/PRINT.md`](docs/PRINT.md). No new server endpoint.
- Sheets can be numbered in the bottom margin — project name, sheet number and
  which side — so a stack of loose double-sided pages can be paired again.
  Turning on a back mode turns this on with it.
- Repeated cards are decoded once instead of once per copy, which makes a full
  page of a single card noticeably faster to build.

### Fixed

- A batch run that could not put the canvas back afterwards — a piece of
  artwork moved or deleted while the dialog was open would do it — left the
  history lock held. Undo and redo then did nothing for the rest of the session
  and no further edits were recorded, with nothing on screen to say why. The
  same fault was in the batch preview.
- Opening a project replaced the current card without asking, so unsaved work
  disappeared. **New** and **load template** have always asked; **Open** now
  does too.
- `Ctrl/⌘ + Z` while typing in a Card Fields box rolled back the whole canvas
  instead of undoing the typing, and left the box showing text the card no
  longer had. Undo and redo are now left to the field when the caret is in one.
- Importing a picture without the local server running stored it as a `blob:`
  URL, which stops existing when the tab closes — the last place in the app
  where that could happen. It is inlined instead, so the artwork survives a
  reload and a saved project still finds it.
- Dismissing the batch dialog with Escape or the ✕ during a run left the run
  going against a dialog that was no longer on screen and could no longer be
  stopped. Both now cancel it, as the Close button already did.

## 0.3.0 — print sheets

- **Print sheets**: lay finished cards out on A4, US Letter, US Legal, A3 or
  Tabloid at their true physical size, with crop marks or full-page cut lines,
  bleed handling and adjustable margins and gaps. Print the current card
  repeated, or a whole folder rendered by the batch generator. Output is a
  single PDF — which carries a real page size, so "print at 100%" means
  something — or one PNG per page. Reachable from the top bar or `Ctrl/⌘ + P`;
  documented in [`docs/PRINT.md`](docs/PRINT.md). No new server endpoint.

### Security

- The workspace API now checks `Origin` and `Host`. Without them, any web page
  you had open could `POST` to `127.0.0.1` and rewrite your workspace, and a
  DNS record pointed at loopback could read it back. Requests without an
  `Origin` — curl, CI, scripts — are unaffected. `/files/` no longer sends
  `Access-Control-Allow-Origin: *`.
- A request body larger than the limit, or sent chunked, now closes its
  connection instead of leaving the unread bytes to be parsed as the next
  request.

### Fixed

- Artwork picked from disk is copied into the workspace instead of being
  referenced by a `blob:` URL, which stopped existing when the tab closed — so
  a saved project pointed at nothing and the art was gone on reopen, with no
  error anywhere. Affected the image import button, the Card Fields art picker,
  Properties → Replace, and files dropped onto the canvas.
- "Clip to card" could not be switched off again after a reload: the marker
  identifying our clip path was not persisted.
- Snapping did nothing while dragging more than one layer — the members of the
  selection were treated as snap targets and matched themselves at zero
  distance.
- An export that failed left the guide suppressor latched on, so smart guides,
  the safe zone and the bleed guide stayed invisible for the rest of the
  session, and a transparent-background export left the background cleared.
- Escape while renaming a layer committed the rename it was meant to cancel.
- The template browser never highlighted the loaded template: it compared a
  display name to a slug. `/api/templates` now returns an `id`, and the list
  redraws when a template or project is loaded.
- A batch data file with headers and no rows discarded the spreadsheet that was
  already loaded before reporting the error.
- A file disappearing mid-scan no longer fails a whole directory listing.
- Dialogs now trap Tab and are labelled by their title; focus returns to
  whatever opened them. `aria-modal` does none of this on its own.
- `Ctrl/⌘ + O` now opens a project, as the shortcut list always claimed.
  `Ctrl/⌘ + C` and `V` no longer also run the browser's own copy and paste.
  The un-interceptable `Ctrl+N` row was removed from the list.
- Dropped the write-only `tcgLocked` property; lock state already round-trips
  through the Fabric properties the UI actually reads.

## 0.2.0 — batch generation

- **Batch generator**: render a whole set from a CSV/TSV/JSON file. Column-to-slot
  mapping with auto-matching, first-row preview, filename patterns, export
  subfolders, optional per-card project files, live progress and cancel.
  Reachable from the top bar or `Ctrl/⌘ + B`; documented in `docs/BATCH.md`.
- `POST /api/export` now accepts `folder` and `overwrite`.
- New `workspace/batch/` folder with a worked six-card example.
- Added `tools/smoke_test.mjs` and a GitHub Actions workflow: static checks on
  Python 3.8/3.12, module parsing, template validation, a no-remote-assets guard
  and a headless browser smoke test.
- Fixed `.gitattributes` so `run.sh` keeps LF endings on Windows checkouts.

## 0.1.0 — first public build

Initial release: local launcher, workspace file API, Fabric.js 6 editor with
layers, smart guides and undo/redo, template system with named slots, asset
library with font loading, layer effects (gradients, strokes, shadows, blend
modes, image adjustments), project save/open and PNG/JPEG export.
