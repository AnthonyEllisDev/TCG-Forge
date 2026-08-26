# TCG Forge

**A local, open-source trading card design studio that runs in your browser.**

TCG Forge is a card layout editor with the workflow of a real desktop app: a
launcher script starts a tiny local server, your browser becomes the workspace,
and every asset, template and project lives in ordinary folders on your disk.
No account, no cloud, no network connection required.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Card setup    │                                    │  Card fields       │
│  Insert        │                                    │  Layers            │
│  Templates     │            your card               │  Properties        │
│  Asset library │                                    │  Effects           │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Quick start

**Requirements:** Python 3.8 or newer and any modern browser. That is the whole
list — no npm install, no build step, no internet.

| Platform | Command |
| --- | --- |
| Windows | double-click **`run.bat`** |
| macOS / Linux | **`./run.sh`** |
| Any | `python launch.py` |

The launcher picks a free port (7870 by default), opens your browser and prints
the workspace path it is using. Press `Ctrl+C` in the terminal to stop it.

Useful flags:

```bash
python launch.py --port 8123          # choose a port
python launch.py --no-browser         # don't auto-open a browser
python launch.py --workspace ~/cards  # keep your work outside the repo
python launch.py --verbose            # log every request
```

> **Use the launcher, not the HTML file.** Modern browsers refuse to load ES
> modules from `file://` URLs, so double-clicking `web/index.html` will not
> start the app. The launcher exists precisely to serve those files locally —
> it still never touches the network. If the server stops while you are working,
> the app keeps running in the page and falls back to browser downloads for
> saving until you restart it.

---

## What it does

**Full layout control.** Everything on the card is a layer you can move, scale,
rotate, reorder, lock, hide, group and rename. Nothing about the layout is
hard-coded to a particular game.

**Your own art.** Drop frames, backgrounds, icons, textures and fonts into the
workspace folders and they appear in the Asset Library with thumbnails. Click to
place, or drag straight onto the card. Files from anywhere on your computer can
be dragged onto the canvas too.

**Templates with named slots.** A template stores a complete layout plus a list
of fields. Load one and the right-hand **Card Fields** panel becomes a form:
type a name, paste rules text, choose artwork. Art dropped into a slot is scaled
to cover the slot and clipped to it, so swapping images never breaks the design.
Any layout you build can be saved as a template.

**Real layer effects.** Solid, linear-gradient and radial-gradient fills;
strokes with dashed and dotted styles and stroke-behind-fill for crisp text;
drop shadows and coloured glows; all sixteen canvas blend modes; opacity;
clipping to the card; corner radii; image crop and pan; brightness, contrast,
saturation, blur, grayscale, sepia and invert adjustments.

**Typography that behaves.** Any `.ttf`/`.otf`/`.woff` in `assets/fonts` is
registered automatically and appears in the font list. Line height, letter
spacing, alignment, uppercase transform, and auto-fit that shrinks rules text
until it fits its box (and never grows past the size the template intended).

**Print-ready output.** Card presets are sized in real inches at your chosen dpi
(Poker 2.5 × 3.5 in at 300 dpi = 750 × 1050 px). Export PNG or JPEG at 1× to 4×,
with optional transparency, saved straight into `workspace/exports`. Safe-zone
and bleed guides are on-screen only and never appear in the export.

**Built for keyboards.** Undo/redo, duplicate, copy/paste, nudge, layer
ordering, zoom, fit, and space-drag panning. Press `?` in the app for the full
list.

---

## The workspace

Everything you make lives in one folder tree that you can copy, back up, or
version-control:

```
workspace/
├── assets/
│   ├── frames/        card-sized frame overlays (PNG/SVG/WebP…)
│   ├── backgrounds/   full-card backgrounds
│   ├── icons/         mana symbols, element icons, set symbols
│   ├── art/           illustrations
│   ├── textures/      overlays: foil, grain, hatching
│   └── fonts/         .ttf / .otf / .woff / .woff2
├── templates/         reusable layouts (.json)
├── projects/          saved cards (.json)
└── exports/           rendered PNG / JPEG
```

Add files with the **Import files…** button, or just copy them into the folders
and press **⟳** in the Asset Library. Subfolders are supported and shown as
groups.

Projects reference images by path by default, which keeps project files small
and lets a whole folder be shared as a set. Tick **Embed images in project
file** if you would rather have one self-contained file per card.

Nothing is ever hard-deleted by the app: removing a workspace file through the
API moves it to `workspace/.trash/`.

---

## Building a card in five steps

1. **Templates → pick one** (or start from *Blank Starter*).
2. **Card Fields** — type the name, type line and rules text.
3. **Asset Library → Art** — click an illustration to drop it into the art slot.
4. **Layers / Properties** — nudge anything that needs nudging; add a glow, a
   gradient panel, a set symbol.
5. **Export** — choose 2× for a crisp print file. It lands in
   `workspace/exports`.

To make the layout reusable, give the text layers slot names in
*Properties → Typography → Field slot* and hit **Save current card as
template…**. Your slots become that template's form fields.

---

## Documentation

| Document | What is in it |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How the app is put together, module by module |
| [`docs/TEMPLATES.md`](docs/TEMPLATES.md) | Template and project file format, slot system |
| [`docs/API.md`](docs/API.md) | The local HTTP API exposed by `launch.py` |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | What is planned next, and where help is welcome |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Development setup and code conventions |

---

## Design principles

1. **Local first.** The app must work with the network cable unplugged, forever.
   Dependencies are vendored, never fetched from a CDN.
2. **Plain files.** Templates and projects are readable JSON; assets are normal
   images in normal folders. Nothing is locked in a database.
3. **No build step.** The front end is plain ES modules. Edit a file, reload the
   page, see the change. That keeps the contribution barrier at zero.
4. **The editor is generic.** Nothing in the core knows what "mana cost" means.
   Games are described by templates and assets, not by code.

---

## Tech

- **Fabric.js 6** (vendored in `web/vendor/`, MIT) for canvas objects
- **Vanilla ES modules** — no framework, no bundler, no transpiler
- **Python standard library** for the launcher and file API — no pip install

---

## Privacy

TCG Forge makes no outbound requests. The server binds to `127.0.0.1` only, so
it is not reachable from other machines on your network unless you deliberately
pass `--host 0.0.0.0`. There is no telemetry of any kind.

---

## Licence

MIT — see [`LICENSE`](LICENSE). The bundled sample assets and starter templates
are released under the same terms; use them in commercial projects freely.

Fabric.js is MIT licensed; its notice is kept in `web/vendor/fabric.LICENSE`.
