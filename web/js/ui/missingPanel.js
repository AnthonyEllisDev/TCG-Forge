/*
 * Missing pictures — find where a card's artwork went, and point the cards
 * at it.
 *
 * A project names its pictures by workspace path, so moving or renaming a
 * file in the asset folders (or opening the set on another computer) leaves
 * cards naming a file that is not there. They still open — the art box stands
 * in and the card keeps the path — and this is the way back: one list of
 * every such picture, a match by file name where the library has one, and a
 * relink that moves every card naming it at once.
 */

import { $, el, on } from '../util/dom.js';
import { bus, EVT } from '../util/bus.js';
import { api } from '../core/api.js';
import { assets } from '../core/assets.js';
import { isRendering } from '../core/batch.js';
import { missingArt, relinkArt } from '../core/cards.js';
import { openModal, toast } from './dialogs.js';

/** Library folders that hold pictures a card's art slot can show. */
const PICTURE_CATEGORIES = ['art', 'backgrounds', 'frames', 'textures', 'icons'];

let checkTimer = null;
let checkToken = 0;
let working = false;

export function initMissingPanel() {
  on($('#cardMissingFind'), 'click', () => openMissingDialog());
  // Which cards there are, which one is showing and what the library holds
  // are what can make a picture go missing or come back; an edit to a layer
  // cannot.
  for (const event of [EVT.CARDS, EVT.PROJECT, EVT.ASSETS, EVT.STATUS]) bus.on(event, scheduleCheck);
}

/* ------------------------------------------------------------ the notice -- */

function scheduleCheck() {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(syncNotice, 250);
}

/** Show, under Card Fields, how many pictures the cards name that are gone. */
async function syncNotice() {
  const box = $('#cardMissing');
  if (!box) return;
  // A run borrows the canvas, and the card on screen is a spreadsheet row
  // then; the run's end announces the card again.
  if (isRendering()) return;
  const token = ++checkToken;
  let missing = [];
  try {
    missing = await missingArt();
  } catch (err) {
    console.warn('[missing] could not look for missing pictures', err);
  }
  // A later check started while this one listed folders; it has the say.
  if (token !== checkToken) return;
  box.hidden = !missing.length;
  $('#cardMissingText').textContent = missing.length ? describeMissing(missing) : '';
}

function describeMissing(missing) {
  const cards = new Set(missing.flatMap((item) => item.cards)).size;
  const pictures = missing.length === 1 ? '1 picture is' : `${missing.length} pictures are`;
  return `${pictures} missing (${cards === 1 ? '1 card' : `${cards} cards`})`;
}

/* ------------------------------------------------------------ the dialog -- */

const fileOf = (path) => String(path).split('/').pop();
const stemOf = (name) => name.replace(/\.[^.]+$/, '');

/** Every picture in the library, as `{path, label, category}`. */
function libraryPictures() {
  const out = [];
  for (const category of PICTURE_CATEGORIES) {
    for (const item of assets.index[category] || []) {
      if (item.path) out.push({ path: item.path, file: item.file || fileOf(item.path), category });
    }
  }
  return out;
}

/**
 * Pictures that are probably the missing one: the same file name anywhere in
 * the library, then the same name with another extension (a PNG saved again
 * as WebP). A file name says nothing about which of two same-named files is
 * meant, so only a single exact match is chosen for the user.
 */
function matchesFor(path, pictures) {
  const file = fileOf(path).toLowerCase();
  const stem = stemOf(file);
  const exact = pictures.filter((p) => p.file.toLowerCase() === file);
  const similar = pictures.filter((p) => p.file.toLowerCase() !== file && stemOf(p.file.toLowerCase()) === stem);
  return { exact, similar };
}

function cardsText(cards) {
  const places = cards.map((index) => index + 1);
  const shown = places.slice(0, 6).join(', ') + (places.length > 6 ? ', …' : '');
  return `${places.length === 1 ? 'card' : 'cards'} ${shown}`;
}

function pictureSelect(item, index, pictures) {
  const select = el('select', { id: `missingPick_${index}`, 'aria-label': `New place for ${item.path}` });
  select.append(el('option', { value: '', text: 'Leave it missing' }));
  const { exact, similar } = matchesFor(item.path, pictures);
  if (exact.length || similar.length) {
    const group = el('optgroup', { label: 'Same name' });
    for (const p of [...exact, ...similar]) group.append(el('option', { value: p.path, text: p.path }));
    select.append(group);
  }
  for (const category of PICTURE_CATEGORIES) {
    const inCategory = pictures.filter((p) => p.category === category);
    if (!inCategory.length) continue;
    const group = el('optgroup', { label: `assets/${category}` });
    for (const p of inCategory) group.append(el('option', { value: p.path, text: p.path }));
    select.append(group);
  }
  if (exact.length === 1) select.value = exact[0].path;
  return { select, found: exact.length === 1 };
}

export async function openMissingDialog() {
  const list = el('div', { class: 'missing-list', id: 'missingList' });
  const status = el('div', { class: 'hint', id: 'missingStatus', role: 'status' });
  const body = el('div', {}, [
    el('p', {
      class: 'hint',
      text: 'These pictures are named by cards in this project but are not in the workspace — moved, renamed, or left on another computer. Choose where each one is now: every card that names it is pointed at that file, and keeps how it framed the picture.',
    }),
    list,
    status,
  ]);
  let rows = [];

  async function draw(note = '') {
    list.innerHTML = '';
    rows = [];
    if (!api.online) {
      list.append(el('div', { class: 'grid-empty', text: 'Start the app with run.sh / run.bat to look for missing pictures.' }));
      status.textContent = '';
      return;
    }
    status.textContent = 'Looking…';
    // A file put back by hand since the library was last read is found too.
    await assets.refresh();
    const missing = await missingArt();
    const pictures = libraryPictures();
    let found = 0;
    missing.forEach((item, index) => {
      const pick = pictureSelect(item, index, pictures);
      if (pick.found) found += 1;
      rows.push({ item, select: pick.select });
      list.append(
        el('div', { class: 'missing-row' }, [
          el('div', { class: 'missing-head' }, [
            el('code', { class: 'missing-path', text: item.path, title: item.path }),
            el('span', { class: 'missing-cards', text: cardsText(item.cards) }),
          ]),
          pick.select,
        ])
      );
    });
    if (!missing.length) {
      list.append(el('div', { class: 'grid-empty', text: 'Every picture the cards name is in the workspace.' }));
    }
    const lead = note ? `${note} ` : '';
    status.textContent = missing.length
      ? `${lead}${found ? `${found} found by file name — check the choice and press Relink.` : 'Choose where each picture is now, or put the file back and press Look again.'}`
      : note;
  }

  async function relink() {
    const chosen = rows.filter((row) => row.select.value);
    if (!chosen.length) {
      status.textContent = 'Choose a picture for at least one of them first.';
      return;
    }
    if (isRendering()) {
      status.textContent = 'A render is using the card — try again when it has finished.';
      return;
    }
    working = true;
    let pictures = 0;
    let cards = 0;
    try {
      for (const row of chosen) {
        const changed = await relinkArt(row.item.path, row.select.value);
        if (changed) {
          pictures += 1;
          cards += changed;
        }
      }
    } catch (err) {
      status.textContent = `Could not relink: ${err.message}`;
      return;
    } finally {
      working = false;
    }
    const note = `Relinked ${pictures === 1 ? '1 picture' : `${pictures} pictures`} on ${cards === 1 ? '1 card' : `${cards} cards`}.`;
    toast(note, 'ok');
    await draw(note);
  }

  openModal({
    title: 'Missing pictures',
    body,
    wide: true,
    canClose: () => !working || 'Still relinking — a moment.',
    buttons: [
      { label: 'Close', onClick: (close) => close() },
      { label: 'Look again', onClick: () => { if (!working) draw(); } },
      { label: 'Relink', primary: true, onClick: () => { if (!working) relink(); } },
    ],
  });
  await draw();
}
