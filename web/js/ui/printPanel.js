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
  CUT_GUIDES,
  PAGE_SIZES,
  buildSheets,
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
  const source = el('select');
  source.append(
    el('option', { value: 'card', text: 'The current card, repeated' }),
    el('option', { value: 'folder', text: 'A folder in workspace/exports' })
  );
  const copies = el('input', { type: 'number', min: '1', max: '500', value: '9' });
  const folder = el('select');
  folder.append(el('option', { value: '', text: 'exports/ …' }));

  const page = el('select');
  for (const [key, size] of Object.entries(PAGE_SIZES)) {
    page.append(el('option', { value: key, text: size.label }));
  }
  const orientation = el('select');
  orientation.append(
    el('option', { value: 'portrait', text: 'Portrait' }),
    el('option', { value: 'landscape', text: 'Landscape' })
  );
  const guides = el('select');
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

  const format = el('select');
  format.append(
    el('option', { value: 'pdf', text: 'PDF — one file, real page size' }),
    el('option', { value: 'png', text: 'PNG — one file per page' })
  );

  const fit = el('div', { class: 'hint' });
  const status = el('div', { class: 'hint', text: 'Choose a source and press Preview.' });
  const preview = el('div', { class: 'batch-preview' });

  const folderRow = el('label', { class: 'field' }, [el('span', { text: 'Folder' }), folder]);
  const copiesRow = el('label', { class: 'field' }, [el('span', { text: 'Copies' }), copies]);

  const syncSource = () => {
    const isFolder = source.value === 'folder';
    folderRow.hidden = !isFolder;
    copiesRow.hidden = isFolder;
  };
  on(source, 'change', () => {
    syncSource();
    describe();
  });
  syncSource();

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
    });
  }

  function describe() {
    try {
      const plan = currentPlan();
      const [w, h] = plan.trimInches;
      fit.className = 'hint';
      fit.textContent =
        `${plan.cols} × ${plan.rows} = ${plan.perPage} cards per ${plan.label}` +
        ` · each ${w.toFixed(2)} × ${h.toFixed(2)} in` +
        ` · sheet ${plan.pageWidth} × ${plan.pageHeight} px`;
    } catch (err) {
      fit.className = 'hint warn';
      fit.textContent = err.message;
    }
  }
  for (const node of [page, orientation, margin, gap, bleed, dpi]) {
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
      el('h3', { text: '3 · Output' }),
      el('div', { class: 'field-row' }, [
        el('label', { class: 'field' }, [el('span', { text: 'Format' }), format]),
      ]),
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
    }
    if (folders.length) folder.value = folders[0].path;
  });

  /* ------------------------------------------------------------------ run */

  async function sourceURLs(plan) {
    if (source.value === 'folder') {
      if (!folder.value) throw new Error('pick a folder of rendered cards first');
      const urls = await listExportImages(folder.value);
      if (!urls.length) throw new Error(`no images in ${folder.value}`);
      return urls;
    }
    // One render of the current card, reused for every copy: the browser
    // caches the decode, and a data URL costs nothing to repeat.
    const multiplier = Number(dpi.value) / (state.card.dpi || 300);
    const url = editor.toDataURL({ multiplier, format: 'png' });
    const count = Math.max(1, Math.min(500, Math.round(num(copies, plan.perPage))));
    return Array.from({ length: count }, () => url);
  }

  async function run({ previewOnly }) {
    if (busy) return;
    busy = true;
    try {
      const plan = currentPlan();
      status.className = 'hint';
      status.textContent = 'Loading cards…';
      const urls = await sourceURLs(plan);

      const pages = await buildSheets(urls, plan, {
        guides: guides.value,
        onProgress: ({ loaded, total }) => {
          status.textContent = `Loading cards… ${loaded} / ${total}`;
        },
      });

      preview.innerHTML = '';
      preview.append(
        el('img', {
          src: pages[0].canvas.toDataURL('image/jpeg', 0.7),
          alt: `Sheet 1 of ${pages.length}`,
        })
      );

      if (previewOnly) {
        status.textContent =
          `${pages.length} sheet${pages.length === 1 ? '' : 's'} · ${urls.length} cards · ` +
          `showing sheet 1 of ${pages.length}`;
        return;
      }

      status.textContent = 'Writing sheets…';
      const stem = slugify(
        source.value === 'folder' ? folder.value.split('/').pop() : state.project.name,
        'print-sheet'
      );
      const written =
        format.value === 'pdf'
          ? await writePDF(pages, plan, stem)
          : await writePNGs(pages, stem);

      status.textContent = `${pages.length} sheet${pages.length === 1 ? '' : 's'} → ${written}`;
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
  for (let i = 0; i < pages.length; i += 1) {
    const dataURL = pages[i].canvas.toDataURL('image/png');
    const filename = `${stem}-sheet-${String(i + 1).padStart(2, '0')}.png`;
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
