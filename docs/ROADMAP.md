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
- **Per-card quantities** (0.5.0) — a count column in a batch file, recorded in
  a `deck.json` beside the rendered cards and honoured by the print sheet
  builder, so a deck is `4 × Lightning Bolt` rather than four duplicated
  spreadsheet rows. See [`BATCH.md`](BATCH.md).
- **Conditional layers** (0.6.0) — a layer tied to a field is shown only while
  that field is filled (or only while it is empty), so an empty spreadsheet cell
  hides the ornament behind a field and not just its text. See
  [`TEMPLATES.md`](TEMPLATES.md).
- **Multi-card projects** (0.7.0) — one layout and a list of cards in a single
  project file, with a card strip to switch between them, spreadsheet rows
  added as editable cards, and export or print of every card at once. See
  [`CARDS.md`](CARDS.md).
- **Copies per card in a project** (0.8.0) — a count on each card, honoured by
  printing every card and written as a `deck.json` by exporting every card. See
  [`CARDS.md`](CARDS.md).
- **Distribute** (0.9.0) — equal gaps between three or more layers, across or
  down the card, from the view toolbar or **Alt + Shift + H / V**.
- **Card numbering** (0.10.0) — a text layer written from the card's place in
  its set (`{n:3}/{total}`), in the editor, batch runs, exports and print
  sheets. See [`TEMPLATES.md`](TEMPLATES.md).
- **Per-card layout changes** (0.11.0) — *Only on this card* lets one card move,
  resize, turn, fade or recolour a layer without changing it for the rest of
  the set. See [`CARDS.md`](CARDS.md#a-change-for-one-card).
- **Icons in rules text** (0.12.0) — `{gem}` in a field, a cell or on the card
  becomes an inline symbol from an icon font, which
  `tools/build_icon_font.py` builds from a folder of SVGs. See
  [`ICONS.md`](ICONS.md).
- **Cards to a spreadsheet and back** (0.13.0) — *Save as CSV* writes a
  project's cards as a sheet with each card's id; loading it back with *Add
  rows as cards* updates those cards in place. See
  [`CARDS.md`](CARDS.md#the-cards-as-a-spreadsheet-and-back).
- **Bleed made from the card's edges** (0.14.0) — exports, batch runs and print
  sheets mirror the card's outermost strip into a print shop's bleed, so cards
  designed at their finished size need no redesign. See
  [`PRINT.md`](PRINT.md#bleed).
- **Filtering the card strip** (0.15.0) — find cards in a big set by any
  field, a field's words, an icon, artwork or number, and step through the
  matches. See [`CARDS.md`](CARDS.md#finding-a-card).
- **Tabletop deck sheets** (0.16.0) — a project's cards or a rendered folder
  laid out as Tabletop Simulator custom-deck sheets, with the hidden-card slot,
  copies and a back. See [`TABLETOP.md`](TABLETOP.md).
- **Art framing per card** (0.17.0) — move, zoom and turn a card's picture in
  its art window, kept with the card through switches, saves, exports, prints
  and tabletop sheets. See
  [`CARDS.md`](CARDS.md#framing-a-cards-artwork).

## Next

- **Text on a path / arced titles.** Fabric supports path text; it needs UI.
- **More alignment.** Match sizes, align to a chosen key object, and distribute
  with a gap you type rather than an equal share.
- **Rulers and manual guides.** Draggable guides that snap, saved with the
  template.

- **Coloured icons in text.** Today an icon takes the text's colour. A
  per-icon colour (or full-colour SVG runs) needs Fabric's per-character
  styles kept in step with the text, through Card Fields, batch and card
  switches.

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
