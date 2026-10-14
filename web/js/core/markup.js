/**
 * Bold and italic words inside a text layer: `<b>Flying</b>` and
 * `<i>(This creature can block…)</i>`.
 *
 * The tags are part of the text — in Card Fields, a spreadsheet cell, a
 * saved project — and are read every time the text is measured and drawn.
 * They take no room and are never painted; the words between them are set in
 * the layer's font, bold or italic. Nothing is stored as Fabric character
 * styles, which are keyed by position and wiped by every set('text') (Card
 * Fields, batch rows and card switches all do one), so formatting goes
 * wherever its words go, and a layer with no tags is drawn exactly as before.
 */

/* What a character is: plain, inside bold and/or italic, or part of a tag. */
const BOLD = 1;
const ITALIC = 2;
const TAG = 4;

const TAGS = [
  { text: '<b>', flag: BOLD, open: true },
  { text: '</b>', flag: BOLD, open: false },
  { text: '<i>', flag: ITALIC, open: true },
  { text: '</i>', flag: ITALIC, open: false },
];
const ANY_TAG = /<\/?[bi]>/gi;

/** A text without its formatting tags: what a reader of the card sees. */
export function plainText(text) {
  return String(text ?? '').replace(ANY_TAG, '');
}

/** Whether a text uses any formatting tag. */
export function hasMarkup(text) {
  ANY_TAG.lastIndex = 0;
  return ANY_TAG.test(String(text ?? ''));
}

/**
 * The kind of every character, line by line, for a text split into lines
 * of graphemes the way Fabric splits it. A tag must sit within one line, but
 * what it opens runs on across line breaks until it is closed (or the text
 * ends); a closing tag with nothing open is still a tag, and hidden.
 */
export function markupKinds(lines) {
  let bold = 0;
  let italic = 0;
  return lines.map((chars) => {
    const kinds = new Array(chars.length).fill(0);
    for (let i = 0; i < chars.length; i += 1) {
      if (chars[i] === '<') {
        const tag = TAGS.find((t) => tagAt(chars, i, t.text));
        if (tag) {
          kinds.fill(TAG, i, i + tag.text.length);
          if (tag.flag === BOLD) bold = Math.max(0, bold + (tag.open ? 1 : -1));
          else italic = Math.max(0, italic + (tag.open ? 1 : -1));
          i += tag.text.length - 1;
          continue;
        }
      }
      kinds[i] = (bold ? BOLD : 0) | (italic ? ITALIC : 0);
    }
    return kinds;
  });
}

function tagAt(chars, at, text) {
  for (let k = 0; k < text.length; k += 1) {
    if (String(chars[at + k] ?? '').toLowerCase() !== text[k]) return false;
  }
  return true;
}

/* ------------------------------------------------------------- drawing -- */

/** The kinds for a layer's current text, worked out once per text. */
function kindsOf(obj) {
  const text = String(obj.text ?? '');
  const cached = obj.__tcgMarkup;
  if (cached && cached.text === text) return cached.kinds;
  let kinds = null;
  if (hasMarkup(text)) {
    const split = (line) => (obj.graphemeSplit ? obj.graphemeSplit(line) : Array.from(line));
    kinds = markupKinds(text.split(/\r?\n/).map(split));
  }
  obj.__tcgMarkup = { text, kinds };
  return kinds;
}

/*
 * The kind of the character Fabric names by (line, char). A Textbox names
 * its *wrapped* lines, except while it is wrapping; its own style lookup
 * turns a wrapped place into one in the typed lines through `_styleMap`, and
 * this does the same, so the answer always matches the character asked about.
 */
function kindAt(obj, lineIndex, charIndex) {
  const kinds = kindsOf(obj);
  if (!kinds) return 0;
  let line = lineIndex;
  let char = charIndex;
  if (obj._styleMap && !obj.isWrapping) {
    const place = obj._styleMap[lineIndex];
    if (!place) return 0;
    line = place.line;
    char = place.offset + charIndex;
  }
  return kinds[line]?.[char] || 0;
}

function lineHasMarkup(obj, lineIndex) {
  if (!kindsOf(obj)) return false;
  const length = obj._textLines?.[lineIndex]?.length || 0;
  for (let c = 0; c < length; c += 1) if (kindAt(obj, lineIndex, c)) return true;
  return false;
}

if (typeof fabric !== 'undefined' && fabric.FabricText) {
  const text = fabric.FabricText.prototype;

  // Fabric asks the same question when text is copied or dragged on the
  // canvas, and would then write the bold into the pasted characters' own
  // styles, where removing the tags could no longer undo it.
  let copying = 0;
  const selectionStyles = text.getSelectionStyles;
  text.getSelectionStyles = function selectionStylesAsTyped(...args) {
    copying += 1;
    try {
      return selectionStyles.apply(this, args);
    } finally {
      copying -= 1;
    }
  };

  // Measuring and drawing both ask for a character's complete style, so one
  // answer here sets bold words at their bold width for wrapping and auto-fit
  // and draws them bold. A tag is drawn in no colour at all.
  const completeStyle = text.getCompleteStyleDeclaration;
  text.getCompleteStyleDeclaration = function styleWithMarkup(lineIndex, charIndex) {
    const style = completeStyle.call(this, lineIndex, charIndex);
    if (copying) return style;
    const kind = kindAt(this, lineIndex, charIndex);
    if (!kind) return style;
    if (kind & TAG) {
      return {
        ...style,
        fill: 'rgba(0,0,0,0)',
        stroke: null,
        textBackgroundColor: '',
        underline: false,
        overline: false,
        linethrough: false,
      };
    }
    return {
      ...style,
      ...(kind & BOLD ? { fontWeight: 'bold' } : {}),
      ...(kind & ITALIC ? { fontStyle: 'italic' } : {}),
    };
  };

  // A tag takes no room, including the layer's letter spacing.
  const graphemeBox = text._getGraphemeBox;
  text._getGraphemeBox = function boxWithoutTags(grapheme, lineIndex, charIndex, ...rest) {
    const box = graphemeBox.call(this, grapheme, lineIndex, charIndex, ...rest);
    if (kindAt(this, lineIndex, charIndex) & TAG) {
      box.width = 0;
      box.kernedWidth = 0;
    }
    return box;
  };

  // Fabric draws a line with no character styles in one call, in the
  // layer's own font, which would paint the tags and set every word plain.
  // Wrap every class that owns the method, once each (as core/icons.js does).
  const owners = new Set();
  for (const klass of [fabric.FabricText, fabric.IText, fabric.Textbox]) {
    let proto = klass?.prototype;
    while (proto && !Object.prototype.hasOwnProperty.call(proto, 'isEmptyStyles')) proto = Object.getPrototypeOf(proto);
    if (proto) owners.add(proto);
  }
  for (const proto of owners) {
    const emptyStyles = proto.isEmptyStyles;
    proto.isEmptyStyles = function emptyUnlessMarkedUp(lineIndex) {
      if (lineIndex !== undefined && lineHasMarkup(this, lineIndex)) return false;
      return emptyStyles.call(this, lineIndex);
    };
  }
}
