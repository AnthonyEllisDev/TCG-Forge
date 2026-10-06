# Tabletop deck sheets

Tabletop Simulator — and the virtual tables that read the same format — builds
a deck of cards from one picture with every face on it in a grid. **Tabletop**
in the top bar makes those pictures from your set, so a game can be played
online the same afternoon it was designed.

## What it does

1. **Cards.** Either *the cards in this project*, drawn fresh, or *a folder in
   `workspace/exports`* — what a batch run or *Export → Every card* left there.
   **Repeat each card by its copies** turns four copies into four cards in the
   deck: from the card strip's **Copies** box for a project, or from the
   folder's `deck.json`. The line under the source says how many cards that
   is and how many sheets they need before anything is drawn.
2. **Back.** Optional. Pick a folder in `workspace/exports`; its first image is
   written beside the sheets as `back.png` and also fills each sheet's hidden
   slot (below).
3. **Output.** **Preview** draws the first sheet; **Make deck sheets** writes
   everything into `workspace/exports/<name>-tabletop/`:

   | File | What it is |
   | --- | --- |
   | `<name>.jpg` (or `<name>-1.jpg`, `<name>-2.jpg` …) | the face sheets |
   | `back.png` | the card back, at the cards' size, when one was chosen |
   | `tabletop.json` | each sheet's grid and card count, so they are still there next week |

   The folder is overwritten each time, like an export of every card.

## The rules the sheets follow

- **Ten across, seven down, at most.** That is the largest grid the importer
  takes. A smaller deck gets the grid with the fewest spare slots — the
  squarest sheet when two grids tie — never narrower or shorter than two.
- **The last slot is not a card.** The bottom-right slot of every grid is the
  face the other players see while a card is in someone's hand. So a sheet
  holds at most 69 cards, and the slot is filled with the back when you chose
  one (black otherwise — set *Back is Hidden* in the importer to use the back
  instead).
- **4096 px on a side.** Bigger sheets are refused or blurred by many graphics
  cards. Cards are scaled down to fit, never cropped: a full 10 × 7 sheet of
  750 × 1050 px cards is 409 × 573 px per card. Every sheet of one deck uses
  the same card size.
- **Square corners.** A table rounds its own card corners, so a project's
  cards are drawn without the card radius; otherwise the sheet's black would
  show in each corner.

## Importing into Tabletop Simulator

1. Put the sheet and the back somewhere the game can load them — a local file
   path works for a game you host; for others to see the cards, upload them
   (Steam Cloud from inside the game, or any image host).
2. **Objects → Components → Cards → Custom Deck**, and place it.
3. **Face**: the sheet. **Back**: `back.png` (or any back you like).
4. **Width**, **Height** and **Number**: the values the dialog listed for this
   sheet (they are in `tabletop.json` too). *Number* is the number of cards —
   it never counts the hidden slot.
5. Import. For a deck spread over several sheets, import each sheet as its own
   Custom Deck and drop them on each other to merge them.

## In `tabletop.json`

```json
{
  "format": "tcgforge.tabletop",
  "version": 1,
  "name": "core-set",
  "cards": 75,
  "cardSize": [409, 573],
  "back": "back.png",
  "sheets": [
    { "file": "core-set-1.jpg", "width": 10, "height": 7, "number": 69, "first": 1 },
    { "file": "core-set-2.jpg", "width": 4,  "height": 2, "number": 6,  "first": 70 }
  ]
}
```

`first` is the deck position of the sheet's first card, counting copies.

## Under the hood

`web/js/core/tabletop.js` is image composition only — like the print sheet it
never touches the editor, the slots or the project file. `planTabletop()` cuts
the deck into sheets and sizes the cards; `composeTabletopSheet()` paints one
sheet. The dialog is `web/js/ui/tabletopPanel.js`.
