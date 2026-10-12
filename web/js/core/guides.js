/*
 * Guides: lines the user places on the card to line layers up against.
 *
 * They are part of the layout, like the card's size, so they live on
 * `state.card.guides` as `{x: [...], y: [...]}` in card pixels — `x` holds
 * vertical guides (a position across the card), `y` horizontal ones. That puts
 * them in projects, templates and undo steps with no extra plumbing. They are
 * painted by the editor and never reach an export.
 *
 * This module is the pure part: what a valid list looks like, and what goes
 * into a file. The editor owns changing them (editor.addGuide() and friends).
 */

/** Most guides a card keeps on either axis; past this a list is a mistake. */
export const MAX_GUIDES = 64;

export const AXES = ['x', 'y'];

/** An empty guide list. A new object every time: lists are never shared. */
export const noGuides = () => ({ x: [], y: [] });

/** A guide position kept to a tenth of a pixel, inside the card. */
export function guideAt(value, size) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const limit = Number.isFinite(size) && size > 0 ? size : Infinity;
  return Math.round(Math.min(Math.max(n, 0), limit) * 10) / 10;
}

/**
 * A guide list as the editor keeps it, from whatever a file (or an older
 * build, which has none) holds. Positions outside the card are dropped rather
 * than pulled to its edge: a guide at 900 on a card resized to 750 wide was
 * placed for the bigger card, and is not a guide at 750.
 */
export function cleanGuides(raw, card = {}) {
  const out = noGuides();
  if (!raw || typeof raw !== 'object') return out;
  for (const axis of AXES) {
    const size = axis === 'x' ? card.width : card.height;
    const list = Array.isArray(raw[axis]) ? raw[axis] : [];
    for (const value of list) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || (Number.isFinite(size) && n > size)) continue;
      if (out[axis].length < MAX_GUIDES) out[axis].push(guideAt(n, size));
    }
  }
  return out;
}

export const guideCount = (guides) => (guides?.x?.length || 0) + (guides?.y?.length || 0);

/**
 * The card as a project or template file stores it: guides only when there
 * are some, so a set without guides diffs the same as before they existed.
 */
export function cardForFile(card) {
  const out = { ...card };
  if (guideCount(card.guides)) out.guides = cleanGuides(card.guides, card);
  else delete out.guides;
  return out;
}
