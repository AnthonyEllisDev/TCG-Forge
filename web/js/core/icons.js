/*
 * Icons in text — {gem}, {element-fire} — drawn from an icon font.
 *
 * An icon is a character in the Private Use Area of a font in
 * workspace/assets/fonts whose glyph carries a name (tools/build_icon_font.py
 * makes one from the SVG icons). The text stores the character itself, so an
 * icon is copied, saved, undone, batch-rendered and auto-fitted exactly like a
 * letter; `{name}` is only how it is typed. Nothing here knows what any icon
 * means — a game's symbols are whatever its font calls them.
 *
 * The canvas finds the glyph by font fallback: every text layer's font is
 * followed by the icon fonts, so a character its own font lacks is looked up
 * there. Text layers keep the font they were given.
 */

import { bus, EVT } from '../util/bus.js';

const PUA_START = 0xe000;
const PUA_END = 0xf8ff;

/* name → { name, char, family } */
const catalogue = new Map();
/* Families that hold icons, in the order they were found. */
const families = [];

/* ----------------------------------------------------------- reading -- */

/**
 * Every named Private Use Area glyph in a TrueType/OpenType font, as
 * name → code point. A font without a format 2 `post` table names nothing and
 * gives an empty map; so does anything that is not a plain sfnt (WOFF).
 */
export function readIconNames(buffer) {
  const view = new DataView(buffer);
  const names = new Map();
  if (view.byteLength < 12) return names;
  const tag = view.getUint32(0);
  if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) return names;
  const tables = {};
  const count = view.getUint16(4);
  for (let i = 0; i < count; i += 1) {
    const at = 12 + 16 * i;
    const name = String.fromCharCode(...new Uint8Array(buffer, at, 4));
    tables[name] = { offset: view.getUint32(at + 8), length: view.getUint32(at + 12) };
  }
  if (!tables.cmap || !tables.post) return names;

  const glyphOf = readCmap(view, tables.cmap.offset);
  const glyphNames = readPost(view, tables.post);
  if (!glyphNames) return names;
  for (const [cp, gid] of glyphOf) {
    const name = glyphNames[gid];
    if (name) names.set(name.toLowerCase(), cp);
  }
  return names;
}

/** Code point → glyph id for the Private Use Area, from format 4 or 12. */
function readCmap(view, base) {
  const out = new Map();
  const count = view.getUint16(base + 2);
  let best = null;
  for (let i = 0; i < count; i += 1) {
    const at = base + 4 + 8 * i;
    const platform = view.getUint16(at);
    const sub = base + view.getUint32(at + 4);
    const format = view.getUint16(sub);
    if (platform !== 0 && platform !== 3) continue;
    if (format === 12) { best = { sub, format }; break; }
    if (format === 4 && !best) best = { sub, format };
  }
  if (!best) return out;
  const { sub, format } = best;
  if (format === 12) {
    const groups = view.getUint32(sub + 12);
    for (let g = 0; g < groups; g += 1) {
      const at = sub + 16 + 12 * g;
      const start = view.getUint32(at);
      const end = view.getUint32(at + 4);
      const glyph = view.getUint32(at + 8);
      for (let cp = Math.max(start, PUA_START); cp <= Math.min(end, PUA_END); cp += 1) {
        out.set(cp, glyph + cp - start);
      }
    }
    return out;
  }
  const segs = view.getUint16(sub + 6) / 2;
  const ends = sub + 14;
  const starts = ends + 2 * segs + 2;
  const deltas = starts + 2 * segs;
  const ranges = deltas + 2 * segs;
  for (let s = 0; s < segs; s += 1) {
    const end = view.getUint16(ends + 2 * s);
    const start = view.getUint16(starts + 2 * s);
    const delta = view.getInt16(deltas + 2 * s);
    const rangeOffset = view.getUint16(ranges + 2 * s);
    for (let cp = Math.max(start, PUA_START); cp <= Math.min(end, PUA_END); cp += 1) {
      let glyph;
      if (rangeOffset) {
        glyph = view.getUint16(ranges + 2 * s + rangeOffset + 2 * (cp - start));
        if (glyph) glyph = (glyph + delta) & 0xffff;
      } else {
        glyph = (cp + delta) & 0xffff;
      }
      if (glyph) out.set(cp, glyph);
    }
  }
  return out;
}

/** Glyph id → name from a format 2 `post` table; null for any other format. */
function readPost(view, { offset, length }) {
  if (view.getUint32(offset) !== 0x00020000) return null;
  const count = view.getUint16(offset + 32);
  const strings = [];
  let at = offset + 34 + 2 * count;
  const end = offset + length;
  while (at < end) {
    const len = view.getUint8(at);
    let text = '';
    for (let i = 1; i <= len; i += 1) text += String.fromCharCode(view.getUint8(at + i));
    strings.push(text);
    at += 1 + len;
  }
  // Indices below 258 are the standard Macintosh glyph names (space, A, …);
  // no icon is one of those, so only the font's own strings are kept.
  const names = [];
  for (let gid = 0; gid < count; gid += 1) {
    const index = view.getUint16(offset + 34 + 2 * gid);
    names.push(index >= 258 ? strings[index - 258] || null : null);
  }
  return names;
}

/* -------------------------------------------------------- catalogue -- */

/**
 * Take note of a font the browser has just registered as `family`. Fonts with
 * no named icons are ignored. Returns how many icons it added.
 */
export function addIconFont(family, buffer) {
  let names;
  try {
    names = readIconNames(buffer);
  } catch (err) {
    console.warn(`[icons] could not read ${family}`, err);
    return 0;
  }
  let added = 0;
  for (const [name, cp] of names) {
    // The first font to name an icon keeps it; a second font cannot quietly
    // change what {gem} means on cards already made.
    if (catalogue.has(name)) continue;
    catalogue.set(name, { name, char: String.fromCodePoint(cp), family });
    added += 1;
  }
  if (added && !families.includes(family)) {
    families.push(family);
    publish();
  }
  return added;
}

/** Every known icon, by name. */
export const iconList = () => [...catalogue.values()].sort((a, b) => a.name.localeCompare(b.name));

/** The families icons come from, for font fallback. */
export const iconFamilies = () => [...families];

const TOKEN = /\{([a-z0-9][a-z0-9_.-]*)\}/gi;

/**
 * Turn every `{name}` that names a known icon into the icon. Anything else in
 * braces is left exactly as typed, so `{n}` in a card-number pattern or a
 * filename pattern is never touched by accident.
 */
export function expandIcons(text) {
  const value = String(text ?? '');
  if (!catalogue.size || !value.includes('{')) return value;
  return value.replace(TOKEN, (whole, name) => catalogue.get(name.toLowerCase())?.char ?? whole);
}

/* ---------------------------------------------------------- fallback -- */

const quoted = (family) => `"${family.replace(/["\\]/g, '')}"`;

function publish() {
  const list = families.map(quoted).join(', ');
  // Inputs and the palette draw icons the same way the canvas does.
  document.documentElement.style.setProperty('--font-icons', `${list}, sans-serif`);
  bus.emit(EVT.ICONS, iconList());
}

/*
 * Fabric builds the CSS font for every run of text in one place. Adding the
 * icon families after the layer's own font is what lets "Deal 2 {fire}" draw
 * the words in the layer's font and the icon from the icon font, both on the
 * canvas and in Fabric's measurements, so wrapping and auto-fit see the icon
 * at its real width.
 */
if (typeof fabric !== 'undefined' && fabric.FabricText) {
  const base = fabric.FabricText.prototype._getFontDeclaration;
  fabric.FabricText.prototype._getFontDeclaration = function fontWithIcons(...args) {
    const declaration = base.apply(this, args);
    return families.length ? `${declaration}, ${families.map(quoted).join(', ')}` : declaration;
  };
}
