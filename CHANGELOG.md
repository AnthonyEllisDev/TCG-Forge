# Changelog

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
