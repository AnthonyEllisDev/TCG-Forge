/**
 * Arced text: a text box bent along a circle.
 *
 * A text layer's `tcgArc` is the angle, in degrees, of the slice of circle its
 * box's width spans: positive bends the middle up (a banner), negative bends
 * it down (a smile), 0 or absent is straight text. Only that number is saved.
 * The curve Fabric lays the characters on is made from it and the box's width
 * every time the text is measured, so resizing the box, a per-card width, an
 * auto-fit, a card switch or a batch row all bend the text they produced
 * without any of them knowing about arcs.
 */

export const MAX_ARC = 180;

/** A saved or typed arc as a number of degrees, or 0 for straight text. */
export function cleanArc(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 0;
  const clamped = Math.max(-MAX_ARC, Math.min(MAX_ARC, value));
  // Below half a degree nobody can see the bend; treat it as straight so a
  // slider dragged back to the middle leaves no key in the file.
  return Math.abs(clamped) < 0.5 ? 0 : Math.round(clamped * 10) / 10;
}

/**
 * The circle through both ends of a box `width` wide whose arc spans
 * `degrees`, as an SVG path from the left end to the right, and how far the
 * middle of the arc stands off the line between the ends (the sagitta).
 */
export function arcGeometry(width, degrees) {
  const arc = cleanArc(degrees);
  const w = Math.max(1, Number(width) || 1);
  if (!arc) return { d: `M 0 0 L ${w} 0`, sag: 0, radius: Infinity };
  const half = (Math.abs(arc) * Math.PI) / 360;
  const radius = w / (2 * Math.sin(half));
  const sag = radius * (1 - Math.cos(half));
  // Over the top (clockwise on screen) for a positive arc, under the bottom
  // for a negative one. Never the large arc: at most a half circle.
  const d = arc > 0
    ? `M 0 ${sag} A ${radius} ${radius} 0 0 1 ${w} ${sag}`
    : `M 0 0 A ${radius} ${radius} 0 0 0 ${w} 0`;
  return { d, sag, radius };
}

/** How tall the text itself is, without the room its bend takes. */
export function textHeightOf(obj) {
  return (obj?.height || 0) - (obj?._arcSag || 0);
}

/* ------------------------------------------------------------- drawing -- */

/*
 * Fabric can lay a text along a path, which does the hard part: each
 * character is placed and turned along the curve, and alignment works along
 * the curve's length. Three things are added here. The path is made from the
 * box rather than stored. The box is made tall enough to hold the bend, so
 * the selection, snapping and alignment see where the words are drawn. And
 * Fabric puts every line of a path text on the same curve, on top of each
 * other; here each line is moved off the curve by its place in the block, so
 * wrapped text draws as parallel arcs.
 */
if (typeof fabric !== 'undefined' && fabric.Textbox) {
  const textbox = fabric.Textbox.prototype;
  const measure = textbox.initDimensions;
  textbox.initDimensions = function initDimensionsWithArc(...args) {
    const result = measure.apply(this, args);
    if (!this.initialized) return result;
    const arc = cleanArc(this.tcgArc);
    if (arc) {
      const { d, sag } = arcGeometry(this.width, arc);
      const path = new fabric.Path(d, { visible: false });
      path.tcgArcPath = true;
      this.path = path;
      this.setPathInfo();
      this.pathAlign = 'center';
      this.pathSide = 'left';
      this.pathStartOffset = 0;
      this._arcSag = sag;
      this._clearCache();
      this.height = this.calcTextHeight() + sag;
    } else if (this.path?.tcgArcPath) {
      this.path = null;
      this.pathAlign = 'baseline';
      this._arcSag = 0;
      this._clearCache();
    }
    return result;
  };

  const base = fabric.FabricText.prototype;
  const measureLine = base._measureLine;
  base._measureLine = function measureLineOnArc(lineIndex, ...rest) {
    const result = measureLine.call(this, lineIndex, ...rest);
    if (!this.path?.tcgArcPath) return result;
    const lines = this._textLines?.length || 0;
    if (String(this.textAlign).startsWith('justify')) justifyOnArc(this, lineIndex, result.width);
    if (lines < 2) return result;
    let above = 0;
    let total = 0;
    for (let i = 0; i < lines; i += 1) {
      const h = this.getHeightOfLine(i);
      if (i < lineIndex) above += h;
      total += h;
    }
    const shift = above + this.getHeightOfLine(lineIndex) / 2 - total / 2;
    for (const box of this.__charBounds[lineIndex] || []) {
      if (box.renderLeft === undefined) continue;
      // Down the page as the character stands: across the curve, not down
      // the screen, so the lines stay parallel to it at both ends.
      box.renderLeft -= Math.sin(box.angle) * shift;
      box.renderTop += Math.cos(box.angle) * shift;
    }
    return result;
  };

  /*
   * Fabric places path text by left, centre or right only, and widens a
   * justified line's spaces after placing it, so a justified arc drew as
   * left-aligned with the Justify button lit. Here the spaces are widened
   * first and the line laid along the curve again, filling it end to end; a
   * line Fabric would not stretch (the last of a paragraph, for the
   * justify-left/centre/right modes) follows the rest of the mode's name.
   */
  function justifyOnArc(obj, lineIndex, lineWidth) {
    const chars = obj._textLines[lineIndex] || [];
    const bounds = obj.__charBounds[lineIndex] || [];
    const info = obj.path.segmentsInfo;
    const length = info?.[info.length - 1]?.length;
    if (!length) return;
    const align = String(obj.textAlign);
    const stretch = align === 'justify'
      || (lineIndex !== obj._textLines.length - 1 && !obj.isEndOfWrapping(lineIndex));
    const spaces = chars.filter((c) => obj._reSpaceAndTab.test(c)).length;
    let start = 0;
    let extra = 0;
    if (stretch && spaces && lineWidth < length) {
      extra = (length - lineWidth) / spaces;
    } else if (align.endsWith('center')) {
      start = (length - lineWidth) / 2;
    } else if (align.endsWith('right')) {
      start = length - lineWidth;
    }
    let at = start;
    for (let i = 0; i < chars.length; i += 1) {
      const box = bounds[i];
      if (!box) continue;
      if (extra && obj._reSpaceAndTab.test(chars[i])) {
        box.width += extra;
        box.kernedWidth += extra;
      }
      obj._setGraphemeOnPath(at, box);
      at += box.kernedWidth;
    }
  }

  // The curve is derived, so the file keeps only the angle. An older build
  // opening it shows the words straight, which is the right thing to lose.
  const toObject = base.toObject;
  base.toObject = function toObjectWithoutArcPath(...args) {
    const out = toObject.apply(this, args);
    if (this.path?.tcgArcPath) {
      delete out.path;
      out.pathAlign = 'baseline';
    }
    return out;
  };
}
