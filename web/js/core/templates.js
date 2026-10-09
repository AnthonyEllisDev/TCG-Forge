/*
 * Templates — reusable card layouts with named slots.
 *
 * A slot is just a `tcgSlot` string on an object. Every object carrying a slot
 * becomes an editable field in the Card Fields panel, which is what turns a
 * drawing tool into a card maker: load a frame once, then fill in the words.
 */

import { api } from './api.js';
import { bus, EVT } from '../util/bus.js';
import { state } from './state.js';
import { editor } from './editor.js';
import { history } from './history.js';
import {
  CUSTOM_PROPS,
  forEachImageJSON,
  isImageJSON,
  makeArtBox,
  makeImage,
  standInForMissingArt,
  styleObject,
  toLayoutJSON,
} from './objects.js';
import { fitImage } from './effects.js';
import { expandIcons } from './icons.js';
import { resetCards, settled } from './cards.js';
import { slugify } from '../util/dom.js';

export const TEMPLATE_FORMAT = 'tcgforge.template';

export async function listTemplates() {
  if (!api.online) return [];
  return api.listTemplates();
}

export async function loadTemplateFile(path) {
  return api.readJSON(path);
}

/* --------------------------------------------------------------- apply --- */

export async function applyTemplate(data, { keepName = false } = {}) {
  if (!data?.canvas) throw new Error('Template has no canvas data.');
  // A card switch still loading its art would finish writing that card into
  // the template's layout — and put the dirty flag back as it found it, so the
  // stray words looked saved.
  await history.settled();
  await settled();
  return editor.replaceCard(() => loadTemplate(data, { keepName }));
}

async function loadTemplate(data, { keepName }) {
  Object.assign(state.card, data.card || {});
  state.project.templateId = data.id || slugify(data.name, 'template');
  state.project.fields = normaliseFields(data.fields, data.canvas);
  if (!keepName) state.project.name = data.name || state.project.name;
  // A template is somewhere to start, not the project that happened to be open
  // a moment ago. Left pointing at that project's file, the next Save writes
  // this layout straight over it — under a name the top bar has already
  // replaced, so there is nothing on screen to suggest what is about to go.
  state.project.path = null;
  // One card, whatever the project had: the card list is rebuilt from the
  // canvas the first time anything asks for it.
  state.project.cards = null;
  state.project.activeCard = 0;

  const canvasJSON = JSON.parse(JSON.stringify(data.canvas));
  relinkImages(canvasJSON);
  const missing = await standInForMissingArt(canvasJSON);

  editor.canvas.setDimensions({ width: state.card.width, height: state.card.height });
  await editor.loadJSON(canvasJSON);
  editor.canvas.backgroundColor = canvasJSON.background ?? state.card.background;
  editor.applyCardClip();
  editor.fitToWindow();
  // Also forgets any artwork the previous project's card could not load,
  // which would otherwise be written into this template's first card.
  resetCards();

  bus.emit(EVT.CARD, state.card);
  bus.emit(EVT.PROJECT, state.project);
  bus.emit(EVT.TEMPLATE_APPLIED, data);
  bus.emit(EVT.OBJECTS, editor.objects());
  history.reset();
  state.setDirty(true);
  return { missingArt: Object.values(missing) };
}

/** Point every workspace image at its path, so no port is baked into the file. */
function relinkImages(canvasJSON) {
  forEachImageJSON(canvasJSON, (obj) => {
    if (obj.tcgAsset) obj.src = api.fileURL(obj.tcgAsset);
  });
}

/** Build a field list from explicit definitions plus any slots found on objects. */
function normaliseFields(fields, canvasJSON) {
  const defined = (fields || []).map((f) => ({
    id: f.id,
    label: f.label || f.id,
    type: f.type || 'text',
    placeholder: f.placeholder || '',
    order: f.order ?? 0,
  }));
  const known = new Set(defined.map((f) => f.id));

  for (const obj of canvasJSON?.objects || []) {
    if (!obj.tcgSlot || known.has(obj.tcgSlot)) continue;
    known.add(obj.tcgSlot);
    defined.push({
      id: obj.tcgSlot,
      label: prettyLabel(obj.tcgSlot),
      type: isImageJSON(obj) || obj.tcgKind === 'art' ? 'image' : guessTextType(obj),
      placeholder: '',
      order: 99,
    });
  }
  return defined.sort((a, b) => a.order - b.order);
}

function guessTextType(obj) {
  const text = String(obj.text || '');
  return text.length > 60 || text.includes('\n') ? 'multiline' : 'text';
}

function prettyLabel(id) {
  return String(id)
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/* --------------------------------------------------------------- fields --- */

export function fieldValue(slot) {
  const objs = editor.findBySlot(slot);
  const obj = objs[0];
  if (!obj) return '';
  if (obj.type === 'image') return obj.tcgAsset || '';
  return obj.text ?? '';
}

export function setFieldText(slot, value) {
  const objs = editor.findBySlot(slot);
  if (!objs.length) return false;
  for (const obj of objs) {
    if (obj.type !== 'textbox' && obj.type !== 'i-text' && obj.type !== 'text') continue;
    // `{gem}` in a spreadsheet cell or a field is the icon, wherever the
    // words came from.
    const text = expandIcons(value);
    obj.set('text', obj.tcgUppercase ? text.toUpperCase() : text);
    if (obj.tcgAutoFit) editor.autoFitText(obj);
  }
  editor.canvas.requestRenderAll();
  editor.touch();
  return true;
}

/** Whether a slot's layers take artwork rather than words. */
export function isImageSlot(targets) {
  const first = targets[0];
  return !!first && (first.type === 'image' || first.tcgKind === 'art' || first.tcgKind === 'icon');
}

/** Artwork that was put into a slot, as opposed to a layer the layout ships. */
export const isPlacedArt = (obj) => obj?.type === 'image' && !!obj.tcgArtBox;

/**
 * Drop artwork into a slot. The target's bounds become the art window: the
 * image is scaled to cover it and clipped to it, so swapping art never breaks
 * the layout.
 */
export async function setFieldImage(slot, url, { assetPath = null } = {}) {
  const targets = editor.findBySlot(slot);
  const target = targets[0];
  const canvas = editor.canvas;

  const box = target
    ? target.tcgArtBox || boundsOf(target)
    : {
        left: state.card.width * 0.1,
        top: state.card.height * 0.15,
        width: state.card.width * 0.8,
        height: state.card.height * 0.45,
      };

  const img = await makeImage(url, {
    assetPath,
    tcgSlot: slot,
    tcgKind: 'art',
    tcgName: target?.tcgName || `Art: ${slot}`,
    tcgArtBox: box,
    tcgPlaceholder: placeholderFor(target),
  });

  fitImage(img, box, 'cover');
  img.set(
    'clipPath',
    new fabric.Rect({
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      absolutePositioned: true,
    })
  );

  // Whatever holds the slot *now*: a card switch may have put its own art in
  // while this picture loaded, and replacing the layer seen before the wait
  // would leave both pictures in the slot, on every card.
  const current = editor.findBySlot(slot)[0] || null;
  const index = current ? canvas.getObjects().indexOf(current) : canvas.getObjects().length;
  if (current) canvas.remove(current);
  canvas.add(img);
  canvas.moveObjectTo(img, Math.max(0, index));
  canvas.setActiveObject(img);
  canvas.requestRenderAll();
  editor.touch();
  bus.emit(EVT.OBJECTS, editor.objects());
  return img;
}

/**
 * Take artwork out of a slot and put back the layer it replaced.
 *
 * Artwork remembers that layer when it is placed. Art placed by a version that
 * did not has only its window to go on, so it gets a plain art box there.
 * Returns false when there is nothing placed to take out.
 */
export async function clearFieldImage(slot) {
  const target = editor.findBySlot(slot)[0];
  if (!isPlacedArt(target)) return false;

  let layer;
  if (target.tcgPlaceholder) {
    [layer] = await fabric.util.enlivenObjects([target.tcgPlaceholder]);
  } else {
    const box = target.tcgArtBox;
    layer = makeArtBox({
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      tcgName: target.tcgName,
      tcgSlot: slot,
    });
  }
  styleObject(layer);

  const canvas = editor.canvas;
  const index = canvas.getObjects().indexOf(target);
  if (canvas.getActiveObject() === target) canvas.discardActiveObject();
  canvas.remove(target);
  canvas.add(layer);
  canvas.moveObjectTo(layer, Math.max(0, index));
  canvas.requestRenderAll();
  editor.touch();
  return true;
}

/* ---------------------------------------------------------- framing ----- */

/** How far a picture may be zoomed into its window, as a multiple of cover. */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;

const close = (a, b, eps) => Math.abs(a - b) < eps;
const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback);

/** The smallest zoom a framing keeps — a corner handle can go below cover. */
const LEAST_ZOOM = 0.05;
/** How far a picture's centre may sit from the window's, in window sizes. */
const MAX_SHIFT = 10;

/**
 * How placed artwork sits in its window, relative to the window, so it means
 * the same thing for any picture: `zoom` is its scale over the scale that
 * just covers the window, `x`/`y` move its centre by a fraction of the
 * window's width/height, `angle` turns it. Properties can also flip the
 * picture (`flipX`/`flipY`), stretch it (`stretch`, height scale over width
 * scale) and crop it (`crop`, fractions of the whole picture); those are kept
 * too, or the next card switch quietly undid them. `null` is the plain cover
 * fit every picture gets when it is placed — which is most cards, so they
 * store nothing.
 */
export function readFraming(img) {
  if (!isPlacedArt(img) || !img.width || !img.height || !img.scaleX) return null;
  const box = img.tcgArtBox;
  const cover = Math.max(box.width / img.width, box.height / img.height);
  // Inside a multi-layer selection a layer's centre is the selection's.
  const centre = img.group
    ? fabric.util.transformPoint(img.getCenterPoint(), img.group.calcTransformMatrix())
    : img.getCenterPoint();
  const framing = {
    zoom: round(img.scaleX / cover, 4),
    x: round((centre.x - (box.left + box.width / 2)) / box.width, 4),
    y: round((centre.y - (box.top + box.height / 2)) / box.height, 4),
    angle: round(((img.angle % 360) + 360) % 360, 2),
  };
  if (framing.angle === 360) framing.angle = 0;
  if (img.flipX) framing.flipX = true;
  if (img.flipY) framing.flipY = true;
  const stretch = round(img.scaleY / img.scaleX, 4);
  if (!close(stretch, 1, 1e-3)) framing.stretch = stretch;
  const crop = readCrop(img);
  if (crop) framing.crop = crop;
  return cleanFraming(framing);
}

/** A framing as read from a file or a record: clamped, or null for plain. */
export function cleanFraming(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const framing = {
    zoom: Math.min(MAX_ZOOM, Math.max(LEAST_ZOOM, finite(raw.zoom, 1))),
    // A zoomed or stretched picture can sit well off-centre and still fill
    // the window, so the reach is generous.
    x: Math.min(MAX_SHIFT, Math.max(-MAX_SHIFT, finite(raw.x, 0))),
    y: Math.min(MAX_SHIFT, Math.max(-MAX_SHIFT, finite(raw.y, 0))),
  };
  const angle = finite(raw.angle, 0) % 360;
  if (angle) framing.angle = angle;
  if (raw.flipX === true) framing.flipX = true;
  if (raw.flipY === true) framing.flipY = true;
  const stretch = Math.min(10, Math.max(0.1, finite(raw.stretch, 1)));
  if (!close(stretch, 1, 1e-3)) framing.stretch = stretch;
  const crop = cleanCrop(raw.crop);
  if (crop) framing.crop = crop;
  const plain =
    close(framing.zoom, 1, 1e-3) && close(framing.x, 0, 1e-3) && close(framing.y, 0, 1e-3) &&
    Object.keys(framing).length === 3;
  return plain ? null : framing;
}

/** The whole picture's size, which a crop is a part of. */
function fullSize(img) {
  const original = img.getOriginalSize?.() || {};
  return {
    width: img._baseWidth || original.width || img.width,
    height: img._baseHeight || original.height || img.height,
  };
}

function readCrop(img) {
  const full = fullSize(img);
  if (!full.width || !full.height) return null;
  return cleanCrop({
    x: round((img.cropX || 0) / full.width, 4),
    y: round((img.cropY || 0) / full.height, 4),
    w: round(img.width / full.width, 4),
    h: round(img.height / full.height, 4),
  });
}

/** A crop inside the picture, or null for the whole of it. */
function cleanCrop(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const w = Math.min(1, Math.max(0.01, finite(raw.w, 1)));
  const h = Math.min(1, Math.max(0.01, finite(raw.h, 1)));
  const x = Math.min(1 - w, Math.max(0, finite(raw.x, 0)));
  const y = Math.min(1 - h, Math.max(0, finite(raw.y, 0)));
  const whole = close(w, 1, 1e-3) && close(h, 1, 1e-3) && close(x, 0, 1e-3) && close(y, 0, 1e-3);
  return whole ? null : { x, y, w, h };
}

/**
 * Sit placed artwork in its window as a framing says; `null` is the cover
 * fit. The window's clip does not move, so the picture is cropped by it as
 * it was when the framing was read. Returns false for anything that is not
 * placed artwork.
 */
export function applyFraming(img, framing) {
  if (!isPlacedArt(img) || !img.width || !img.height) return false;
  const box = img.tcgArtBox;
  const f = cleanFraming(framing) || { zoom: 1, x: 0, y: 0 };
  // The crop first: the cover scale is worked out from the part that shows.
  const full = fullSize(img);
  const crop = f.crop || { x: 0, y: 0, w: 1, h: 1 };
  img.set({
    cropX: Math.round(crop.x * full.width),
    cropY: Math.round(crop.y * full.height),
    width: Math.max(1, Math.round(crop.w * full.width)),
    height: Math.max(1, Math.round(crop.h * full.height)),
  });
  const scale = Math.max(box.width / img.width, box.height / img.height) * f.zoom;
  img.set({
    scaleX: scale,
    scaleY: scale * (f.stretch || 1),
    angle: f.angle || 0,
    flipX: !!f.flipX,
    flipY: !!f.flipY,
  });
  img.setPositionByOrigin(
    new fabric.Point(box.left + box.width / 2 + f.x * box.width, box.top + box.height / 2 + f.y * box.height),
    'center',
    'center'
  );
  img.setCoords();
  return true;
}

/**
 * Zoom the artwork in a slot, keeping where its centre sits in the window, or
 * put it back to the cover fit (`zoom` null). For the Card Fields controls;
 * moving the picture is done by dragging it on the card.
 */
export function frameFieldImage(slot, zoom = null) {
  const img = editor.findBySlot(slot)[0];
  if (!isPlacedArt(img)) return false;
  const current = readFraming(img) || { zoom: 1, x: 0, y: 0 };
  // Never below the cover fit from here — unless the picture is already
  // smaller (a corner handle can do that), where the slider steps from it.
  const least = Math.min(MIN_ZOOM, current.zoom);
  const framing = zoom === null ? null : { ...current, zoom: Math.min(MAX_ZOOM, Math.max(least, zoom)) };
  // Framing is placed in card coordinates; a member of a multi-layer
  // selection holds coordinates relative to the selection.
  const members = editor.memberSelection();
  try {
    applyFraming(img, framing);
  } finally {
    if (members.length > 1) editor.select(members);
  }
  editor.canvas.requestRenderAll();
  editor.touch();
  bus.emit(EVT.OBJECTS, editor.objects());
  return true;
}

function round(value, places) {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/** The layer that artwork dropped on `target` will hand the slot back to. */
function placeholderFor(target) {
  if (!target) return undefined;
  // Replacing art with art keeps the original placeholder, not the old art.
  if (isPlacedArt(target)) return target.tcgPlaceholder;
  const json = target.toObject(CUSTOM_PROPS);
  // An image the layout ships in a slot would otherwise keep the absolute URL
  // the browser resolved, port and all.
  if (isImageJSON(json) && json.tcgAsset) json.src = api.fileURL(json.tcgAsset);
  return json;
}

function boundsOf(obj) {
  const bb = obj.getBoundingRect();
  return { left: bb.left, top: bb.top, width: bb.width, height: bb.height };
}

/* ----------------------------------------------------------- save as ----- */

export function buildTemplate({ name, description = '', author = '', tags = [] }) {
  // A template is a layout: a change the card on screen made for itself stays
  // with that card.
  const canvas = toLayoutJSON(editor.toJSON());
  relinkImages(canvas);
  const fields = collectFields();
  return {
    format: TEMPLATE_FORMAT,
    version: 1,
    id: slugify(name, 'template'),
    name,
    description,
    author,
    tags,
    card: { ...state.card },
    fields,
    canvas,
  };
}

export function collectFields() {
  const seen = new Map();
  for (const obj of editor.objects()) {
    if (!obj.tcgSlot) continue;
    if (seen.has(obj.tcgSlot)) continue;
    seen.set(obj.tcgSlot, {
      id: obj.tcgSlot,
      label: prettyLabel(obj.tcgSlot),
      type: obj.type === 'image' || obj.tcgKind === 'art' ? 'image' : guessTextType(obj),
      placeholder: typeof obj.text === 'string' ? obj.text.slice(0, 60) : '',
    });
  }
  return Array.from(seen.values());
}

/** Where a template of this name is saved. */
export const templateTarget = (name) => `templates/${slugify(name, 'template')}.json`;

export async function saveTemplate(meta) {
  const template = buildTemplate(meta);
  const path = templateTarget(template.name);
  if (api.online) {
    await api.writeJSON(path, template, { backup: true });
    bus.emit(EVT.TEMPLATES);
    return { path, saved: 'workspace', template };
  }
  return { path: null, saved: 'memory', template };
}
