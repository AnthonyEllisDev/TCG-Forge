# Changelog

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
