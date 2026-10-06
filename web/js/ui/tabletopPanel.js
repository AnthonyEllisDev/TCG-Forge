/*
 * Tabletop dialog — the UI over core/tabletop.js.
 *
 * Pick the cards, pick a back, write deck sheets a virtual tabletop can
 * import. Like the print dialog, drawing a project's cards borrows the canvas
 * the way a batch run does; everything after that is composition of finished
 * images.
 */

import { downloadURL, el, on, slugify } from '../util/dom.js';
import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { cardList, cardQuantities, renderCards } from '../core/cards.js';
import { isRendering } from '../core/batch.js';
import { DECK_FILE, expandByQuantity } from '../core/printSheet.js';
import {
  CARDS_PER_SHEET,
  TABLETOP_FILE,
  buildTabletopManifest,
  buildTabletopSheets,
  planTabletop,
} from '../core/tabletop.js';
import { imageFileName, listExportFolders, listExportImages, loadDeck } from './printPanel.js';
import { openModal, toast } from './dialogs.js';

const JPEG_QUALITY = 0.9;

let busy = false;

export function initTabletopPanel() {
  on(document, 'click', (e) => {
    if (e.target.closest('[data-action="tabletop"]')) openTabletopDialog();
  });
}

export function openTabletopDialog() {
  const source = el('select', { id: 'tabletopSource' });
  source.append(
    el('option', { value: 'project', text: `The cards in this project (${cardList().length})` }),
    el('option', { value: 'folder', text: 'A folder in workspace/exports' })
  );
  const folder = el('select', { id: 'tabletopFolder' });
  folder.append(el('option', { value: '', text: 'exports/ …' }));
  const back = el('select', { id: 'tabletopBack' });
  back.append(el('option', { value: '', text: 'None — set a back in the table' }));
  const useQty = el('input', { type: 'checkbox', id: 'tabletopUseQty', checked: true });

  const fit = el('div', { class: 'hint', id: 'tabletopFit' });
  const status = el('div', { class: 'hint', id: 'tabletopStatus', text: 'Choose the cards and press Preview.' });
  const preview = el('div', { class: 'batch-preview' });

  const folderRow = el('label', { class: 'field' }, [el('span', { text: 'Folder' }), folder]);
  const qtyRow = el('label', { class: 'check' }, [useQty, ' Repeat each card by its copies']);

  let deck = null;
  let deckToken = 0;

  /* How many cards, and so how many sheets, is known before anything is
     drawn for a project; a folder's count waits for its listing. */
  async function describe() {
    const token = (deckToken += 1);
    folderRow.hidden = source.value !== 'folder';
    fit.className = 'hint';
    let count = 0;
    let note = '';
    if (source.value === 'project') {
      deck = null;
      const counts = cardQuantities();
      count = useQty.checked ? counts.reduce((n, qty) => n + qty, 0) : counts.length;
      useQty.disabled = counts.every((qty) => qty === 1);
    } else {
      if (!folder.value) {
        fit.textContent = 'Pick a folder of rendered cards — a batch run or Export → Every card leaves one.';
        return;
      }
      const [images, found] = await Promise.all([
        listExportImages(folder.value).catch(() => []),
        loadDeck(folder.value),
      ]);
      if (token !== deckToken) return;
      deck = found;
      useQty.disabled = !deck;
      if (deck && useQty.checked) {
        const names = new Set(images.map(imageFileName));
        count = deck.filter((card) => names.has(card.file)).reduce((n, card) => n + card.qty, 0);
        note = ` · copies from ${DECK_FILE}`;
      } else {
        count = images.length;
      }
    }
    if (!count) {
      fit.textContent = 'No cards to lay out.';
      return;
    }
    try {
      const plan = planTabletop({ count, cardWidth: state.card.width, cardHeight: state.card.height });
      const grids = plan.sheets.map((sheet) => `${sheet.columns} × ${sheet.rows}`);
      fit.textContent =
        `${count} cards → ${plan.sheets.length} sheet${plan.sheets.length === 1 ? '' : 's'}` +
        ` (${[...new Set(grids)].join(', ')})${note}`;
    } catch (err) {
      fit.className = 'hint warn';
      fit.textContent = err.message;
    }
  }
  for (const node of [source, folder, useQty]) on(node, 'change', describe);
  describe();

  const body = el('div', { class: 'stack' }, [
    el('div', { class: 'subgroup' }, [
      el('h3', { text: '1 · Cards' }),
      el('div', { class: 'field-row' }, [
        el('label', { class: 'field' }, [el('span', { text: 'Source' }), source]),
        folderRow,
      ]),
      qtyRow,
      fit,
    ]),
    el('div', { class: 'subgroup' }, [
      el('h3', { text: '2 · Back' }),
      el('div', { class: 'field-row' }, [
        el('label', { class: 'field' }, [el('span', { text: 'Back from' }), back]),
      ]),
      el('p', {
        class: 'hint',
        text: 'The first image in the folder is written beside the sheets as back.png, and also fills the last slot of each sheet — the face other players see while a card is in your hand.',
      }),
    ]),
    el('div', { class: 'subgroup' }, [
      el('h3', { text: '3 · Output' }),
      el('p', {
        class: 'hint',
        text: `Up to ${CARDS_PER_SHEET} cards per sheet, ten across and seven down at most, no more than 4096 px on a side. ` +
          'In Tabletop Simulator: Objects → Components → Cards → Custom Deck, then give each sheet\'s Width, Height and Number as listed below. ' +
          (api.online
            ? `Sheets, the back and ${TABLETOP_FILE} are written into workspace/exports.`
            : 'Without the local server each file downloads separately.'),
      }),
      status,
      preview,
    ]),
  ]);

  openModal({
    title: 'Tabletop deck sheets',
    wide: true,
    body,
    canClose: () => !isRendering() || 'Still drawing the cards — close the dialog once they are done.',
    buttons: [
      { label: 'Close', onClick: (close) => close() },
      { label: 'Preview', onClick: () => run({ previewOnly: true }) },
      { label: 'Make deck sheets', primary: true, onClick: () => run({ previewOnly: false }) },
    ],
  });

  listExportFolders().then((folders) => {
    for (const entry of folders) {
      folder.append(el('option', { value: entry.path, text: entry.name }));
      back.append(el('option', { value: entry.path, text: entry.name }));
    }
    if (folders.length) folder.value = folders[0].path;
    describe();
  });

  /* ------------------------------------------------------------------ run */

  async function cardURLs() {
    if (source.value === 'folder') {
      if (!folder.value) throw new Error('pick a folder of rendered cards first');
      const urls = await listExportImages(folder.value);
      if (!urls.length) throw new Error(`no images in ${folder.value}`);
      if (!deck || !useQty.checked) return urls;
      const byName = new Map(urls.map((url) => [imageFileName(url), url]));
      const present = deck.filter((card) => byName.has(card.file));
      if (!present.length) throw new Error(`${DECK_FILE} in ${folder.value} names none of the images that are there`);
      return expandByQuantity(present.map((card) => byName.get(card.file)), present.map((card) => card.qty));
    }
    // A table rounds its own corners; a rounded render would leave the sheet's
    // black showing in them.
    const counts = cardQuantities();
    const urls = await renderCards({
      multiplier: 1,
      squareCorners: true,
      onProgress: ({ index, total }) => {
        status.textContent = `Drawing cards… ${index + 1} / ${total}`;
      },
    });
    return useQty.checked ? expandByQuantity(urls, counts) : urls;
  }

  async function backURL() {
    if (!back.value) return null;
    const urls = await listExportImages(back.value);
    if (!urls.length) throw new Error(`no images in ${back.value}`);
    return urls[0];
  }

  async function run({ previewOnly }) {
    if (busy) return;
    busy = true;
    try {
      status.className = 'hint';
      status.textContent = 'Loading cards…';
      const stem = slugify(
        source.value === 'folder' ? folder.value.split('/').pop() : state.project.name,
        'deck'
      );
      const urls = await cardURLs();
      const built = await buildTabletopSheets(urls, {
        back: await backURL(),
        onProgress: ({ loaded, total }) => {
          status.textContent = `Loading cards… ${loaded} / ${total}`;
        },
      });

      preview.innerHTML = '';
      preview.append(
        el('img', {
          src: built.sheets[0].canvas.toDataURL('image/jpeg', 0.7),
          alt: `Sheet 1 of ${built.sheets.length}`,
        })
      );
      const lines = built.sheets.map(
        (sheet, i) => `Sheet ${i + 1}: Width ${sheet.columns}, Height ${sheet.rows}, Number ${sheet.number}`
      );
      const summary =
        `${built.total} cards at ${built.cell.width} × ${built.cell.height} px · ${lines.join(' · ')}`;

      if (previewOnly) {
        status.textContent = summary;
        return;
      }
      status.textContent = 'Writing sheets…';
      const where = await writeSheets(built, stem);
      status.textContent = `${summary} → ${where}`;
      toast(`Deck sheets ready: ${where}`, 'ok', 5000);
    } catch (err) {
      status.className = 'hint warn';
      status.textContent = `Deck sheets failed: ${err.message}`;
    } finally {
      busy = false;
    }
  }
}

/* ---------------------------------------------------------------- output -- */

/**
 * Write each sheet, the back and the manifest into one folder. The folder is
 * overwritten each time, like an export of every card, so the manifest always
 * describes this run.
 */
async function writeSheets(built, stem) {
  const folder = `${stem}-tabletop`;
  const files = built.sheets.map((_, i) =>
    built.sheets.length === 1 ? `${stem}.jpg` : `${stem}-${i + 1}.jpg`
  );
  const outputs = built.sheets.map((sheet, i) => ({
    filename: files[i],
    dataURL: sheet.canvas.toDataURL('image/jpeg', JPEG_QUALITY),
  }));
  if (built.hidden) {
    const canvas = document.createElement('canvas');
    canvas.width = built.cell.width;
    canvas.height = built.cell.height;
    canvas.getContext('2d').drawImage(built.hidden, 0, 0, canvas.width, canvas.height);
    outputs.push({ filename: 'back.png', dataURL: canvas.toDataURL('image/png') });
  }
  const manifest = buildTabletopManifest(stem, built, files, built.hidden ? 'back.png' : null);

  if (!api.online) {
    for (const { filename, dataURL } of outputs) downloadURL(dataURL, filename);
    return `${outputs.length} downloads`;
  }
  let dir = `exports/${folder}`;
  for (const { filename, dataURL } of outputs) {
    const res = await api.exportImage({ filename, dataURL, folder, overwrite: true });
    dir = res.path.split('/').slice(0, -1).join('/');
  }
  await api.writeJSON(`${dir}/${TABLETOP_FILE}`, manifest);
  return dir;
}
