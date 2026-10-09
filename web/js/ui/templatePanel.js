/* Template browser: list, load, and save the current card as a template. */

import { $, activatable, el, on } from '../util/dom.js';
import { bus, EVT } from '../util/bus.js';
import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { wouldReplace } from '../core/project.js';
import {
  applyTemplate, listTemplates, loadTemplateFile, saveTemplate, templateTarget,
} from '../core/templates.js';
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
  // Loading a template redraws this list; a keyboard user who loaded it from
  // here should still be on its row afterwards, not back at the top of the page.
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.path : null;
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
      dataset: { path: tpl.path },
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
    activatable(item, () => load(tpl), { label: `Load template ${tpl.name}` });
    list.append(item);
  }
  if (focused) list.querySelector(`[data-path="${CSS.escape(focused)}"]`)?.focus();
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
    const { missingArt = [] } = (await applyTemplate(data)) || {};
    if (missingArt.length) {
      toast(`Loaded template “${data.name}”, but its art is missing (${missingArt.join(', ')}) — the art box is shown instead.`, 'warn', 6000);
    } else {
      toast(`Loaded template “${data.name}”.`, 'ok');
    }
  } catch (err) {
    toast(`Could not load template: ${err.message}`, 'err');
  }
}

function openSaveDialog(typed = null) {
  const name = el('input', { type: 'text', value: typed?.name ?? (state.project.name || 'My Template') });
  const description = el('input', { type: 'text', value: typed?.description ?? '', placeholder: 'Short description shown in the browser' });
  const author = el('input', { type: 'text', value: typed?.author ?? '', placeholder: 'Your name (optional)' });
  const tags = el('input', { type: 'text', value: typed?.tags ?? '', placeholder: 'fantasy, monster, holo' });

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
          const meta = {
            name: name.value.trim() || 'Untitled template',
            description: description.value.trim(),
            author: author.value.trim(),
            tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
          };
          const typedNow = { name: name.value, description: description.value, author: author.value, tags: tags.value };
          close();
          try {
            // The name is the file name, and the default name is the project's,
            // so a clash with an earlier template (or a shipped one) is easy.
            const target = templateTarget(meta.name);
            if (await wouldReplace(target)) {
              const replace = await confirmDialog({
                title: 'Replace an existing template?',
                message: `${target} already holds a template. Saving replaces it; the file it replaces is kept once as a .bak beside it.`,
                confirmLabel: 'Replace',
                danger: true,
              });
              if (!replace) {
                openSaveDialog(typedNow);
                return;
              }
            }
            const res = await saveTemplate(meta);
            if (res.saved === 'workspace') {
              toast(`Saved to ${res.path}`, 'ok');
              refresh();
            } else {
              toast('Saved in memory only — start the local server to write templates to disk.', 'warn');
            }
          } catch (err) {
            toast(`Save failed: ${err.message}`, 'err');
            openSaveDialog(typedNow);
          }
        },
      },
    ],
  });
}
