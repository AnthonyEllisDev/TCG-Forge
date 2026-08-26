/*
 * Batch panel — the UI over core/batch.js.
 *
 * Load a spreadsheet, map its columns onto the current template's slots,
 * preview a row, then render the whole set into workspace/exports.
 */

import { el, on, readFileAsText } from '../util/dom.js';
import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { collectFields } from '../core/templates.js';
import { fillPattern, listDataFiles, parseAny, renderRow, runBatch } from '../core/batch.js';
import { openModal, toast } from './dialogs.js';

let table = { columns: [], rows: [] };
let mapping = {};
let sourceName = '';
let running = false;
let cancelRequested = false;

const nodes = {};

export function initBatchPanel() {
  on(document, 'click', (e) => {
    if (e.target.closest('[data-action="batch"]')) openBatchDialog();
  });
}

/* --------------------------------------------------------------- helpers -- */

function availableSlots() {
  const fromTemplate = (state.project.fields || []).map((f) => f.id);
  const fromCanvas = collectFields().map((f) => f.id);
  return Array.from(new Set([...fromTemplate, ...fromCanvas]));
}

/** Match a spreadsheet column to a slot: exact id, then label-ish, then contains. */
function guessSlot(column, slots) {
  const key = column.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const normalised = slots.map((slot) => [slot, slot.toLowerCase().replace(/[\s_-]+/g, '')]);
  const exact = normalised.find(([, s]) => s === key);
  if (exact) return exact[0];
  const partial = normalised.find(([, s]) => s.includes(key) || key.includes(s));
  return partial ? partial[0] : '-';
}

function setStatus(message, kind = '') {
  if (nodes.status) {
    nodes.status.textContent = message;
    nodes.status.className = `hint ${kind}`;
  }
}

function setProgress(done, total) {
  if (!nodes.bar) return;
  const pct = total ? Math.round((done / total) * 100) : 0;
  nodes.bar.style.width = `${pct}%`;
  nodes.count.textContent = total ? `${done} / ${total}` : '';
}

function logLine(text, kind = '') {
  if (!nodes.log) return;
  nodes.log.append(el('div', { class: `log-line ${kind}`, text }));
  nodes.log.scrollTop = nodes.log.scrollHeight;
}

/* ---------------------------------------------------------------- dialog -- */

export function openBatchDialog() {
  const slots = availableSlots();

  /* --- data source --- */
  const fileInput = el('input', { type: 'file', accept: '.csv,.tsv,.txt,.json', hidden: true });
  const workspaceSelect = el('select');
  workspaceSelect.append(el('option', { value: '', text: 'workspace/batch …' }));

  const summary = el('div', { class: 'hint', text: 'No data loaded yet.' });

  const source = el('div', { class: 'stack' }, [
    el('div', { class: 'field-row' }, [
      el('button', { class: 'btn', text: 'Load file…', onClick: () => fileInput.click() }),
      workspaceSelect,
      el('button', {
        class: 'btn',
        text: 'Open',
        onClick: async () => {
          if (!workspaceSelect.value) return;
          try {
            const res = await api.request(`/api/read?path=${encodeURIComponent(workspaceSelect.value)}`);
            loadData(res.content, workspaceSelect.value.split('/').pop(), slots);
          } catch (err) {
            toast(`Could not read file: ${err.message}`, 'err');
          }
        },
      }),
    ]),
    summary,
    fileInput,
  ]);

  on(fileInput, 'change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      loadData(await readFileAsText(file), file.name, slots);
    } catch (err) {
      toast(`Could not parse ${file.name}: ${err.message}`, 'err');
    }
    fileInput.value = '';
  });

  /* --- mapping --- */
  const mapTable = el('div', { class: 'map-table' });

  /* --- output options --- */
  const pattern = el('input', { type: 'text', value: '{n:3}-{title}', spellcheck: 'false' });
  const subfolder = el('input', { type: 'text', value: '', placeholder: 'e.g. core-set', spellcheck: 'false' });
  const format = el('select');
  format.append(el('option', { value: 'png', text: 'PNG' }), el('option', { value: 'jpeg', text: 'JPEG' }));
  const scale = el('select');
  for (const value of [1, 2, 3, 4]) {
    scale.append(el('option', { value: String(value), text: `${value}×  (${state.card.width * value} × ${state.card.height * value})` }));
  }
  scale.value = String(state.settings.lastExportScale || 2);
  const saveProjects = el('input', { type: 'checkbox' });

  /* --- progress --- */
  nodes.bar = el('div', { class: 'progress-fill' });
  nodes.count = el('span', { class: 'readout' });
  nodes.status = el('div', { class: 'hint', text: 'Load a spreadsheet to begin.' });
  nodes.log = el('div', { class: 'batch-log' });
  nodes.preview = el('div', { class: 'batch-preview' });

  const body = el('div', { class: 'stack' }, [
    el('div', { class: 'subgroup' }, [el('h3', { text: '1 · Data' }), source]),
    el('div', { class: 'subgroup' }, [
      el('h3', { text: '2 · Map columns to slots' }),
      mapTable,
      el('p', {
        class: 'hint',
        text: 'Text columns fill text layers. Columns mapped to an art or icon slot are looked up in the Asset Library by name, or can hold a workspace path like assets/art/dragon.png.',
      }),
    ]),
    el('div', { class: 'subgroup' }, [
      el('h3', { text: '3 · Output' }),
      el('div', { class: 'field-row' }, [
        el('label', { class: 'field' }, [el('span', { text: 'Filename pattern' }), pattern]),
        el('label', { class: 'field' }, [el('span', { text: 'Subfolder in exports/' }), subfolder]),
      ]),
      el('div', { class: 'field-row' }, [
        el('label', { class: 'field' }, [el('span', { text: 'Format' }), format]),
        el('label', { class: 'field' }, [el('span', { text: 'Resolution' }), scale]),
      ]),
      el('label', { class: 'check' }, [saveProjects, ' Also save an editable project file per card']),
      el('p', { class: 'hint', text: 'Pattern tokens: {column} for any column, {n} for the row number, {n:3} to pad it to 3 digits.' }),
    ]),
    el('div', { class: 'subgroup' }, [
      el('h3', { text: '4 · Render' }),
      el('div', { class: 'field-row' }, [
        el('button', {
          class: 'btn',
          text: 'Preview first row',
          onClick: () => preview(),
        }),
        nodes.count,
      ]),
      el('div', { class: 'progress' }, [nodes.bar]),
      nodes.status,
      nodes.preview,
      nodes.log,
    ]),
  ]);

  const options = () => ({
    multiplier: Number(scale.value),
    format: format.value,
    pattern: pattern.value.trim() || '{n:3}',
    subfolder: subfolder.value.trim(),
    saveProjects: saveProjects.checked,
    toWorkspace: api.online,
  });

  const close = openModal({
    title: 'Batch generate a set',
    wide: true,
    body,
    buttons: [
      { label: 'Close', onClick: (c) => (running ? (cancelRequested = true) : c()) },
      {
        label: 'Render set',
        primary: true,
        onClick: async (_c, _bodyEl) => start(options()),
      },
    ],
  });

  nodes.renderButton = document.querySelector('#modalFoot .btn.primary');
  nodes.mapTable = mapTable;
  nodes.summary = summary;
  nodes.slots = slots;

  if (!slots.length) {
    setStatus('The current card has no slots, so there is nothing to fill. Load a template first.', 'warn');
  }
  if (!api.online) {
    setStatus('Without the local server each card downloads separately — start run.sh / run.bat for folder output.', 'warn');
  }

  /* populate the workspace file list lazily */
  listDataFiles().then((files) => {
    for (const file of files) {
      workspaceSelect.append(el('option', { value: file.path, text: file.name }));
    }
    if (files.length) workspaceSelect.value = files[0].path;
  });

  /* keep a reference so the render button can be relabelled */
  nodes.close = close;
}

/* ----------------------------------------------------------------- data --- */

function loadData(text, filename, slots) {
  table = parseAny(text, filename);
  sourceName = filename;
  if (!table.rows.length) throw new Error('no data rows found');

  mapping = {};
  for (const column of table.columns) mapping[column] = guessSlot(column, slots);

  nodes.summary.textContent = `${table.rows.length} rows × ${table.columns.length} columns from ${filename}`;
  renderMapping(slots);

  const mapped = Object.values(mapping).filter((s) => s && s !== '-').length;
  setStatus(`${mapped} of ${table.columns.length} columns matched a slot automatically.`,
    mapped ? '' : 'warn');
}

function renderMapping(slots) {
  const host = nodes.mapTable;
  host.innerHTML = '';
  if (!table.columns.length) return;

  for (const column of table.columns) {
    const select = el('select');
    select.append(el('option', { value: '-', text: '— ignore —' }));
    for (const slot of slots) select.append(el('option', { value: slot, text: slot }));
    select.value = mapping[column] || '-';
    on(select, 'change', () => {
      mapping[column] = select.value;
    });

    const sample = String(table.rows[0]?.[column] ?? '').slice(0, 40);
    host.append(
      el('div', { class: 'map-row' }, [
        el('span', { class: 'map-col', text: column }),
        el('span', { class: 'map-sample', text: sample }),
        select,
      ])
    );
  }
}

/* -------------------------------------------------------------- actions --- */

async function preview() {
  if (!table.rows.length) {
    toast('Load a spreadsheet first.', 'warn');
    return;
  }
  setStatus('Rendering preview…');
  try {
    const url = await renderRow(table.rows[0], mapping, { multiplier: 1 });
    nodes.preview.innerHTML = '';
    nodes.preview.append(el('img', { src: url, alt: 'First row preview' }));
    setStatus(`Preview of row 1 → ${fillPattern('{n:3}-{title}', table.rows[0], 0)}`);
  } catch (err) {
    setStatus(`Preview failed: ${err.message}`, 'warn');
  }
}

async function start(options) {
  if (running) {
    cancelRequested = true;
    return;
  }
  if (!table.rows.length) {
    toast('Load a spreadsheet first.', 'warn');
    return;
  }
  const mapped = Object.values(mapping).filter((s) => s && s !== '-');
  if (!mapped.length) {
    toast('Map at least one column to a slot.', 'warn');
    return;
  }

  running = true;
  cancelRequested = false;
  nodes.log.innerHTML = '';
  nodes.renderButton.textContent = 'Cancel';
  state.set('lastExportScale', options.multiplier);
  setProgress(0, table.rows.length);
  setStatus(`Rendering ${table.rows.length} cards…`);

  const started = performance.now();
  let done = 0;

  try {
    const result = await runBatch({
      rows: table.rows,
      mapping,
      options,
      shouldCancel: () => cancelRequested,
      onProgress: ({ status, name, error }) => {
        if (status === 'done') {
          done += 1;
          setProgress(done, table.rows.length);
          logLine(`✓ ${name}`);
        } else if (status === 'failed') {
          done += 1;
          setProgress(done, table.rows.length);
          logLine(`✕ ${name} — ${error}`, 'err');
        }
      },
    });

    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const where = options.toWorkspace
      ? `workspace/exports${options.subfolder ? `/${options.subfolder}` : ''}`
      : 'your downloads folder';
    setStatus(
      `${result.rendered.length} cards rendered in ${seconds}s → ${where}` +
        (result.failed.length ? ` · ${result.failed.length} failed` : '') +
        (cancelRequested ? ' · cancelled' : ''),
      result.failed.length ? 'warn' : ''
    );
    toast(`Batch complete: ${result.rendered.length} of ${table.rows.length} cards from ${sourceName}.`,
      result.failed.length ? 'warn' : 'ok', 5000);
  } catch (err) {
    setStatus(`Batch failed: ${err.message}`, 'warn');
    toast(`Batch failed: ${err.message}`, 'err');
  } finally {
    running = false;
    cancelRequested = false;
    if (nodes.renderButton) nodes.renderButton.textContent = 'Render set';
  }
}
