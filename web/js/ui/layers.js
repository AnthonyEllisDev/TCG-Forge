/* Layers panel: ordering, visibility, locking, renaming, drag-and-drop. */

import { $, activatable, el, on } from '../util/dom.js';
import { bus, EVT } from '../util/bus.js';
import { editor, parseShowIf } from '../core/editor.js';
import { kindOf, labelOf } from '../core/objects.js';

const KIND_BADGE = {
  text: 'T',
  art: '🖼',
  frame: '▣',
  icon: '★',
  background: '▤',
  shape: '▭',
  group: '⧉',
};

let listEl = null;
let dragIndex = null;
let shown = [];   // the layer list as it was last drawn, by row index
let drawn = '';   // what each row said when it was drawn — see sameRows()

export function initLayers() {
  listEl = $('#layerList');

  bus.on(EVT.OBJECTS, render);
  bus.on(EVT.SELECTION, render);

  on($('#rightDock'), 'click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'layer-up') editor.order('up');
    else if (action === 'layer-down') editor.order('down');
    else if (action === 'layer-top') editor.order('top');
    else if (action === 'layer-bottom') editor.order('bottom');
    else if (action === 'duplicate') editor.duplicate();
    else if (action === 'group') editor.toggleGroup();
    else if (action === 'delete') editor.remove();
  });

  render();
}

/** A fingerprint of everything a row shows except which rows are selected. */
function rowsKey(objects) {
  return objects
    .map((obj) => [kindOf(obj), labelOf(obj), obj.tcgSlot || '', obj.tcgShowIf || '',
      obj.visible === false, obj.selectable === false].join('\u0001'))
    .join('\u0002');
}

/**
 * Picking a layer changes only which rows are highlighted. Rebuilding every row
 * for that swaps the nodes under the pointer between the two clicks of a
 * double-click, so the browser never reports one and a layer could not be
 * renamed with the mouse; it also detached the rename box the moment it was
 * clicked into. When nothing else changed, restyle the rows in place.
 */
function sameRows(objects) {
  return objects.length === shown.length &&
    objects.every((obj, i) => obj === shown[i]) &&
    rowsKey(objects) === drawn &&
    listEl.querySelectorAll('.layer-row').length === objects.length;
}

function render({ force = false } = {}) {
  if (!listEl) return;
  const objects = editor.objects();
  const active = editor.selection();
  if (!force && objects.length && sameRows(objects)) {
    for (const row of listEl.querySelectorAll('.layer-row')) {
      const on = active.includes(shown[Number(row.dataset.index)]);
      row.classList.toggle('active', on);
      if (on) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
    }
    return;
  }
  // Choosing a layer from the keyboard redraws the list; keep the keyboard on
  // the row it chose rather than dropping it back to the page.
  const focused = document.activeElement?.classList?.contains('layer-row') && listEl.contains(document.activeElement)
    ? shown[Number(document.activeElement.dataset.index)]
    : null;
  shown = objects.slice();
  drawn = rowsKey(objects);
  listEl.innerHTML = '';

  if (!objects.length) {
    listEl.append(el('div', { class: 'grid-empty', text: 'No layers yet — insert a shape or load a template.' }));
    updateCount(0);
    return;
  }

  // top layer first
  for (let i = objects.length - 1; i >= 0; i -= 1) {
    const obj = objects[i];
    const row = el('div', {
      class: `layer-row${active.includes(obj) ? ' active' : ''}${obj.visible === false ? ' hidden-layer' : ''}`,
      draggable: 'true',
      dataset: { index: String(i) },
    });

    row.append(el('span', { class: 'layer-kind', text: KIND_BADGE[kindOf(obj)] || '▭' }));

    const nameEl = el('span', { class: 'layer-name', text: labelOf(obj) });
    nameEl.title = 'Double-click to rename';
    row.append(nameEl);

    if (obj.tcgSlot) row.append(el('span', { class: 'layer-slot', text: obj.tcgSlot }));
    const rule = parseShowIf(obj.tcgShowIf);
    if (rule) {
      row.append(el('span', {
        class: 'layer-slot layer-cond',
        text: `${rule.negate ? 'unless' : 'if'} ${rule.slot}`,
        title: `Shown only when “${rule.slot}” is ${rule.negate ? 'empty' : 'filled'}`,
      }));
    }

    row.append(
      el('button', {
        class: `layer-btn${obj.visible === false ? ' on' : ''}`,
        text: obj.visible === false ? '◌' : '◉',
        // A conditional layer's visibility follows its field; a toggle here
        // would be undone by the very next edit.
        title: rule ? 'Shown and hidden by its field — change it in Properties → Layer' : 'Show / hide layer',
        disabled: !!rule,
        onClick: (e) => {
          e.stopPropagation();
          obj.set('visible', obj.visible === false);
          editor.canvas.requestRenderAll();
          editor.touch();
          render();
        },
      })
    );

    row.append(
      el('button', {
        class: `layer-btn${obj.selectable === false ? ' on' : ''}`,
        text: obj.selectable === false ? '🔒' : '🔓',
        title: 'Lock / unlock layer',
        onClick: (e) => {
          e.stopPropagation();
          toggleLock(obj);
          render();
        },
      })
    );

    const pick = (e) => {
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        const next = new Set(editor.selection());
        next.has(obj) ? next.delete(obj) : next.add(obj);
        editor.select(Array.from(next));
      } else {
        editor.select(obj);
      }
    };
    row.addEventListener('click', (e) => {
      // Placing the caret in the rename box is not a request to pick the layer.
      if (e.target.closest('.layer-btn, input')) return;
      pick(e);
    });
    // Not role="button": the row holds buttons of its own, and a button inside
    // a button is announced as nonsense. It is a focusable row that selects.
    activatable(row, pick, { role: null, label: `Layer ${labelOf(obj)}` });
    if (active.includes(obj)) row.setAttribute('aria-current', 'true');

    nameEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRename(nameEl, obj);
    });

    row.addEventListener('dragstart', () => {
      dragIndex = i;
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      dragIndex = null;
      row.classList.remove('dragging');
      listEl.querySelectorAll('.drag-over').forEach((n) => n.classList.remove('drag-over'));
    });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drag-over');
      if (dragIndex === null || dragIndex === i) return;
      editor.moveToIndex(editor.objects()[dragIndex], i);
    });

    listEl.append(row);
  }
  if (focused) {
    listEl.querySelector(`.layer-row[data-index="${objects.indexOf(focused)}"]`)?.focus();
  }

  updateCount(objects.length);
}

function toggleLock(obj) {
  const locked = obj.selectable === false;
  obj.set({
    selectable: locked,
    evented: locked,
    hasControls: locked,
    lockMovementX: !locked,
    lockMovementY: !locked,
    lockRotation: !locked,
    lockScalingX: !locked,
    lockScalingY: !locked,
  });
  if (!locked) editor.canvas.discardActiveObject();
  editor.canvas.requestRenderAll();
  editor.touch();
}

function startRename(nameEl, obj) {
  const input = el('input', { type: 'text', value: obj.tcgName || labelOf(obj) });
  nameEl.textContent = '';
  nameEl.append(input);
  input.focus();
  input.select();

  // render() detaches the input, which fires its blur handler — so cancelling
  // by re-rendering would commit the very edit it is meant to throw away.
  let done = false;
  const finish = (fn) => {
    if (done) return;
    done = true;
    fn();
    // The rename box is not part of the fingerprint, so a cancelled rename
    // would otherwise be left on screen by the in-place path.
    render({ force: true });
  };
  const commit = () =>
    finish(() => {
      obj.set('tcgName', input.value.trim() || undefined);
      editor.touch();
    });
  const cancel = () => finish(() => {});

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') cancel();
    e.stopPropagation();
  });
}

function updateCount(n) {
  const stat = $('#statLayers');
  if (stat) stat.textContent = `${n} layer${n === 1 ? '' : 's'}`;
}
