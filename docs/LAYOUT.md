# Arranging layers

Everything on a card is a layer. This page covers lining layers up with each
other and with the card, making several layers the same size, and the rulers
and guides that keep a layout's lines in place.

## Align

The six align buttons in the view toolbar (left, centre, right, top, middle,
bottom) move the selected layers:

- **One layer** aligns to the card.
- **Several layers** align to whatever **Properties → Transform → Align to**
  says:
  - **The selection** — the box around all of them (the default). *Align
    left* moves every layer to the leftmost edge among them.
  - **The key layer** — the key stays where it is and the others line up
    with it.
  - **The card** — each layer aligns to the card on its own, as if it were
    selected alone. Handy for centring a title and a stats plate in one go.

The choice is remembered between sessions.

## The key layer

When more than one layer is selected, one of them is the **key layer**: the
one *Align to: the key layer* and *Match* measure from. It is outlined in
gold on the card (only on screen — never in an export) and named in
**Properties → Key layer**.

The key is the **first layer you picked**. Click the plain rectangle, then
Shift-click the others, and the rectangle is the key. In the Layers panel,
Ctrl- or Shift-click adds layers in the same way. A drag-box picks its layers
all at once, from the bottom of the stack up, so its key is the lowest one —
choose another in **Properties → Key layer** at any time.

## Match size

**Properties → Transform → Match the key layer's** gives the other selected
layers the key's **Width**, **Height** or **Both** — the sizes the Width and
Height boxes show for the key. Each layer keeps its top-left corner.

- Boxes and triangles take the size as their own width and height.
- Pictures, ellipses, lines and groups are scaled to it.
- **Text boxes** take the width, and rewrap; their height is whatever their
  words need, so they sit out a height match (the toast says so). A text box
  is never narrower than its longest word. An auto-fit text box refits its
  words to the new width.
- **Locked layers** are left alone, as every arranging command does.
- A layer marked *Only on this card* is matched on this card only, like any
  other change to it.

Each press is one undo step. The size counts a layer's stroke, as the Width
and Height boxes do.

## Distribute

**⋯** and **⋮** (or **Alt + Shift + H / V**) space three or more layers so
the gaps between them are equal. The layer that starts first stays put and
the last one ends where the furthest edge was.

## Space by a gap

When the gaps should be a particular size rather than an equal share — cost
pips 6 px apart, stat icons butted together — type the gap into
**Properties → Transform → Space from the key by** and press
**Across** or **Down**.

- The **key layer** stays where it is.
- The other layers are taken in the order they start (left to right for
  *Across*, top to bottom for *Down*). The ones before the key close up to
  it; the ones after it follow it. Each is set exactly the gap away from its
  neighbour, edge to edge.
- **0** butts the layers together; a **negative** gap overlaps them by that
  much.
- Two layers are enough. A **locked** key still anchors the row; other
  locked layers are left out.
- Only the one axis moves — spacing *Across* leaves every layer's height on
  the card as it was. Align them first if they should share a line.

The gap is remembered between sessions. Each press is one undo step.

## Rulers and guides

Rulers run along the top and left of the work area, measuring the card in
pixels at whatever zoom you are at. The pale band on each ruler is the card;
a thin gold line follows the mouse.

- **Add a guide** — drag down from the top ruler for a horizontal guide, or
  across from the left ruler for a vertical one, and let go over the card.
  Letting go while still on the ruler adds nothing.
- **Move it** — every guide has a mark on the ruler that measures it (a
  vertical guide's mark is on the top ruler). Drag the mark along the ruler.
- **Remove it** — drag its mark past the end of the card, or double-click the
  mark.
- **Type it** — **Card Setup → Guides** lists every guide with its position
  in pixels from the card's left or top edge. **+ Vertical** and
  **+ Horizontal** add one down or across the middle of the card, ready to
  type over; **×** removes one and **Clear** removes them all.

While **Snap** is on, a guide being dragged snaps to the card's edges, centre
and safe zone and to the edges and centres of layers, and a layer being
dragged snaps to guides as it does to the card and other layers.

Guides belong to the **layout**, like the card's size: every card in a
project shares them, they are saved in the project file and in a template
saved from it, and adding, moving or removing one is an undo step. Opening a
project or template without guides clears them; **New** starts with none. A
guide that a smaller card size leaves outside the card is dropped. Guides are
drawn only in the editor — never in an export, a batch run, a print sheet or
a tabletop sheet.

**Rulers and guides** in Card Setup, or **Ctrl + ;**, hides the rulers and
the guides together; hidden guides are not snapped to. The choice is
remembered between sessions.

