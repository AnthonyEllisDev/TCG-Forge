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
