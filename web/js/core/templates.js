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
import { makeImage } from './objects.js';
import { fitImage } from './effects.js';
import { slugify } from '../util/dom.js';

export const TEMPLATE_FORMAT = 'tcgforge.template';

/* Serialised objects report "Image"; live instances report "image". */
const isImageJSON = (obj) => String(obj?.type || '').toLowerCase() === 'image';

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

  Object.assign(state.card, data.card || {});
  state.project.templateId = data.id || slugify(data.name, 'template');
  state.project.fields = normaliseFields(data.fields, data.canvas);
  if (!keepName) state.project.name = data.name || state.project.name;
  // A template is somewhere to start, not the project that happened to be open
  // a moment ago. Left pointing at that project's file, the next Save writes
  // this layout straight over it — under a name the top bar has already
  // replaced, so there is nothing on screen to suggest what is about to go.
  state.project.path = null;

  const canvasJSON = JSON.parse(JSON.stringify(data.canvas));
  for (const obj of canvasJSON.objects || []) {
    if (isImageJSON(obj) && obj.tcgAsset) obj.src = api.fileURL(obj.tcgAsset);
  }

  editor.canvas.setDimensions({ width: state.card.width, height: state.card.height });
  await editor.loadJSON(canvasJSON);
  editor.canvas.backgroundColor = canvasJSON.background ?? state.card.background;
  editor.applyCardClip();
  editor.fitToWindow();

  bus.emit(EVT.CARD, state.card);
  bus.emit(EVT.PROJECT, state.project);
  bus.emit(EVT.TEMPLATE_APPLIED, data);
  bus.emit(EVT.OBJECTS, editor.objects());
  history.reset();
  state.setDirty(true);
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
    obj.set('text', obj.tcgUppercase ? String(value).toUpperCase() : String(value));
    if (obj.tcgAutoFit) editor.autoFitText(obj);
  }
  editor.canvas.requestRenderAll();
  editor.touch();
  return true;
}

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

  const index = target ? canvas.getObjects().indexOf(target) : canvas.getObjects().length;
  const img = await makeImage(url, {
    assetPath,
    tcgSlot: slot,
    tcgKind: 'art',
    tcgName: target?.tcgName || `Art: ${slot}`,
    tcgArtBox: box,
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

  if (target) canvas.remove(target);
  canvas.add(img);
  canvas.moveObjectTo(img, Math.max(0, index));
  canvas.setActiveObject(img);
  canvas.requestRenderAll();
  editor.touch();
  bus.emit(EVT.OBJECTS, editor.objects());
  return img;
}

function boundsOf(obj) {
  const bb = obj.getBoundingRect();
  return { left: bb.left, top: bb.top, width: bb.width, height: bb.height };
}

/* ----------------------------------------------------------- save as ----- */

export function buildTemplate({ name, description = '', author = '', tags = [] }) {
  const canvas = editor.toJSON();
  for (const obj of canvas.objects || []) {
    if (isImageJSON(obj) && obj.tcgAsset) obj.src = api.fileURL(obj.tcgAsset);
  }
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

export async function saveTemplate(meta) {
  const template = buildTemplate(meta);
  const path = `templates/${template.id}.json`;
  if (api.online) {
    await api.writeJSON(path, template, { backup: true });
    bus.emit(EVT.TEMPLATES);
    return { path, saved: 'workspace', template };
  }
  return { path: null, saved: 'memory', template };
}
