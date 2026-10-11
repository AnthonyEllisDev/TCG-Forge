# Icons in text

Rules text on a real card is full of small symbols — a mana gem, a tap arrow, a
shield beside a keyword. In TCG Forge an icon is a character, so it sits in a
line of text, wraps with it, shrinks with auto-fit, and travels through Card
Fields, batch spreadsheets, project files and exports exactly like a letter.

```
Deal 2 {element-fire} damage to any target.
{shield} Gilded Sentinel gets +0/+2 as long as you control an artifact.
```

## Putting an icon in

- **Card Fields.** Type `{name}` — `{gem}`, `{element-fire}` — into any text
  field and it turns into the icon as soon as the closing brace is typed. Or
  click into the field and pick the icon from the **Icons** palette under the
  fields; it goes in at the caret.
- **On the card.** Type `{name}` straight into a text layer; it turns into the
  icon when you finish editing (click away or press Escape).
- **Properties → Text.** Same as Card Fields. The palette also inserts here if
  this was the last text box you were in.
- **Spreadsheets.** Write `{name}` in a cell. Batch runs and **Add rows as
  cards** turn it into the icon. Names are not case sensitive (`{GEM}` works).

A name in braces that is not an icon is left exactly as typed, so a card-number
pattern like `{n:3}` or a filename pattern like `{title}` is never touched.

Hover over a palette button to see its name.

## The shipped icons

`workspace/assets/fonts/Forge-Icons.ttf` holds one glyph for each sample icon in
`workspace/assets/icons`:

| Type | Icon | Type | Icon |
|---|---|---|---|
| `{element-air}` | wind | `{gem}` | gem |
| `{element-dark}` | crescent | `{heart}` | heart |
| `{element-earth}` | mountains | `{shield}` | shield |
| `{element-fire}` | flame | `{skull}` | skull |
| `{element-light}` | sunburst | `{star}` | star |
| `{element-water}` | drop | `{sword}` | sword |

An icon takes the size and weight of the text around it, and its colour too
unless the layer gives it one of its own (next section). A font glyph is one
colour; for a many-coloured symbol, place the SVG from the Asset Library as its
own layer instead.

## Colouring icons

Select a text layer and open **Properties → Typography → Icon colours**:

- **All icons** — one colour for every icon in the layer that has none of its
  own. A gold for every symbol in the rules box, say.
- **One row per icon** — the icons in the layer's text are listed; give any of
  them its own colour. `{element-fire}` red and `{element-water}` blue, with
  everything else gold.
- **Colour another icon** — the colours belong to the *layer*, not to the
  words on screen. A rules box shows different icons on different cards, so
  pick an icon here to colour it before any card uses it. An icon that has a
  colour stays in the list after it leaves the text.
- **Reset** — the icon takes the text colour again (or the *All icons* colour,
  if there is one).

Because the colours are part of the layer, they hold on every card in a
project, in every batch row, export, print sheet and tabletop sheet, and in a
template saved from the card. The text is unchanged — `{gem}` is still one
character, so spreadsheets, the CSV round trip and auto-fit see exactly what
they did before. Each change is one undo step.

The colours are saved on the layer as `tcgIconColors`, by icon name:

```json
"tcgIconColors": { "element-fire": "#d8432a", "*": "#d9a520" }
```

`*` is *All icons*. A name no icon font provides any more is kept and does
nothing until the font is back.

## Making your own icons

Put SVG files in `workspace/assets/icons` (or any folder) and build a font from
them — standard library Python, nothing to install:

```
python tools/build_icon_font.py
python tools/build_icon_font.py --icons path/to/svgs --out workspace/assets/fonts/My-Icons.ttf
python tools/build_icon_font.py --list          # the name and code point of every icon
```

Each file becomes an icon named after the file (`Fire Rune.svg` → `{fire-rune}`).
Reload the app and the new icons are in the palette. (A font the browser has
already loaded is not loaded twice, so ⟳ in the Asset Library picks up a *new*
icon font but not a rebuilt one.)

What the builder understands:

- **Filled shapes** — `path`, `rect`, `circle`, `ellipse`, `polygon`,
  `polyline` — with any path commands, including arcs.
- **Strokes** with round caps and joins (`stroke-linecap="round"`), which is
  how line icons are usually drawn. A stroke is drawn at its `stroke-width`.
- **`transform`** on any element or group.

Colour, gradients and opacity are ignored — the shape is kept, its paint is
not. Masks and clip paths are left out, and `fill-rule="evenodd"` is drawn as
non-zero (the builder warns about it, and about any element it cannot read).
Draw holes as a contour running the opposite way round, as most icon editors
do.

### Code points stay put

The text on a card stores the icon's character — a code point in Unicode's
Private Use Area (U+E000 upwards) — not its name. So when the builder rewrites
a font it reads the old one first: every icon keeps the code point it had, and
new icons take the next free one. A saved card never finds a different icon in
its text after a rebuild.

Taking an icon *out* and rebuilding leaves its code point reserved — the
builder warns, and records it in the font — so cards that used it show an empty
box where it was rather than some newer icon. Put the file back and it takes
its old code point again. A code point is never handed out twice.

A *new* font starts after the highest code point the other fonts in its folder
use, so two fonts built with this tool never share one. A font from elsewhere
may still collide (most start at U+E000): the first font loaded keeps the code
point, and the other font's icon is left out of the palette with a warning in
the browser console, rather than inserting a character that draws as somebody
else's icon.

## Bringing an icon font from elsewhere

Any `.ttf` or `.otf` in `workspace/assets/fonts` whose Private Use Area glyphs
have names is read the same way, so an existing icon font made with another
tool works too, under its own glyph names. (A WOFF's tables are compressed and
cannot be read for names; convert it to TTF first.) When two fonts name the
same icon, the one found first keeps the name.

## How it works

`core/icons.js` reads each library font's `cmap` and `post` tables to learn
which Private Use Area characters have names. Text layers keep the font you
gave them; the canvas lists the icon fonts after it as fallbacks, so a
character the layer's font lacks is drawn from the icon font. Measuring goes
through the same fallback, which is why wrapping and auto-fit see an icon at its
real width. The text boxes in the side panels use the same fallback, so an icon
in a field shows as the icon.

Icon colours are applied as the text is drawn, not stored in the text: Fabric's
per-character styles are keyed by position and wiped by every change of text
(Card Fields, batch rows and card switches all make one), so `core/icons.js`
wraps `getCompleteStyleDeclaration()` to give an icon character its layer's
colour, and `isEmptyStyles()` so a line holding a coloured icon is drawn run by
run rather than in one call. Colour does not change a glyph's width, so
measuring, wrapping and auto-fit are untouched. (The side-panel text boxes show
icons in the text colour; an input cannot colour single characters.)

If an icon font is removed from the workspace, its characters are still in the
text and show as empty boxes until it is put back.
