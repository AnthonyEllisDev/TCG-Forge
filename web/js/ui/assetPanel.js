/*
 * Asset library panel — thumbnail browser over the workspace asset folders,
 * with click-to-place, drag-to-canvas and file import.
 */

import { $, $$, bytes, el, on } from '../util/dom.js';
import { bus, EVT } from '../util/bus.js';
import { api } from '../core/api.js';
import { assets } from '../core/assets.js';
import { editor } from '../core/editor.js';
import { state } from '../core/state.js';
import { setFieldImage } from '../core/templates.js';
import { openModal, toast } from './dialogs.js';

let category = 'frames';
let query = '';

export function initAssetPanel() {
  category = state.settings.assetCategory || 'frames';
  $$('#assetTabs .tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.cat === category);
    on(tab, 'click', () => {
      category = tab.dataset.cat;
      state.set('assetCategory', category);
      $$('#assetTabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
      render();
    });
  });

  on($('#assetSearch'), 'input', (e) => {
    query = e.target.value;
    render();
  });

  on(document, 'click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'reload-assets') refresh();
    else if (action === 'import-asset') $('#assetFileInput').click();
    else if (action === 'reveal-workspace') showWorkspacePath();
  });

  on($('#assetFileInput'), 'change', async (e) => {
    const files = e.target.files;
    if (!files?.length) return;
    try {
      const imported = await assets.importFiles(files, category === 'fonts' ? 'fonts' : category);
      toast(`Imported ${imported.length} file${imported.length === 1 ? '' : 's'} into ${category}.`, 'ok');
    } catch (err) {
      toast(`Import failed: ${err.message}`, 'err');
    }
    e.target.value = '';
    render();
  });

  bus.on(EVT.ASSETS, render);
  initCanvasDrop();
  render();
}

export async function refresh() {
  await assets.refresh();
  render();
}

/* ---------------------------------------------------------------- render */

function render() {
  const grid = $('#assetGrid');
  if (!grid) return;
  const items = assets.list(category, query);
  grid.innerHTML = '';

  if (!items.length) {
    grid.append(
      el('div', {
        class: 'grid-empty',
        html: api.online
          ? `Nothing in <b>assets/${category}</b> yet.<br>Drop files into that folder and press ⟳, or use Import.`
          : 'Running without the local server — use Import to load files for this session.',
      })
    );
    updateMeta(0);
    return;
  }

  for (const item of items) {
    const cell = el('div', {
      class: 'asset-cell',
      draggable: 'true',
      title: `${item.name}${item.group ? ` · ${item.group}` : ''}\n${item.file || ''}`,
    });

    if (category === 'fonts') {
      cell.append(el('span', { class: 'font-chip', text: 'Aa', style: `font-family:"${item.name}"` }));
    } else {
      cell.append(el('img', { src: item.url || api.fileURL(item.path), loading: 'lazy', alt: item.name }));
    }
    cell.append(el('span', { class: 'cell-name', text: item.name }));

    cell.addEventListener('click', () => placeAsset(item));
    cell.addEventListener('mouseenter', () => updateMeta(items.length, item));
    cell.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(
        'application/x-tcg-asset',
        JSON.stringify({ ...item, category })
      );
      e.dataTransfer.effectAllowed = 'copy';
    });

    grid.append(cell);
  }
  updateMeta(items.length);
}

function updateMeta(count, item) {
  const meta = $('#assetMeta');
  if (!meta) return;
  if (item) {
    meta.textContent = `${item.file || item.name}${item.size ? ` · ${bytes(item.size)}` : ''}`;
  } else {
    meta.textContent = `${count} item${count === 1 ? '' : 's'} in ${category}`;
  }
}

/* ----------------------------------------------------------------- place */

export async function placeAsset(item, dropPoint = null) {
  const cat = item.category || category;
  const url = item.url || api.fileURL(item.path);

  if (cat === 'fonts') {
    const target = editor.selection().filter((o) => o.type === 'textbox' || o.type === 'i-text');
    if (!target.length) {
      toast(`“${item.name}” is ready to use — pick it in Typography.`, 'info');
      return null;
    }
    target.forEach((o) => o.set('fontFamily', item.name));
    editor.canvas.requestRenderAll();
    editor.touch();
    toast(`Applied ${item.name} to ${target.length} text layer${target.length === 1 ? '' : 's'}.`, 'ok');
    return null;
  }

  const { width: W, height: H } = state.card;

  try {
    if (cat === 'frames') {
      const img = await editor.addImage(url, {
        assetPath: item.path,
        tcgKind: 'frame',
        tcgName: `Frame: ${item.name}`,
        center: false,
      });
      img.set({ scaleX: W / img.width, scaleY: H / img.height, left: 0, top: 0 });
      img.setCoords();
      editor.canvas.bringObjectToFront(img);
      editor.canvas.requestRenderAll();
      return img;
    }

    if (cat === 'backgrounds' || cat === 'textures') {
      const img = await editor.addImage(url, {
        assetPath: item.path,
        tcgKind: 'background',
        tcgName: `${cat === 'textures' ? 'Texture' : 'Background'}: ${item.name}`,
        center: false,
      });
      const scale = Math.max(W / img.width, H / img.height);
      img.set({
        scaleX: scale,
        scaleY: scale,
        left: (W - img.width * scale) / 2,
        top: (H - img.height * scale) / 2,
      });
      img.setCoords();
      editor.canvas.sendObjectToBack(img);
      editor.canvas.requestRenderAll();
      return img;
    }

    if (cat === 'icons') {
      const img = await editor.addImage(url, {
        assetPath: item.path,
        tcgKind: 'icon',
        tcgName: `Icon: ${item.name}`,
        center: !dropPoint,
      });
      const target = W * 0.14;
      img.scaleToWidth(target);
      if (dropPoint) {
        img.set({ left: dropPoint.x - target / 2, top: dropPoint.y - img.getScaledHeight() / 2 });
      }
      img.setCoords();
      editor.canvas.requestRenderAll();
      return img;
    }

    /* artwork: drop straight into the art slot when the template has one */
    if (editor.findBySlot('art').length) {
      return await setFieldImage('art', url, { assetPath: item.path });
    }
    const img = await editor.addImage(url, {
      assetPath: item.path,
      tcgKind: 'art',
      tcgName: item.name,
      center: !dropPoint,
    });
    if (dropPoint) {
      img.set({
        left: dropPoint.x - img.getScaledWidth() / 2,
        top: dropPoint.y - img.getScaledHeight() / 2,
      });
      img.setCoords();
      editor.canvas.requestRenderAll();
    }
    return img;
  } catch (err) {
    toast(`Could not place ${item.name}: ${err.message}`, 'err');
    return null;
  }
}

/* ------------------------------------------------------------- canvas DnD */

function initCanvasDrop() {
  const scroll = $('#canvasScroll');
  if (!scroll) return;

  const pointOf = (e) => {
    const rect = editor.canvas.upperCanvasEl.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / editor.zoom,
      y: (e.clientY - rect.top) / editor.zoom,
    };
  };

  scroll.addEventListener('dragover', (e) => {
    e.preventDefault();
    scroll.classList.add('drop-target');
  });
  scroll.addEventListener('dragleave', () => scroll.classList.remove('drop-target'));

  scroll.addEventListener('drop', async (e) => {
    e.preventDefault();
    scroll.classList.remove('drop-target');
    const point = pointOf(e);

    const payload = e.dataTransfer.getData('application/x-tcg-asset');
    if (payload) {
      try {
        await placeAsset(JSON.parse(payload), point);
      } catch (err) {
        toast(`Drop failed: ${err.message}`, 'err');
      }
      return;
    }

    const files = Array.from(e.dataTransfer.files || []).filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    try {
      for (const file of files) {
        const source = await assets.sourceForFile(file, category === 'fonts' ? 'art' : category);
        const img = await editor.addImage(source.url, {
          assetPath: source.path,
          tcgName: file.name.replace(/\.[^.]+$/, ''),
          center: false,
        });
        img.set({
          left: point.x - img.getScaledWidth() / 2,
          top: point.y - img.getScaledHeight() / 2,
        });
        img.setCoords();
      }
    } catch (err) {
      toast(`Could not place dropped files: ${err.message}`, 'err');
      return;
    }
    editor.canvas.requestRenderAll();
    toast(`Placed ${files.length} image${files.length === 1 ? '' : 's'} and added them to your library.`, 'ok');
  });
}

/* --------------------------------------------------------------- helpers */

function showWorkspacePath() {
  const root = api.workspacePath || '(running without the local server)';
  openModal({
    title: 'Workspace folder',
    body: el('div', { class: 'stack' }, [
      el('p', { class: 'hint', text: 'Drop your own frames, icons, backgrounds and fonts into these folders, then press ⟳ in the Asset Library.' }),
      el('div', { class: 'path', text: root }),
      el('div', { class: 'kv' }, [
        el('span', { text: 'Frames' }), el('span', { class: 'path', text: 'assets/frames' }),
        el('span', { text: 'Backgrounds' }), el('span', { class: 'path', text: 'assets/backgrounds' }),
        el('span', { text: 'Icons' }), el('span', { class: 'path', text: 'assets/icons' }),
        el('span', { text: 'Artwork' }), el('span', { class: 'path', text: 'assets/art' }),
        el('span', { text: 'Textures' }), el('span', { class: 'path', text: 'assets/textures' }),
        el('span', { text: 'Fonts (.ttf/.otf)' }), el('span', { class: 'path', text: 'assets/fonts' }),
      ]),
    ]),
    buttons: [{ label: 'Close', primary: true, onClick: (close) => close() }],
  });
}
