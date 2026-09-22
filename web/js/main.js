/*
 * TCG Forge — application bootstrap.
 *
 * Everything runs locally: Fabric.js is vendored in web/vendor, fonts and
 * artwork are read from the workspace folder, and no request ever leaves
 * the machine.
 */

import { $ } from './util/dom.js';
import { bus, EVT } from './util/bus.js';
import { api } from './core/api.js';
import { state } from './core/state.js';
import { editor } from './core/editor.js';
import { history } from './core/history.js';
import { assets } from './core/assets.js';
import { applyTemplate } from './core/templates.js';

import { initDialogs, toast } from './ui/dialogs.js';
import { initPanels } from './ui/panels.js';
import { initToolbar } from './ui/toolbar.js';
import { initLayers } from './ui/layers.js';
import { initProperties } from './ui/properties.js';
import { initAssetPanel } from './ui/assetPanel.js';
import { initTemplatePanel, refresh as refreshTemplates } from './ui/templatePanel.js';
import { initFieldsPanel } from './ui/fieldsPanel.js';
import { initBatchPanel } from './ui/batchPanel.js';
import { initPrintPanel } from './ui/printPanel.js';
import { initShortcuts } from './ui/shortcuts.js';

async function boot() {
  if (typeof fabric === 'undefined') {
    document.body.innerHTML =
      '<p style="padding:32px;font-family:sans-serif;color:#e8ecf5">' +
      'Fabric.js failed to load from <code>web/vendor/fabric.min.js</code>. ' +
      'Re-download the project files and try again.</p>';
    return;
  }

  editor.init({
    canvasEl: $('#cardCanvas'),
    stageEl: $('#canvasStage'),
    scrollEl: $('#canvasScroll'),
  });

  initDialogs();
  initPanels();
  initToolbar();
  initLayers();
  initProperties();
  initAssetPanel();
  initTemplatePanel();
  initFieldsPanel();
  initBatchPanel();
  initPrintPanel();
  initShortcuts();
  history.attach();

  bus.emit(EVT.CARD, state.card);
  bus.emit(EVT.PROJECT, state.project);
  bus.emit(EVT.HISTORY, history.status());

  const online = await api.connect();
  await assets.refresh();
  await refreshTemplates();

  if (online) {
    await loadStarterTemplate();
  } else {
    toast('Running without the local server — start run.sh / run.bat for full file access.', 'warn', 5200);
  }

  window.addEventListener('beforeunload', (e) => {
    if (!state.dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });

  editor.fitToWindow();
  bus.emit(EVT.READY);
}

/** First run: open a starter template so the editor is never an empty void. */
async function loadStarterTemplate() {
  try {
    const templates = await api.listTemplates();
    if (!templates.length) return;
    const starter =
      templates.find((t) => /starter|classic|spell/i.test(t.name)) || templates[0];
    const data = await api.readJSON(starter.path);
    await applyTemplate(data);
    state.setDirty(false);
  } catch (err) {
    console.warn('[boot] starter template unavailable', err);
  }
}

/* Expose a small handle for debugging and for user scripts/plugins. */
window.TCGForge = { editor, state, api, assets, history, bus, EVT };

boot().catch((err) => {
  console.error('[boot] failed', err);
  toast(`Startup failed: ${err.message}`, 'err', 8000);
});
