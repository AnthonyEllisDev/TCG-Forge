/*
 * Card strip — the cards in this project, under the canvas.
 *
 * One tile per card: a thumbnail once the card has been on screen this
 * session, its first words either way. Pictures are not saved in the project
 * file; they would be most of its size and all of its diff noise.
 */

import { $, el, on } from '../util/dom.js';
import { bus, EVT } from '../util/bus.js';
import { editor } from '../core/editor.js';
import { history } from '../core/history.js';
import {
  activeIndex,
  addCard,
  cardLabel,
  cardList,
  captureValues,
  moveCard,
  removeCard,
  slotKinds,
  switchCard,
} from '../core/cards.js';
import { confirmDialog, toast } from './dialogs.js';

const thumbs = new Map();   // card id -> data URL, this session only
let busy = false;
let thumbTimer = null;

export function initCardStrip() {
  on(document, 'click', (e) => {
    const action = e.target.closest('[data-card-action]')?.dataset.cardAction;
    if (action) runAction(action);
  });

  bus.on(EVT.CARDS, render);
  bus.on(EVT.TEMPLATE_APPLIED, render);
  bus.on(EVT.PROJECT, render);
  bus.on(EVT.MODIFIED, () => {
    // After the edit has settled, not on every keystroke of it.
    clearTimeout(thumbTimer);
    thumbTimer = setTimeout(refreshThumb, 350);
  });
  render();
}

/** Show the card before or after this one. */
export function stepCard(delta) {
  return goTo(activeIndex() + delta);
}

async function goTo(index) {
  if (busy || index < 0 || index >= cardList().length) return;
  // The card being left is still on screen: its picture is taken now or never.
  refreshThumb();
  busy = true;
  try {
    const missing = await switchCard(index);
    if (missing.length) {
      toast(`This card names artwork that could not be loaded: ${missing.join(', ')}`, 'warn', 5200);
    }
  } catch (err) {
    toast(`Could not show that card: ${err.message}`, 'err');
  } finally {
    busy = false;
    render();
  }
}

async function runAction(action) {
  if (busy) return;
  const index = activeIndex();
  try {
    if (action === 'add' || action === 'copy') {
      refreshThumb();
      busy = true;
      try {
        await addCard({ copy: action === 'copy' });
      } finally {
        busy = false;
      }
    } else if (action === 'prev') {
      await goTo(index - 1);
    } else if (action === 'next') {
      await goTo(index + 1);
    } else if (action === 'left' || action === 'right') {
      moveCard(index, action === 'left' ? -1 : 1);
    } else if (action === 'delete') {
      if (cardList().length <= 1) return;
      const label = cardLabel(cardList()[index], index);
      const go = await confirmDialog({
        title: 'Delete this card?',
        message: `“${label}” is removed from the project. The layout and the other cards are not touched.`,
        confirmLabel: 'Delete card',
        danger: true,
      });
      if (!go) return;
      busy = true;
      try {
        await removeCard(index);
      } finally {
        busy = false;
      }
    }
  } catch (err) {
    toast(`${err.message}`, 'err');
  }
  render();
}

/** Keep the picture of the card on screen current. */
function refreshThumb() {
  clearTimeout(thumbTimer);
  // While a batch or print run holds history, the canvas shows a spreadsheet
  // row, not this card.
  if (!editor.canvas || busy || history.locked) return;
  const card = cardList()[activeIndex()];
  try {
    thumbs.set(card.id, editor.thumbnail());
  } catch (err) {
    console.warn('[cards] thumbnail failed', err);
    return;
  }
  render();
}

function render() {
  const host = $('#cardTiles');
  if (!host || !editor.canvas) return;
  const cards = cardList();
  const active = activeIndex();
  const kinds = slotKinds();
  // Rebuilding the tiles must not throw keyboard focus back to the page.
  const hadFocus = host.contains(document.activeElement);

  host.innerHTML = '';
  cards.forEach((card, index) => {
    // The card on screen is labelled from its slots, not from its record,
    // which is only brought up to date when another card is shown.
    const label = cardLabel(index === active ? { values: captureValues() } : card, index, kinds);
    const thumb = thumbs.get(card.id);
    const tile = el(
      'button',
      {
        class: `card-tile${index === active ? ' active' : ''}`,
        type: 'button',
        // Plain buttons, not listbox options: a listbox promises arrow-key
        // movement, and here Tab and Page Up / Down are the keys.
        'aria-current': index === active ? 'true' : null,
        'aria-label': `Card ${index + 1} of ${cards.length}: ${label}`,
        title: label,
        dataset: { cardId: card.id },
        onClick: () => goTo(index),
      },
      [
        thumb
          ? el('img', { src: thumb, alt: '' })
          : el('span', { class: 'tile-blank', text: String(index + 1) }),
        el('span', { class: 'tile-label', text: `${index + 1}. ${label}` }),
      ]
    );
    host.append(tile);
  });

  const count = $('#cardCount');
  if (count) count.textContent = `${active + 1} / ${cards.length}`;
  const single = cards.length <= 1;
  for (const [action, disabled] of [
    ['delete', single],
    ['prev', active === 0],
    ['next', active === cards.length - 1],
    ['left', active === 0],
    ['right', active === cards.length - 1],
  ]) {
    const button = $(`[data-card-action="${action}"]`);
    if (button) button.disabled = disabled;
  }
  const current = host.querySelector('.card-tile.active');
  current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  if (hadFocus) current?.focus();
}
