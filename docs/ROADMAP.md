# Roadmap

Ordered roughly by how much they improve day-to-day card making. Nothing here is
a promise; it is a shared to-do list. Issues and pull requests welcome on any of
it.

## Shipped

- **Batch generation from CSV/JSON** (0.2.0) — see [`BATCH.md`](BATCH.md).
- **Print sheets** (0.3.0) — cards laid out on A4/Letter/Legal/A3/Tabloid at
  their true physical size, with crop marks or cut lines, bleed handling and
  PDF or PNG output. See [`PRINT.md`](PRINT.md).
- **Card backs, duplex and gutterfold sheets** (0.4.0) — a shared or per-card
  back, mirrored back pages with a choice of flip edge, a millimetre alignment
  shift for printer drift, and fold-over sheets for people without a duplex
  printer. See [`PRINT.md`](PRINT.md).

## Next

- **Per-card quantities.** A `qty` column in a batch file, honoured by the
  print sheet builder, so a deck is `4 × Lightning Bolt` rather than four
  duplicated spreadsheet rows. Every comparable tool has this.
- **Conditional layers.** A `tcgShowIf` property so an empty spreadsheet cell
  hides the icon badge or divider behind the field, not just its text.
- **Multi-card projects.** A card list in one file, with a strip of thumbnails to
  switch between them — the natural home for set-wide edits.
- **Text on a path / arced titles.** Fabric supports path text; it needs UI.
- **Alignment and distribution.** Distribute spacing, match sizes, align to a
  chosen key object.
- **Rulers and manual guides.** Draggable guides that snap, saved with the
  template.

## Soon after

- **Layer masking.** Use one layer as an alpha mask for another (currently only
  rectangular clipping to a slot or the card is supported).
- **Effect presets.** Save a stack of fill + stroke + shadow settings and reapply
  it to any layer — house styles in one click.
- **Template inheritance.** A "common" template that others extend, so a set-wide
  frame change does not mean editing twelve files.
- **Undo grouping.** Treat a drag or a slider sweep as one history step rather
  than several.
- **Colour palette panel.** Per-project swatches shared across layers.

## Later / bigger

- **Foil and holographic overlays.** Blend-mode driven, exported as a separate
  spot layer for printers that support it.
- **Plugin API.** A `plugins/` folder scanned at startup; plugins register tools,
  panels and export formats against the existing event bus.
- **Optional desktop shell.** A Tauri wrapper so there is a double-clickable
  binary for people who do not want Python installed. The web app stays the
  source of truth.
- **Community asset packs.** A documented pack format (`pack.json` + folders)
  that can be dropped into `assets/` and shared.

## Deliberately not planned

- **Accounts, cloud sync, or telemetry.** The app should keep working with the
  network cable unplugged.
- **A bundler or framework rewrite.** The zero-build setup is what keeps the
  contribution barrier low.
- **Bundled copyrighted card frames.** The sample pack stays original and MIT
  licensed; recreations of specific published games belong in user asset packs.
