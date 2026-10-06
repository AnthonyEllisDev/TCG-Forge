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
 *
 * A card may also change a layer for itself alone — nudge the title, turn a
 * badge, recolour a plate (`overrides`, keyed by the layer's `tcgId`). Such a
 * layer carries the layout's own values in `tcgBase` while its card is shown;
 * every other card, and every file, sees the layout.
 *
 * How a card's artwork sits in its window — zoomed, moved, turned — is the
 * card's too (`framing`, keyed by slot). The art layer is replaced from card
 * to card, so that is kept as a relation to the window, not as a layer.
 */

import { api } from './api.js';
import { bus, EVT } from '../util/bus.js';
import { state } from './state.js';
import { editor } from './editor.js';
import { history } from './history.js';
import { applyRow, isRendering, runBatch, toCSV } from './batch.js';
import { collapseIcons, expandIcons } from './icons.js';
import { readQuantity } from './printSheet.js';
import {
  applyFraming,
  cleanFraming,
  collectFields,
  isImageSlot,
  isPlacedArt,
  readFraming,
} from './templates.js';
import { OVERRIDE_KEYS, overrideKeysFor, revertToLayout } from './objects.js';
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
export function captureValues({ remembered = true } = {}) {
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
  // A batch row on the canvas is not that card, and has no such picture.
  if (!remembered) return values;
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
  if (!src.startsWith(files)) return src || null;
  // The address is percent-encoded; the card stores the file's own path.
  const path = src.slice(files.length);
  try {
    return decodeURIComponent(path) || null;
  } catch {
    return path || null;
  }
}

/** Artwork a card names that could not be loaded when it was last shown. */
let unresolved = {};

/**
 * A card switch in progress. The pointer already names the incoming card while
 * the canvas is still being filled with it, so for that moment the canvas is
 * neither card and must not be read into either.
 */
let switching = null;

/**
 * Artwork the user has placed that is still loading. A switch that started
 * meanwhile would carry the picture onto the incoming card, so switches and
 * renders wait for these as they wait for a switch.
 */
const placing = new Set();

/** Resolves once no card switch, and no placing of art, is in progress. */
export async function settled() {
  while (switching || placing.size) {
    await (switching || Promise.allSettled([...placing]));
  }
}

/**
 * Place artwork on the card on screen, holding back any switch until it has
 * landed. `work` starts only once the canvas is settled, so it always lands
 * on the card that was showing when it began.
 */
export async function placeArt(work) {
  await settled();
  const job = work();
  placing.add(job);
  try {
    return await job;
  } finally {
    placing.delete(job);
  }
}

/** True while a card switch is drawing the incoming card. */
export const isSwitching = () => !!switching;

/** Write the card on screen back into the list. */
export function syncActive() {
  const cards = cardList();
  // Mid-switch the outgoing card has already been written back and the
  // incoming one's record is still the truth.
  if (switching) return cards;
  const card = cards[state.project.activeCard];
  card.values = captureValues();
  const overrides = captureOverrides();
  if (Object.keys(overrides).length) card.overrides = overrides;
  else delete card.overrides;
  const framing = captureFraming();
  if (framing) card.framing = framing;
  else delete card.framing;
  return cards;
}

/* --------------------------------------------------------------- framing -- */

/** How the card on screen frames its artwork, by slot; null when all is plain. */
function captureFraming() {
  const out = {};
  readLayers(() => {
    for (const [slot, kind] of slotKinds()) {
      if (kind !== 'image') continue;
      const framing = readFraming(editor.findBySlot(slot)[0]);
      if (framing) out[slot] = framing;
    }
  });
  return Object.keys(out).length ? out : null;
}

/**
 * Frame the artwork on screen as a card says. Every art slot is set, not
 * only the ones the card names: a picture carried over from the previous
 * card (same file, so not reloaded) would otherwise keep that card's zoom.
 */
export function showFraming(framing) {
  for (const [slot, kind] of slotKinds()) {
    if (kind !== 'image') continue;
    applyFraming(editor.findBySlot(slot)[0], framing?.[slot] || null);
  }
  editor.canvas?.requestRenderAll();
}

/** A card's framing as read from a file: `{}` when it has none. */
function readFramingMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const framing = {};
  for (const [slot, value] of Object.entries(raw)) {
    const clean = cleanFraming(value);
    if (clean) framing[slot] = clean;
  }
  return Object.keys(framing).length ? { framing } : {};
}

/* -------------------------------------------------------------- overrides -- */

/**
 * Whether a layer can be changed for one card. Artwork slots cannot: the
 * picture is replaced on every card, and how a card crops its art is a
 * different question from where a layer sits. Nor can anything inside a
 * group, which moves as the layout's.
 */
export function canOverride(obj) {
  if (!obj?.tcgId || obj.group || obj.type === 'activeselection') return false;
  if (!editor.objects().includes(obj)) return false;
  return !(obj.tcgSlot && isImageSlot(editor.findBySlot(obj.tcgSlot)));
}

/** The layout's values for what a card may change about this layer. */
function layoutValues(obj) {
  return Object.fromEntries(overrideKeysFor(obj).map((key) => [key, obj[key]]));
}

/** Keep only what a card may change, in a shape that can be set. */
function cleanPatch(patch) {
  const out = {};
  for (const key of OVERRIDE_KEYS) {
    const value = patch?.[key];
    if (key === 'fill' ? typeof value === 'string' : Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/**
 * Where a layer sits, read in card coordinates. A member of a multi-layer
 * selection holds coordinates relative to the selection, so the selection is
 * dropped for the reading and put back after.
 */
function readLayers(read) {
  const members = editor.memberSelection();
  try {
    return read();
  } finally {
    if (members.length > 1) editor.select(members);
  }
}

/** What the card on screen has changed for itself, as sparse patches. */
function captureOverrides() {
  const out = {};
  const changed = editor.objects().filter((obj) => obj.tcgBase && obj.tcgId);
  if (!changed.length) return out;
  readLayers(() => {
    for (const obj of changed) {
      const patch = {};
      for (const [key, base] of Object.entries(obj.tcgBase)) {
        if (obj[key] !== base) patch[key] = obj[key];
      }
      // A layer marked with nothing changed yet is still marked: the next
      // nudge belongs to this card.
      out[obj.tcgId] = cleanPatch(patch);
    }
  });
  return out;
}

/**
 * Show a card's own changes on the layout: every layer goes back to the
 * layout first, then each patch is laid over its layer. Layers a patch names
 * that are no longer on the layout are passed over.
 */
export function showOverrides(overrides) {
  const touched = editor.objects().filter((obj) => revertToLayout(obj));
  for (const [id, patch] of Object.entries(overrides || {})) {
    const obj = editor.objects().find((o) => o.tcgId === id);
    if (!canOverride(obj)) continue;
    const base = layoutValues(obj);
    const own = Object.entries(cleanPatch(patch)).filter(([key]) => key in base);
    obj.set({ tcgBase: base, ...Object.fromEntries(own) });
    obj.initDimensions?.();
    obj.setCoords();
    touched.push(obj);
  }
  // A text box given another width wraps differently, and auto-fit has to
  // measure it again.
  new Set(touched).forEach((obj) => { if (obj.tcgAutoFit) editor.autoFitText(obj); });
  editor.canvas?.requestRenderAll();
}

/** Whether a layer is changed on the card on screen alone. */
export const isOverridden = (obj) => !!obj?.tcgBase;

/**
 * Make a layer the card on screen's own, or give it back to the layout.
 * Handing it back puts it where the layout has it — the card's change is
 * dropped, not spread to the rest of the set.
 */
export function setOverride(obj, on) {
  if (on) {
    if (!canOverride(obj) || obj.tcgBase) return false;
    obj.set('tcgBase', layoutValues(obj));
  } else if (!revertToLayout(obj)) {
    return false;
  }
  editor.canvas.requestRenderAll();
  editor.touch();
  editor.emitSelection();
  return true;
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

/* ---------------------------------------------------------------- filter -- */

/**
 * Split a filter into terms. Words are matched separately and all must be
 * found; "quoted words" are one term; `slot:words` looks in that field only;
 * `#12` is the card at that place in the strip. A prefix that names no field
 * is left as text, so `10:30` still searches for itself.
 */
export function parseFilter(query, slots = new Set(slotKinds().keys())) {
  const terms = [];
  const pattern = /(?:([^\s:"]+):)?(?:"([^"]*)"?|(\S+))/g;
  for (const match of String(query || '').matchAll(pattern)) {
    let [whole, slot, quoted, word] = match;
    if (slot !== undefined && !slots.has(slot)) {
      slot = undefined;
      quoted = undefined;
      word = whole.replace(/"/g, '');
    }
    const text = (quoted ?? word ?? '').toLowerCase().trim();
    if (!slot && /^#\d+$/.test(text)) {
      terms.push({ number: Number(text.slice(1)) });
    } else if (text) {
      terms.push({ slot: slot || null, text });
    }
  }
  return terms;
}

/**
 * What a filter searches in one value: text as the sheet writes it, so
 * `{gem}` finds the icon, and artwork by its path. A picture held only as a
 * data URL has no name to find, and its base64 would match almost anything.
 */
function searchable(value) {
  const text = String(value ?? '');
  if (/^(data|blob):/i.test(text)) return '';
  return collapseIcons(text).toLowerCase();
}

/** Does a card's set of values pass every term? */
export function cardMatches(values, terms, number = 0) {
  return terms.every((term) => {
    if (term.number !== undefined) return term.number === number;
    if (term.slot) return searchable(values?.[term.slot]).includes(term.text);
    return Object.values(values || {}).some((value) => searchable(value).includes(term.text));
  });
}

/**
 * The places in the strip of the cards a filter lets through, or `null` when
 * the filter is blank. The card on screen is read from its slots, since its
 * record is only brought up to date when another card is shown. Only slots the
 * layout still has are searched, so a value left over from a removed field
 * cannot match.
 */
export function matchingCards(query) {
  if (!String(query || '').trim()) return null;
  const kinds = slotKinds();
  const terms = parseFilter(query, new Set(kinds.keys()));
  if (!terms.length) return null;
  const active = activeIndex();
  const out = [];
  cardList().forEach((card, index) => {
    const source = index === active ? captureValues() : card.values || {};
    const values = {};
    for (const slot of kinds.keys()) values[slot] = source[slot];
    if (cardMatches(values, terms, index + 1)) out.push(index);
  });
  return out;
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
  // An undo still loading would release the history lock halfway through the
  // switch and put the old card's step over the new card.
  await history.settled();
  // Art still loading belongs to the card it was placed on, so it lands there
  // first; this also keeps two switches from running into each other.
  await settled();
  const cards = cardList();
  if (index === state.project.activeCard || index < 0 || index >= cards.length) return [];
  syncActive();
  let finish;
  switching = new Promise((resolve) => { finish = resolve; });
  try {
    return await showCard(index, cards);
  } finally {
    switching = null;
    finish();
  }
}

async function showCard(index, cards) {
  const wasDirty = state.dirty;
  history.locked = true;
  editor.canvas.discardActiveObject();
  let failed = {};
  try {
    state.project.activeCard = index;
    failed = await applyValues(cards[index].values);
    showOverrides(cards[index].overrides);
    showFraming(cards[index].framing);
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
  const card = { id: uid('card'), values, qty: copy ? qtyOf(source) : 1 };
  if (copy && source.overrides) card.overrides = JSON.parse(JSON.stringify(source.overrides));
  if (copy && source.framing) card.framing = JSON.parse(JSON.stringify(source.framing));
  cards.splice(at, 0, card);
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
 * The column that ties a spreadsheet row to the card it was written from. Its
 * leading underscore keeps the batch dialog from guessing a slot for it.
 */
export const ID_COLUMN = '_id';

/**
 * Append spreadsheet rows as cards. Nothing is rendered: a row becomes the
 * same values a card holds, so the set can be edited card by card afterwards.
 * A quantity column, when there is one, becomes each card's count.
 *
 * A row whose `_id` names a card already in the project updates that card
 * instead — the way back for a sheet written by cardsTable(). Only the mapped
 * slots change: a column left out, or set to ignore, keeps the card's own
 * value, and so do its per-card layer changes. If the card on screen is one
 * of them, it is shown again with its new values.
 */
export async function addRows(rows, mapping, resolve, { qtyColumn = '' } = {}) {
  if (isRendering()) throw new Error('a render is using the card — try again when it has finished');
  await history.settled();
  await settled();
  const cards = syncActive();
  const byId = new Map(cards.map((card) => [card.id, card]));
  const fresh = rows.filter((row) => !byId.has(String(row[ID_COLUMN] ?? '').trim()));
  if (cards.length + fresh.length > MAX_CARDS) {
    throw new Error(`that would make ${cards.length + fresh.length} cards — a project holds at most ${MAX_CARDS}`);
  }
  const kinds = slotKinds();
  const missing = new Set();
  const touched = new Set();
  let added = 0;
  for (const row of rows) {
    const id = String(row[ID_COLUMN] ?? '').trim();
    // A row copied in the spreadsheet carries the same id twice; the first
    // updates the card and the copy becomes a card of its own.
    const card = byId.get(id) && !touched.has(id) ? byId.get(id) : null;
    const values = card ? { ...card.values } : {};
    for (const [column, slot] of Object.entries(mapping)) {
      if (!kinds.has(slot)) continue;
      const cell = String(row[column] ?? '').trim();
      if (kinds.get(slot) === 'text') {
        values[slot] = expandIcons(row[column] ?? '');
      } else if (cell) {
        try {
          const asset = resolve(cell);
          values[slot] = asset?.path || asset?.url || null;
        } catch {
          missing.add(cell);
          values[slot] = null;
        }
      } else if (card && !/^(data|blob):/i.test(card.values[slot] || '')) {
        // Blank means blank, for art too: the card goes back to the layout's.
        // Except for a picture kept inside the project file, which a sheet
        // has no way to hold — cardsTable() wrote it out as a blank cell.
        values[slot] = null;
      }
    }
    if (card) {
      // A new picture starts at the cover fit; another picture's zoom would
      // mean nothing on it.
      for (const slot of Object.keys(card.framing || {})) {
        if (values[slot] !== card.values[slot]) delete card.framing[slot];
      }
      if (card.framing && !Object.keys(card.framing).length) delete card.framing;
      card.values = values;
      if (qtyColumn) card.qty = readQuantity(row[qtyColumn]);
      touched.add(id);
    } else {
      cards.push({ id: uid('card'), values, qty: qtyColumn ? readQuantity(row[qtyColumn]) : 1 });
      added += 1;
    }
  }
  const active = state.project.activeCard;
  if (touched.has(cards[active].id)) {
    // The canvas is the truth for the card on screen, so a new value in its
    // record means nothing until the card is drawn from it again.
    await settled();
    let finish;
    switching = new Promise((done) => { finish = done; });
    try {
      await showCard(active, cards);
    } finally {
      switching = null;
      finish();
    }
  }
  if (added || touched.size) state.setDirty(true);
  bus.emit(EVT.CARDS, cards);
  return { added, updated: touched.size, missing: [...missing] };
}

/**
 * Every card as a spreadsheet: one row per card, one column per slot, its
 * copies, and its id so the sheet can come back as an update (addRows). Icons
 * are written as their `{name}`, which reads in any spreadsheet and turns back
 * into the icon on the way in. Artwork is its workspace path; a picture that
 * only lives inside the project file as a data URL has no path to write and
 * is left blank — `inline` counts those.
 */
export async function cardsTable() {
  await settled();
  const cards = syncActive();
  const kinds = slotKinds();
  const slots = [...kinds.keys()];
  const qtyColumn = kinds.has('qty') ? 'copies' : 'qty';
  const columns = [ID_COLUMN, ...slots, qtyColumn];
  let inline = 0;
  const rows = cards.map((card) => {
    const row = { [ID_COLUMN]: card.id, [qtyColumn]: String(qtyOf(card)) };
    for (const [slot, kind] of kinds) {
      const value = card.values?.[slot];
      if (kind === 'text') {
        row[slot] = collapseIcons(value ?? '');
      } else if (value && /^(data|blob):/i.test(value)) {
        row[slot] = '';
        inline += 1;
      } else {
        row[slot] = value || '';
      }
    }
    return row;
  });
  return { columns, rows, inline, csv: toCSV(columns, rows) };
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
    const row = {
      _card: cardLabel(card, index, kinds),
      _qty: qtyOf(card),
      _overrides: card.overrides || null,
      _framing: card.framing || null,
    };
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
export function exportCards({ multiplier = 2, format = 'png', transparent = false, bleedMm = 0, onProgress } = {}) {
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
      bleedMm,
      subfolder,
      pattern: '{n:3}-{_card}',
      toWorkspace: api.online,
      qtyColumn: '_qty',
      prepare: showCardChanges,
    },
  });
}

/** Lay a card's own changes over a batch row: its layers, then its art. */
function showCardChanges(row) {
  showOverrides(row._overrides);
  showFraming(row._framing);
}

/** Render every card to data URLs, in order, without writing anything. */
export async function renderCards({ multiplier = 1, squareCorners = false, onProgress } = {}) {
  const { rows, mapping } = cardRows();
  const urls = [];
  const result = await runBatch({
    rows,
    mapping,
    onProgress,
    options: {
      multiplier,
      format: 'png',
      squareCorners,
      sink: (url) => urls.push(url),
      prepare: showCardChanges,
    },
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
  if (onlyActive) {
    // The canvas holds a batch row here, not the card on screen, so the art
    // that card could not load is not this row's.
    const card = { id: uid('card'), values: captureValues({ remembered: false }) };
    const overrides = captureOverrides();
    if (Object.keys(overrides).length) card.overrides = overrides;
    const framing = captureFraming();
    if (framing) card.framing = framing;
    return { cards: [card], activeCard: 0 };
  }
  const cards = syncActive();
  // A change to a layer that has since been deleted from the layout means
  // nothing any more, on any card.
  const layers = new Set(editor.objects().map((obj) => obj.tcgId).filter(Boolean));
  return {
    // A count, or a card's own changes, are written only where they say
    // something, so a plain set of singles saves exactly as it did before
    // either existed.
    cards: cards.map((card) => {
      const out = { id: card.id, values: { ...card.values } };
      if (qtyOf(card) !== 1) out.qty = qtyOf(card);
      const overrides = Object.entries(card.overrides || {}).filter(([id]) => layers.has(id));
      if (overrides.length) out.overrides = Object.fromEntries(overrides);
      const framing = Object.entries(card.framing || {}).filter(([slot, value]) => card.values?.[slot] && value);
      if (framing.length) out.framing = Object.fromEntries(framing);
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
        ...readOverrides(card?.overrides),
        ...readFramingMap(card?.framing),
      }))
    : null;
  state.project.activeCard = Number.isInteger(data?.activeCard) ? data.activeCard : 0;
  const cards = cardList();
  // Artwork the card on screen names but could not show when it was saved
  // came back as the placeholder. It is still the card's art, and stepping off
  // the card must not read the placeholder over it.
  const active = cards[state.project.activeCard];
  for (const [slot, kind] of slotKinds()) {
    const value = active.values[slot];
    if (kind === 'image' && value && !isPlacedArt(editor.findBySlot(slot)[0])) unresolved[slot] = value;
  }
  // The file holds the layout; the card it opens on may have changed some of
  // it for itself.
  showOverrides(active.overrides);
  bus.emit(EVT.CARDS, state.project.cards);
}

/** A card's own changes as read from a file: `{}` when it has none. */
function readOverrides(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const overrides = {};
  for (const [id, patch] of Object.entries(raw)) {
    if (patch && typeof patch === 'object') overrides[id] = cleanPatch(patch);
  }
  return Object.keys(overrides).length ? { overrides } : {};
}

/** Forget the list — the project is one card again, whatever is on screen. */
export function resetCards() {
  unresolved = {};
  state.project.cards = null;
  state.project.activeCard = 0;
  bus.emit(EVT.CARDS, cardList());
}
