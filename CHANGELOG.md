# Changelog

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
