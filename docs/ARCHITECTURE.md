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
request line. `HEAD` answers to the same checks. Nothing sends
`Access-Control-Allow-Origin`.

Workspace files under `/files/` are served with `Content-Security-Policy:
sandbox`. They are pictures, fonts and data to the app, which is unaffected;
but an SVG from an asset pack can carry a script, and opened on its own it
would otherwise run as this origin and could call the API.

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
    │   ├── bleed.js    bleed made by mirroring a rendered card's edges
    │   ├── tabletop.js deck sheets for virtual tabletops
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
        ├── tabletopPanel.js the tabletop deck sheet dialog
        ├── missingPanel.js  missing card pictures, and relinking them
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

**The key layer** (0.20.0). Fabric keeps a multi-selection's members in
stacking order (or in the order handed to `ActiveSelection`), which says
nothing about which layer the user meant to line the rest up with. The editor
keeps its own `picked` list from the selection events (`notePicks()`: a single
selection starts the list, layers added later are appended) and `keyChoice`,
a member chosen in Properties (`setKeyLayer()`). `keyLayer()` is that choice,
else the first picked member, else the first member; `null` below two layers.
`select()` and `memberSelection()` carry both across the drop-and-reselect
that `distribute()`, `align()` and `matchSize()` do — `discardActiveObject()`
fires `selection:cleared`, which would otherwise reset the order. The key is
outlined in `drawGuides()` (so never in an export). `align(mode, {to})` reads
`to` from `state.settings.alignTo` — `selection` (their own bounds, as before),
`key` (the key's bounding rect; the key does not move) or `card` — and
reselects afterwards so the selection box follows. `matchSize('width' |
'height' | 'both')` gives every unlocked member the key's `getScaledWidth()` /
`getScaledHeight()`: `scaleX`/`scaleY` (then `bakeScale()` for boxes and
triangles), a text box's `width` only (then `autoFitText()`), each layer's
top-left corner kept; it returns `{changed, skipped}` or `false`. Properties
shows `#pSeveral` (`#pKey`, `#pAlignTo`, `#pMatchW`/`#pMatchH`/`#pMatchBoth`)
for a multi-selection; the view toolbar had no room.

### History

`core/history.js` snapshots `{card, canvas}` as a JSON string on a debounced
`editor:modified`, capped at 80 steps. Undo and redo take any snapshot still
waiting out the debounce first, so an edit made a moment before Ctrl+Z is the
one that is undone. Restoring a step awaits its images, so steps queue one
behind another rather than loading over each other, and a step is refused while
something else holds the history lock (a card switch, a batch run). Restoring re-applies the card geometry
and calls `canvas.loadFromJSON`. Snapshots are strings so no live object can be
mutated out from under a step. A module can keep its own state in every step
with `history.keep(name, {read, write})` (0.20.0): `cards.js` keeps
`unresolved` there, so undoing art placed over a missing picture brings the
picture's path back with the placeholder.

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
`tcgBase`, and grouping hands its members back to the layout first. (A copied
or pasted layer drops `tcgSlot` too, and `editor.toggleGroup()` refuses a
selection holding a slot — the slot system only sees top-level layers, so a
slot inside a group would vanish from the card.) Batch runs
start every row from the layout snapshot (`layoutSnapshot()`), and a project's
rows carry `_overrides`, which `runBatch()`'s `prepare` hook lays over the row
before it is drawn — `batch.js` itself knows nothing of cards.

**A card frames its own artwork** (0.17.0). The art layer is replaced from
card to card, so its position cannot be a per-layer override; it is kept as a
relation to the window instead. `templates.readFraming(img)` reads placed art
against its `tcgArtBox` as `{zoom, x, y, angle?}` — scale over the cover
scale, centre offset as a fraction of the window — or `null` for the plain
cover fit; `applyFraming(img, framing)` sets it back (a `null` framing is the
cover fit). `syncActive()` stores the card's framings as `framing: {<slot>:
…}`; `showFraming()` runs after `showOverrides()` on every switch and in the
`prepare` hook of *every card* renders (rows carry `_framing`), and sets
*every* art slot, so a picture kept on the canvas because the next card names
the same file does not keep the last card's zoom. `addRows()` drops a slot's
framing when the sheet changes its picture. Art the user places goes through
`cards.placeArt()`, which a switch, a save and every render wait for through
`settled()` — otherwise a switch started while the picture loaded carried it
to the next card. Since 0.18.0 a placement counts for `settled()` from the
moment it is asked for (it waits for switches and earlier placements itself),
`exportCards()`/`renderCards()` await `settled()` before reading the rows, and
Properties → *Replace…* is a placement too. The framing also carries flips,
`stretch` and `crop` (fractions of `_baseWidth`/`_baseHeight`), applied crop
first so the cover scale is worked out from what shows. `syncActive()` keeps
a slot's previous framing while its art is `unresolved` (the placeholder has
none).

**A card's own changes, seen and reset** (0.18.0). `cards.ownChanges(index)`
counts a card's layers with `tcgBase` and its framed art slots — read from
the canvas for the card on screen (unless a switch or a run has it), from the
record otherwise; `describeOwnChanges()` words it. `ui/cardStrip.js` marks
tiles (`.tile-own`, aria-label and title) and redoes only the active tile on
`OBJECTS`/`MODIFIED`; `parseFilter()` turns `has:changes` into `{has:
'changes'}` unless a slot is called `has`. `resetOwnChanges()` reverts every
`tcgBase` layer (`revertToLayout`, auto-fit again), puts art to the cover fit
and `touch()`es once, so it is one undo step; Card Fields' `#cardOwn` box
offers it.

**Opening a project whose card art is missing** (0.18.0). Fabric's
`loadFromJSON()` rejects when any image fails, so `project.loadProject()`
first probes each top-level placed-art image (`tcgArtBox` + `tcgPlaceholder`)
and swaps a missing one for its placeholder; `loadCards(data, {missing})`
puts the path in `unresolved` (and into the card of a version-1 file).
`openProjectPath()`/`openProjectData()` return `{missingArt}` so the Open
dialog can say which pictures are gone. Since 0.19.0 the probe is
`objects.standInForMissingArt()`, and `templates.loadTemplate()` runs it too
(`applyTemplate()` returns `{missingArt}`).

**Relinking missing pictures** (0.19.0). `cards.missingArt()` gathers every
workspace path the cards' art slots name (the card on screen from its slots),
lists each folder once with `api.listFolder()` (`/api/list`) and returns the
paths not found, with the cards naming them. `cards.relinkArt(from, to)` waits
like any card operation (`history.settled()`, `settled()`, refuses while a run
has the canvas), rewrites every matching value, keeps `framing`, and redraws
the card on screen through `showCard()` inside a `switching` window, as
`addRows()` does. Placing or clearing art from Card Fields or the asset panel
calls `cards.forgetMissingArt(slot)`, so a remembered missing picture cannot
come back once the user has chosen other art. `ui/missingPanel.js` keeps the
Card Fields notice (`#cardMissing`, checked on `CARDS`/`PROJECT`/`ASSETS`)
and draws the dialog, where a single same-name file in the library is chosen
in advance.

**Filtering the strip** (0.15.0). `cards.parseFilter()` turns the box's text
into terms (`{slot, text}` or `{number}`); a `slot:` prefix counts only when it
names a slot the layout has. `cardMatches()` tests one card's values — text
through `collapseIcons()` so `{gem}` matches, art by path, `data:`/`blob:`
values never — and `matchingCards()` returns the strip positions that pass,
reading the card on screen from its slots. All of it is read-only; the filter
itself lives in `ui/cardStrip.js` (not in `state`, not in the file), which
skips non-matching tiles except the active one and makes `stepCard()` step to
the next match. Anything that loads a new canvas — `applyTemplate()` and
`applyProject()` — first awaits `history.settled()` and `cards.settled()`, so a
switch still loading its art cannot finish into it.

**A sheet of the cards, and back** (0.13.0). `cardsTable()` turns the list
into `{columns, rows, csv}` — `_id`, one column per slot, `qty` — with icons
collapsed to `{name}` (`icons.collapseIcons()`) and art as workspace paths;
`batch.toCSV()` is `parseTable()`'s inverse. `addRows()` is the way back: a row
whose `_id` names a card updates that card's mapped slots (and its count) in
place, keeping its overrides; any other row is appended. It waits for
`history.settled()` and `settled()`, refuses while `isRendering()`, and when the
card on screen is updated redraws it through `showCard()` inside the same
`switching` window a card switch uses.

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

Bleed (0.14.0) is image composition too. `core/bleed.js` has no imports:
`mirrorBleed()` takes a rendered card and returns a canvas a few pixels larger
on every side, with each side strip flipped across its edge and each corner
across both, and `bleedPixels()` turns millimetres into pixels at a dpi. Two
callers use it. `project.renderCard()` is the one export path — the export
dialog, `runBatch()` (so *Every card* and batch runs) and the batch preview all
render through it — and with a bleed it draws the card with
`editor.toDataURL({ squareCorners: true })` (the rounded-corner clip is left
off, or its transparent corners would be mirrored into the margin as notches),
mirrors it, and only then encodes JPEG on a white backdrop. And
`buildSheets({ mirror: true })` replaces each decoded image with its mirrored
version, the bleed scaled from sheet pixels to the image's own, after which
`drawCard()` lays it over slot + bleed exactly as it does an image that carried
bleed from the start; the print dialog renders its own cards with square
corners for it. Neither path knows anything about slots or layers.

Tabletop deck sheets (0.16.0) are the same kind of module. `core/tabletop.js`
imports only `loadImage()` from the print sheet: `gridFor()` picks the
smallest grid of at most 10 × 7 that holds a sheet's cards plus the hidden
slot (the grid's *last* slot, which the table shows for a card in hand) —
fewest spare slots first, then the squarest sheet, never under 2 × 2; `planTabletop()` cuts a deck
into sheets of 69 and gives every sheet of one deck the same card size, scaled
down only as far as the largest grid needs to stay inside 4096 px;
`composeTabletopSheet()` paints faces in reading order and the back into the
hidden slot. `ui/tabletopPanel.js` gets the cards the way the print dialog
does — `renderCards()` for a project (square corners, since a table rounds its
own), or a folder's images and its `deck.json` — and repeats copies with
`expandByQuantity()` before anything is laid out.

Exports are the card's exact size times the resolution: `editor.toDataURL()`
passes Fabric an explicit `width`/`height`, because the canvas element is a
whole number of screen pixels at the current zoom and Fabric otherwise sizes the
picture from it (0.14.0; a 750 px card came out 749 or 751 px wide).

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
