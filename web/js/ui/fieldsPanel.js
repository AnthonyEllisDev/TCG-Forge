/*
 * Card Fields panel — the form view of a template.
 *
 * Every layer carrying a `tcgSlot` shows up here, so filling in a card is
 * typing into labelled boxes instead of hunting for text layers on canvas.
 */

import { $, el, on } from '../util/dom.js';
import { bus, EVT } from '../util/bus.js';
import { editor } from '../core/editor.js';
import { state } from '../core/state.js';
import { collectFields, fieldValue, setFieldImage, setFieldText } from '../core/templates.js';
import { toast } from './dialogs.js';

let signature = '';
let artInput = null;

export function initFieldsPanel() {
  bus.on(EVT.TEMPLATE_APPLIED, () => render(true));
  bus.on(EVT.OBJECTS, () => render(false));
  bus.on(EVT.PROJECT, () => render(false));
  render(true);
}

function currentFields() {
  const fromTemplate = state.project.fields || [];
  const fromCanvas = collectFields();
  const merged = new Map();
  for (const f of fromTemplate) merged.set(f.id, f);
  for (const f of fromCanvas) if (!merged.has(f.id)) merged.set(f.id, f);
  // drop fields whose layer no longer exists
  return Array.from(merged.values()).filter((f) => editor.findBySlot(f.id).length);
}

function render(force) {
  const host = $('#fieldForm');
  const hint = $('#fieldHint');
  if (!host) return;

  const fields = currentFields();
  const sig = fields.map((f) => `${f.id}:${f.type}`).join('|');
  if (!force && sig === signature) {
    syncValues(fields);
    return;
  }
  signature = sig;
  host.innerHTML = '';

  if (!fields.length) {
    hint.hidden = false;
    hint.textContent =
      'No fields yet. Load a template, or give any text layer a slot name in Properties → Typography → Field slot.';
    return;
  }
  hint.hidden = true;

  for (const field of fields) {
    const item = el('div', { class: 'ff-item' });
    item.append(el('label', { text: field.label || field.id, for: `ff_${field.id}` }));

    if (field.type === 'image') {
      const objs = editor.findBySlot(field.id);
      const current = objs[0]?.tcgAsset;
      const row = el('div', { class: 'btn-row' }, [
        el('button', {
          class: 'btn tiny',
          text: 'Choose image…',
          onClick: () => pickArt(field.id),
        }),
        el('button', {
          class: 'btn tiny',
          text: 'Select layer',
          onClick: () => editor.select(editor.findBySlot(field.id)[0]),
        }),
      ]);
      item.append(row);
      item.append(el('div', { class: 'hint', text: current ? current : 'Drop art from the Asset Library, or use Choose image.' }));
    } else if (field.type === 'multiline') {
      const area = el('textarea', { id: `ff_${field.id}`, rows: '3', placeholder: field.placeholder || '' });
      area.value = fieldValue(field.id);
      on(area, 'input', () => setFieldText(field.id, area.value));
      item.append(area);
    } else {
      const input = el('input', { type: 'text', id: `ff_${field.id}`, placeholder: field.placeholder || '' });
      input.value = fieldValue(field.id);
      on(input, 'input', () => setFieldText(field.id, input.value));
      item.append(input);
    }

    host.append(item);
  }
}

function syncValues(fields) {
  for (const field of fields) {
    if (field.type === 'image') continue;
    const node = document.getElementById(`ff_${field.id}`);
    if (!node || node === document.activeElement) continue;
    const value = fieldValue(field.id);
    if (node.value !== value) node.value = value;
  }
}

function pickArt(slot) {
  if (!artInput) {
    artInput = el('input', { type: 'file', accept: 'image/*', hidden: true });
    document.body.append(artInput);
  }
  artInput.onchange = async () => {
    const file = artInput.files?.[0];
    if (!file) return;
    try {
      await setFieldImage(slot, URL.createObjectURL(file));
      toast(`Placed ${file.name} in “${slot}”.`, 'ok');
    } catch (err) {
      toast(`Could not place image: ${err.message}`, 'err');
    }
    artInput.value = '';
  };
  artInput.click();
}
