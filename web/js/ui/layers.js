/* Layers panel: ordering, visibility, locking, renaming, drag-and-drop. */

import { $, el, on } from '../util/dom.js';
import { bus, EVT } from '../util/bus.js';
import { editor } from '../core/editor.js';
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

function render() {
  if (!listEl) return;
  const objects = editor.objects();
  const active = editor.selection();
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

    row.append(
      el('button', {
        class: `layer-btn${obj.visible === false ? ' on' : ''}`,
        text: obj.visible === false ? '◌' : '◉',
        title: 'Show / hide layer',
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

    row.addEventListener('click', (e) => {
      if (e.target.closest('.layer-btn')) return;
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        const next = new Set(editor.selection());
        next.has(obj) ? next.delete(obj) : next.add(obj);
        editor.select(Array.from(next));
      } else {
        editor.select(obj);
      }
    });

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
    tcgLocked: !locked,
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

  const commit = () => {
    const value = input.value.trim();
    obj.set('tcgName', value || undefined);
    editor.touch();
    render();
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') render();
    e.stopPropagation();
  });
}

function updateCount(n) {
  const stat = $('#statLayers');
  if (stat) stat.textContent = `${n} layer${n === 1 ? '' : 's'}`;
}
