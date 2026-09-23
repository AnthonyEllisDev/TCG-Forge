/*
 * Batch generation — render a whole card set from a spreadsheet.
 *
 * The slot system already knows how to write a value into a layout, so a set
 * is just: for each row, reset to the template, push the row's values into the
 * matching slots, render, save. Nothing here knows what a "card" means; it
 * only knows columns, slots and files.
 */

import { api } from './api.js';
import { assets } from './assets.js';
import { editor } from './editor.js';
import { history } from './history.js';
import { state } from './state.js';
import { setFieldImage, setFieldText } from './templates.js';
import { serializeProject } from './project.js';
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

/* -------------------------------------------------------------- patterns -- */

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
  return slugify(filled, `card-${index + 1}`);
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

    if (targets[0].type === 'image' || targets[0].tcgKind === 'art' || targets[0].tcgKind === 'icon') {
      // An empty image cell leaves the template's placeholder in place.
      if (value === '') continue;
      const asset = resolveAsset(value);
      if (asset) await setFieldImage(slot, asset.url, { assetPath: asset.path });
    } else {
      // An empty text cell clears the field — otherwise the template's
      // placeholder copy would leak into the finished card.
      setFieldText(slot, value);
    }
  }
}

/** Render a single row to a data URL without saving anything — used for preview. */
export async function renderRow(row, mapping, { multiplier = 1, format = 'png', transparent = false } = {}) {
  const snapshot = JSON.stringify({ card: { ...state.card }, canvas: editor.toJSON() });
  history.locked = true;
  editor.canvas.discardActiveObject();
  try {
    await applyRow(row, mapping);
    await nextFrame();
    return editor.toDataURL({ multiplier, format, transparent });
  } finally {
    // Releasing the lock is nested inside its own finally because the restore
    // can throw — an image the row referenced may have gone from the
    // workspace. Left latched, history stops recording for the rest of the
    // session and undo dies silently.
    try {
      await restoreSnapshot(snapshot);
    } finally {
      history.locked = false;
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
    pattern = '{n:3}-{title}',
    subfolder = '',
    saveProjects = false,
    toWorkspace = true,
  } = options;

  const snapshot = JSON.stringify({ card: { ...state.card }, canvas: editor.toJSON() });
  const originalName = state.project.name;
  const extension = format === 'jpeg' ? 'jpg' : 'png';
  const rendered = [];
  const failed = [];

  history.locked = true;
  editor.canvas.discardActiveObject();

  try {
    for (let index = 0; index < rows.length; index += 1) {
      if (shouldCancel()) break;
      const row = rows[index];
      const name = fillPattern(pattern, row, index);
      onProgress({ index, total: rows.length, name, status: 'working' });

      try {
        await restoreSnapshot(snapshot);
        await applyRow(row, mapping);
        await nextFrame();

        const dataURL = editor.toDataURL({ multiplier, format, transparent });
        const filename = `${name}.${extension}`;

        if (toWorkspace && api.online) {
          const res = await api.exportImage({ filename, dataURL, folder: subfolder, overwrite: true });
          rendered.push({ index, name, path: res.path });
        } else {
          downloadURL(dataURL, filename);
          rendered.push({ index, name, path: null });
        }

        if (saveProjects && api.online) {
          state.project.name = name;
          const project = await serializeProject();
          const folder = subfolder ? `${slugify(subfolder)}/` : '';
          await api.writeJSON(`projects/${folder}${name}.json`, project);
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
      await restoreSnapshot(snapshot);
    } finally {
      history.locked = false;
    }
  }

  return { rendered, failed, total: rows.length };
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
