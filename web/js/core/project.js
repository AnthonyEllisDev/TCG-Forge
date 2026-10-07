/*
 * Project files: serialise the card, write it to the workspace (or download
 * it when running without the backend), and export finished images.
 */

import { api } from './api.js';
import { bus, EVT } from '../util/bus.js';
import { state } from './state.js';
import { editor } from './editor.js';
import { history } from './history.js';
import { forEachImageJSON, isImageJSON, toLayoutJSON } from './objects.js';
import { bleedPixels, mirrorBleed } from './bleed.js';
import { loadCards, resetCards, serializeCards, settled, slotKinds } from './cards.js';
import { downloadText, downloadURL, slugify } from '../util/dom.js';

export const PROJECT_FORMAT = 'tcgforge.project';
/* 2 (0.7.0) added `cards` and `activeCard`. A version-1 file has neither and
   opens as a project of one card; `canvas` means the same in both. */
export const PROJECT_VERSION = 2;

/* ------------------------------------------------------------ serialise -- */

export async function serializeProject({ embed = state.settings.embedImages, onlyActive = false } = {}) {
  // The file's canvas is the layout; what the card on screen changed for
  // itself goes with that card, in the list.
  const canvas = toLayoutJSON(editor.toJSON());
  // Taken in the same tick as the canvas: embedding awaits every picture, and
  // a card switch that starts meanwhile would move the active card under it.
  const { cards, activeCard } = serializeCards({ onlyActive });
  if (embed) await embedImageSources(canvas);
  else dereferenceImages(canvas);
  if (embed) await embedCardImages(cards);

  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name: state.project.name,
    templateId: state.project.templateId,
    card: { ...state.card },
    fields: state.project.fields || [],
    canvas,
    cards,
    activeCard,
    meta: {
      app: 'TCG Forge',
      embedded: !!embed,
      modified: new Date().toISOString(),
    },
  };
}

/** Replace base64 image data with the workspace path it came from. */
function dereferenceImages(canvasJSON) {
  forEachImageJSON(canvasJSON, (obj) => {
    if (obj.tcgAsset) obj.src = api.fileURL(obj.tcgAsset);
  });
}

/** Inline every image as a data URL so the project file is self-contained. */
async function embedImageSources(canvasJSON) {
  const images = [];
  forEachImageJSON(canvasJSON, (obj) => images.push(obj));
  for (const obj of images) {
    if (!obj.src || obj.src.startsWith('data:')) continue;
    try {
      const res = await fetch(obj.src);
      // A missing file answers with an error page, which would otherwise be
      // embedded as the picture and make the project impossible to open.
      if (!res.ok) throw new Error(`${res.status}`);
      obj.src = await blobToDataURL(await res.blob());
    } catch (err) {
      console.warn('[project] could not embed image', obj.src, err);
      // Not embedded, so it is referenced like any other: by workspace path,
      // which comes back to life when the file does.
      if (obj.tcgAsset) obj.src = api.fileURL(obj.tcgAsset);
    }
  }
}

/** The same for the artwork the other cards name, which is not on the canvas. */
async function embedCardImages(cards) {
  const imageSlots = [...slotKinds()].filter(([, kind]) => kind === 'image').map(([slot]) => slot);
  for (const card of cards) {
    for (const slot of imageSlots) {
      const value = card.values[slot];
      if (!value || String(value).startsWith('data:')) continue;
      try {
        const res = await fetch(api.fileURL(value));
        if (!res.ok) throw new Error(`${res.status}`);
        card.values[slot] = await blobToDataURL(await res.blob());
      } catch (err) {
        console.warn('[project] could not embed image', value, err);
      }
    }
  }
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/* ---------------------------------------------------------------- apply -- */

export async function applyProject(data) {
  if (!data || typeof data !== 'object') throw new Error('Not a TCG Forge project file.');
  if (data.format && data.format !== PROJECT_FORMAT && data.format !== 'tcgforge.template') {
    throw new Error(`Unsupported file format: ${data.format}`);
  }
  // Same window as for templates: a switch that lands after the load would
  // paint the outgoing card over the project just opened.
  await history.settled();
  await settled();
  return editor.replaceCard(() => loadProject(data));
}

async function loadProject(data) {
  Object.assign(state.card, data.card || {});
  state.project.name = data.name || state.project.name;
  state.project.templateId = data.templateId || data.id || null;
  state.project.fields = data.fields || [];

  const canvasJSON = data.canvas || { objects: [], background: state.card.background };
  restoreImagePaths(canvasJSON);
  const missing = await standInForMissingArt(canvasJSON);

  editor.canvas.setDimensions({ width: state.card.width, height: state.card.height });
  await editor.loadJSON(canvasJSON);
  editor.canvas.backgroundColor = canvasJSON.background ?? state.card.background;
  editor.applyCardClip();
  editor.fitToWindow();
  loadCards(data, { missing });

  bus.emit(EVT.CARD, state.card);
  bus.emit(EVT.PROJECT, state.project);
  bus.emit(EVT.OBJECTS, editor.objects());
  history.reset();
  return { missingArt: Object.values(missing) };
}

/*
 * A card's picture that has gone from the workspace (renamed, moved, on
 * another machine) made Fabric refuse the whole file, so the project could not
 * be opened at all until the picture came back. Card switches already show the
 * slot's placeholder for such a picture and keep its path; the card the file
 * opens on now does the same. Other images — a frame, a background — still
 * refuse the file: there is no layer to stand in for them.
 */
async function standInForMissingArt(canvasJSON) {
  const missing = {};
  const objects = Array.isArray(canvasJSON.objects) ? canvasJSON.objects : [];
  await Promise.all(
    objects.map(async (obj, index) => {
      const placeholder = obj?.tcgPlaceholder;
      if (!isImageJSON(obj) || !obj.tcgArtBox || !obj.tcgSlot || !placeholder || typeof placeholder !== 'object') return;
      if (await imageLoads(obj.src)) return;
      objects[index] = placeholder;
      missing[obj.tcgSlot] = obj.tcgAsset || obj.src;
    })
  );
  return missing;
}

function imageLoads(src) {
  if (!src) return Promise.resolve(false);
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = src;
  });
}

function restoreImagePaths(canvasJSON) {
  forEachImageJSON(canvasJSON, (obj) => {
    if (obj.tcgAsset && !String(obj.src || '').startsWith('data:')) {
      obj.src = api.fileURL(obj.tcgAsset);
    }
  });
}

/* ----------------------------------------------------------------- save -- */

/** Where a project of this name is saved when it has no file yet. */
export const projectTarget = (name = state.project.name) => `projects/${slugify(name, 'card')}.json`;

/**
 * Whether saving to `target` would replace a file other than this project's
 * own. A new project, or Save As, goes to a path made from its name, and two
 * projects called the same thing — "Untitled Card" above all — used to
 * overwrite each other without a word.
 */
export async function wouldReplace(target) {
  if (!api.online || target === state.project.path) return false;
  const folder = target.split('/').slice(0, -1).join('/');
  try {
    const data = await api.request(`/api/list?path=${encodeURIComponent(folder)}`);
    return (data.entries || []).some((entry) => entry.path === target && !entry.dir);
  } catch {
    // No folder yet means nothing in it to replace.
    return false;
  }
}

export async function saveProject({ path = state.project.path, name } = {}) {
  if (name) state.project.name = name;
  // A card switch still filling the canvas would be read as the card it is
  // switching to, over that card's own record. Let it land first.
  await settled();
  // Serialising and writing both await, and the editor stays live meanwhile.
  // An edit made in that window is not in the file, so it must not be marked
  // saved — or New and Open would throw it away without asking.
  const revision = state.revision;
  const data = await serializeProject();
  const target = path || projectTarget();
  const settle = () => {
    if (state.revision === revision) state.setDirty(false);
  };

  if (api.online) {
    await api.writeJSON(target, data, { backup: true });
    state.project.path = target;
    settle();
    bus.emit(EVT.PROJECT, state.project);
    return { path: target, saved: 'workspace' };
  }

  downloadText(JSON.stringify(data, null, 2), `${slugify(state.project.name, 'card')}.json`);
  settle();
  return { path: null, saved: 'download' };
}

export async function openProjectPath(path) {
  const data = await api.readJSON(path);
  const { missingArt } = await applyProject(data);
  state.project.path = path;
  state.setDirty(false);
  bus.emit(EVT.PROJECT, state.project);
  return { data, missingArt };
}

export async function openProjectData(data, { path = null } = {}) {
  const { missingArt } = await applyProject(data);
  state.project.path = path;
  state.setDirty(false);
  bus.emit(EVT.PROJECT, state.project);
  return { missingArt };
}

export async function newProject({ width, height, dpi, radius, background, preset } = {}) {
  // A card switch still drawing would finish into the blank card: the last
  // project's art on it, marked saved.
  await history.settled();
  await settled();
  Object.assign(state.card, {
    width: width ?? state.card.width,
    height: height ?? state.card.height,
    dpi: dpi ?? state.card.dpi,
    radius: radius ?? state.card.radius,
    background: background ?? state.card.background,
    preset: preset ?? state.card.preset,
  });
  state.project.name = 'Untitled Card';
  state.project.path = null;
  state.project.templateId = null;
  state.project.fields = [];

  editor.clear();
  editor.canvas.setDimensions({ width: state.card.width, height: state.card.height });
  editor.applyCardClip();
  editor.fitToWindow();
  resetCards();

  bus.emit(EVT.CARD, state.card);
  bus.emit(EVT.PROJECT, state.project);
  bus.emit(EVT.OBJECTS, editor.objects());
  history.reset();
  state.setDirty(false);
}

/* --------------------------------------------------------------- export -- */

function decodeImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not read the rendered card back'));
    img.src = url;
  });
}

/**
 * Render the card on the canvas, `bleedMm` larger on every side.
 *
 * With no bleed this is `editor.toDataURL()` exactly. With bleed the card is
 * drawn with square corners — a shop cuts its own radius, and a rounded
 * corner's transparent pixels would be mirrored into the bleed as notches —
 * and as PNG, so a JPEG is only encoded once, after the edges are added.
 */
export async function renderCard({
  multiplier = 2,
  format = 'png',
  quality = 0.94,
  transparent = false,
  bleedMm = 0,
  squareCorners = false,
} = {}) {
  const bleed = bleedPixels(bleedMm, state.card.dpi || 300, multiplier);
  if (!bleed) return editor.toDataURL({ multiplier, format, quality, transparent, squareCorners });

  const trimmed = editor.toDataURL({ multiplier, format: 'png', transparent, squareCorners: true });
  const canvas = mirrorBleed(await decodeImage(trimmed), bleed);
  if (format === 'jpeg') {
    // JPEG has no transparency; without a backdrop it would turn black.
    const flat = document.createElement('canvas');
    flat.width = canvas.width;
    flat.height = canvas.height;
    const ctx = flat.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, flat.width, flat.height);
    ctx.drawImage(canvas, 0, 0);
    return flat.toDataURL('image/jpeg', quality);
  }
  return canvas.toDataURL('image/png');
}

export async function exportImage({
  multiplier = 2,
  format = 'png',
  transparent = false,
  bleedMm = 0,
  toWorkspace = true,
  filename,
} = {}) {
  // Mid-switch the canvas still shows the card being left.
  await settled();
  const dataURL = await renderCard({ multiplier, format, transparent, bleedMm });
  const ext = format === 'jpeg' ? 'jpg' : format;
  const name = filename || `${slugify(state.project.name, 'card')}.${ext}`;

  if (toWorkspace && api.online) {
    const res = await api.exportImage({ filename: name, dataURL });
    return { saved: 'workspace', path: res.path, absolute: res.absolute, dataURL };
  }

  downloadURL(dataURL, name);
  return { saved: 'download', path: null, dataURL };
}
