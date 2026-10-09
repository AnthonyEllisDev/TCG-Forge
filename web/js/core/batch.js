/*
 * Batch generation — render a whole card set from a spreadsheet.
 *
 * The slot system already knows how to write a value into a layout, so a set
 * is just: for each row, reset to the template, push the row's values into the
 * matching slots, render, save. Nothing here knows what a "card" means; it
 * only knows columns, slots and files.
 */

import { api } from './api.js';
import { bus, EVT } from '../util/bus.js';
import { assets } from './assets.js';
import { editor } from './editor.js';
import { history } from './history.js';
import { state } from './state.js';
import { clearFieldImage, isImageSlot, setFieldImage, setFieldText } from './templates.js';
import { renderCard, serializeProject } from './project.js';
import { DECK_FILE, buildDeck, readQuantity } from './printSheet.js';
import { toLayoutJSON } from './objects.js';
import { settled } from './cards.js';
import { downloadURL, slugify } from '../util/dom.js';

/* --------------------------------------------------------------- parsing -- */

/** Guess the delimiter from the header line, ignoring quoted sections. */
export function detectDelimiter(text) {
  const line = String(text).split(/\r?\n/, 1)[0] || '';
  const counts = { ',': 0, '\t': 0, ';': 0, '|': 0 };
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && char in counts) counts[char] += 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0
    ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
    : ',';
}

/**
 * Parse delimited text into `{ columns, rows }`. Handles quoted fields,
 * escaped quotes ("") and newlines inside quotes — the things that make
 * hand-rolled CSV splitting fall over on real spreadsheet exports.
 */
export function parseTable(text, { delimiter } = {}) {
  const raw = String(text).replace(/^﻿/, '');
  const sep = delimiter || detectDelimiter(raw);

  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];

    if (inQuotes) {
      if (char === '"') {
        if (raw[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') inQuotes = true;
    else if (char === sep) {
      record.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && raw[i + 1] === '\n') i += 1;
      record.push(field);
      if (record.some((value) => value.trim() !== '')) records.push(record);
      record = [];
      field = '';
    } else {
      field += char;
    }
  }
  record.push(field);
  if (record.some((value) => value.trim() !== '')) records.push(record);

  if (!records.length) return { columns: [], rows: [], delimiter: sep };

  const header = records[0].map((name, index) => name.trim() || `column_${index + 1}`);
  const rows = records.slice(1).map((values) => {
    const row = {};
    header.forEach((name, index) => {
      row[name] = (values[index] ?? '').trim();
    });
    return row;
  });

  return { columns: header, rows, delimiter: sep };
}

/**
 * The reverse of parseTable(): `{ columns, rows }` as CSV text that
 * parseTable() — and a spreadsheet — reads back to the same cells. A cell is
 * quoted when it holds a comma, a quote or a line break. Lines end in CRLF
 * and the text starts with a byte-order mark, which is what makes Excel read
 * it as UTF-8 rather than mangling every accented letter.
 */
export function toCSV(columns, rows) {
  const cell = (value) => {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.map(cell).join(',')];
  for (const row of rows) lines.push(columns.map((column) => cell(row[column])).join(','));
  return `\ufeff${lines.join('\r\n')}\r\n`;
}

/** Accept a JSON array of objects as an alternative to CSV. */
export function parseJSONTable(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data.rows;
  if (!Array.isArray(list)) throw new Error('JSON data must be an array of row objects.');
  const columns = [];
  for (const row of list) {
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  }
  const rows = list.map((row) => {
    const out = {};
    for (const key of columns) out[key] = row[key] === undefined || row[key] === null ? '' : String(row[key]);
    return out;
  });
  return { columns, rows, delimiter: null };
}

export function parseAny(text, filename = '') {
  return /\.json$/i.test(filename) || String(text).trim().startsWith('[')
    ? parseJSONTable(text)
    : parseTable(text);
}

/** Column names that mean "how many of this card", in the order tools use them. */
const QTY_COLUMNS = ['qty', 'quantity', 'count', 'copies', 'number', 'amount'];

/**
 * Pick the quantity column out of a header row, or '' when there is none.
 * `mapped` names columns already feeding a slot: a layout with a slot called
 * `qty` writes its counts as `copies` (cardsTable), so a column that is not
 * card content wins over one that is.
 */
export function guessQtyColumn(columns = [], mapped = new Set()) {
  const normalise = (name) => String(name).trim().toLowerCase().replace(/[\s_-]+/g, '');
  for (const pool of [columns.filter((column) => !mapped.has(column)), columns]) {
    for (const want of QTY_COLUMNS) {
      const hit = pool.find((column) => normalise(column) === want);
      if (hit) return hit;
    }
  }
  return '';
}

/* -------------------------------------------------------------- patterns -- */

/** Room for uniqueNamer()'s "-NNN" and an extension inside the server's 120. */
const MAX_NAME = 100;

/**
 * Expand `{column}` tokens in an output-name pattern.
 * `{n}` is the 1-based row number, `{n:3}` pads it to three digits.
 */
export function fillPattern(pattern, row, index) {
  const filled = String(pattern || '{n:3}').replace(/\{([^}]+)\}/g, (match, token) => {
    const [key, pad] = token.split(':');
    if (key === 'n') return String(index + 1).padStart(Number(pad) || 1, '0');
    const value = row[key];
    return value === undefined ? '' : String(value);
  });
  // The server cuts file names at 120 characters. Cutting here instead, before
  // uniqueNamer() sees the name, keeps its "-2" and the extension on the end.
  const slug = slugify(filled, `card-${index + 1}`).slice(0, MAX_NAME).replace(/-+$/, '');
  return slug || `card-${index + 1}`;
}

/**
 * Hand out names that are unique within one run.
 *
 * Batch exports overwrite on purpose, so re-running a set replaces it. But two
 * rows that fill the pattern the same way — `{title}` over two printings of
 * one card — used to write the same file twice: the first card was gone, and
 * the deck list then counted the survivor for both. The second of a name gets
 * `-2`, the third `-3`, skipping anything an earlier row already took.
 */
export function uniqueNamer() {
  const taken = new Set();
  return (name) => {
    let candidate = name;
    for (let n = 2; taken.has(candidate); n += 1) candidate = `${name}-${n}`;
    taken.add(candidate);
    return candidate;
  };
}

/* ---------------------------------------------------------------- assets -- */

const SEARCH_ORDER = ['art', 'icons', 'frames', 'backgrounds', 'textures'];

/**
 * Turn a spreadsheet cell into something loadable: a URL, a workspace path,
 * or the name of a file already in the asset library.
 */
export function resolveAsset(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\/files\//i.test(raw)) {
    // A workspace URL is a path in disguise. Kept as a URL it has no path, so
    // a card holding it could not be embedded (fileURL would make it
    // /files/files/…) and the art was quietly left out of the file.
    try {
      const path = raw.slice('/files/'.length).split('/').map(decodeURIComponent).join('/');
      if (path) return { url: api.fileURL(path), path };
    } catch {
      // A malformed escape: use it as it stands, like any other URL.
    }
  }
  if (/^(data:|blob:|https?:|\/files\/)/i.test(raw)) return { url: raw, path: null };
  if (/^(assets|projects|templates|exports)\//i.test(raw)) {
    return { url: api.fileURL(raw), path: raw };
  }

  const needle = raw.toLowerCase().replace(/\.[^.]+$/, '');
  for (const category of SEARCH_ORDER) {
    for (const item of assets.index[category] || []) {
      if (item.name.toLowerCase() === needle || (item.file || '').toLowerCase() === raw.toLowerCase()) {
        return { url: item.url || api.fileURL(item.path), path: item.path };
      }
    }
  }
  throw new Error(`no asset named "${raw}" in the library`);
}

/* ------------------------------------------------------------------ run --- */

const nextFrame = () =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

/*
 * One run at a time. A run borrows the canvas: it snapshots it, writes rows
 * into it and puts the snapshot back at the end. A second run started inside
 * the first takes its snapshot of a spreadsheet row, releases the history lock
 * the first one is relying on, and restores that row over the user's card when
 * it finishes.
 */
let rendering = false;

/*
 * The canvas is the user's card again. The restore announced its layers while
 * the run still held it, and panels that read the card on screen stand aside
 * then (they would read a spreadsheet row) — so they must be told again, or
 * they keep showing what they could see during the run.
 */
function announceReturned() {
  bus.emit(EVT.OBJECTS, editor.objects());
}

/** Whether a batch, export or print run has the canvas right now. */
export const isRendering = () => rendering;

function claimCanvas() {
  if (rendering) throw new Error('another set is still rendering — wait for it to finish');
  rendering = true;
}

/**
 * The snapshot a run starts each row from: the layout, without the changes the
 * card on screen made to its layers for itself. Starting rows from the
 * snapshot as taken printed one card's nudged title on every row.
 */
function layoutSnapshot(snapshot) {
  const data = JSON.parse(snapshot);
  toLayoutJSON(data.canvas);
  return JSON.stringify(data);
}

async function restoreSnapshot(snapshot) {
  const data = JSON.parse(snapshot);
  Object.assign(state.card, data.card);
  editor.canvas.setDimensions({ width: state.card.width, height: state.card.height });
  await editor.loadJSON(data.canvas);
  editor.canvas.backgroundColor = data.canvas.background ?? state.card.background;
  editor.applyCardClip();
  editor.applyZoom();
}

/** Push one row of values into the slots named by `mapping`. */
export async function applyRow(row, mapping) {
  for (const [column, slot] of Object.entries(mapping)) {
    if (!slot || slot === '-') continue;
    const value = row[column];
    if (value === undefined) continue;

    const targets = editor.findBySlot(slot);
    if (!targets.length) continue;

    if (isImageSlot(targets)) {
      // An empty cell and a card's null both mean "the layout's own art
      // layer". A batch run starts each row from the canvas as it stands, and
      // since a project's art belongs to the card on screen, skipping the cell
      // printed that card's picture on every row that left it blank.
      if (value === null || String(value).trim() === '') {
        await clearFieldImage(slot);
        continue;
      }
      const asset = resolveAsset(value);
      if (asset) await setFieldImage(slot, asset.url, { assetPath: asset.path });
    } else {
      // An empty text cell clears the field — otherwise the template's
      // placeholder copy would leak into the finished card.
      setFieldText(slot, value ?? '');
    }
  }
}

/** Render a single row to a data URL without saving anything — used for preview. */
export async function renderRow(row, mapping, {
  multiplier = 1, format = 'png', transparent = false, number = null, bleedMm = 0,
} = {}) {
  // Mid-switch the canvas is neither card: a snapshot taken then is put back
  // at the end over the card the switch has since finished drawing.
  await settled();
  const snapshot = JSON.stringify({ card: { ...state.card }, canvas: editor.toJSON() });
  const wasDirty = state.dirty;
  claimCanvas();
  history.locked = true;
  editor.canvas.discardActiveObject();
  try {
    if (number) editor.setNumberContext(number);
    const layout = layoutSnapshot(snapshot);
    if (layout !== snapshot) await restoreSnapshot(layout);
    await applyRow(row, mapping);
    await nextFrame();
    return await renderCard({ multiplier, format, transparent, bleedMm });
  } finally {
    // Releasing the lock is nested inside its own finally because the restore
    // can throw — an image the row referenced may have gone from the
    // workspace. Left latched, history stops recording for the rest of the
    // session and undo dies silently.
    try {
      editor.setNumberContext(null);
      await restoreSnapshot(snapshot);
    } finally {
      history.locked = false;
      rendering = false;
      // Writing the row into the slots marked the card edited, but the canvas
      // is back as it was: a project saved a moment ago is still saved, and
      // saying otherwise makes New and Open ask about changes that do not exist.
      state.setDirty(wasDirty);
      announceReturned();
    }
  }
}

/**
 * Render every row. Returns `{ rendered, failed }`; the canvas is always
 * restored to the layout it started from, even if a row throws.
 */
export async function runBatch({
  rows = [],
  mapping = {},
  options = {},
  onProgress = () => {},
  shouldCancel = () => false,
} = {}) {
  const {
    multiplier = 2,
    format = 'png',
    transparent = false,
    // Millimetres mirrored out from each edge (core/bleed.js); 0 is none.
    bleedMm = 0,
    // Corners left square (the print sheet adds its own bleed around them).
    squareCorners = false,
    pattern = '{n:3}-{title}',
    subfolder = '',
    saveProjects = false,
    toWorkspace = true,
    qtyColumn = '',
    // Given, every image goes here instead of to disk: the print sheet uses
    // this to lay out a project's cards without writing them anywhere first.
    sink = null,
    // Given, called with each row once its values are in and before it is
    // drawn — a project's cards use it to lay their own changes over the
    // layout. The run knows nothing of what it does.
    prepare = null,
  } = options;

  // Same reason as renderRow: never borrow the canvas halfway through a card
  // switch, or the run's final restore puts the card being left back on screen
  // under the other card's name, and the next save writes it there.
  await settled();
  // One name for the folder, used for the images, the deck list and the
  // project files alike. The server keeps only the last part of a path, so
  // "Core Set/2" landed in exports/2 (beside "Promo/2", overwriting it) while
  // its projects went to projects/core-set-2.
  const folderName = subfolder ? slugify(subfolder, 'batch') : '';
  const snapshot = JSON.stringify({ card: { ...state.card }, canvas: editor.toJSON() });
  const layout = layoutSnapshot(snapshot);
  const originalName = state.project.name;
  const extension = format === 'jpeg' ? 'jpg' : 'png';
  const rendered = [];
  const failed = [];
  // A card wanted four times is rendered once and counted four times; the
  // count travels to the print sheet in a deck list rather than as four
  // identical files with four different numbers in their names.
  const deck = [];
  const uniqueName = uniqueNamer();

  const wasDirty = state.dirty;
  claimCanvas();
  history.locked = true;
  editor.canvas.discardActiveObject();

  try {
    for (let index = 0; index < rows.length; index += 1) {
      if (shouldCancel()) break;
      const row = rows[index];
      const name = uniqueName(fillPattern(pattern, row, index));
      onProgress({ index, total: rows.length, name, status: 'working' });

      try {
        // Each row is a card of a set of rows.length, numbered in row order —
        // the same {n} its filename gets.
        editor.setNumberContext({ n: index + 1, total: rows.length });
        await restoreSnapshot(layout);
        await applyRow(row, mapping);
        if (prepare) await prepare(row, index);
        await nextFrame();

        const dataURL = await renderCard({ multiplier, format, transparent, bleedMm, squareCorners });
        const filename = `${name}.${extension}`;

        const qty = qtyColumn ? readQuantity(row[qtyColumn]) : 1;

        if (sink) {
          sink(dataURL, filename);
          rendered.push({ index, name, path: null, qty });
        } else if (toWorkspace && api.online) {
          const res = await api.exportImage({ filename, dataURL, folder: folderName, overwrite: true });
          rendered.push({ index, name, path: res.path, qty });
        } else {
          downloadURL(dataURL, filename);
          rendered.push({ index, name, path: null, qty });
        }
        deck.push({ file: filename, qty });

        if (saveProjects && api.online && !sink) {
          state.project.name = name;
          const project = await serializeProject({ onlyActive: true });
          const folder = folderName ? `${folderName}/` : '';
          // Same safety net as an ordinary save: a hand-made project that
          // happens to share the name is kept beside it.
          await api.writeJSON(`projects/${folder}${name}.json`, project, { backup: true });
        }

        onProgress({ index, total: rows.length, name, status: 'done' });
      } catch (err) {
        failed.push({ index, name, error: err.message });
        onProgress({ index, total: rows.length, name, status: 'failed', error: err.message });
      }
    }
  } finally {
    state.project.name = originalName;
    // Same reason as renderRow: a restore that throws must not take undo and
    // redo down with it for the rest of the session.
    try {
      editor.setNumberContext(null);
      await restoreSnapshot(snapshot);
    } finally {
      history.locked = false;
      rendering = false;
      state.setDirty(wasDirty);
      announceReturned();
    }
  }

  // Written after the cards, and only where they landed, so the list always
  // describes a folder that exists. A run without a quantity column writes
  // nothing: every card is one of itself and the list would say nothing.
  let deckPath = null;
  if (qtyColumn && deck.length && toWorkspace && api.online && rendered[0]?.path) {
    const folder = rendered[0].path.split('/').slice(0, -1).join('/');
    deckPath = `${folder}/${DECK_FILE}`;
    try {
      await api.writeJSON(deckPath, buildDeck(originalName, deck));
    } catch (err) {
      console.warn('[batch] could not write the deck list', err);
      deckPath = null;
    }
  }

  return { rendered, failed, total: rows.length, deck, deckPath, folder: folderName };
}

/** List CSV/JSON data files sitting in workspace/batch. */
export async function listDataFiles() {
  if (!api.online) return [];
  try {
    const data = await api.request('/api/list?path=batch');
    return (data.entries || []).filter((entry) => !entry.dir && /\.(csv|tsv|json|txt)$/i.test(entry.name));
  } catch {
    return [];
  }
}
