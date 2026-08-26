/*
 * Top bar, card setup, insert tools, view toolbar and status bar wiring.
 */

import { $, $$, el, isHex, on, toHex } from '../util/dom.js';
import { bus, EVT } from '../util/bus.js';
import { api } from '../core/api.js';
import { state, presetSize } from '../core/state.js';
import { editor } from '../core/editor.js';
import { history } from '../core/history.js';
import {
  exportImage,
  newProject,
  openProjectData,
  openProjectPath,
  saveProject,
} from '../core/project.js';
import { confirmDialog, openModal, promptDialog, toast } from './dialogs.js';

export function initToolbar() {
  bindActions();
  bindInsert();
  bindCardSetup();
  bindViewToolbar();
  bindStatus();
}

/* ------------------------------------------------------------- actions -- */

function bindActions() {
  on(document, 'click', async (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;

    switch (action) {
      case 'new-project': return handleNew();
      case 'open-project': return openProjectDialog();
      case 'save-project': return handleSave();
      case 'save-project-as': return handleSaveAs();
      case 'undo': return history.undo();
      case 'redo': return history.redo();
      case 'export': return openExportDialog();
      case 'shortcuts': return openShortcuts();
      default: break;
    }
  });

  const nameInput = $('#projectName');
  on(nameInput, 'change', () => {
    state.project.name = nameInput.value.trim() || 'Untitled Card';
    state.setDirty(true);
  });
}

async function handleNew() {
  if (state.dirty) {
    const go = await confirmDialog({
      title: 'Start a new card?',
      message: 'The current card has unsaved changes.',
      confirmLabel: 'Discard and start new',
      danger: true,
    });
    if (!go) return;
  }
  await newProject({});
  toast('New card ready.', 'ok');
}

async function handleSave() {
  try {
    const res = await saveProject({});
    toast(res.saved === 'workspace' ? `Saved to ${res.path}` : 'Downloaded project file.', 'ok');
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'err');
  }
}

async function handleSaveAs() {
  const name = await promptDialog({
    title: 'Save project as',
    label: 'Project name',
    value: state.project.name,
    confirmLabel: 'Save',
    hint: api.online ? 'Saved into workspace/projects as a .json file.' : 'Downloaded to your browser downloads folder.',
  });
  if (!name) return;
  try {
    const res = await saveProject({ name, path: null });
    $('#projectName').value = state.project.name;
    toast(res.saved === 'workspace' ? `Saved to ${res.path}` : 'Downloaded project file.', 'ok');
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'err');
  }
}

async function openProjectDialog() {
  const body = el('div', { class: 'stack' });
  const list = el('div', { class: 'list' });
  body.append(list);

  const fileInput = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
  body.append(
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn', text: 'Load from file…', onClick: () => fileInput.click() }),
      el('span', { class: 'hint', text: 'Project files are plain JSON — easy to diff and share.' }),
    ]),
    fileInput
  );

  on(fileInput, 'change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      await openProjectData(data);
      $('#projectName').value = state.project.name;
      close();
      toast(`Opened ${file.name}.`, 'ok');
    } catch (err) {
      toast(`Could not open file: ${err.message}`, 'err');
    }
  });

  let close = openModal({
    title: 'Open project',
    body,
    buttons: [{ label: 'Close', onClick: (c) => c() }],
  });

  if (!api.online) {
    list.append(el('div', { class: 'grid-empty', text: 'Start the app with run.sh / run.bat to browse saved projects.' }));
    return;
  }

  try {
    const projects = await api.listProjects();
    if (!projects.length) {
      list.append(el('div', { class: 'grid-empty', text: 'No saved projects yet.' }));
      return;
    }
    for (const project of projects) {
      const item = el('div', { class: 'list-item' }, [
        el('div', { class: 'li-title', text: project.name }),
        el('div', { class: 'li-sub', text: `${project.path} · ${project.modified.replace('T', ' ').replace('+00:00', ' UTC')}` }),
      ]);
      on(item, 'click', async () => {
        try {
          await openProjectPath(project.path);
          $('#projectName').value = state.project.name;
          close();
          toast(`Opened ${project.name}.`, 'ok');
        } catch (err) {
          toast(`Could not open: ${err.message}`, 'err');
        }
      });
      list.append(item);
    }
  } catch (err) {
    list.append(el('div', { class: 'grid-empty', text: `Could not list projects: ${err.message}` }));
  }
}

/* -------------------------------------------------------------- export -- */

export function openExportDialog() {
  const scale = el('select', {}, []);
  for (const value of [1, 2, 3, 4]) {
    scale.append(el('option', { value: String(value), text: `${value}× (${state.card.width * value} × ${state.card.height * value} px)` }));
  }
  scale.value = String(state.settings.lastExportScale || 2);

  const format = el('select');
  format.append(el('option', { value: 'png', text: 'PNG (lossless, supports transparency)' }));
  format.append(el('option', { value: 'jpeg', text: 'JPEG (smaller, no transparency)' }));

  const transparent = el('input', { type: 'checkbox' });
  const toWorkspace = el('input', { type: 'checkbox', checked: api.online });
  toWorkspace.disabled = !api.online;

  const body = el('div', { class: 'stack' }, [
    el('label', { class: 'field' }, [el('span', { text: 'Resolution' }), scale]),
    el('label', { class: 'field' }, [el('span', { text: 'Format' }), format]),
    el('label', { class: 'check' }, [transparent, ' Transparent background']),
    el('label', { class: 'check' }, [toWorkspace, api.online ? ' Also save into workspace/exports' : ' Save to workspace (needs the local server)']),
    el('p', { class: 'hint', text: 'Print tip: 300 dpi at 2.5 × 3.5 in is 750 × 1050 px. Export at 1× if your card is already sized for print.' }),
  ]);

  openModal({
    title: 'Export card',
    body,
    buttons: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Export',
        primary: true,
        onClick: async (close) => {
          try {
            state.set('lastExportScale', Number(scale.value));
            const res = await exportImage({
              multiplier: Number(scale.value),
              format: format.value,
              transparent: transparent.checked,
              toWorkspace: toWorkspace.checked,
            });
            close();
            if (res.saved === 'workspace') {
              toast(`Exported to ${res.path}`, 'ok', 4200);
            } else {
              toast('Exported — check your downloads.', 'ok');
            }
          } catch (err) {
            toast(`Export failed: ${err.message}`, 'err');
          }
        },
      },
    ],
  });
}

/* -------------------------------------------------------------- insert -- */

function bindInsert() {
  on(document, 'click', (e) => {
    const kind = e.target.closest('[data-insert]')?.dataset.insert;
    if (!kind) return;
    if (kind === 'image') {
      $('#imageFileInput').click();
      return;
    }
    editor.insert(kind);
  });

  on($('#imageFileInput'), 'change', async (e) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      try {
        await editor.addImage(URL.createObjectURL(file), {
          tcgName: file.name.replace(/\.[^.]+$/, ''),
        });
      } catch (err) {
        toast(`Could not load ${file.name}: ${err.message}`, 'err');
      }
    }
    e.target.value = '';
  });

  const embed = $('#embedImages');
  embed.checked = !!state.settings.embedImages;
  on(embed, 'change', () => state.set('embedImages', embed.checked));
}

/* ---------------------------------------------------------- card setup -- */

function bindCardSetup() {
  const preset = $('#cardPreset');
  const width = $('#cardWidth');
  const height = $('#cardHeight');
  const dpi = $('#cardDpi');
  const radius = $('#cardRadius');
  const bg = $('#cardBg');
  const bgHex = $('#cardBgHex');

  const syncPreset = () => {
    if (preset.value === 'custom') return;
    const size = presetSize(preset.value, Number(dpi.value));
    if (!size) return;
    width.value = size.width;
    height.value = size.height;
  };

  on(preset, 'change', syncPreset);
  on(dpi, 'change', syncPreset);
  for (const node of [width, height]) {
    on(node, 'input', () => {
      preset.value = 'custom';
    });
  }

  on($('#applyCardSetup'), 'click', () => {
    editor.setCard({
      width: Math.max(64, Number(width.value) || state.card.width),
      height: Math.max(64, Number(height.value) || state.card.height),
      dpi: Number(dpi.value) || 300,
      radius: Math.max(0, Number(radius.value) || 0),
      preset: preset.value,
    });
    editor.fitToWindow();
    toast(`Card set to ${state.card.width} × ${state.card.height} px.`, 'ok');
  });

  on(radius, 'change', () => editor.setCard({ radius: Math.max(0, Number(radius.value) || 0) }));

  on(bg, 'input', () => {
    bgHex.value = bg.value;
    editor.setCard({ background: bg.value });
  });
  on(bgHex, 'change', () => {
    if (!isHex(bgHex.value)) return;
    bg.value = toHex(bgHex.value);
    editor.setCard({ background: bgHex.value });
  });
  on($('#cardBgClear'), 'click', () => {
    editor.setCard({ background: '' });
    toast('Card background is now transparent.', 'ok');
  });

  const safe = $('#showSafeZone');
  const bleed = $('#showBleed');
  safe.checked = !!state.settings.safeZone;
  bleed.checked = !!state.settings.bleed;
  on(safe, 'change', () => {
    state.set('safeZone', safe.checked);
    editor.canvas.requestRenderAll();
  });
  on(bleed, 'change', () => {
    state.set('bleed', bleed.checked);
    editor.canvas.requestRenderAll();
  });

  bus.on(EVT.CARD, (card) => {
    width.value = card.width;
    height.value = card.height;
    radius.value = card.radius;
    if (card.background) {
      bg.value = toHex(card.background, '#12161f');
      bgHex.value = toHex(card.background, '#12161f');
    }
    const stat = $('#statCard');
    if (stat) stat.textContent = `${card.width} × ${card.height} px @ ${card.dpi}dpi`;
  });
}

/* --------------------------------------------------------- view toolbar -- */

function bindViewToolbar() {
  on(document, 'click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'zoom-in') editor.setZoom(editor.zoom * 1.15);
    else if (action === 'zoom-out') editor.setZoom(editor.zoom / 1.15);
    else if (action === 'zoom-fit') editor.fitToWindow();

    const align = e.target.closest('[data-align]')?.dataset.align;
    if (align) editor.align(align);
  });

  on($('#zoomLabel'), 'click', () => editor.setZoom(1));

  const snap = $('#snapToggle');
  const guides = $('#guideToggle');
  const checker = $('#checkerToggle');
  snap.checked = state.settings.snap;
  guides.checked = state.settings.guides;
  checker.checked = state.settings.checker;
  $('#canvasStage').classList.toggle('checker', checker.checked);

  on(snap, 'change', () => state.set('snap', snap.checked));
  on(guides, 'change', () => state.set('guides', guides.checked));
  on(checker, 'change', () => {
    state.set('checker', checker.checked);
    $('#canvasStage').classList.toggle('checker', checker.checked);
  });

  bus.on(EVT.ZOOM, (zoom) => {
    const label = $('#zoomLabel');
    if (label) label.textContent = `${Math.round(zoom * 100)}%`;
  });
}

/* --------------------------------------------------------------- status -- */

function bindStatus() {
  bus.on(EVT.STATUS, ({ online, info }) => {
    const pill = $('#serverPill');
    if (!pill) return;
    pill.className = `pill ${online ? 'pill-ok' : 'pill-off'}`;
    pill.textContent = online ? `local server · ${info.version}` : 'browser only';
    pill.title = online
      ? `Reading and writing files in ${info.workspace}`
      : 'No backend detected — saving falls back to downloads.';
    const ws = $('#statWorkspace');
    if (ws) ws.textContent = online ? info.workspace : 'no workspace';
  });

  bus.on('editor:pointer', ({ x, y }) => {
    const stat = $('#statPointer');
    if (stat) stat.textContent = `${x}, ${y}`;
  });

  bus.on(EVT.PROJECT, () => {
    $('#dirtyDot').classList.toggle('on', state.dirty);
    const name = $('#projectName');
    if (name && document.activeElement !== name) name.value = state.project.name;
  });

  bus.on(EVT.HISTORY, (status) => {
    $$('[data-action="undo"]').forEach((b) => (b.disabled = !status.canUndo));
    $$('[data-action="redo"]').forEach((b) => (b.disabled = !status.canRedo));
  });
}

/* ------------------------------------------------------------ shortcuts -- */

export function openShortcuts() {
  const rows = [
    ['Ctrl/⌘ + Z', 'Undo'],
    ['Ctrl/⌘ + Shift + Z', 'Redo'],
    ['Ctrl/⌘ + S', 'Save project'],
    ['Ctrl/⌘ + E', 'Export card'],
    ['Ctrl/⌘ + B', 'Batch generate a set'],
    ['Ctrl/⌘ + N', 'New card'],
    ['Ctrl/⌘ + O', 'Open project'],
    ['Ctrl/⌘ + D', 'Duplicate selection'],
    ['Ctrl/⌘ + C / V', 'Copy / paste'],
    ['Ctrl/⌘ + A', 'Select all layers'],
    ['Ctrl/⌘ + G', 'Group / ungroup'],
    ['Delete / Backspace', 'Delete selection'],
    ['Arrow keys', 'Nudge 1 px (Shift = 10 px)'],
    ['[ / ]', 'Send backward / bring forward'],
    ['Ctrl/⌘ + 0', 'Fit card to window'],
    ['Ctrl/⌘ + + / −', 'Zoom in / out'],
    ['Ctrl/⌘ + wheel', 'Zoom at pointer'],
    ['Space + drag', 'Pan the work area'],
    ['Escape', 'Deselect / close dialog'],
  ];
  const kv = el('div', { class: 'kv' });
  for (const [key, description] of rows) {
    kv.append(el('kbd', { text: key }), el('span', { text: description }));
  }
  openModal({
    title: 'Keyboard shortcuts',
    body: kv,
    buttons: [{ label: 'Close', primary: true, onClick: (close) => close() }],
  });
}
