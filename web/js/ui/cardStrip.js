/*
 * Card strip — the cards in this project, under the canvas.
 *
 * One tile per card: a thumbnail once the card has been on screen this
 * session, its first words either way. Pictures are not saved in the project
 * file; they would be most of its size and all of its diff noise.
 *
 * The filter box narrows the tiles to the cards whose fields match, and the
 * previous / next buttons and Page Up / Down then step through those only. It
 * is a way of looking at the set, not a change to it: the strip order, the
 * numbering, exports and prints are all still the whole set, and the filter
 * is not saved.
 */

import { $, downloadText, el, on, slugify } from '../util/dom.js';
import { bus, EVT } from '../util/bus.js';
import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { editor } from '../core/editor.js';
import { history } from '../core/history.js';
import { isRendering } from '../core/batch.js';
import { wouldReplace } from '../core/project.js';
import {
  activeIndex,
  addCard,
  cardLabel,
  cardList,
  cardsTable,
  captureValues,
  matchingCards,
  moveCard,
  qtyOf,
  removeCard,
  setCardQty,
  slotKinds,
  switchCard,
} from '../core/cards.js';
import { confirmDialog, toast } from './dialogs.js';

const thumbs = new Map();   // card id -> data URL, this session only
let busy = false;
let thumbTimer = null;
let filter = '';

export function initCardStrip() {
  on(document, 'click', (e) => {
    const action = e.target.closest('[data-card-action]')?.dataset.cardAction;
    if (action) runAction(action);
  });

  // Taken on every keystroke, not on change: change waits for the box to lose
  // focus, and a Ctrl+S typed before that would save the old count. A box
  // emptied to retype it is left alone until it holds a number again.
  const qty = $('#cardQty');
  on(qty, 'input', () => {
    if (qty.value.trim() !== '') setCardQty(activeIndex(), qty.value);
  });
  on(qty, 'change', () => {
    qty.value = String(qtyOf(cardList()[activeIndex()]));
  });

  const box = $('#cardFilter');
  on(box, 'input', () => {
    filter = box.value;
    render();
  });
  on(box, 'keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      stepMatch(e.shiftKey ? -1 : 1, { wrap: true });
    } else if (e.key === 'Escape' && box.value) {
      e.preventDefault();
      clearFilter();
    }
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

/** Show the card before or after this one — among the filtered cards, if any. */
export function stepCard(delta) {
  return stepMatch(delta);
}

/** Put the keyboard in the filter box (the `/` shortcut). */
export function focusFilter() {
  const box = $('#cardFilter');
  box?.focus();
  box?.select();
}

export function clearFilter() {
  const box = $('#cardFilter');
  if (box) box.value = '';
  filter = '';
  render();
}

/**
 * The next card in `delta`'s direction that the filter lets through. With
 * `wrap`, the search carries on from the other end, as a find does.
 */
function neighbour(delta, { wrap = false, matches = matchingCards(filter) } = {}) {
  const count = cardList().length;
  const active = activeIndex();
  const allowed = matches ? new Set(matches) : null;
  for (let step = 1; step < count; step += 1) {
    let index = active + delta * step;
    if (wrap) index = ((index % count) + count) % count;
    else if (index < 0 || index >= count) return -1;
    if (!allowed || allowed.has(index)) return index;
  }
  return -1;
}

function stepMatch(delta, options) {
  const index = neighbour(delta, options);
  if (index < 0) return Promise.resolve();
  return goTo(index);
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
      await stepMatch(-1);
    } else if (action === 'next') {
      await stepMatch(1);
    } else if (action === 'left' || action === 'right') {
      moveCard(index, action === 'left' ? -1 : 1);
    } else if (action === 'sheet') {
      await saveSheet();
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

/**
 * Every card's fields as a CSV in workspace/batch, where the batch dialog
 * lists it. The sheet carries each card's id, so loading it back with *Add
 * rows as cards* updates these cards rather than adding a second set.
 */
async function saveSheet() {
  // During a run the canvas shows a spreadsheet row, and the card on screen
  // would be read from it.
  if (isRendering()) {
    toast('Wait for the render to finish first.', 'warn');
    return;
  }
  const table = await cardsTable();
  const file = `${slugify(state.project.name, 'cards')}.csv`;
  const count = `${table.rows.length} ${table.rows.length === 1 ? 'card' : 'cards'}`;
  const note = table.inline
    ? ` ${table.inline} ${table.inline === 1 ? 'picture lives' : 'pictures live'} only inside the project file and ${table.inline === 1 ? 'was' : 'were'} left blank.`
    : '';
  if (!api.online) {
    downloadText(table.csv, file, 'text/csv');
    toast(`Downloaded ${count} as ${file}.${note}`, table.inline ? 'warn' : 'ok', 6000);
    return;
  }
  const target = `batch/${file}`;
  if (await wouldReplace(target)) {
    const go = await confirmDialog({
      title: 'Replace a spreadsheet?',
      message: `${target} already exists — perhaps with edits not brought back yet. Saving replaces it; the file it replaces is kept once as a .bak beside it.`,
      confirmLabel: 'Replace',
      danger: true,
    });
    if (!go) return;
  }
  await api.writeText(target, table.csv, { backup: true });
  toast(`Saved ${count} to ${target}. Edit it in a spreadsheet, then bring it back with Batch → Add rows as cards.${note}`,
    table.inline ? 'warn' : 'ok', 7000);
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
  const matches = matchingCards(filter);
  const shown = matches ? new Set(matches) : null;

  host.innerHTML = '';
  cards.forEach((card, index) => {
    const matched = !shown || shown.has(index);
    if (!matched && index !== active) return;
    // The card on screen is labelled from its slots, not from its record,
    // which is only brought up to date when another card is shown.
    const label = cardLabel(index === active ? { values: captureValues() } : card, index, kinds);
    const thumb = thumbs.get(card.id);
    const tile = el(
      'button',
      {
        class: `card-tile${index === active ? ' active' : ''}${matched ? '' : ' no-match'}`,
        type: 'button',
        // Plain buttons, not listbox options: a listbox promises arrow-key
        // movement, and here Tab and Page Up / Down are the keys.
        'aria-current': index === active ? 'true' : null,
        'aria-label': `Card ${index + 1} of ${cards.length}: ${label}` +
          (qtyOf(card) > 1 ? `, ${qtyOf(card)} copies` : '') +
          (matched ? '' : ', not matching the filter'),
        title: label,
        dataset: { cardId: card.id },
        onClick: () => goTo(index),
      },
      [
        thumb
          ? el('img', { src: thumb, alt: '' })
          : el('span', { class: 'tile-blank', text: String(index + 1) }),
        el('span', { class: 'tile-label', text: `${index + 1}. ${label}` }),
        qtyOf(card) > 1 ? el('span', { class: 'tile-qty', text: `×${qtyOf(card)}`, 'aria-hidden': 'true' }) : null,
      ]
    );
    host.append(tile);
  });
  if (shown && !shown.size) host.append(el('span', { class: 'strip-empty', text: 'No card matches the filter.' }));

  const count = $('#cardCount');
  if (count) count.textContent = `${active + 1} / ${cards.length}`;
  const found = $('#cardFilterCount');
  if (found) found.textContent = shown ? `${shown.size} of ${cards.length} match` : '';
  const qty = $('#cardQty');
  if (qty && document.activeElement !== qty) qty.value = String(qtyOf(cards[active]));
  // The deck only needs saying when it is not simply one of each.
  const copies = cards.reduce((sum, card) => sum + qtyOf(card), 0);
  const total = $('#cardDeckTotal');
  if (total) total.textContent = copies === cards.length ? '' : `${copies} in the deck`;
  const single = cards.length <= 1;
  for (const [action, disabled] of [
    ['delete', single],
    ['prev', neighbour(-1, { matches }) < 0],
    ['next', neighbour(1, { matches }) < 0],
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
