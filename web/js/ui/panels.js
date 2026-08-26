/* Collapsible panels and draggable dock splitters, with persisted layout. */

import { $, $$, clamp, on } from '../util/dom.js';
import { state } from '../core/state.js';
import { editor } from '../core/editor.js';

export function initPanels() {
  /* --- collapse / expand ------------------------------------------------ */
  for (const panel of $$('.panel')) {
    const key = panel.dataset.panel;
    if (state.settings.collapsed?.[key]) panel.classList.add('collapsed');
    const head = panel.querySelector('.panel-head');
    on(head, 'click', () => {
      panel.classList.toggle('collapsed');
      state.settings.collapsed = {
        ...state.settings.collapsed,
        [key]: panel.classList.contains('collapsed'),
      };
      state.saveSettings();
    });
  }

  /* --- dock resizing ---------------------------------------------------- */
  applyDockWidths();
  makeSplitter($('#splitLeft'), 'left');
  makeSplitter($('#splitRight'), 'right');
}

function applyDockWidths() {
  document.documentElement.style.setProperty('--dock-w-left', `${state.settings.dockLeft}px`);
  document.documentElement.style.setProperty('--dock-w-right', `${state.settings.dockRight}px`);
}

function makeSplitter(node, side) {
  if (!node) return;
  let dragging = false;

  node.addEventListener('pointerdown', (e) => {
    dragging = true;
    node.classList.add('dragging');
    node.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  node.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const width =
      side === 'left'
        ? clamp(e.clientX, 220, 520)
        : clamp(window.innerWidth - e.clientX, 240, 560);
    if (side === 'left') state.settings.dockLeft = Math.round(width);
    else state.settings.dockRight = Math.round(width);
    applyDockWidths();
  });

  const stop = () => {
    if (!dragging) return;
    dragging = false;
    node.classList.remove('dragging');
    state.saveSettings();
    editor.fitToWindow();
  };
  node.addEventListener('pointerup', stop);
  node.addEventListener('pointercancel', stop);
}
