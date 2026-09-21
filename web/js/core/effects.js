/*
 * Layer effects: gradients, strokes, shadows and image adjustments.
 * Everything here reads and writes plain Fabric properties so the results
 * survive save/load without any extra bookkeeping.
 */

import { toHex } from '../util/dom.js';

/* --------------------------------------------------------------- fill ---- */

export function fillMode(obj) {
  const fill = obj?.fill;
  if (!fill) return 'none';
  if (typeof fill === 'string') return 'solid';
  if (fill.type === 'radial') return 'radial';
  if (fill.type === 'linear') return 'linear';
  return 'solid';
}

export function fillColors(obj) {
  const fill = obj?.fill;
  if (typeof fill === 'string') return { a: toHex(fill, '#ffffff'), b: '#000000', angle: 90 };
  if (fill?.colorStops?.length) {
    const stops = [...fill.colorStops].sort((x, y) => x.offset - y.offset);
    return {
      a: toHex(stops[0].color, '#ffffff'),
      b: toHex(stops[stops.length - 1].color, '#000000'),
      angle: gradientAngle(fill),
    };
  }
  return { a: '#ffffff', b: '#000000', angle: 90 };
}

/**
 * Recover a linear gradient's angle from the gradient itself.
 *
 * Fabric's `Gradient.toObject()` writes a fixed set of keys, so an angle
 * parked on the gradient object does not survive a save. The coordinates do,
 * and they already encode the angle — so read it back out of them rather than
 * storing it twice.
 */
function gradientAngle(fill) {
  const { x1 = 0, y1 = 0, x2 = 0, y2 = 0 } = fill.coords || {};
  if (fill.type !== 'linear' || (x1 === x2 && y1 === y2)) return 90;
  const deg = Math.round((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI);
  return ((deg % 360) + 360) % 360;
}

export function setSolidFill(obj, color) {
  obj.set('fill', color);
}

export function setGradientFill(obj, { type = 'linear', from = '#5b7cfa', to = '#0b1020', angle = 90 } = {}) {
  const w = obj.width || 100;
  const h = obj.height || 100;
  const cx = w / 2;
  const cy = h / 2;
  let coords;

  if (type === 'radial') {
    coords = { x1: cx, y1: cy, r1: 0, x2: cx, y2: cy, r2: Math.max(w, h) / 2 };
  } else {
    const rad = (angle * Math.PI) / 180;
    const len = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
    coords = {
      x1: cx - (Math.cos(rad) * len) / 2,
      y1: cy - (Math.sin(rad) * len) / 2,
      x2: cx + (Math.cos(rad) * len) / 2,
      y2: cy + (Math.sin(rad) * len) / 2,
    };
  }

  const gradient = new fabric.Gradient({
    type,
    gradientUnits: 'pixels',
    coords,
    colorStops: [
      { offset: 0, color: from },
      { offset: 1, color: to },
    ],
  });
  obj.set('fill', gradient);
}

/* ------------------------------------------------------------- stroke ---- */

export function strokeStyleOf(obj) {
  const dash = obj?.strokeDashArray;
  if (!dash || !dash.length) return 'solid';
  return dash[0] <= (obj.strokeWidth || 1) * 1.2 ? 'dotted' : 'dashed';
}

export function setStroke(obj, { color, width, style } = {}) {
  if (color !== undefined) obj.set('stroke', width === 0 ? obj.stroke : color);
  if (width !== undefined) obj.set('strokeWidth', width);
  const w = obj.strokeWidth || 1;
  if (style === 'dashed') obj.set('strokeDashArray', [w * 3, w * 2]);
  else if (style === 'dotted') obj.set('strokeDashArray', [w, w * 1.8]);
  else if (style === 'solid') obj.set('strokeDashArray', null);
  obj.set('strokeUniform', true);
}

/* ------------------------------------------------------------- shadow ---- */

export function shadowValues(obj) {
  const s = obj?.shadow;
  if (!s) return { on: false, color: '#000000', blur: 12, x: 0, y: 4 };
  return {
    on: true,
    color: toHex(s.color, '#000000'),
    blur: s.blur ?? 12,
    x: s.offsetX ?? 0,
    y: s.offsetY ?? 4,
  };
}

export function setShadow(obj, values) {
  if (!values || values.on === false) {
    obj.set('shadow', null);
    return;
  }
  obj.set(
    'shadow',
    new fabric.Shadow({
      color: values.color ?? '#000000',
      blur: Number(values.blur ?? 12),
      offsetX: Number(values.x ?? 0),
      offsetY: Number(values.y ?? 4),
      nonScaling: false,
    })
  );
}

/* ------------------------------------------------------- image filters ---- */

const FILTER_TYPES = {
  brightness: 'Brightness',
  contrast: 'Contrast',
  saturation: 'Saturation',
  blur: 'Blur',
  grayscale: 'Grayscale',
  sepia: 'Sepia',
  invert: 'Invert',
};

export function filterValues(img) {
  const out = {
    brightness: 0,
    contrast: 0,
    saturation: 0,
    blur: 0,
    grayscale: false,
    sepia: false,
    invert: false,
  };
  for (const f of img?.filters || []) {
    const type = (f.type || '').toLowerCase();
    if (type === 'brightness') out.brightness = Math.round((f.brightness || 0) * 100);
    else if (type === 'contrast') out.contrast = Math.round((f.contrast || 0) * 100);
    else if (type === 'saturation') out.saturation = Math.round((f.saturation || 0) * 100);
    else if (type === 'blur') out.blur = Math.round((f.blur || 0) * 100);
    else if (type === 'grayscale') out.grayscale = true;
    else if (type === 'sepia') out.sepia = true;
    else if (type === 'invert') out.invert = true;
  }
  return out;
}

export function applyFilters(img, values) {
  if (!img || img.type !== 'image') return;
  const F = fabric.filters;
  const list = [];

  if (values.brightness) list.push(new F[FILTER_TYPES.brightness]({ brightness: values.brightness / 100 }));
  if (values.contrast) list.push(new F[FILTER_TYPES.contrast]({ contrast: values.contrast / 100 }));
  if (values.saturation) list.push(new F[FILTER_TYPES.saturation]({ saturation: values.saturation / 100 }));
  if (values.grayscale) list.push(new F[FILTER_TYPES.grayscale]());
  if (values.sepia && F.Sepia) list.push(new F.Sepia());
  if (values.invert) list.push(new F[FILTER_TYPES.invert]());
  if (values.blur) list.push(new F[FILTER_TYPES.blur]({ blur: values.blur / 100 }));

  img.filters = list;
  img.applyFilters();
}

/* ---------------------------------------------------------------- crop ---- */

export function cropValues(img) {
  const bw = img._baseWidth || img.width;
  const bh = img._baseHeight || img.height;
  const spanX = Math.max(0, bw - img.width);
  const spanY = Math.max(0, bh - img.height);
  return {
    w: Math.round((img.width / bw) * 100),
    h: Math.round((img.height / bh) * 100),
    x: spanX ? Math.round(((img.cropX || 0) / spanX) * 100) : 50,
    y: spanY ? Math.round(((img.cropY || 0) / spanY) * 100) : 50,
  };
}

export function applyCrop(img, { w, h, x, y }) {
  const bw = img._baseWidth || img.width;
  const bh = img._baseHeight || img.height;
  const newW = Math.max(8, Math.round((bw * w) / 100));
  const newH = Math.max(8, Math.round((bh * h) / 100));
  const spanX = Math.max(0, bw - newW);
  const spanY = Math.max(0, bh - newH);
  img.set({
    width: newW,
    height: newH,
    cropX: Math.round((spanX * x) / 100),
    cropY: Math.round((spanY * y) / 100),
  });
  img.setCoords();
}

export function resetCrop(img) {
  const bw = img._baseWidth || img.width;
  const bh = img._baseHeight || img.height;
  img.set({ width: bw, height: bh, cropX: 0, cropY: 0 });
  img.setCoords();
}

/** Scale an image so it fits inside (contain) or covers a target box. */
export function fitImage(img, box, mode = 'contain') {
  const w = img.width;
  const h = img.height;
  const scale =
    mode === 'cover'
      ? Math.max(box.width / w, box.height / h)
      : Math.min(box.width / w, box.height / h);
  img.set({
    scaleX: scale,
    scaleY: scale,
    left: box.left + (box.width - w * scale) / 2,
    top: box.top + (box.height - h * scale) / 2,
  });
  img.setCoords();
}
