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
    │   ├── templates.js template load/save and the slot system
    │   └── project.js  serialise, save, open, export
    └── ui/
        ├── panels.js      collapsing panels, dock splitters
        ├── toolbar.js     top bar, card setup, view toolbar, status bar
        ├── layers.js      layer list, drag reorder, rename, lock, hide
        ├── properties.js  the contextual property inspector
        ├── assetPanel.js  thumbnail browser, click-to-place, drag & drop
        ├── templatePanel.js
        ├── fieldsPanel.js the form view of a template
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
| `templates:applied` | a template was loaded |
| `project:changed` | project name / path / dirty flag |
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
| `_baseWidth`, `_baseHeight` | natural image size, used by the crop sliders |

> One gotcha worth knowing: serialised Fabric objects use capitalised type names
> (`"Image"`, `"Textbox"`) while live instances report lower case (`"image"`).
> Code that walks raw JSON compares case-insensitively.

### Rendering and coordinates

Objects are positioned in **card coordinates** (0,0 to width,height at the
card's pixel size). Zoom is applied with `canvas.setZoom()` plus a matching
`setDimensions()`, so nothing has to be rescaled when the view changes and
exports are always computed from the true card size.

Rounded card corners are a canvas-level `clipPath`, which means they clip the
background too and survive export.

Smart guides, the safe zone and the bleed guide are painted in an `after:render`
hook straight onto the canvas context. An `exporting` flag suppresses them while
`toDataURL()` runs, so guides never end up in the output.

### History

`core/history.js` snapshots `{card, canvas}` as a JSON string on a debounced
`editor:modified`, capped at 80 steps. Restoring re-applies the card geometry
and calls `canvas.loadFromJSON`. Snapshots are strings so no live object can be
mutated out from under a step.

## Extending it

- **A new shape or tool:** add a factory in `core/objects.js`, a case in
  `editor.insert()`, and a button with `data-insert="…"` in `index.html`.
- **A new effect:** add the read/write pair in `core/effects.js`, then the
  controls in the properties panel markup and `ui/properties.js`.
- **A new panel:** add a `<section class="panel" data-panel="…">` and an
  `init…()` module; `ui/panels.js` picks up collapsing and persistence for free.
- **Scripting from the console:** `window.TCGForge` exposes
  `{ editor, state, api, assets, history, bus, EVT }` for batch jobs and
  experiments.
