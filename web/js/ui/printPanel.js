/*
 * Print sheet dialog — the UI over core/printSheet.js.
 *
 * Pick what to lay out, pick a page, look at the preview, write the sheets.
 * Everything it composes is already-rendered images, so nothing in here can
 * reach the card you are editing.
 */

import { downloadURL, el, on, slugify } from '../util/dom.js';
import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { editor } from '../core/editor.js';
import {
  BACK_MODES,
  CUT_GUIDES,
  DECK_FILE,
  FLIP_EDGES,
  PAGE_SIZES,
  buildSheets,
  expandByQuantity,
  parseDeck,
  planSheet,
} from '../core/printSheet.js';
import { buildPDF, dataURLToBytes, pdfDataURL } from '../core/pdf.js';
import { openModal, toast } from './dialogs.js';

const JPEG_QUALITY = 0.94;

let busy = false;

export function initPrintPanel() {
  on(document, 'click', (e) => {
    if (e.target.closest('[data-action="print-sheet"]')) openPrintDialog();
  });
}

/* --------------------------------------------------------------- helpers -- */

/** Folders under workspace/exports, which is where a batch run leaves a set. */
async function listExportFolders() {
  if (!api.online) return [];
  try {
    const data = await api.request('/api/list?path=exports');
    return (data.entries || []).filter((entry) => entry.dir);
  } catch {
    return [];
  }
}

/**
 * Read the deck list a batch run leaves beside its cards, if there is one.
 *
 * Its absence is the normal case and not an error: a folder of images with no
 * list is simply one of each.
 */
async function loadDeck(path) {
  try {
    return parseDeck(await api.readJSON(`${path}/${DECK_FILE}`));
  } catch {
    return null;
  }
}

async function listExportImages(path) {
  const data = await api.request(`/api/list?path=${encodeURIComponent(path)}`);
  return (data.entries || [])
    .filter((entry) => !entry.dir && /\.(png|jpe?g|webp)$/i.test(entry.name))
    .map((entry) => api.fileURL(entry.path));
}

function num(node, fallback) {
  const value = parseFloat(node.value);
  return Number.isFinite(value) ? value : fallback;
}

/* ---------------------------------------------------------------- dialog -- */

export function openPrintDialog() {
  /* The dialog's controls are named, so anything driving them — a test, a
     future preset — can ask for one by what it is. */
  const source = el('select', { id: 'printSource' });
  source.append(
    el('option', { value: 'card', text: 'The current card, repeated' }),
    el('option', { value: 'folder', text: 'A folder in workspace/exports' })
  );
  const copies = el('input', { type: 'number', id: 'printCopies', min: '1', max: '500', value: '9' });
  const folder = el('select', { id: 'printFolder' });
  folder.append(el('option', { value: '', text: 'exports/ …' }));

  const page = el('select', { id: 'printPage' });
  for (const [key, size] of Object.entries(PAGE_SIZES)) {
    page.append(el('option', { value: key, text: size.label }));
  }
  const orientation = el('select', { id: 'printOrientation' });
  orientation.append(
    el('option', { value: 'portrait', text: 'Portrait' }),
    el('option', { value: 'landscape', text: 'Landscape' })
  );
  const guides = el('select', { id: 'printGuides' });
  for (const [key, label] of Object.entries(CUT_GUIDES)) {
    guides.append(el('option', { value: key, text: label }));
  }
  const margin = el('input', { type: 'number', min: '0', max: '40', step: '0.5', value: '6' });
  const gap = el('input', { type: 'number', min: '0', max: '40', step: '0.5', value: '0' });
  const bleed = el('input', { type: 'number', min: '0', max: '10', step: '0.5', value: '0' });
  const dpi = el('select');
  for (const value of [150, 300, 600]) {
    dpi.append(el('option', { value: String(value), text: `${value} dpi` }));
  }
  dpi.value = '300';

  /* --- backs --- */
  const backMode = el('select', { id: 'printBackMode' });
  for (const [key, label] of Object.entries(BACK_MODES)) {
    backMode.append(el('option', { value: key, text: label }));
  }
  const backFolder = el('select', { id: 'printBackFolder' });
  backFolder.append(el('option', { value: '', text: 'exports/ …' }));
  const flipEdge = el('select', { id: 'printFlipEdge' });
  for (const [key, label] of Object.entries(FLIP_EDGES)) {
    flipEdge.append(el('option', { value: key, text: label }));
  }
  const shiftX = el('input', { type: 'number', min: '-10', max: '10', step: '0.1', value: '0' });
  const shiftY = el('input', { type: 'number', min: '-10', max: '10', step: '0.1', value: '0' });
  const pageLabels = el('input', { type: 'checkbox', id: 'printPageLabels' });

  const format = el('select', { id: 'printFormat' });
  format.append(
    el('option', { value: 'pdf', text: 'PDF — one file, real page size' }),
    el('option', { value: 'png', text: 'PNG — one file per page' })
  );

  /* Ids so the readouts can be found by what they are rather than by where
     they happen to sit in the dialog. */
  const fit = el('div', { class: 'hint', id: 'printFit' });
  const status = el('div', { class: 'hint', id: 'printStatus', text: 'Choose a source and press Preview.' });
  const preview = el('div', { class: 'batch-preview' });

  const useQty = el('input', { type: 'checkbox', id: 'printUseQty', checked: true });
  const deckHint = el('p', { class: 'hint', id: 'printDeckHint' });

  const folderRow = el('label', { class: 'field' }, [el('span', { text: 'Folder' }), folder]);
  const copiesRow = el('label', { class: 'field' }, [el('span', { text: 'Copies' }), copies]);
  const qtyRow = el('label', { class: 'check' }, [useQty, ' Repeat each card by its deck quantity']);
  const backFolderRow = el('label', { class: 'field' }, [el('span', { text: 'Backs from' }), backFolder]);
  const flipRow = el('label', { class: 'field' }, [el('span', { text: 'Printer flips on' }), flipEdge]);
  const shiftRow = el('div', { class: 'field-row' }, [
    el('label', { class: 'field' }, [el('span', { text: 'Back shift X (mm)' }), shiftX]),
    el('label', { class: 'field' }, [el('span', { text: 'Back shift Y (mm)' }), shiftY]),
  ]);
  const backHint = el('p', { class: 'hint' });

  /* The deck list belongs to the folder, so it is looked up when the folder
     changes rather than when the sheets are built — otherwise the first the
     user hears of forty cards is forty cards. */
  let deck = null;
  let deckToken = 0;
  async function syncDeck() {
    const isFolder = source.value === 'folder';
    qtyRow.hidden = !isFolder;
    deckHint.hidden = !isFolder;
    // The listing populating the folder select and the user changing it can
    // both land here, so a slower lookup must not overwrite a newer one.
    const token = (deckToken += 1);
    const found = isFolder && folder.value ? await loadDeck(folder.value) : null;
    if (token !== deckToken) return;
    deck = found;
    useQty.disabled = !deck;
    if (!isFolder) return;
    deckHint.textContent = deck
      ? `${DECK_FILE} in this folder asks for ${deck.reduce((n, c) => n + c.qty, 0)} cards ` +
        `from ${deck.length} designs. Untick to print one of each instead.`
      : `No ${DECK_FILE} here — one of each. Map a quantity column in the batch dialog ` +
        'to have a run write one.';
  }

  const syncSource = () => {
    const isFolder = source.value === 'folder';
    folderRow.hidden = !isFolder;
    copiesRow.hidden = isFolder;
  };
  on(source, 'change', () => {
    syncSource();
    syncDeck();
    describe();
  });
  on(folder, 'change', () => {
    syncDeck();
    describe();
  });
  syncSource();
  syncDeck();

  const syncBacks = () => {
    const mode = backMode.value;
    const duplex = mode === 'duplex';
    backFolderRow.hidden = mode === 'off';
    flipRow.hidden = !duplex;
    shiftRow.hidden = !duplex;
    backHint.hidden = mode === 'off';
    backHint.textContent = duplex
      ? 'Print the pages in order, both sides. If the backs land on the wrong cards the printer flips on the other edge; if they are a millimetre or two out, nudge them with the shift boxes.'
      : 'Fronts print below the fold and backs above it, upside down. Fold on the dashed line, glue the halves together, then cut — backs line up every time, at half the cards per sheet.';
    // One sheet of paper now carries two pages of output, so say which is which.
    if (mode !== 'off') pageLabels.checked = true;
  };
  on(backMode, 'change', () => {
    syncBacks();
    describe();
  });
  syncBacks();

  /* Every geometry control changes how many cards fit, so say so immediately
     rather than making the user press Preview to find out. */
  function currentPlan() {
    return planSheet({
      cardWidth: state.card.width,
      cardHeight: state.card.height,
      cardDpi: state.card.dpi || 300,
      page: page.value,
      landscape: orientation.value === 'landscape',
      dpi: Number(dpi.value),
      marginMm: num(margin, 6),
      gapMm: num(gap, 0),
      bleedMm: num(bleed, 0),
      backMode: backMode.value,
      flipEdge: flipEdge.value,
      shiftXMm: num(shiftX, 0),
      shiftYMm: num(shiftY, 0),
    });
  }

  function describe() {
    try {
      const plan = currentPlan();
      const [w, h] = plan.trimInches;
      const sides = { off: '', duplex: ' · double-sided', gutterfold: ' · gutterfold' };
      fit.className = 'hint';
      fit.textContent =
        `${plan.cols} × ${plan.rows} = ${plan.perPage} cards per ${plan.label}` +
        ` · each ${w.toFixed(2)} × ${h.toFixed(2)} in` +
        ` · sheet ${plan.pageWidth} × ${plan.pageHeight} px` +
        sides[plan.backMode];
    } catch (err) {
      fit.className = 'hint warn';
      fit.textContent = err.message;
    }
  }
  for (const node of [page, orientation, margin, gap, bleed, dpi, flipEdge, shiftX, shiftY]) {
    on(node, 'change', describe);
    on(node, 'input', describe);
  }
  describe();

  const body = el('div', { class: 'stack' }, [
    el('div', { class: 'subgroup' }, [
      el('h3', { text: '1 · What to print' }),
      el('div', { class: 'field-row' }, [
        el('label', { class: 'field' }, [el('span', { text: 'Source' }), source]),
        copiesRow,
        folderRow,
      ]),
      qtyRow,
      deckHint,
    ]),
    el('div', { class: 'subgroup' }, [
      el('h3', { text: '2 · Page' }),
      el('div', { class: 'field-row' }, [
        el('label', { class: 'field' }, [el('span', { text: 'Paper' }), page]),
        el('label', { class: 'field' }, [el('span', { text: 'Orientation' }), orientation]),
      ]),
      el('div', { class: 'field-row' }, [
        el('label', { class: 'field' }, [el('span', { text: 'Margin (mm)' }), margin]),
        el('label', { class: 'field' }, [el('span', { text: 'Gap (mm)' }), gap]),
        el('label', { class: 'field' }, [el('span', { text: 'Bleed (mm)' }), bleed]),
      ]),
      el('div', { class: 'field-row' }, [
        el('label', { class: 'field' }, [el('span', { text: 'Cut guides' }), guides]),
        el('label', { class: 'field' }, [el('span', { text: 'Resolution' }), dpi]),
      ]),
      fit,
      el('p', {
        class: 'hint',
        text: 'Cards are placed at the size their dpi says they are, so print at 100% — never "fit to page". Bleed assumes the source images already carry it; the guides mark the trim line inside it.',
      }),
    ]),
    el('div', { class: 'subgroup' }, [
      el('h3', { text: '3 · Card backs' }),
      el('div', { class: 'field-row' }, [
        el('label', { class: 'field' }, [el('span', { text: 'Both sides' }), backMode]),
        backFolderRow,
      ]),
      el('div', { class: 'field-row' }, [flipRow]),
      shiftRow,
      backHint,
      el('p', {
        class: 'hint',
        text: 'A folder holding one image gives every card the same back; a folder holding one image per card gives each its own, paired in the order the files are listed.',
      }),
    ]),
    el('div', { class: 'subgroup' }, [
      el('h3', { text: '4 · Output' }),
      el('div', { class: 'field-row' }, [
        el('label', { class: 'field' }, [el('span', { text: 'Format' }), format]),
      ]),
      el('label', { class: 'check' }, [pageLabels, ' Number the sheets in the bottom margin']),
      el('p', {
        class: 'hint',
        text: api.online
          ? 'Sheets are written into workspace/exports.'
          : 'Without the local server each sheet downloads separately.',
      }),
      status,
      preview,
    ]),
  ]);

  openModal({
    title: 'Print sheet',
    wide: true,
    body,
    buttons: [
      { label: 'Close', onClick: (close) => close() },
      { label: 'Preview', onClick: () => run({ previewOnly: true }) },
      { label: 'Make sheets', primary: true, onClick: () => run({ previewOnly: false }) },
    ],
  });

  listExportFolders().then((folders) => {
    for (const entry of folders) {
      folder.append(el('option', { value: entry.path, text: entry.name }));
      backFolder.append(el('option', { value: entry.path, text: entry.name }));
    }
    if (folders.length) folder.value = folders[0].path;
    syncDeck();
  });

  /* ------------------------------------------------------------------ run */

  /**
   * The designs to print, and how many of each.
   *
   * `quantities` is null when every card is one of itself, which keeps the
   * ordinary path exactly as it was.
   */
  async function sourceDesigns(plan) {
    if (source.value === 'folder') {
      if (!folder.value) throw new Error('pick a folder of rendered cards first');
      const urls = await listExportImages(folder.value);
      if (!urls.length) throw new Error(`no images in ${folder.value}`);
      if (!deck || !useQty.checked) return { urls, quantities: null };

      // The list names files; the folder holds them. Match on the name alone
      // and print what is actually there, so a card deleted from the folder is
      // simply missing rather than fatal.
      const byName = new Map(urls.map((url) => [url.split('/').pop(), url]));
      const present = deck.filter((card) => byName.has(card.file));
      if (!present.length) {
        throw new Error(`${DECK_FILE} in ${folder.value} names none of the images that are there`);
      }
      return {
        urls: present.map((card) => byName.get(card.file)),
        quantities: present.map((card) => card.qty),
      };
    }
    // One render of the current card, reused for every copy: the browser
    // caches the decode, and a data URL costs nothing to repeat.
    const multiplier = Number(dpi.value) / (state.card.dpi || 300);
    const url = editor.toDataURL({ multiplier, format: 'png' });
    const count = Math.max(1, Math.min(500, Math.round(num(copies, plan.perPage))));
    return { urls: Array.from({ length: count }, () => url), quantities: null };
  }

  async function backURLs() {
    if (backMode.value === 'off') return [];
    if (!backFolder.value) throw new Error('pick the folder holding your card backs');
    const urls = await listExportImages(backFolder.value);
    if (!urls.length) throw new Error(`no images in ${backFolder.value}`);
    return urls;
  }

  async function run({ previewOnly }) {
    if (busy) return;
    busy = true;
    try {
      const plan = currentPlan();
      status.className = 'hint';
      status.textContent = 'Loading cards…';
      const stem = slugify(
        source.value === 'folder' ? folder.value.split('/').pop() : state.project.name,
        'print-sheet'
      );
      const designs = await sourceDesigns(plan);
      const backs = await backURLs();

      // Backs pair against designs and are then repeated with them, so "one
      // back per card" keeps meaning one per design rather than one per copy.
      const urls = designs.quantities
        ? expandByQuantity(designs.urls, designs.quantities)
        : designs.urls;
      const pairedBacks =
        designs.quantities && backs.length === designs.urls.length
          ? expandByQuantity(backs, designs.quantities)
          : backs;

      const pages = await buildSheets(urls, plan, {
        backs: pairedBacks,
        guides: guides.value,
        pageLabel: pageLabels.checked ? stem : '',
        onProgress: ({ loaded, total }) => {
          status.textContent = `Loading cards… ${loaded} / ${total}`;
        },
      });

      preview.innerHTML = '';
      preview.append(
        el('img', {
          src: pages[0].canvas.toDataURL('image/jpeg', 0.7),
          alt: `Page 1 of ${pages.length}`,
        })
      );

      const summary =
        `${pages.length} page${pages.length === 1 ? '' : 's'} · ${urls.length} cards` +
        (designs.quantities ? ` from ${designs.urls.length} designs` : '') +
        (plan.backMode === 'duplex' ? ' · fronts and backs interleaved' : '');

      if (previewOnly) {
        status.textContent = `${summary} · showing page 1`;
        return;
      }

      status.textContent = 'Writing sheets…';
      const written =
        format.value === 'pdf'
          ? await writePDF(pages, plan, stem)
          : await writePNGs(pages, stem);

      status.textContent = `${summary} → ${written}`;
      toast(`Print sheet ready: ${written}`, 'ok', 5000);
    } catch (err) {
      status.className = 'hint warn';
      status.textContent = `Print sheet failed: ${err.message}`;
    } finally {
      busy = false;
    }
  }
}

/* ---------------------------------------------------------------- output -- */

async function writePDF(pages, plan, stem) {
  const [widthPt, heightPt] = plan.pagePoints;
  const pdf = buildPDF(
    pages.map(({ canvas }) => ({
      jpeg: dataURLToBytes(canvas.toDataURL('image/jpeg', JPEG_QUALITY)),
      pixelWidth: canvas.width,
      pixelHeight: canvas.height,
      widthPt,
      heightPt,
    })),
    { title: `${stem} print sheet` }
  );

  const dataURL = pdfDataURL(pdf);
  const filename = `${stem}-sheets.pdf`;
  if (api.online) {
    const res = await api.exportImage({ filename, dataURL, folder: 'print' });
    return res.path;
  }
  downloadURL(dataURL, filename);
  return filename;
}

async function writePNGs(pages, stem) {
  const written = [];
  let sheet = 0;
  for (let i = 0; i < pages.length; i += 1) {
    // A front and its back belong to the same sheet of paper, so they share a
    // number and differ by their side — the order to feed the printer in.
    if (pages[i].side !== 'back') sheet += 1;
    const side = pages[i].side === 'front' ? '' : `-${pages[i].side}`;
    const dataURL = pages[i].canvas.toDataURL('image/png');
    const filename = `${stem}-sheet-${String(sheet).padStart(2, '0')}${side}.png`;
    if (api.online) {
      const res = await api.exportImage({ filename, dataURL, folder: 'print' });
      written.push(res.path);
    } else {
      downloadURL(dataURL, filename);
      written.push(filename);
    }
  }
  return written.length === 1 ? written[0] : `${written.length} files in exports/print`;
}
