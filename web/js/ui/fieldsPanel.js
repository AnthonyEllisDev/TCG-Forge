/*
 * Card Fields panel — the form view of a template.
 *
 * Every layer carrying a `tcgSlot` shows up here, so filling in a card is
 * typing into labelled boxes instead of hunting for text layers on canvas.
 */

import { $, el, on } from '../util/dom.js';
import { bus, EVT } from '../util/bus.js';
import { assets } from '../core/assets.js';
import { editor } from '../core/editor.js';
import { state } from '../core/state.js';
import {
  clearFieldImage,
  collectFields,
  fieldValue,
  frameFieldImage,
  isPlacedArt,
  MAX_ZOOM,
  MIN_ZOOM,
  readFraming,
  setFieldImage,
  setFieldText,
} from '../core/templates.js';
import {
  activeIndex,
  cardList,
  describeOwnChanges,
  forgetMissingArt,
  isSwitching,
  ownChanges,
  placeArt,
  resetOwnChanges,
  settled,
} from '../core/cards.js';
import { toast } from './dialogs.js';
import { expandTyped } from './iconPalette.js';

let signature = '';
let artInput = null;

export function initFieldsPanel() {
  bus.on(EVT.TEMPLATE_APPLIED, () => render(true));
  bus.on(EVT.OBJECTS, () => render(false));
  bus.on(EVT.PROJECT, () => render(false));
  bus.on(EVT.CARDS, syncOwn);
  on($('#cardOwnReset'), 'click', () => {
    const reset = resetOwnChanges();
    if (reset) toast(`Back to the layout: ${describeOwnChanges(reset)}. Ctrl+Z brings them back.`, 'ok');
    else toast('Nothing to reset on this card just now.', 'warn');
  });
  render(true);
}

/*
 * A card that moves, resizes or recolours a layer for itself, or frames its
 * art its own way, says so here, with a way back to the layout — without
 * hunting through the Layers panel for the "this card" badges and the art
 * for its zoom.
 */
function syncOwn() {
  const box = $('#cardOwn');
  if (!box) return;
  const words = describeOwnChanges(ownChanges());
  box.hidden = !words;
  $('#cardOwnText').textContent = words ? `This card's own: ${words}` : '';
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

  syncOwn();
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
          dataset: { pickSlot: field.id },
          onClick: () => pickArt(field.id),
        }),
        el('button', {
          class: 'btn tiny',
          text: 'Select layer',
          onClick: () => editor.select(editor.findBySlot(field.id)[0]),
        }),
        el('button', {
          class: 'btn tiny',
          text: 'Clear',
          title: 'Take the artwork out and put the placeholder back',
          disabled: !isPlacedArt(objs[0]),
          dataset: { clearSlot: field.id },
          onClick: () => {
            clearFieldImage(field.id);
            forgetMissingArt(field.id);
          },
        }),
      ]);
      item.append(row);
      item.append(framingRow(field));
      item.append(el('div', { class: 'hint', id: `ffh_${field.id}`, text: artHint(current) }));
    } else if (field.type === 'multiline') {
      const area = el('textarea', {
        id: `ff_${field.id}`, rows: '3', placeholder: field.placeholder || '', dataset: { iconTarget: '' },
      });
      area.value = fieldValue(field.id);
      guardSwitch(area, field.id);
      on(area, 'input', () => {
        if (heldBySwitch(area, field.id)) return;
        expandTyped(area);
        setFieldText(field.id, area.value);
      });
      item.append(area);
    } else {
      const input = el('input', {
        type: 'text', id: `ff_${field.id}`, placeholder: field.placeholder || '', dataset: { iconTarget: '' },
      });
      input.value = fieldValue(field.id);
      guardSwitch(input, field.id);
      on(input, 'input', () => {
        if (heldBySwitch(input, field.id)) return;
        expandTyped(input);
        setFieldText(field.id, input.value);
      });
      item.append(input);
    }

    host.append(item);
  }
}

/*
 * While a card switch is drawing the incoming card, the box still shows the
 * card being left and the switch is about to write every slot. Typing then
 * landed on the old card's words and was wiped a moment later, so it is
 * refused for that moment and the box shows the new card once it is there.
 */
function guardSwitch(node, slot) {
  on(node, 'beforeinput', (e) => {
    if (!isSwitching()) return;
    e.preventDefault();
    resyncAfterSwitch(node, slot);
  });
}

/** For input that skips `beforeinput` (the icon palette sets the value). */
function heldBySwitch(node, slot) {
  if (!isSwitching()) return false;
  resyncAfterSwitch(node, slot);
  return true;
}

function resyncAfterSwitch(node, slot) {
  settled().then(() => {
    if (node.isConnected) node.value = fieldValue(slot);
  });
}

/*
 * How this card's picture sits in its window. Moving it is a drag on the
 * card; the zoom is here because Ctrl + wheel on the canvas already zooms the
 * view. Both are kept per card.
 */
function framingRow(field) {
  const slot = field.id;
  const zoom = el('input', {
    type: 'range',
    id: `ffz_${slot}`,
    min: String(MIN_ZOOM * 100),
    max: String(MAX_ZOOM * 100),
    step: '5',
    value: '100',
    'aria-label': `Zoom the ${field.label || slot} artwork`,
  });
  const readout = el('output', { id: `ffzo_${slot}`, for: `ffz_${slot}`, text: '100%' });
  const refit = el('button', {
    class: 'btn tiny',
    text: 'Refit',
    title: 'Fill the window with the whole picture again',
    dataset: { refitSlot: slot },
    onClick: () => frameFieldImage(slot, null),
  });
  on(zoom, 'input', () => {
    // Mid-switch the slot is about to hold the next card's picture.
    if (isSwitching()) {
      settled().then(() => syncFraming(slot));
      return;
    }
    readout.textContent = `${zoom.value}%`;
    frameFieldImage(slot, Number(zoom.value) / 100);
  });
  const row = el('div', { class: 'ff-frame' }, [el('span', { text: 'Zoom' }), zoom, readout, refit]);
  syncFraming(slot, { zoom, readout, refit });
  return row;
}

function syncFraming(slot, nodes = null) {
  const zoom = nodes?.zoom || document.getElementById(`ffz_${slot}`);
  const readout = nodes?.readout || document.getElementById(`ffzo_${slot}`);
  const refit = nodes?.refit || document.querySelector(`[data-refit-slot="${CSS.escape(slot)}"]`);
  if (!zoom) return;
  const target = editor.findBySlot(slot)[0];
  const placed = isPlacedArt(target);
  const framing = placed ? readFraming(target) : null;
  const percent = Math.round((framing?.zoom ?? 1) * 100);
  zoom.disabled = !placed;
  if (zoom !== document.activeElement) {
    // A picture shrunk below the cover fit on the canvas: the slider reaches
    // down to it, so it shows where it is and steps from there.
    zoom.min = String(Math.min(MIN_ZOOM * 100, Math.floor(percent / 5) * 5));
    zoom.value = String(percent);
  }
  if (readout) readout.textContent = `${percent}%`;
  if (refit) refit.disabled = !framing;
}

const artHint = (path) => path || 'Drop art from the Asset Library, or use Choose image.';

function syncValues(fields) {
  for (const field of fields) {
    if (field.type === 'image') {
      // Placing, clearing and switching cards all change what is in the slot
      // without changing which fields there are.
      const target = editor.findBySlot(field.id)[0];
      const hint = document.getElementById(`ffh_${field.id}`);
      if (hint) hint.textContent = artHint(target?.tcgAsset);
      const clear = document.querySelector(`[data-clear-slot="${CSS.escape(field.id)}"]`);
      if (clear) clear.disabled = !isPlacedArt(target);
      syncFraming(field.id);
      continue;
    }
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
    if (isSwitching()) {
      toast('The card is still changing — try again in a moment.', 'err');
      artInput.value = '';
      return;
    }
    // The upload is part of the placement, so a card switch started while it
    // is under way waits for it; uploading first and placing after let the
    // switch finish in between, and the picture went onto the next card.
    const card = cardList()[activeIndex()]?.id;
    try {
      await placeArt(async () => {
        const source = await assets.sourceForFile(file, 'art');
        if (cardList()[activeIndex()]?.id !== card) throw new Error('the card changed before the picture arrived');
        await setFieldImage(slot, source.url, { assetPath: source.path });
        forgetMissingArt(slot);
      });
      toast(`Placed ${file.name} in “${slot}”.`, 'ok');
    } catch (err) {
      toast(`Could not place image: ${err.message}`, 'err');
    }
    artInput.value = '';
  };
  artInput.click();
}
