# Templates, slots and project files

Both file types are plain JSON in `workspace/`. You can edit them by hand, diff
them in git, and share them as ordinary files.

## The slot system

A **slot** is a string on a layer (`tcgSlot`). It does two things:

1. it makes that layer appear as a field in the **Card Fields** panel, and
2. it gives templates a stable name to write into.

Text layers with a slot get a text or multi-line input. Layers whose kind is
`art` (or which are images) get an image picker: the incoming picture is scaled
to **cover** the slot's box and clipped to it, so artwork never spills over the
frame no matter its aspect ratio.

To add a slot to any layer: select it, open **Properties → Typography → Field
slot** (text) — or set it while authoring a template. Common names, used by the
starter templates: `title`, `cost`, `type`, `rules`, `flavor`, `stats`, `icon`,
`art`, `footer`.

## Conditional layers

A layer can follow a field. Select it and choose **Properties → Layer → Show this
layer**:

- **Only when “cost” is filled** — the layer is on the card while the `cost`
  field holds any visible text or placed artwork, and gone while it is empty.
  This is the cost gem that should not appear on a card with no cost, or the
  stats plate that should not appear on a spell.
- **Only when “cost” is empty** — the reverse: a "no cost" marker, or a
  decorative filler for a card with nothing in that box.

It is stored as `tcgShowIf` on the layer: the slot's name, or the name with a
leading `!` for the reverse. Whitespace alone counts as empty, and so does an
art slot still holding the template's placeholder box. The condition is
re-checked on every change, so typing in a field, loading a project, and every
row of a batch run each decide for themselves — a batch file only has to leave a
cell blank.

A conditional layer's visibility belongs to its condition. The Layers panel
marks it `if cost` or `unless cost` and greys out its eye toggle; set the
condition back to **Always** to hide or show it by hand again.

The Classic Spell template uses both kinds of ornament: its cost gem follows
`cost` and its stats plate follows `stats`.

## Card numbering

A text layer can write its own text from where the card sits in its set — a
collector number, "3 of 12", a page count. Select the layer and type a pattern
into **Properties → Text → Card numbering**:

| Token | Becomes |
| --- | --- |
| `{n}` | the card's position in the set, counting from 1 |
| `{total}` | how many cards the set has |
| `{n:3}`, `{total:3}` | the same, padded with zeros to three digits (`007`) |

Anything else is kept as typed, so `No. {n} of {total}` and `{n:3}/{total:3}`
both work. "The set" depends on what is drawing the card:

- **In the editor**, it is the project's card list: card 3 of a twelve-card
  project is `{n}` = 3, `{total}` = 12. Adding, deleting, reordering or
  switching cards renumbers at once. A project with one card is 1 of 1.
- **In a batch run** — rendering a spreadsheet, *Export → Every card in this
  project*, *Print → Every card in this project* — each row is a card of the run
  and is numbered in row order, the same `{n}` its filename pattern uses. The
  batch dialog's preview is row 1 of however many rows are loaded.

Copies do not change numbering: a card wanted four times is one design with one
number, as on a real collector's list.

The pattern owns the text, the way a condition owns a layer's visibility. While
it is set the layer cannot be typed into — on the canvas or in the Text box —
and the Layers panel marks it `#`. Clear the pattern to type into it again; the
last number stays as ordinary text. A numbered layer cannot also be a slot
(each box is disabled while the other is set), because a slot's text belongs to
the card and a numbered layer's belongs to the set.

It is stored as `tcgNumbering` on the layer. The text saved beside it is just
what was on screen at the time; it is worked out again whenever the card is
loaded. The Classic Spell template numbers its cards in the bottom-right corner
with `{n:3}/{total:3}`.

## Arced text

A text box can bend its words along a circle — a title arched like a banner
across the top of a card, a type line that smiles under the art. Select the
layer and drag **Properties → Typography → Arc**, or use the arrow keys on it
(5° a press, Home and End for the extremes). Above zero arches the words,
below zero curves them the other way; **Straighten** puts them back.

The angle is how much of a circle the **box's width** spans, from 5° for a
gentle lift to 180° for a half circle. So the same angle bends a wide box's
words more gently than a narrow box's would: short words in a wide box sit on
the flat top of a big arc. Centre the text (the alignment buttons beside the
style toggles) for an arch that is even on both sides; left and right
alignment start the words at that end of the curve.

When you arc a layer, the ends of its line stay where the words were and the
middle bends away — upwards for an arch, downwards for a smile — and the box
grows by the height of the bend, so selecting, snapping and aligning see the
words where they are drawn. Text that wraps onto several lines is drawn as
parallel arcs. Auto-fit still fits the words, not the bend, so arcing a rules
box does not shrink its text.

The bend is worked out from the box each time the text is measured, so it
follows everything that changes the box or its words: resizing it, a
spreadsheet row, Card Fields, a card switch, a per-card width (*Only on this
card*). It is drawn in every output.

It is stored as `tcgArc` on the layer — just the angle; nothing else in the
file changes. A build from before 0.24.0 opens the layer with straight text.
Only text boxes can arc (every text layer TCG Forge makes is one); the row
does not appear for other layers. Typing on the canvas works as usual on an
arced layer, though the caret is drawn on the straight line.

## Bold and italic words

Rules text is rarely one style from start to finish: a keyword in bold, the
reminder text after it in italics, a line of flavour in the same box. Wrap
the words in tags:

```
<b>Flying</b>, haste. <i>(This creature can block creatures with flying.)</i>
```

The tags work wherever text goes in — a Card Fields box, Properties → Text,
a spreadsheet cell, typing on the card. In a Card Fields box or Properties →
Text, select some words and press **Ctrl+B** or **Ctrl+I** (⌘ on a Mac) to
wrap them; press it again on the same words to take the tags away.

On the card the tags take no room and are never drawn. The words between
them are set in the layer's own font, bold or italic, and measured that way,
so wrapping and auto-fit see them at their real width; arced text bends them
like any other word. `<b>` and `<i>` can be nested and run on across line
breaks until they are closed — or to the end of the text if they never are.
Capitals work too (`<B>`, which is what an UPPERCASE layer makes of them).
Only these four tags mean anything: `<u>` or any other text in angle
brackets is shown as typed.

A font usually has its bold and italic faces in separate files. Put them in
`assets/fonts` and the browser uses them where it can; where a face is
missing it draws a slanted or thickened version of the regular one.

The tags are part of the text, so they are saved, exported to a spreadsheet
and read back exactly as typed, and they work on every card of a set and in
every batch row. The card strip shows and searches a card's words without
them. A literal `<b>` cannot be shown on a card; the angle brackets on their
own (`a < b`) are fine. A build from before 0.25.0 shows the tags as text.

## Template file

`workspace/templates/<id>.json`

```json
{
  "format": "tcgforge.template",
  "version": 1,
  "id": "classic-spell",
  "name": "Classic Spell Frame",
  "description": "Ornate fantasy frame with cost, type line, rules box and stats.",
  "author": "TCG Forge",
  "tags": ["fantasy", "starter"],
  "card": {
    "width": 750, "height": 1050, "dpi": 300,
    "radius": 36, "background": "#1a1410", "preset": "poker",
    "guides": { "x": [375], "y": [140, 600] }
  },
  "fields": [
    { "id": "title", "label": "Card name",  "type": "text",      "order": 1 },
    { "id": "art",   "label": "Artwork",    "type": "image",     "order": 3 },
    { "id": "rules", "label": "Rules text", "type": "multiline", "order": 5 }
  ],
  "canvas": { "version": "6.9.1", "objects": [ … Fabric objects … ] }
}
```

| Key | Notes |
| --- | --- |
| `id` | filename stem; must be unique |
| `card` | geometry applied when the template loads; `guides` (optional) holds the layout's guides in card pixels — `x` vertical, `y` horizontal |
| `fields` | form definition. `type` is `text`, `multiline` or `image`; `order` sorts the panel |
| `canvas` | exactly what `canvas.toObject()` produced, including the `tcg*` properties. Images name their file by workspace path (`tcgAsset`, with `src` under `/files/`), never by a full URL |

Any layer carrying a `tcgSlot` that is *not* listed in `fields` is still picked
up automatically and appended to the form — `fields` exists so you can control
labels and ordering.

## Project file

`workspace/projects/<name>.json`

```json
{
  "format": "tcgforge.project",
  "version": 2,
  "name": "Ember Wyrm",
  "templateId": "classic-spell",
  "card": { "...": "same shape as above" },
  "fields": [ "...inherited from the template..." ],
  "canvas": { "...": "the layout, showing the active card" },
  "cards": [ { "id": "card_k3j9x2a", "values": { "title": "Ember Wyrm", "art": "assets/art/wyrm.png" } } ],
  "activeCard": 0,
  "meta": { "app": "TCG Forge", "embedded": false, "modified": "2026-01-01T00:00:00.000Z" }
}
```

`version` is `2` from 0.7.0, which added `cards` and `activeCard`: the values
each card puts into the layout's slots, and which of them `canvas` is showing.
A version-1 file has neither and opens as a project of one card. See
[`CARDS.md`](CARDS.md).

`meta.embedded` records how images were stored:

- **`false` (default)** — image layers keep `tcgAsset` (a workspace-relative
  path) and their `src` points at `/files/…`. Small files; share the whole
  workspace folder and everything resolves.
- **`true`** — every image is inlined as a base64 data URL, including the
  artwork the other cards in `cards` name. One self-contained file, much
  larger, portable anywhere.

Toggle it with **Insert → Embed images in project file**.

## Authoring a template by hand

The reliable route is to build the layout in the app and use **Save current card
as template…**. If you would rather script it, `tools/build_templates.mjs` shows
the pattern used for the starter set: drive the running app in a headless
browser, build objects with Fabric, then `POST /api/write`. Generating templates
through the real runtime means the JSON can never drift from what the app
expects.

## Sizing reference

| Preset | Inches | 300 dpi | 600 dpi |
| --- | --- | --- | --- |
| Poker / TCG | 2.5 × 3.5 | 750 × 1050 | 1500 × 2100 |
| Bridge | 2.25 × 3.5 | 675 × 1050 | 1350 × 2100 |
| Tarot | 2.75 × 4.75 | 825 × 1425 | 1650 × 2850 |
| Square | 2.75 × 2.75 | 825 × 825 | 1650 × 1650 |
| Mini | 1.75 × 2.5 | 525 × 750 | 1050 × 1500 |

Most print shops want 300 dpi minimum plus a 1/8 in bleed. Design at the final
size, keep anything that must survive the cut inside the **Safe zone**, and
export at 1× with **Bleed** set to 3 mm: the card's own edges are mirrored out
to make the bleed (see [`PRINT.md`](PRINT.md#bleed-for-a-print-shop)). Design at
1× and export at 2× if you want headroom.
