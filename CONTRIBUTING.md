# Contributing to TCG Forge

Thanks for taking a look. The project is intentionally small and dependency-free
so that "clone it and start editing" actually works.

## Getting set up

```bash
git clone <your fork>
cd tcgforge
python launch.py            # that's it — no npm install, no build
```

Edit a file in `web/`, reload the browser, see the change. There is no watcher
to run and no bundle to rebuild.

Hard refresh (`Ctrl+Shift+R`) after editing CSS or JS if your browser caches
aggressively.

## Project conventions

**No network dependencies.** Nothing may be fetched from a CDN at runtime. If a
library is needed, vendor it into `web/vendor/` with its licence file and note
it in the README.

**No build step.** Front-end code is plain ES modules using browser-native
syntax. No TypeScript, no JSX, no transpiler.

**UI modules do not touch Fabric.** Panels call into `core/editor.js` and listen
on the event bus (`util/bus.js`). If you find yourself importing `fabric` inside
`ui/`, the operation probably belongs in the core.

**Python: standard library only.** `launch.py` must run on a clean Python 3.8+
install on Windows, macOS and Linux.

**Comments explain why, not what.** The code says what it does; comments are for
the reasoning, the gotcha, or the constraint that made it look like that.

**Style.** 2-space indent in JS, 4 in Python. Single quotes in JS. Keep lines
under about 100 characters. Prefer small named functions over clever one-liners.

## Where things live

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full map. In short:

| I want to… | Go to |
| --- | --- |
| add a shape or insert tool | `core/objects.js` + `editor.insert()` + a `data-insert` button |
| add a layer effect | `core/effects.js` + `ui/properties.js` + markup in `index.html` |
| change the look | `css/theme.css` (tokens first, components second) |
| add a panel | new `<section class="panel">` + an `init…()` in `ui/` |
| touch file handling | `launch.py` and `core/api.js` together |

## Testing changes

There is no test runner yet (contributions welcome). Before opening a PR, please
walk through this by hand:

1. App loads with **no console errors**.
2. Load each starter template; the card renders correctly.
3. Type in a Card Field — the canvas updates.
4. Place an asset from each category (frame, background, icon, art, font).
5. Undo/redo across several operations, including delete and group.
6. Save a project, reload the page, open it again — everything comes back.
7. Export a PNG and confirm guides are *not* in the output.
8. Reload with the server stopped (`file://`) and confirm the app still opens
   and warns instead of crashing.

If you change the starter templates or sample assets, regenerate them:

```bash
python tools/make_sample_assets.py
npm i playwright && node tools/build_templates.mjs   # app must be running
```

## Pull requests

- One change per PR, with a short description of the user-visible effect.
- Include a screenshot for anything visual.
- If you add a `tcg*` property, add it to `CUSTOM_PROPS` in `core/objects.js` and
  document it in `docs/ARCHITECTURE.md`, or it will not survive save/load.
- New event names go in `util/bus.js` next to the others.

## Asset contributions

Sample assets must be original work or provably compatibly licensed, and must
not recreate the trade dress of a published game. Keep them as SVG where
possible so the repository stays small.
