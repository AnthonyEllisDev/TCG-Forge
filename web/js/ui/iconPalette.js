/*
 * The icon palette under Card Fields, and `{name}` typed into a text box.
 *
 * Both write the icon's character into a text input that is marked
 * `data-icon-target`: the Card Fields boxes and Properties → Text. The input's
 * own `input` handler then does what it always does with its value, so an
 * icon reaches the canvas by exactly the path a letter does.
 */

import { $, el, on } from '../util/dom.js';
import { bus, EVT } from '../util/bus.js';
import { expandIcons, iconList } from '../core/icons.js';
import { toast } from './dialogs.js';

/* The text box an icon goes into: the last one that had the focus. */
let target = null;

export function initIconPalette() {
  // Remember the box rather than the focus: by the time a palette button is
  // pressed from the keyboard, the box has lost it.
  on(document, 'focusin', (e) => {
    if (e.target?.matches?.('[data-icon-target]')) target = e.target;
  });
  bus.on(EVT.ICONS, render);
  render();
}

/**
 * Replace every finished `{name}` in a text box with its icon, keeping the
 * caret where it was in the text. Returns whether anything changed.
 */
export function expandTyped(node) {
  const value = node.value;
  const expanded = expandIcons(value);
  if (expanded === value) return false;
  const caret = expandIcons(value.slice(0, node.selectionStart ?? value.length)).length;
  node.value = expanded;
  node.setSelectionRange?.(caret, caret);
  return true;
}

function render() {
  const host = $('#iconPalette');
  if (!host) return;
  const icons = iconList();
  host.innerHTML = '';
  host.hidden = !icons.length;
  if (!icons.length) return;

  host.append(
    el('div', { class: 'icon-palette-head' }, [
      el('span', { text: 'Icons' }),
      el('span', { class: 'hint', text: 'click to insert, or type {name}' }),
    ])
  );
  const grid = el('div', { class: 'icon-grid', role: 'group', 'aria-label': 'Insert an icon' });
  for (const icon of icons) {
    const button = el('button', {
      type: 'button',
      class: 'icon-btn',
      text: icon.char,
      title: `{${icon.name}}`,
      'aria-label': `Insert ${icon.name}`,
      dataset: { icon: icon.name },
    });
    on(button, 'click', () => insert(icon));
    grid.append(button);
  }
  host.append(grid);
}

/*
 * A box can stay in the page while it is out of sight — Properties → Text is
 * hidden, not removed, when the selection stops being a text layer — and an
 * icon typed into it there goes nowhere anyone can see.
 */
const usable = (node) => !!node && node.isConnected && !node.disabled
  && (node.checkVisibility ? node.checkVisibility() : node.offsetParent !== null);

function insert(icon) {
  const node = usable(target) ? target : $('#fieldForm [data-icon-target]');
  if (!usable(node)) {
    toast('Click into a text field first, then pick the icon.', 'warn');
    return;
  }
  const start = node.selectionStart ?? node.value.length;
  const end = node.selectionEnd ?? start;
  node.focus();
  node.setRangeText(icon.char, start, end, 'end');
  node.dispatchEvent(new Event('input', { bubbles: true }));
}
