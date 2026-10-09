/*
 * Object factories and the custom properties TCG Forge persists on top of
 * Fabric's own serialisation.
 *
 *   tcgName   - the label shown in the Layers panel
 *   tcgKind   - frame | art | icon | text | shape | background | group
 *   tcgSlot   - template field id this object is bound to (e.g. "title")
 *   tcgAsset  - workspace-relative path an image came from, so projects can
 *               reference files on disk instead of embedding base64
 *   tcgAutoFit / tcgUppercase - text behaviours
 *   tcgClip   - clip the object to the card rectangle
 *   tcgCardClip - marks the clipPath that tcgClip installed, so switching the
 *               option off again knows which clip is ours. Fabric passes
 *               propertiesToInclude down into a clipPath, so this round-trips
 *               — but only because it is listed below.
 *   tcgShowIf - a slot name: the layer is shown only while that slot holds
 *               something ("!slot" inverts it). See editor.applyConditions().
 *   tcgPlaceholder - on artwork placed into a slot, the serialised layer it
 *               replaced (usually the dashed art box), so the slot can be
 *               emptied again — which is what switching to a card with no art
 *               in that slot does. See templates.clearFieldImage().
 *   tcgBase   - on a layer the card on screen has changed for itself alone,
 *               the layout's own values for the properties it changed
 *               (OVERRIDE_KEYS). The live layer shows the card's version; this
 *               is what every other card shows. Saved files never carry it —
 *               toLayoutJSON() puts it back first — but undo snapshots do,
 *               which is why it is listed below. See cards.setOverride().
 *   _baseWidth/_baseHeight - natural pixel size of an image, for cropping
 */

import { uid } from '../util/dom.js';

export const CUSTOM_PROPS = [
  'tcgName',
  'tcgKind',
  'tcgSlot',
  'tcgAsset',
  'tcgAutoFit',
  'tcgUppercase',
  'tcgClip',
  'tcgCardClip',
  'tcgId',
  'tcgArtBox',
  'tcgFitHeight',
  'tcgFitSize',
  'tcgShowIf',
  'tcgNumbering',
  'tcgPlaceholder',
  'tcgBase',
  '_baseWidth',
  '_baseHeight',
  'selectable',
  'evented',
  'lockMovementX',
  'lockMovementY',
  'lockRotation',
  'lockScalingX',
  'lockScalingY',
  'hasControls',
];

/**
 * What a card may change about a layer for itself alone: where it sits, its
 * size and turn, how see-through it is, and a plain colour. Nothing that
 * changes what a layer *is* — its text belongs to the card's slots already,
 * and its stacking order is the layout's. Which of these apply depends on the
 * layer: see overrideKeysFor().
 */
export const OVERRIDE_KEYS = ['left', 'top', 'scaleX', 'scaleY', 'width', 'height', 'angle', 'opacity', 'fill'];

/**
 * The override keys that mean "size" differ by layer. A resized box or
 * triangle has its scale folded into width and height (editor.bakeScale), and
 * a text box is resized by its width — its height follows its words. An
 * image's width and height are its crop, so a picture is sized by scale alone.
 */
export function overrideKeysFor(obj) {
  const type = String(obj?.type || '').toLowerCase();
  return OVERRIDE_KEYS.filter((key) => {
    if (key === 'width') return type === 'rect' || type === 'triangle' || type === 'textbox';
    if (key === 'height') return type === 'rect' || type === 'triangle';
    if (key === 'fill') return typeof obj?.fill === 'string';
    return true;
  });
}

/** Put a layer the card on screen changed back to how the layout has it. */
export function revertToLayout(obj) {
  if (!obj?.tcgBase) return false;
  obj.set({ ...obj.tcgBase, tcgBase: undefined });
  // A text box back at the layout's width has to wrap its words again.
  obj.initDimensions?.();
  obj.setCoords?.();
  return true;
}

/**
 * Canvas JSON as the shared layout: every layer the card on screen changed for
 * itself is written with the layout's values instead. A project or template
 * file holds the layout and each card's changes separately, so a build that
 * knows nothing of card changes still opens the layout it expects.
 */
export function toLayoutJSON(canvasJSON) {
  const visit = (list) => {
    for (const obj of list || []) {
      if (obj?.tcgBase && typeof obj.tcgBase === 'object') Object.assign(obj, obj.tcgBase);
      if (obj) delete obj.tcgBase;
      if (Array.isArray(obj?.objects)) visit(obj.objects);
    }
  };
  visit(canvasJSON?.objects);
  return canvasJSON;
}

const CONTROL_STYLE = {
  transparentCorners: false,
  cornerColor: '#5b7cfa',
  cornerStrokeColor: '#0a0d14',
  borderColor: '#5b7cfa',
  cornerSize: 9,
  cornerStyle: 'circle',
  padding: 0,
  borderScaleFactor: 1.4,
};

export function styleObject(obj, extra = {}) {
  obj.set({ ...CONTROL_STYLE, ...extra });
  if (!obj.tcgId) obj.set('tcgId', uid('obj'));
  return obj;
}

export function kindOf(obj) {
  if (!obj) return 'object';
  if (obj.tcgKind) return obj.tcgKind;
  const type = obj.type;
  if (type === 'textbox' || type === 'i-text' || type === 'text') return 'text';
  if (type === 'image') return 'art';
  if (type === 'group') return 'group';
  return 'shape';
}

export function labelOf(obj) {
  if (!obj) return '';
  if (obj.tcgName) return obj.tcgName;
  if (obj.type === 'textbox' || obj.type === 'i-text') {
    const text = String(obj.text || '').replace(/\s+/g, ' ').trim();
    return text ? `“${text.slice(0, 22)}${text.length > 22 ? '…' : ''}”` : 'Text';
  }
  const map = {
    rect: 'Rectangle',
    circle: 'Circle',
    ellipse: 'Ellipse',
    triangle: 'Triangle',
    line: 'Line',
    path: 'Path',
    image: 'Image',
    group: 'Group',
  };
  return map[obj.type] || 'Layer';
}

/* -------------------------------------------------------- serialised images */

/* Serialised Fabric objects report capitalised types ("Image"); live instances
   report lower case ("image"). Compare case-insensitively. */
export const isImageJSON = (obj) => String(obj?.type || '').toLowerCase() === 'image';

/**
 * Visit every image in serialised canvas JSON, including those inside groups.
 *
 * Walking only the top level misses grouped artwork, and a grouped image keeps
 * the absolute URL the browser resolved — port and all — so it breaks the
 * first time the launcher picks a different port, and "embed images" quietly
 * leaves it out.
 */
export function forEachImageJSON(canvasJSON, visit) {
  const walk = (list) => {
    for (const obj of list || []) {
      if (isImageJSON(obj)) visit(obj);
      else if (Array.isArray(obj?.objects)) walk(obj.objects);
      // The layer a slot will go back to is stored whole, and it can be an
      // image too: it needs the same relinking as everything else.
      if (obj?.tcgPlaceholder) walk([obj.tcgPlaceholder]);
    }
  };
  walk(canvasJSON?.objects);
}

/* ---------------------------------------------------------------- factories */

export function makeText(text, options = {}) {
  const box = new fabric.Textbox(text, {
    left: 0,
    top: 0,
    width: 400,
    fontSize: 32,
    fill: '#ffffff',
    fontFamily: 'Georgia',
    textAlign: 'left',
    lineHeight: 1.16,
    splitByGrapheme: false,
    tcgKind: 'text',
    ...options,
  });
  return styleObject(box);
}

export function makeRect(options = {}) {
  return styleObject(
    new fabric.Rect({
      left: 0,
      top: 0,
      width: 300,
      height: 120,
      fill: '#2b3446',
      rx: 0,
      ry: 0,
      strokeUniform: true,
      tcgKind: 'shape',
      ...options,
    })
  );
}

export function makeEllipse(options = {}) {
  return styleObject(
    new fabric.Ellipse({
      left: 0,
      top: 0,
      rx: 120,
      ry: 120,
      fill: '#2b3446',
      strokeUniform: true,
      tcgKind: 'shape',
      ...options,
    })
  );
}

export function makeTriangle(options = {}) {
  return styleObject(
    new fabric.Triangle({
      left: 0,
      top: 0,
      width: 220,
      height: 200,
      fill: '#2b3446',
      strokeUniform: true,
      tcgKind: 'shape',
      ...options,
    })
  );
}

export function makeLine(points = [0, 0, 300, 0], options = {}) {
  return styleObject(
    new fabric.Line(points, {
      stroke: '#e8ecf5',
      strokeWidth: 4,
      strokeUniform: true,
      tcgKind: 'shape',
      tcgName: 'Line',
      ...options,
    })
  );
}

/**
 * Load an image from any URL (workspace file, data URL or blob) and return a
 * styled fabric image. `assetPath` keeps the workspace-relative origin so the
 * project file can reference it instead of embedding the pixels.
 */
export async function makeImage(url, { assetPath = null, ...options } = {}) {
  const img = await fabric.FabricImage.fromURL(url, { crossOrigin: 'anonymous' });
  img.set({
    tcgKind: options.tcgKind || 'art',
    tcgAsset: assetPath,
    _baseWidth: img.width,
    _baseHeight: img.height,
    ...options,
  });
  return styleObject(img);
}

/** A dashed placeholder box that marks where art belongs in a template. */
export function makeArtBox(options = {}) {
  return styleObject(
    new fabric.Rect({
      left: 0,
      top: 0,
      width: 620,
      height: 460,
      fill: '#1b2231',
      stroke: '#5b7cfa',
      strokeWidth: 3,
      strokeDashArray: [12, 8],
      strokeUniform: true,
      tcgKind: 'art',
      tcgName: 'Art box',
      tcgSlot: 'art',
      ...options,
    })
  );
}

/*
 * A card's picture that has gone from the workspace (renamed, moved, on
 * another machine) made Fabric refuse the whole file, so the project could not
 * be opened at all until the picture came back. Card switches already show the
 * slot's placeholder for such a picture and keep its path; the card a project
 * opens on does the same, and so does a template saved from such a card.
 * Other images — a frame, a background — still refuse the file: there is no
 * layer to stand in for them. Returns the missing pictures by slot.
 */
export async function standInForMissingArt(canvasJSON) {
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
