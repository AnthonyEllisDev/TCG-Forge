/* Template browser: list, load, and save the current card as a template. */

import { $, el, on } from '../util/dom.js';
import { bus, EVT } from '../util/bus.js';
import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { applyTemplate, listTemplates, loadTemplateFile, saveTemplate } from '../core/templates.js';
import { confirmDialog, openModal, toast } from './dialogs.js';

let templates = [];
let query = '';

export function initTemplatePanel() {
  on($('#templateSearch'), 'input', (e) => {
    query = e.target.value.toLowerCase();
    render();
  });

  on(document, 'click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'reload-templates') refresh();
    else if (action === 'save-template') openSaveDialog();
  });

  bus.on(EVT.TEMPLATES, refresh);
  // The list only redraws on its own data changing, so loading a template or
  // opening a project would leave the highlight on the previous row.
  bus.on(EVT.TEMPLATE_APPLIED, render);
  bus.on(EVT.PROJECT, render);
  refresh();
}

export async function refresh() {
  try {
    templates = await listTemplates();
  } catch (err) {
    console.warn('[templates] list failed', err);
    templates = [];
  }
  render();
}

function render() {
  const list = $('#templateList');
  if (!list) return;
  list.innerHTML = '';

  const items = templates.filter(
    (t) =>
      !query ||
      t.name.toLowerCase().includes(query) ||
      (t.description || '').toLowerCase().includes(query) ||
      (t.tags || []).join(' ').toLowerCase().includes(query)
  );

  if (!items.length) {
    list.append(
      el('div', {
        class: 'grid-empty',
        html: api.online
          ? 'No templates found in <b>workspace/templates</b>.<br>Build a layout and save it as a template.'
          : 'Templates load from the workspace folder — start the app with <b>run.sh</b> / <b>run.bat</b> to browse them.',
      })
    );
    return;
  }

  for (const tpl of items) {
    const item = el('div', {
      // templateId is a slug and need not be the slug of the display name
      // ("classic-spell" vs "Classic Spell Frame"), so match on the id.
      class: `list-item${state.project.templateId && templateIdOf(tpl) === state.project.templateId ? ' active' : ''}`,
    }, [
      el('div', { class: 'li-title', text: tpl.name }),
      el('div', {
        class: 'li-sub',
        text: [tpl.description, tpl.card?.width ? `${tpl.card.width}×${tpl.card.height}` : null,
          tpl.fieldCount ? `${tpl.fieldCount} fields` : null].filter(Boolean).join(' · '),
      }),
    ]);
    if (tpl.tags?.length) {
      item.append(el('div', { class: 'li-tags' }, tpl.tags.map((t) => el('span', { class: 'tag', text: t }))));
    }
    on(item, 'click', () => load(tpl));
    list.append(item);
  }
}

function templateIdOf(tpl) {
  return tpl.id || tpl.file?.replace(/\.json$/i, '') || '';
}

async function load(tpl) {
  if (state.dirty) {
    const go = await confirmDialog({
      title: 'Replace the current card?',
      message: 'Loading a template clears the canvas. Unsaved changes will be lost.',
      confirmLabel: 'Load template',
      danger: true,
    });
    if (!go) return;
  }
  try {
    const data = await loadTemplateFile(tpl.path);
    await applyTemplate(data);
    toast(`Loaded template “${data.name}”.`, 'ok');
  } catch (err) {
    toast(`Could not load template: ${err.message}`, 'err');
  }
}

function openSaveDialog() {
  const name = el('input', { type: 'text', value: state.project.name || 'My Template' });
  const description = el('input', { type: 'text', placeholder: 'Short description shown in the browser' });
  const author = el('input', { type: 'text', placeholder: 'Your name (optional)' });
  const tags = el('input', { type: 'text', placeholder: 'fantasy, monster, holo' });

  const body = el('div', { class: 'stack' }, [
    el('p', { class: 'hint', text: 'Templates store the full layout plus the card size. Any layer with a slot name becomes an editable field.' }),
    el('label', { class: 'field' }, [el('span', { text: 'Template name' }), name]),
    el('label', { class: 'field' }, [el('span', { text: 'Description' }), description]),
    el('label', { class: 'field' }, [el('span', { text: 'Author' }), author]),
    el('label', { class: 'field' }, [el('span', { text: 'Tags (comma separated)' }), tags]),
  ]);

  openModal({
    title: 'Save as template',
    body,
    buttons: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Save template',
        primary: true,
        onClick: async (close) => {
          try {
            const res = await saveTemplate({
              name: name.value.trim() || 'Untitled template',
              description: description.value.trim(),
              author: author.value.trim(),
              tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
            });
            close();
            if (res.saved === 'workspace') {
              toast(`Saved to ${res.path}`, 'ok');
              refresh();
            } else {
              toast('Saved in memory only — start the local server to write templates to disk.', 'warn');
            }
          } catch (err) {
            toast(`Save failed: ${err.message}`, 'err');
          }
        },
      },
    ],
  });
}
