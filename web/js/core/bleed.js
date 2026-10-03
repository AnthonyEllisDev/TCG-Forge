/*
 * Bleed made from the card itself.
 *
 * A print shop trims a little inside the edge of what it prints, so it asks
 * for artwork that runs a few millimetres past the trim line. A card designed
 * at its finished size has nothing out there. Mirroring the outermost strip of
 * the card into that margin gives the cutter something that continues the
 * edge: the colour of the border, the frame, a full-bleed painting. It is cut
 * away, so it only has to be plausible, never seen.
 *
 * Everything here is 2D canvas composition on an already-rendered card, like
 * the print sheet, which uses it too. Nothing reaches into the layers or the
 * slot system; project.renderCard() is the one place that pairs it with the
 * editor.
 */

const MM_PER_INCH = 25.4;

/** Millimetres of bleed as pixels of a card drawn at `dpi` × `multiplier`. */
export function bleedPixels(mm, dpi = 300, multiplier = 1) {
  const value = Number(mm);
  if (!(value > 0)) return 0;
  return Math.round((value / MM_PER_INCH) * dpi * multiplier);
}

/**
 * A canvas `bleedX`/`bleedY` pixels larger on every side than `source`, with
 * the source in the middle and its edges mirrored outwards — sides flipped
 * across their edge, corners across both.
 *
 * The bleed cannot be wider than the picture it is mirrored from; it is
 * capped there rather than refused, since only a strip of it survives the cut.
 */
export function mirrorBleed(source, bleedX, bleedY = bleedX) {
  const w = source.naturalWidth || source.width;
  const h = source.naturalHeight || source.height;
  if (!(w > 0) || !(h > 0)) throw new Error('the card image has no size');
  const bx = Math.max(0, Math.min(Math.round(bleedX), w));
  const by = Math.max(0, Math.min(Math.round(bleedY), h));

  const canvas = document.createElement('canvas');
  canvas.width = w + bx * 2;
  canvas.height = h + by * 2;
  const ctx = canvas.getContext('2d');

  // One axis at a time: where a strip comes from in the source, where it goes
  // on the canvas, and whether it is flipped on the way.
  const spans = (size, bleed) => [
    { from: 0, length: bleed, to: 0, flip: true },
    { from: 0, length: size, to: bleed, flip: false },
    { from: size - bleed, length: bleed, to: bleed + size, flip: true },
  ];
  for (const x of spans(w, bx)) {
    for (const y of spans(h, by)) {
      if (!x.length || !y.length) continue;
      // Flipping a strip in place: x' = (to + to + length) - x maps the
      // destination rectangle back onto itself, reversed.
      ctx.setTransform(
        x.flip ? -1 : 1, 0, 0, y.flip ? -1 : 1,
        x.flip ? x.to * 2 + x.length : 0,
        y.flip ? y.to * 2 + y.length : 0
      );
      ctx.drawImage(source, x.from, y.from, x.length, y.length, x.to, y.to, x.length, y.length);
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}
