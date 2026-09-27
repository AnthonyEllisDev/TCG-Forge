/*
 * Multi-card projects — one layout, many cards.
 *
 * A card is not a canvas. It is the values that go into the layout's slots:
 * `{ title: 'Ember Wyrm', art: 'assets/art/wyrm.png', stats: '' }`. The canvas
 * is the layout with the active card's values in it, so everything that is not
 * a slot — the frame, the ornaments, a font size — is shared by every card,
 * and a set-wide change is one edit. That is how a spreadsheet row already
 * reaches a card in a batch run, which is why this module is mostly
 * `applyRow()` pointed at the project instead of at a file.
 *
 * The canvas is the truth for the card on screen: its stored values are only
 * read when some other card is shown, and are written back from the slots on
 * every switch and every save.
 */

import { api } from './api.js';
import { bus, EVT } from '../util/bus.js';
import { state } from './state.js';
import { editor } from './editor.js';
import { history } from './history.js';
import { applyRow, runBatch } from './batch.js';
import { readQuantity } from './printSheet.js';
import { collectFields, isImageSlot, isPlacedArt } from './templates.js';
import { slugify, uid } from '../util/dom.js';

/** A project holding more than this is almost certainly a mistyped import. */
export const MAX_CARDS = 1000;

/* ------------------------------------------------------------------ list -- */

/** The card list, built from the canvas the first time anything asks. */
export function cardList() {
  const project = state.project;
  if (!Array.isArray(project.cards) || !project.cards.length) {
    project.cards = [{ id: uid('card'), values: {} }];
    project.activeCard = 0;
  }
  project.activeCard = Math.min(Math.max(0, project.activeCard | 0), project.cards.length - 1);
  return project.cards;
}

export const activeIndex = () => (cardList(), state.project.activeCard);

/**
 * How many copies of a card the deck wants. A card is still one design, drawn
 * once; the count only matters where cards are laid out or listed — the print
 * sheet and the deck list an export writes beside its images. A record with no
 * count is one of itself, which is every card saved before counts existed.
 */
export const qtyOf = (card) => readQuantity(card?.qty);

/** Every card's count, in order. */
export const cardQuantities = () => cardList().map(qtyOf);

/** Set how many of a card the deck wants. Returns the count it settled on. */
export function setCardQty(index, value) {
  const cards = cardList();
  const card = cards[index];
  if (!card) return 1;
  const qty = readQuantity(value);
  if (qtyOf(card) === qty) return qty;
  card.qty = qty;
  state.setDirty(true);
  bus.emit(EVT.CARDS, cards);
  return qty;
}

/** Every slot on the layout, and whether it takes words or artwork. */
export function slotKinds() {
  const kinds = new Map();
  const ids = [...(state.project.fields || []).map((f) => f.id), ...collectFields().map((f) => f.id)];
  for (const slot of ids) {
    if (kinds.has(slot)) continue;
    const targets = editor.findBySlot(slot);
    if (targets.length) kinds.set(slot, isImageSlot(targets) ? 'image' : 'text');
  }
  return kinds;
}

/**
 * Read the card on screen out of its slots.
 *
 * Artwork is stored by workspace path, or as the data URL itself when it never
 * had one (placed without the local server). An art slot showing the layout's
 * own layer — the dashed box, or a picture the template ships — is `null`:
 * "no art of its own".
 */
export function captureValues() {
  const values = {};
  for (const [slot, kind] of slotKinds()) {
    const target = editor.findBySlot(slot)[0];
    if (kind === 'text') {
      values[slot] = String(target.text ?? '');
    } else if (isPlacedArt(target)) {
      values[slot] = artValue(target);
    } else {
      values[slot] = null;
    }
  }
  // A picture that would not load stays on the card's record even though the
  // slot shows the placeholder, so visiting the card does not forget it.
  for (const [slot, value] of Object.entries(unresolved)) {
    if (values[slot] === null) values[slot] = value;
  }
  return values;
}

/**
 * How a card refers to its artwork: the workspace path, never the address the
 * browser resolved it to — that has the port in it, and the port changes.
 */
function artValue(img) {
  if (img.tcgAsset) return img.tcgAsset;
  const src = img.getSrc?.() || '';
  const files = `${location.origin}/files/`;
  return (src.startsWith(files) ? src.slice(files.length) : src) || null;
}

/** Artwork a card names that could not be loaded when it was last shown. */
let unresolved = {};

/** Write the card on screen back into the list. */
export function syncActive() {
  const cards = cardList();
  cards[state.project.activeCard].values = captureValues();
  return cards;
}

/** What to call a card in the strip: its first words, or its number. */
export function cardLabel(card, index, kinds = slotKinds()) {
  for (const [slot, kind] of kinds) {
    if (kind !== 'text') continue;
    const text = String(card.values?.[slot] ?? '').replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return `Card ${index + 1}`;
}

/* ----------------------------------------------------------------- apply -- */

/**
 * Put a card's values into the slots on screen.
 *
 * Every slot is written, not only the ones the card mentions: a slot the card
 * has no value for is emptied, or it would show whatever the previous card
 * left there. Artwork that is already in place is left alone, so switching
 * back and forth does not reload it or undo a crop.
 */
async function applyValues(values) {
  const row = {};
  const mapping = {};
  const failed = {};
  for (const [slot, kind] of slotKinds()) {
    const value = values?.[slot];
    if (kind === 'text') {
      row[slot] = value ?? '';
      mapping[slot] = slot;
      continue;
    }
    const target = editor.findBySlot(slot)[0];
    const want = value || null;
    if (want && isPlacedArt(target) && artValue(target) === want) continue;
    if (!want && !isPlacedArt(target)) continue;
    try {
      await applyRow({ [slot]: want }, { [slot]: slot });
    } catch (err) {
      console.warn(`[cards] could not show ${want} in "${slot}"`, err);
      failed[slot] = want;
      await applyRow({ [slot]: null }, { [slot]: slot });
    }
  }
  await applyRow(row, mapping);
  return failed;
}

/**
 * Show another card.
 *
 * Undo history belongs to the card it was made on — a step recorded on one
 * card would put its words back on the next — so it starts afresh on each.
 */
export async function switchCard(index) {
  const cards = cardList();
  if (index === state.project.activeCard || index < 0 || index >= cards.length) return [];
  syncActive();
  const wasDirty = state.dirty;
  history.locked = true;
  editor.canvas.discardActiveObject();
  let failed = {};
  try {
    state.project.activeCard = index;
    failed = await applyValues(cards[index].values);
  } finally {
    history.locked = false;
    // Placing art selects it; a card switch should not leave anything picked.
    editor.canvas.discardActiveObject();
  }
  unresolved = failed;
  history.reset();
  // Looking at another card changes nothing that is saved.
  state.setDirty(wasDirty);
  editor.emitSelection();
  bus.emit(EVT.CARDS, cardList());
  return Object.values(failed);
}

/** Add a card after the one on screen — empty, or a copy of it — and show it. */
export async function addCard({ copy = false } = {}) {
  const cards = syncActive();
  if (cards.length >= MAX_CARDS) throw new Error(`a project holds at most ${MAX_CARDS} cards`);
  const at = state.project.activeCard + 1;
  const source = cards[state.project.activeCard];
  const values = copy ? { ...source.values } : {};
  cards.splice(at, 0, { id: uid('card'), values, qty: copy ? qtyOf(source) : 1 });
  // The copy is the card the list now points at, so leave the pointer where it
  // was and let the switch do the work.
  await switchCard(at);
  state.setDirty(true);
  return at;
}

/** Remove a card. The last one cannot go: a project is at least one card. */
export async function removeCard(index = state.project.activeCard) {
  const cards = cardList();
  if (cards.length <= 1 || index < 0 || index >= cards.length) return false;
  if (index === state.project.activeCard) {
    await switchCard(index === cards.length - 1 ? index - 1 : index + 1);
  }
  cards.splice(index, 1);
  if (index < state.project.activeCard) state.project.activeCard -= 1;
  state.setDirty(true);
  bus.emit(EVT.CARDS, cards);
  return true;
}

/** Move a card one place along the list. */
export function moveCard(index, delta) {
  const cards = cardList();
  const to = index + delta;
  if (index < 0 || index >= cards.length || to < 0 || to >= cards.length) return false;
  const [card] = cards.splice(index, 1);
  cards.splice(to, 0, card);
  const active = state.project.activeCard;
  if (active === index) state.project.activeCard = to;
  else if (active === to) state.project.activeCard = index;
  state.setDirty(true);
  bus.emit(EVT.CARDS, cards);
  return true;
}

/* ------------------------------------------------------------ from a file -- */

/**
 * Append spreadsheet rows as cards. Nothing is rendered: a row becomes the
 * same values a card holds, so the set can be edited card by card afterwards.
 * A quantity column, when there is one, becomes each card's count.
 */
export function addRows(rows, mapping, resolve, { qtyColumn = '' } = {}) {
  const cards = syncActive();
  if (cards.length + rows.length > MAX_CARDS) {
    throw new Error(`that would make ${cards.length + rows.length} cards — a project holds at most ${MAX_CARDS}`);
  }
  const kinds = slotKinds();
  const missing = new Set();
  for (const row of rows) {
    const values = {};
    for (const [column, slot] of Object.entries(mapping)) {
      if (!kinds.has(slot)) continue;
      const cell = String(row[column] ?? '').trim();
      if (kinds.get(slot) === 'text') {
        values[slot] = String(row[column] ?? '');
      } else if (cell) {
        try {
          const asset = resolve(cell);
          values[slot] = asset?.path || asset?.url || null;
        } catch {
          missing.add(cell);
          values[slot] = null;
        }
      }
    }
    cards.push({ id: uid('card'), values, qty: qtyColumn ? readQuantity(row[qtyColumn]) : 1 });
  }
  state.setDirty(true);
  bus.emit(EVT.CARDS, cards);
  return { added: rows.length, missing: [...missing] };
}

/* ---------------------------------------------------------------- render -- */

/**
 * Every card as a batch row, so the batch renderer can draw the set. The
 * `_card` column carries each card's label for the file-name pattern, and
 * `_qty` its count for the deck list.
 */
function cardRows() {
  const cards = syncActive();
  const kinds = slotKinds();
  const mapping = Object.fromEntries([...kinds.keys()].map((slot) => [slot, slot]));
  const rows = cards.map((card, index) => {
    const row = { _card: cardLabel(card, index, kinds), _qty: qtyOf(card) };
    for (const [slot, kind] of kinds) {
      const value = card.values?.[slot];
      row[slot] = kind === 'image' ? value || null : value ?? '';
    }
    return row;
  });
  return { rows, mapping };
}

/**
 * Render every card into a folder under workspace/exports.
 *
 * The deck list is written every time, even when every card is one copy:
 * the folder is overwritten on each export, and a list left from an export
 * whose counts have since changed would print the old deck.
 */
export function exportCards({ multiplier = 2, format = 'png', transparent = false, onProgress } = {}) {
  const { rows, mapping } = cardRows();
  const subfolder = slugify(state.project.name, 'cards');
  return runBatch({
    rows,
    mapping,
    onProgress,
    options: {
      multiplier,
      format,
      transparent,
      subfolder,
      pattern: '{n:3}-{_card}',
      toWorkspace: api.online,
      qtyColumn: '_qty',
    },
  });
}

/** Render every card to data URLs, in order, without writing anything. */
export async function renderCards({ multiplier = 1, onProgress } = {}) {
  const { rows, mapping } = cardRows();
  const urls = [];
  const result = await runBatch({
    rows,
    mapping,
    onProgress,
    options: { multiplier, format: 'png', sink: (url) => urls.push(url) },
  });
  if (result.failed.length) {
    const first = result.failed[0];
    throw new Error(`card ${first.index + 1} could not be drawn: ${first.error}`);
  }
  return urls;
}

/* -------------------------------------------------------------- the file -- */

/**
 * The list as it goes into a project file. `onlyActive` is the card on screen
 * alone — what a batch run saves for each row, which is one card and not the
 * project it was run from.
 */
export function serializeCards({ onlyActive = false } = {}) {
  if (onlyActive) return { cards: [{ id: uid('card'), values: captureValues() }], activeCard: 0 };
  const cards = syncActive();
  return {
    // A count is written only where it says something, so a set of singles
    // saves exactly as it did before counts existed.
    cards: cards.map((card) => {
      const out = { id: card.id, values: { ...card.values } };
      if (qtyOf(card) !== 1) out.qty = qtyOf(card);
      return out;
    }),
    activeCard: state.project.activeCard,
  };
}

/**
 * Take the list from a project file. The canvas has already been loaded with
 * the active card, so nothing is applied here; a file with no list (every
 * project before 0.7.0) is a project of one card.
 */
export function loadCards(data) {
  unresolved = {};
  const list = Array.isArray(data?.cards) ? data.cards.slice(0, MAX_CARDS) : null;
  state.project.cards = list?.length
    ? list.map((card) => ({
        id: typeof card?.id === 'string' ? card.id : uid('card'),
        values: card?.values && typeof card.values === 'object' ? { ...card.values } : {},
        qty: readQuantity(card?.qty),
      }))
    : null;
  state.project.activeCard = Number.isInteger(data?.activeCard) ? data.activeCard : 0;
  cardList();
  bus.emit(EVT.CARDS, state.project.cards);
}

/** Forget the list — the project is one card again, whatever is on screen. */
export function resetCards() {
  unresolved = {};
  state.project.cards = null;
  state.project.activeCard = 0;
  bus.emit(EVT.CARDS, cardList());
}
