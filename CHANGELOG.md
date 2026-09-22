# Changelog

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
