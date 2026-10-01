# Architecture

TCG Forge is deliberately boring under the hood: a static front end talking to a
small file server. There is no build step, no framework and no transpiler, so
anything you read here is exactly what runs.

```
                       ┌──────────────────────────────┐
 run.sh / run.bat ───▶ │  launch.py                   │
                       │  · serves web/ on 127.0.0.1  │
                       │  · REST API over workspace/  │
                       └──────────────┬───────────────┘
                                      │ fetch()
                       ┌──────────────▼───────────────┐
                       │  browser (the whole UI)      │
                       │  · Fabric.js canvas          │
                       │  · ES modules, no bundler    │
                       └──────────────────────────────┘
```

## Back end — `launch.py`

Python 3.8+, standard library only. It serves `web/` statically, streams
workspace files under `/files/…`, and exposes the JSON API documented in
[`API.md`](API.md).

Safety rules it enforces:

- every path is resolved against the workspace root and rejected if it escapes
- uploads are capped at 64 MB and must be base64 data URLs
- deletes are moves into `workspace/.trash/<date>/`
- the socket binds to `127.0.0.1` unless `--host` says otherwise
- requests carrying a foreign `Origin`, or a `Host` this server does not answer
  to, are refused — see below

**Loopback is not a security boundary.** Any page you visit can `POST` to
`127.0.0.1`, and a form-style content type needs no CORS preflight, so a server
that simply trusts local connections hands the whole workspace to whichever
website you happen to have open. Two checks close that:

- **`Origin`** must match the host the request was sent to. Absent is fine —
  curl, CI and plain navigation send none — but a foreign one is refused.
- **`Host`** must be a name this server answers to. Without it, an attacker can
  point their own DNS record at `127.0.0.1`, making their page same-origin with
  yours. Binding to something other than loopback with `--host` is a deliberate
  choice to serve the network, so the server then also answers to any IP
  address (an address cannot be rebound — only a name can), to this
  computer's own name (`hostname`, `hostname.local`) and to every
  `--allow-host` name. Any other name is still refused.

A refused request is answered `403` and the connection is closed, because its
body was never read and the socket can no longer be trusted to start at a
request line. Nothing sends `Access-Control-Allow-Origin`.

If the API is unreachable — the server was stopped, or the page was opened some
other way — `core/api.js` detects it at startup and the app degrades instead of
breaking: the status pill turns red, saving becomes a browser download, and the
asset library only holds files imported during that session.

Note that the launcher is required to *start* the app: browsers refuse to load
ES modules from `file://` URLs, so `web/index.html` cannot be opened directly.

## Front end

```
web/
├── index.html          markup for every panel; ids are the contract with the JS
├── css/
│   ├── theme.css       design tokens + form controls  ← restyle here
│   └── app.css         layout and components
├── vendor/fabric.min.js
└── js/
    ├── main.js         bootstrap and start-up order
    ├── util/
    │   ├── dom.js      $, el(), colour and file helpers
    │   └── bus.js      pub/sub + the canonical event-name list
    ├── core/
    │   ├── api.js      backend client, online/offline detection
    │   ├── state.js    card geometry, current project, persisted settings
    │   ├── objects.js  object factories + the custom props we persist
    │   ├── editor.js   the Fabric canvas: zoom, snapping, ordering, clipboard
    │   ├── history.js  undo/redo snapshots
    │   ├── effects.js  fills, strokes, shadows, filters, crop
    │   ├── assets.js   asset index and font registration
    │   ├── icons.js    icons in text: reads icon fonts, {name} tokens
    │   ├── templates.js template load/save and the slot system
    │   ├── cards.js    multi-card projects: the card list and switching
    │   ├── batch.js    spreadsheet parsing and set rendering
    │   ├── printSheet.js page geometry and sheet composition
    │   ├── pdf.js      a small one-JPEG-per-page PDF writer
    │   └── project.js  serialise, save, open, export
    └── ui/
        ├── panels.js      collapsing panels, dock splitters
        ├── toolbar.js     top bar, card setup, view toolbar, status bar
        ├── layers.js      layer list, drag reorder, rename, lock, hide
        ├── properties.js  the contextual property inspector
        ├── assetPanel.js  thumbnail browser, click-to-place, drag & drop
        ├── templatePanel.js
        ├── fieldsPanel.js the form view of a template
        ├── iconPalette.js the icon palette, and {name} typed into a box
        ├── batchPanel.js  the batch generator dialog
        ├── printPanel.js  the print sheet dialog
        ├── cardStrip.js   the card list under the canvas
        ├── shortcuts.js   keyboard map
        └── dialogs.js     modal + toasts
```

### Rules of the layout

**UI modules never touch Fabric directly.** They call `editor.*` and listen on
the bus. That is what keeps it possible to change the canvas library, or add a
second view of the same document, without rewriting panels.

**The bus is the only cross-module channel.** Event names live in
`util/bus.js`; if you add one, add it there so the list stays readable.

| Event | Meaning |
| --- | --- |
| `editor:selection` | selection changed (payload: array of objects) |
| `editor:objects` | the layer list changed |
| `editor:modified` | something dirtied the project (drives history + autosave dot) |
| `editor:card` | card size, dpi, radius or background changed |
| `editor:zoom` | zoom level changed |
| `history:changed` | undo/redo availability |
| `assets:changed` / `fonts:changed` | library rescanned |
| `icons:changed` | an icon font was read; payload is the icon list |
| `templates:applied` | a template was loaded |
| `project:changed` | project name / path / dirty flag |
| `project:cards` | the card list changed, or another card is on screen |
| `ui:status` | backend went online or offline |

**State lives in one place.** `core/state.js` holds the card geometry, the
current project and the persisted UI settings (localStorage). Fabric owns the
layers themselves; we do not keep a second copy of them.

### Custom properties

Fabric serialises its own properties. TCG Forge adds a small set, listed in
`core/objects.js` as `CUSTOM_PROPS`, and passes that list to
`canvas.toObject()` so they round-trip through save/load:

| Property | Purpose |
| --- | --- |
| `tcgName` | label in the Layers panel |
| `tcgKind` | `frame`, `art`, `icon`, `background`, `text`, `shape`, `group` |
| `tcgSlot` | template field this layer is bound to |
| `tcgAsset` | workspace-relative source path for an image |
| `tcgArtBox` | the art window an image was fitted into |
| `tcgAutoFit`, `tcgFitHeight`, `tcgFitSize` | auto-shrinking text |
| `tcgUppercase` | force uppercase on field updates |
| `tcgClip` | clip this layer to the card rectangle |
| `tcgCardClip` | marks the clipPath `tcgClip` installed, so it can be removed again |
| `tcgShowIf` | a slot name (`"cost"`, or `"!cost"` for the reverse): the layer is shown only while that slot is filled |
| `tcgNumbering` | a pattern (`"{n:3}/{total}"`): the text layer's text is written from the card's place in its set |
| `tcgPlaceholder` | on art placed in a slot: the serialised layer it replaced, so the slot can be emptied again |
| `tcgBase` | on a layer the card on screen has changed for itself: the layout's own values for what it changed. In undo snapshots only — saved files never carry it |
| `_baseWidth`, `_baseHeight` | natural image size, used by the crop sliders |

> One gotcha worth knowing: serialised Fabric objects use capitalised type names
> (`"Image"`, `"Textbox"`) while live instances report lower case (`"image"`).
> Code that walks raw JSON compares case-insensitively — and walks into groups:
> `forEachImageJSON()` in `core/objects.js` is the one way to visit every image
> in saved canvas JSON, so a grouped image is relinked and embedded like any
> other.

> A second one: this list is passed down into an object's `clipPath` as well, so
> a marker parked there survives. It is **not** passed into a `fill`, so nothing
> can be stored on a `Gradient` — `effects.js` reads a gradient's angle back out
> of its coordinates instead of keeping a copy.

### Rendering and coordinates

Objects are positioned in **card coordinates** (0,0 to width,height at the
card's pixel size). Zoom is applied with `canvas.setZoom()` plus a matching
`setDimensions()`, so nothing has to be rescaled when the view changes and
exports are always computed from the true card size.

Rounded card corners are a canvas-level `clipPath`, which means they clip the
background too and survive export.

An icon in text (`docs/ICONS.md`) is a Private Use Area character drawn by
font fallback: `core/icons.js` wraps Fabric's `_getFontDeclaration()` so every
text run's CSS font lists the icon fonts after the layer's own, and Fabric's
width measurements go through the same declaration. When an icon font arrives,
`editor.remeasureText()` clears Fabric's width cache and re-fits every text
layer. `{name}` tokens are turned into characters on the way in —
`setFieldText()` (Card Fields, batch rows, card switches), the Properties text
box, and the end of on-canvas editing — so the text always holds the
character, never the token.

Smart guides, the safe zone and the bleed guide are painted in an `after:render`
hook straight onto the canvas context. An `exporting` flag suppresses them while
`toDataURL()` runs, so guides never end up in the output.

Anything that arranges layers works from `getBoundingRect()`, which is in card
coordinates, rather than from `left`/`top`: a member of a multi-layer selection
keeps those relative to the selection's centre. `align()` and `nudge()` only add
deltas, so they can stay inside the selection. They, `distribute()` and
`remove()` all leave locked layers alone: a locked layer can still be picked
from the Layers panel, so the lock is honoured by the commands, not only by the
canvas. `distribute()` measures every
layer first, then drops the selection (`memberSelection()`), moves each layer
so the gaps between neighbouring bounding boxes are equal — the first layer
stays, the last ends at the furthest edge — and selects them again so the
selection box is drawn around where they now are. It needs three layers and
returns `false` without moving anything below that.

### History

`core/history.js` snapshots `{card, canvas}` as a JSON string on a debounced
`editor:modified`, capped at 80 steps. Undo and redo take any snapshot still
waiting out the debounce first, so an edit made a moment before Ctrl+Z is the
one that is undone. Restoring a step awaits its images, so steps queue one
behind another rather than loading over each other, and a step is refused while
something else holds the history lock (a card switch, a batch run). Restoring re-applies the card geometry
and calls `canvas.loadFromJSON`. Snapshots are strings so no live object can be
mutated out from under a step.

### Batch rendering

`core/batch.js` is deliberately thin: it snapshots the canvas, and for each
spreadsheet row restores that snapshot, writes values into slots via the same
`setFieldText` / `setFieldImage` the Card Fields panel uses, renders, and saves.
Restoring per row is what stops state (auto-fit font sizes, swapped art) leaking
from one card into the next, and the snapshot is restored again in a `finally`
so a failed row can never leave the user's canvas in a half-edited state.
History is locked for the duration, so a 200-card run does not flood undo.

Conditional layers need nothing from the batch renderer either.
`editor.applyConditions()` shows or hides every layer carrying a `tcgShowIf` by
whether its slot holds anything, and `editor.touch()` calls it on every change —
so the `setFieldText` a row goes through has already settled the ornaments by
the time the card is rendered, and the snapshot restore puts them back after.

Card numbering works the same way from the other side. `editor.applyNumbering()`
rewrites every text layer carrying a `tcgNumbering` pattern from
`editor.cardNumber()`, and runs from `touch()`, at the end of `loadJSON()` and
on every `project:cards` event (a card added, deleted, moved or switched to).
`cardNumber()` is the project's active card and list length, unless a run has
set `editor.setNumberContext({n, total})`: `runBatch()` sets it to the row
before each row's snapshot restore, `renderRow()` takes it as an option for the
preview, and both set it back to `null` in the `finally` that restores the
canvas. A numbered layer is never a slot and never a card value, so nothing in
`cards.js` knows about it.

A quantity column does not change any of that. Each design is still rendered
once; the counts are collected as the run goes and written beside the images as
a `deck.json`, which is the only thing the print sheet builder needs in order to
lay out a deck rather than a set. Expanding at print time instead of at render
time is the whole point: four copies of a card are four `drawImage` calls
against one decoded picture, not four renders and four files.

### Multi-card projects

`core/cards.js` keeps a card as the values in its slots —
`{ title: 'Ember Wyrm', art: 'assets/art/wyrm.png' }` — never as a canvas. The
canvas is the layout with the active card's values in it, which is why
everything that is not a slot is shared by every card for free.

Switching cards is `applyRow()` from the batch renderer pointed at the project:
the card on screen is read back out of its slots, then every slot is written
from the next card. For the moment a switch is loading, the canvas is neither
card, so `syncActive()` does not read it and `saveProject()` waits for the
switch to finish (`cards.settled()`). *Every* slot, so a value one card lacks is emptied rather
than left over from the previous card; an art slot with no art of its own goes
back to the layer the art replaced, which placed art carries as
`tcgPlaceholder`. The canvas is the truth for the card on screen: its record in
the list is only brought up to date on a switch or a save. History starts
afresh on each switch, since a snapshot from one card restored onto another
would carry its words across.

**A card can change a layer for itself** (0.11.0). `setOverride(obj, true)`
parks the layout's values for `OVERRIDE_KEYS` (`left`, `top`, `scaleX`,
`scaleY`, `angle`, `opacity`, and `fill` when it is a plain colour) on the layer
as `tcgBase`; the live layer is then the card's version, and editing it edits
only that card. `syncActive()` writes the differences into the card's record as
`overrides: { <tcgId>: {left: 130, …} }`; `showOverrides()` puts every layer
back to its `tcgBase` and lays the incoming card's patches over the layout,
after its values, on every switch and when a project opens. Files hold the
layout only: `toLayoutJSON()` writes each `tcgBase` back over its layer before
a project or template is saved, so an older build opens the layout it expects.
Art slots and group members cannot be changed per card; a copied layer drops
`tcgBase`, and grouping hands its members back to the layout first. Batch runs
start every row from the layout snapshot (`layoutSnapshot()`), and a project's
rows carry `_overrides`, which `runBatch()`'s `prepare` hook lays over the row
before it is drawn — `batch.js` itself knows nothing of cards.

Exporting or printing every card turns the list back into batch rows with an
identity mapping and hands them to `runBatch()`, whose `sink` option collects
the images for the print sheet instead of writing them. Nothing about cards
reaches `printSheet.js`. A card's copies (`qty`, 0.8.0) travel the same way the
batch quantity column does: as a `_qty` column in those rows, so an export
writes the same `deck.json` a spreadsheet run would, and the print dialog hands
the counts to `expandByQuantity()` like a deck list's.

**One run has the canvas at a time.** A run snapshots the canvas, writes rows
into it and restores the snapshot when it ends, so anything else that touches
the canvas meanwhile is overwritten. `runBatch()` and `renderRow()` refuse to
start while another is going (`isRendering()`), and the dialogs that start a run
pass `canClose` to `openModal()`, which is asked before anything dismisses the
dialog — Escape, ✕ and the `close` its own buttons are handed alike (a string
answer is shown as a toast, so a refused **Cancel** says why). A dialog left
open is what keeps the editor out of reach until the canvas is back. The batch
dialog's guard covers **Preview first row** as well as a run.

A project that cannot be loaded — an image it names has gone — must not leave
anything behind. `editor.replaceCard()` wraps opening a project and applying a
template: it keeps the card setup, the project state and the layers, and puts
them all back if the load throws.

### Print sheets

`core/printSheet.js` is the other end of the same pipeline and shares none of
its machinery. It takes images that are already rendered, works out how many
cards fit on a page at their true physical size (pixel size ÷ dpi = inches), and
paints them onto a plain 2D canvas — it never opens the Fabric canvas, the slot
system or a project file, which is why it is short and why it cannot corrupt
anything.

Card backs are the same geometry turned over. When a back mode is on,
`planSheet()` returns `backSlots` running parallel to `slots`: each one is its
front mirrored about the page centre line, which is what the sheet of paper does
when the printer flips it, and which is also where a gutterfold sheet folds — so
one piece of arithmetic covers a short-edge duplex flip and a fold alike, and a
long-edge flip is the same thing about the other axis. A back page is therefore
the front page's own grid painted in `backSlots`, and a gutterfold page is both
blocks on one canvas with the backs drawn through half a turn. `composeBlocks()`
paints any number of blocks onto a page; `composePage()` is the one-block case
every single-sided sheet uses.

Quantities live here too, as arithmetic on lists. `parseDeck()` turns a
`deck.json` into `{ file, qty }` entries — keeping only each entry's own file
name, so a list can never reach outside the folder it was found in — and
`expandByQuantity()` repeats a list by its counts, refusing a run of more than
2000 cards so a mistyped cell cannot lock the tab up. The dialog expands the
fronts and, where a folder holds one back per design, the backs by the same
counts, so "one back per card" keeps meaning one per design and not one per
copy.

`core/pdf.js` turns the finished sheets into a PDF: a catalogue, a page tree and
one DCTDecode image per page, about 150 lines. It exists because an image file
cannot state its physical size, so "print at 100%" only means something in a
format carrying a MediaBox. No server endpoint was needed — `/api/list` finds
the images and `/api/export` writes the files. See [`PRINT.md`](PRINT.md).

## Extending it

- **A new shape or tool:** add a factory in `core/objects.js`, a case in
  `editor.insert()`, and a button with `data-insert="…"` in `index.html`.
- **A new effect:** add the read/write pair in `core/effects.js`, then the
  controls in the properties panel markup and `ui/properties.js`.
- **Anything that takes a file from the user:** call `assets.sourceForFile()`
  and place what it returns. It copies the file into the workspace (or inlines
  it when there is no server) and hands back a URL and a path. A `blob:` URL put
  on the canvas dies with the tab, and the saved project then points at nothing
  — silently, with the artwork simply gone on reopen.
- **A new panel:** add a `<section class="panel" data-panel="…">` and an
  `init…()` module; `ui/panels.js` picks up collapsing and persistence for free.
- **Scripting from the console:** `window.TCGForge` exposes
  `{ editor, state, api, assets, history, bus, EVT }` for batch jobs and
  experiments.
