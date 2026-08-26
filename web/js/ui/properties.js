/*
 * Properties panel — contextual controls for the current selection:
 * transform, fill (solid/gradient), stroke, shadow, typography, image
 * crop and adjustments, plus layer metadata and template slot binding.
 */

import { $, $$, clamp, isHex, on, toHex } from '../util/dom.js';
import { bus, EVT } from '../util/bus.js';
import { editor } from '../core/editor.js';
import { state } from '../core/state.js';
import { assets } from '../core/assets.js';
import { labelOf } from '../core/objects.js';
import {
  applyCrop,
  applyFilters,
  cropValues,
  fillColors,
  fillMode,
  filterValues,
  fitImage,
  resetCrop,
  setGradientFill,
  setShadow,
  setSolidFill,
  setStroke,
  shadowValues,
  strokeStyleOf,
} from '../core/effects.js';

let syncing = false;
let lockRatio = false;
let replaceInput = null;

const el = (id) => document.getElementById(id);

export function initProperties() {
  bindTransform();
  bindFill();
  bindStroke();
  bindShadow();
  bindText();
  bindImage();
  bindMeta();

  bus.on(EVT.SELECTION, sync);
  bus.on(EVT.FONTS, populateFonts);
  bus.on(EVT.CARD, sync);
  populateFonts();
  sync([]);
}

/* ------------------------------------------------------------- plumbing -- */

function selection() {
  return editor.selection();
}

function apply(fn, { render = true } = {}) {
  if (syncing) return;
  const objs = selection();
  if (!objs.length) return;
  objs.forEach((obj) => fn(obj));
  if (render) editor.canvas.requestRenderAll();
  editor.touch();
}

/** Bind an input to a fabric property with an optional value transform. */
function bindInput(id, handler, event = 'input') {
  const node = el(id);
  if (!node) return;
  on(node, event, (e) => handler(node, e));
}

function setVal(id, value) {
  const node = el(id);
  if (node && node.value !== String(value)) node.value = value;
}

function setChecked(id, value) {
  const node = el(id);
  if (node) node.checked = !!value;
}

function setText(id, value) {
  const node = el(id);
  if (node) node.textContent = value;
}

function toggleBtn(id, active) {
  el(id)?.classList.toggle('on', !!active);
}

/* ------------------------------------------------------------ transform -- */

function bindTransform() {
  bindInput('pX', (n) => apply((o) => { o.set('left', num(n.value)); o.setCoords(); }));
  bindInput('pY', (n) => apply((o) => { o.set('top', num(n.value)); o.setCoords(); }));

  bindInput('pW', (n) => apply((o) => resize(o, num(n.value), null)));
  bindInput('pH', (n) => apply((o) => resize(o, null, num(n.value))));

  on(el('pLockRatio'), 'click', () => {
    lockRatio = !lockRatio;
    toggleBtn('pLockRatio', lockRatio);
  });

  bindInput('pAngle', (n) => {
    setText('pAngleVal', `${n.value}°`);
    apply((o) => { o.rotate(num(n.value)); o.setCoords(); });
  });

  bindInput('pOpacity', (n) => {
    setText('pOpacityVal', `${n.value}%`);
    apply((o) => o.set('opacity', num(n.value) / 100));
  });

  bindInput('pBlend', (n) => apply((o) => o.set('globalCompositeOperation', n.value)), 'change');
  bindInput('pFlipX', (n) => apply((o) => o.set('flipX', n.checked)), 'change');
  bindInput('pFlipY', (n) => apply((o) => o.set('flipY', n.checked)), 'change');
  bindInput('pClip', (n) => apply((o) => setCardClip(o, n.checked)), 'change');
}

function resize(obj, width, height) {
  if (width !== null) {
    const w = Math.max(1, width);
    if (obj.type === 'textbox') obj.set('width', w);
    else obj.set('scaleX', w / obj.width);
    if (lockRatio) {
      const ratio = obj.type === 'textbox' ? 1 : obj.scaleX;
      if (obj.type !== 'textbox') obj.set('scaleY', ratio);
    }
  }
  if (height !== null) {
    const h = Math.max(1, height);
    if (obj.type === 'textbox') {
      obj.set('tcgFitHeight', h);
      if (obj.tcgAutoFit) editor.autoFitText(obj);
    } else {
      obj.set('scaleY', h / obj.height);
      if (lockRatio) obj.set('scaleX', obj.scaleY);
    }
  }
  obj.setCoords();
}

function setCardClip(obj, enabled) {
  obj.set('tcgClip', enabled);
  if (!enabled) {
    if (obj.clipPath?.tcgCardClip) obj.set('clipPath', null);
    return;
  }
  const clip = new fabric.Rect({
    left: 0,
    top: 0,
    width: state.card.width,
    height: state.card.height,
    rx: state.card.radius,
    ry: state.card.radius,
    absolutePositioned: true,
  });
  clip.tcgCardClip = true;
  obj.set('clipPath', clip);
}

/* ----------------------------------------------------------------- fill -- */

function bindFill() {
  for (const btn of $$('#fillMode .seg-btn')) {
    on(btn, 'click', () => {
      const mode = btn.dataset.mode;
      $$('#fillMode .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
      el('fillSolid').hidden = mode !== 'solid';
      el('fillGradient').hidden = mode !== 'linear' && mode !== 'radial';
      apply((o) => {
        if (mode === 'none') setSolidFill(o, '');
        else if (mode === 'solid') setSolidFill(o, el('pFill').value);
        else {
          setGradientFill(o, {
            type: mode,
            from: el('gradA').value,
            to: el('gradB').value,
            angle: num(el('gradAngle').value),
          });
        }
      });
    });
  }

  bindInput('pFill', (n) => {
    setVal('pFillHex', n.value);
    apply((o) => setSolidFill(o, n.value));
  });
  bindInput('pFillHex', (n) => {
    if (!isHex(n.value)) return;
    setVal('pFill', toHex(n.value));
    apply((o) => setSolidFill(o, n.value));
  });

  const gradientUpdate = () => {
    const mode = $('#fillMode .seg-btn.active')?.dataset.mode || 'linear';
    if (mode !== 'linear' && mode !== 'radial') return;
    setText('gradAngleVal', `${el('gradAngle').value}°`);
    apply((o) =>
      setGradientFill(o, {
        type: mode,
        from: el('gradA').value,
        to: el('gradB').value,
        angle: num(el('gradAngle').value),
      })
    );
  };
  bindInput('gradA', gradientUpdate);
  bindInput('gradB', gradientUpdate);
  bindInput('gradAngle', gradientUpdate);
}

/* --------------------------------------------------------------- stroke -- */

function bindStroke() {
  const update = () =>
    apply((o) =>
      setStroke(o, {
        color: el('pStroke').value,
        width: num(el('pStrokeWidth').value),
        style: el('pStrokeStyle').value,
      })
    );

  bindInput('pStroke', (n) => {
    setVal('pStrokeHex', n.value);
    update();
  });
  bindInput('pStrokeHex', (n) => {
    if (!isHex(n.value)) return;
    setVal('pStroke', toHex(n.value));
    update();
  });
  bindInput('pStrokeWidth', update);
  bindInput('pStrokeStyle', update, 'change');
  bindInput('pPaintFirst', (n) => apply((o) => o.set('paintFirst', n.checked ? 'stroke' : 'fill')), 'change');
  bindInput('pRadius', (n) =>
    apply((o) => {
      if (o.type !== 'rect') return;
      o.set({ rx: num(n.value), ry: num(n.value) });
    })
  );
}

/* --------------------------------------------------------------- shadow -- */

function bindShadow() {
  const update = () => {
    const on_ = el('shadowOn').checked;
    el('shadowControls').hidden = !on_;
    apply((o) =>
      setShadow(o, {
        on: on_,
        color: el('shadowColor').value,
        blur: num(el('shadowBlur').value),
        x: num(el('shadowX').value),
        y: num(el('shadowY').value),
      })
    );
  };

  bindInput('shadowOn', update, 'change');
  bindInput('shadowColor', (n) => {
    setVal('shadowHex', n.value);
    update();
  });
  bindInput('shadowHex', (n) => {
    if (!isHex(n.value)) return;
    setVal('shadowColor', toHex(n.value));
    update();
  });
  bindInput('shadowBlur', (n) => {
    setText('shadowBlurVal', n.value);
    update();
  });
  bindInput('shadowX', update);
  bindInput('shadowY', update);

  on(el('shadowGlowPreset'), 'click', () => {
    const obj = selection()[0];
    const colour = typeof obj?.fill === 'string' ? toHex(obj.fill, '#5b7cfa') : '#5b7cfa';
    setChecked('shadowOn', true);
    setVal('shadowColor', colour);
    setVal('shadowHex', colour);
    setVal('shadowBlur', 34);
    setVal('shadowX', 0);
    setVal('shadowY', 0);
    setText('shadowBlurVal', '34');
    el('shadowControls').hidden = false;
    apply((o) => setShadow(o, { on: true, color: colour, blur: 34, x: 0, y: 0 }));
  });
}

/* ----------------------------------------------------------------- text -- */

function bindText() {
  bindInput('pText', (n) =>
    apply((o) => {
      if (!isText(o)) return;
      o.set('text', o.tcgUppercase ? n.value.toUpperCase() : n.value);
      if (o.tcgAutoFit) editor.autoFitText(o);
    })
  );

  bindInput('pFontFamily', (n) => apply((o) => o.set('fontFamily', n.value)), 'change');
  bindInput('pFontSize', (n) => apply((o) => o.set('fontSize', clamp(num(n.value), 4, 400))));
  bindInput('pLineHeight', (n) => apply((o) => o.set('lineHeight', num(n.value) || 1.16)));
  bindInput('pCharSpacing', (n) => apply((o) => o.set('charSpacing', num(n.value))));

  on(el('tBold'), 'click', () => toggleText('fontWeight', 'bold', 'normal', 'tBold'));
  on(el('tItalic'), 'click', () => toggleText('fontStyle', 'italic', 'normal', 'tItalic'));
  on(el('tUnderline'), 'click', () => toggleFlag('underline', 'tUnderline'));
  on(el('tStrike'), 'click', () => toggleFlag('linethrough', 'tStrike'));

  on(el('tCaps'), 'click', () => {
    const first = selection()[0];
    const next = !first?.tcgUppercase;
    toggleBtn('tCaps', next);
    apply((o) => {
      if (!isText(o)) return;
      o.set('tcgUppercase', next);
      o.set('text', next ? String(o.text).toUpperCase() : String(o.text));
    });
  });

  for (const btn of $$('[data-textalign]')) {
    on(btn, 'click', () => {
      const value = btn.dataset.textalign;
      $$('[data-textalign]').forEach((b) => b.classList.toggle('on', b === btn));
      apply((o) => o.set('textAlign', value));
    });
  }

  bindInput('pAutoFit', (n) =>
    apply((o) => {
      if (!isText(o)) return;
      o.set('tcgAutoFit', n.checked);
      if (n.checked) {
        o.set('tcgFitHeight', o.tcgFitHeight || o.height);
        o.set('tcgFitSize', o.tcgFitSize || o.fontSize);
        editor.autoFitText(o);
      }
    }),
    'change'
  );

  bindInput('pSlot', (n) =>
    apply((o) => o.set('tcgSlot', n.value.trim() || undefined), { render: false })
  );
}

function toggleText(prop, onValue, offValue, buttonId) {
  const first = selection()[0];
  const next = first?.[prop] === onValue ? offValue : onValue;
  toggleBtn(buttonId, next === onValue);
  apply((o) => o.set(prop, next));
}

function toggleFlag(prop, buttonId) {
  const first = selection()[0];
  const next = !first?.[prop];
  toggleBtn(buttonId, next);
  apply((o) => o.set(prop, next));
}

const isText = (o) => o && (o.type === 'textbox' || o.type === 'i-text' || o.type === 'text');

/* ---------------------------------------------------------------- image -- */

function bindImage() {
  const cropUpdate = () => {
    setText('cropWVal', `${el('cropW').value}%`);
    setText('cropHVal', `${el('cropH').value}%`);
    setText('panXVal', `${el('panX').value}%`);
    setText('panYVal', `${el('panY').value}%`);
    apply((o) => {
      if (o.type !== 'image') return;
      applyCrop(o, {
        w: num(el('cropW').value),
        h: num(el('cropH').value),
        x: num(el('panX').value),
        y: num(el('panY').value),
      });
    });
  };
  ['cropW', 'cropH', 'panX', 'panY'].forEach((id) => bindInput(id, cropUpdate));

  const fxUpdate = () => {
    setText('fxBrightVal', el('fxBright').value);
    setText('fxContrastVal', el('fxContrast').value);
    setText('fxSatVal', el('fxSat').value);
    setText('fxBlurVal', el('fxBlur').value);
    apply((o) => {
      if (o.type !== 'image') return;
      applyFilters(o, {
        brightness: num(el('fxBright').value),
        contrast: num(el('fxContrast').value),
        saturation: num(el('fxSat').value),
        blur: num(el('fxBlur').value),
        grayscale: el('fxGray').checked,
        sepia: el('fxSepia').checked,
        invert: el('fxInvert').checked,
      });
    });
  };
  ['fxBright', 'fxContrast', 'fxSat', 'fxBlur'].forEach((id) => bindInput(id, fxUpdate, 'change'));
  ['fxGray', 'fxSepia', 'fxInvert'].forEach((id) => bindInput(id, fxUpdate, 'change'));

  on(document, 'click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    const img = selection()[0];
    if (!img || img.type !== 'image') return;

    if (action === 'img-fit' || action === 'img-fill') {
      const box = img.tcgArtBox || {
        left: 0,
        top: 0,
        width: state.card.width,
        height: state.card.height,
      };
      fitImage(img, box, action === 'img-fill' ? 'cover' : 'contain');
      editor.canvas.requestRenderAll();
      editor.touch();
    } else if (action === 'img-reset') {
      resetCrop(img);
      editor.canvas.requestRenderAll();
      editor.touch();
      sync();
    } else if (action === 'img-replace') {
      openReplaceDialog(img);
    }
  });
}

function openReplaceDialog(img) {
  if (!replaceInput) {
    replaceInput = document.createElement('input');
    replaceInput.type = 'file';
    replaceInput.accept = 'image/*';
    replaceInput.hidden = true;
    document.body.append(replaceInput);
  }
  replaceInput.onchange = async () => {
    const file = replaceInput.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const target = img;
    const element = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = url;
    });
    target.setElement(element);
    target.set({
      _baseWidth: element.naturalWidth,
      _baseHeight: element.naturalHeight,
      width: element.naturalWidth,
      height: element.naturalHeight,
      cropX: 0,
      cropY: 0,
      tcgAsset: null,
    });
    if (target.tcgArtBox) fitImage(target, target.tcgArtBox, 'cover');
    target.setCoords();
    editor.canvas.requestRenderAll();
    editor.touch();
    replaceInput.value = '';
  };
  replaceInput.click();
}

/* ----------------------------------------------------------------- meta -- */

function bindMeta() {
  bindInput('pName', (n) => apply((o) => o.set('tcgName', n.value.trim() || undefined), { render: false }), 'change');
  bindInput('pVisible', (n) => apply((o) => o.set('visible', n.checked)), 'change');
  bindInput('pLocked', (n) =>
    apply((o) => {
      const locked = n.checked;
      o.set({
        selectable: !locked,
        evented: !locked,
        hasControls: !locked,
        lockMovementX: locked,
        lockMovementY: locked,
        lockRotation: locked,
        lockScalingX: locked,
        lockScalingY: locked,
        tcgLocked: locked,
      });
    }),
    'change'
  );
}

/* ----------------------------------------------------------------- sync -- */

function populateFonts() {
  const select = el('pFontFamily');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '';
  for (const family of assets.fontFamilies()) {
    const option = document.createElement('option');
    option.value = family;
    option.textContent = family;
    option.style.fontFamily = family;
    select.append(option);
  }
  if (current) select.value = current;
}

export function sync() {
  const objs = selection();
  const root = el('propsRoot');
  const empty = el('noSelection');
  const label = $('#selectionLabel');

  if (!objs.length) {
    root.hidden = true;
    empty.hidden = false;
    if (label) {
      label.textContent = 'no selection';
      label.classList.add('muted');
    }
    return;
  }

  root.hidden = false;
  empty.hidden = true;

  const obj = objs[0];
  const multi = objs.length > 1;
  if (label) {
    label.textContent = multi ? `${objs.length} layers selected` : labelOf(obj);
    label.classList.remove('muted');
  }

  syncing = true;
  try {
    const bb = obj.getBoundingRect();
    setVal('pX', Math.round(multi ? bb.left : obj.left));
    setVal('pY', Math.round(multi ? bb.top : obj.top));
    setVal('pW', Math.round(obj.getScaledWidth?.() ?? obj.width));
    setVal('pH', Math.round(obj.getScaledHeight?.() ?? obj.height));
    ['pX', 'pY', 'pW', 'pH'].forEach((id) => {
      const node = el(id);
      if (node) node.disabled = multi;
    });

    setVal('pAngle', Math.round(obj.angle || 0));
    setText('pAngleVal', `${Math.round(obj.angle || 0)}°`);
    setVal('pOpacity', Math.round((obj.opacity ?? 1) * 100));
    setText('pOpacityVal', `${Math.round((obj.opacity ?? 1) * 100)}%`);
    setVal('pBlend', obj.globalCompositeOperation || 'source-over');
    setChecked('pFlipX', obj.flipX);
    setChecked('pFlipY', obj.flipY);
    setChecked('pClip', !!obj.tcgClip);

    /* fill */
    const mode = fillMode(obj);
    $$('#fillMode .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    el('fillSolid').hidden = mode !== 'solid';
    el('fillGradient').hidden = mode !== 'linear' && mode !== 'radial';
    const colors = fillColors(obj);
    setVal('pFill', colors.a);
    setVal('pFillHex', colors.a);
    setVal('gradA', colors.a);
    setVal('gradB', colors.b);
    setVal('gradAngle', colors.angle);
    setText('gradAngleVal', `${colors.angle}°`);

    /* stroke */
    setVal('pStroke', toHex(obj.stroke, '#000000'));
    setVal('pStrokeHex', toHex(obj.stroke, '#000000'));
    setVal('pStrokeWidth', obj.strokeWidth ?? 0);
    setVal('pStrokeStyle', strokeStyleOf(obj));
    setChecked('pPaintFirst', obj.paintFirst === 'stroke');
    const radiusField = el('radiusField');
    if (radiusField) radiusField.hidden = obj.type !== 'rect';
    setVal('pRadius', obj.rx ?? 0);

    /* shadow */
    const shadow = shadowValues(obj);
    setChecked('shadowOn', shadow.on);
    el('shadowControls').hidden = !shadow.on;
    setVal('shadowColor', shadow.color);
    setVal('shadowHex', shadow.color);
    setVal('shadowBlur', shadow.blur);
    setText('shadowBlurVal', String(Math.round(shadow.blur)));
    setVal('shadowX', shadow.x);
    setVal('shadowY', shadow.y);

    /* text */
    const textGroup = $('[data-sub="text"]');
    const textish = isText(obj) && !multi;
    textGroup.hidden = !textish;
    if (textish) {
      setVal('pText', obj.text || '');
      setVal('pFontFamily', obj.fontFamily || 'Georgia');
      setVal('pFontSize', Math.round(obj.fontSize || 24));
      setVal('pLineHeight', obj.lineHeight ?? 1.16);
      setVal('pCharSpacing', obj.charSpacing ?? 0);
      toggleBtn('tBold', obj.fontWeight === 'bold' || obj.fontWeight >= 600);
      toggleBtn('tItalic', obj.fontStyle === 'italic');
      toggleBtn('tUnderline', !!obj.underline);
      toggleBtn('tStrike', !!obj.linethrough);
      toggleBtn('tCaps', !!obj.tcgUppercase);
      $$('[data-textalign]').forEach((b) =>
        b.classList.toggle('on', b.dataset.textalign === (obj.textAlign || 'left'))
      );
      setChecked('pAutoFit', !!obj.tcgAutoFit);
      setVal('pSlot', obj.tcgSlot || '');
    }

    /* image */
    const imageGroup = $('[data-sub="image"]');
    const isImage = obj.type === 'image' && !multi;
    imageGroup.hidden = !isImage;
    if (isImage) {
      const crop = cropValues(obj);
      setVal('cropW', crop.w);
      setVal('cropH', crop.h);
      setVal('panX', crop.x);
      setVal('panY', crop.y);
      setText('cropWVal', `${crop.w}%`);
      setText('cropHVal', `${crop.h}%`);
      setText('panXVal', `${crop.x}%`);
      setText('panYVal', `${crop.y}%`);

      const fx = filterValues(obj);
      setVal('fxBright', fx.brightness);
      setVal('fxContrast', fx.contrast);
      setVal('fxSat', fx.saturation);
      setVal('fxBlur', fx.blur);
      setText('fxBrightVal', fx.brightness);
      setText('fxContrastVal', fx.contrast);
      setText('fxSatVal', fx.saturation);
      setText('fxBlurVal', fx.blur);
      setChecked('fxGray', fx.grayscale);
      setChecked('fxSepia', fx.sepia);
      setChecked('fxInvert', fx.invert);
    }

    /* meta */
    setVal('pName', obj.tcgName || labelOf(obj));
    setChecked('pVisible', obj.visible !== false);
    setChecked('pLocked', obj.selectable === false);
  } finally {
    syncing = false;
  }
}

function num(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}
