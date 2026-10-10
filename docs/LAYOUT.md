# Arranging layers

Everything on a card is a layer. This page covers lining layers up with each
other and with the card, and making several layers the same size.

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
