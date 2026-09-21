/*
 * Editor core — owns the Fabric canvas, the card geometry, zooming,
 * smart guides and all object level operations. UI modules talk to this
 * module and listen on the event bus; they never touch Fabric directly.
 */

import { bus, EVT } from '../util/bus.js';
import { clamp, round } from '../util/dom.js';
import { state } from './state.js';
import {
  CUSTOM_PROPS,
  makeArtBox,
  makeEllipse,
  makeImage,
  makeLine,
  makeRect,
  makeText,
  makeTriangle,
  styleObject,
} from './objects.js';

const SNAP_TOLERANCE = 7;     // screen pixels
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 6;

class Editor {
  constructor() {
    this.canvas = null;
    this.zoom = 1;
    this.guides = [];
    this.clipboard = null;
    this.suspendEvents = false;
    this.exporting = false;
    this._els = {};
  }

  /* ------------------------------------------------------------------ init */

  init({ canvasEl, stageEl, scrollEl }) {
    this._els = { canvasEl, stageEl, scrollEl };

    this.canvas = new fabric.Canvas(canvasEl, {
      width: state.card.width,
      height: state.card.height,
      backgroundColor: state.card.background,
      preserveObjectStacking: true,
      selection: true,
      selectionColor: 'rgba(91,124,250,0.12)',
      selectionBorderColor: '#5b7cfa',
      selectionLineWidth: 1,
      uniformScaling: false,
      controlsAboveOverlay: true,
      enableRetinaScaling: true,
      stopContextMenu: true,
      fireRightClick: true,
    });

    this.applyCardClip();
    this.bindCanvasEvents();
    this.bindViewportEvents();
    this.fitToWindow();
    return this;
  }

  bindCanvasEvents() {
    const c = this.canvas;

    c.on('object:moving', (e) => this.handleMoving(e));
    c.on('object:scaling', () => this.clearGuides());
    c.on('object:rotating', () => this.clearGuides());

    c.on('object:modified', (e) => {
      this.bakeScale(e.target);
      this.clearGuides();
      this.touch();
      bus.emit(EVT.SELECTION, this.selection());
    });

    c.on('object:added', () => this.touch());
    c.on('object:removed', () => this.touch());
    c.on('text:changed', (e) => {
      if (e.target?.tcgAutoFit) this.autoFitText(e.target);
      bus.emit(EVT.OBJECTS, this.objects());
    });
    c.on('text:editing:exited', () => this.touch());

    c.on('selection:created', () => this.emitSelection());
    c.on('selection:updated', () => this.emitSelection());
    c.on('selection:cleared', () => this.emitSelection());

    c.on('mouse:up', () => this.clearGuides());
    c.on('mouse:move', (e) => {
      const p = e.scenePoint || c.getScenePoint?.(e.e);
      if (p) bus.emit('editor:pointer', { x: Math.round(p.x), y: Math.round(p.y) });
    });

    /* Guides are painted after the scene so they always sit on top. */
    c.on('after:render', () => this.drawGuides());
  }

  bindViewportEvents() {
    const { scrollEl } = this._els;
    if (!scrollEl) return;

    // Ctrl/Cmd + wheel = zoom, plain wheel = scroll the work area.
    scrollEl.addEventListener(
      'wheel',
      (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        this.setZoom(this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
      },
      { passive: false }
    );

    // Space-drag panning of the scroll container.
    let panning = false;
    let origin = null;
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.repeat && !isTypingTarget(e.target)) {
        scrollEl.classList.add('panning');
        this.canvas.defaultCursor = 'grab';
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        scrollEl.classList.remove('panning', 'panning-active');
        this.canvas.defaultCursor = 'default';
        panning = false;
      }
    });
    scrollEl.addEventListener('pointerdown', (e) => {
      if (!scrollEl.classList.contains('panning') && e.button !== 1) return;
      panning = true;
      origin = { x: e.clientX, y: e.clientY, sl: scrollEl.scrollLeft, st: scrollEl.scrollTop };
      scrollEl.classList.add('panning-active');
      scrollEl.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });
    scrollEl.addEventListener('pointermove', (e) => {
      if (!panning || !origin) return;
      scrollEl.scrollLeft = origin.sl - (e.clientX - origin.x);
      scrollEl.scrollTop = origin.st - (e.clientY - origin.y);
    });
    scrollEl.addEventListener('pointerup', () => {
      panning = false;
      scrollEl.classList.remove('panning-active');
    });

    window.addEventListener('resize', () => {
      if (this._fitPending) return;
      this._fitPending = setTimeout(() => {
        this._fitPending = null;
        if (this._autoFit) this.fitToWindow();
      }, 120);
    });
  }

  /* ------------------------------------------------------------------ card */

  setCard(patch = {}) {
    Object.assign(state.card, patch);
    const { width, height, background } = state.card;
    this.canvas.setDimensions({ width, height });
    this.canvas.backgroundColor = background || '';
    this.applyCardClip();
    this.applyZoom();
    this.canvas.requestRenderAll();
    bus.emit(EVT.CARD, state.card);
    this.touch();
  }

  /** Rounded card corners are implemented as a canvas-level clip path. */
  applyCardClip() {
    const { width, height, radius } = state.card;
    if (!radius) {
      this.canvas.clipPath = null;
      return;
    }
    this.canvas.clipPath = new fabric.Rect({
      left: 0,
      top: 0,
      width,
      height,
      rx: radius,
      ry: radius,
    });
  }

  /* ------------------------------------------------------------------ zoom */

  setZoom(value, { auto = false } = {}) {
    this.zoom = clamp(value, MIN_ZOOM, MAX_ZOOM);
    this._autoFit = auto;
    this.applyZoom();
    bus.emit(EVT.ZOOM, this.zoom);
  }

  applyZoom() {
    const { width, height } = state.card;
    this.canvas.setZoom(this.zoom);
    this.canvas.setDimensions({
      width: Math.round(width * this.zoom),
      height: Math.round(height * this.zoom),
    });
    const stage = this._els.stageEl;
    if (stage) {
      stage.style.width = `${Math.round(width * this.zoom)}px`;
      stage.style.height = `${Math.round(height * this.zoom)}px`;
      stage.style.borderRadius = `${Math.max(2, state.card.radius * this.zoom)}px`;
    }
    this.canvas.requestRenderAll();
  }

  fitToWindow(padding = 56) {
    const scroll = this._els.scrollEl;
    if (!scroll) return;
    const availW = scroll.clientWidth - padding;
    const availH = scroll.clientHeight - padding;
    const scale = Math.min(availW / state.card.width, availH / state.card.height);
    this.setZoom(scale > 0 ? scale : 1, { auto: true });
  }

  /* -------------------------------------------------------------- guides */

  handleMoving(e) {
    const obj = e.target;
    if (!obj) return;
    this.guides = [];
    if (!state.settings.snap) {
      this.canvas.requestRenderAll();
      return;
    }

    const tol = SNAP_TOLERANCE / this.zoom;
    const { width: W, height: H } = state.card;
    const bb = obj.getBoundingRect();

    const others = this.canvas
      .getObjects()
      .filter((o) => o !== obj && o.visible !== false && !o.isPartOfActiveSelection?.())
      .map((o) => o.getBoundingRect());

    const targetsX = [0, W / 2, W, W * 0.08, W * (1 - 0.08)];
    const targetsY = [0, H / 2, H, H * 0.06, H * (1 - 0.06)];
    for (const o of others) {
      targetsX.push(o.left, o.left + o.width / 2, o.left + o.width);
      targetsY.push(o.top, o.top + o.height / 2, o.top + o.height);
    }

    const edgesX = [bb.left, bb.left + bb.width / 2, bb.left + bb.width];
    const edgesY = [bb.top, bb.top + bb.height / 2, bb.top + bb.height];

    const bestX = nearest(edgesX, targetsX, tol);
    const bestY = nearest(edgesY, targetsY, tol);

    if (bestX) {
      obj.set('left', obj.left + bestX.delta);
      this.guides.push({ axis: 'x', at: bestX.target });
    }
    if (bestY) {
      obj.set('top', obj.top + bestY.delta);
      this.guides.push({ axis: 'y', at: bestY.target });
    }
    obj.setCoords();
  }

  clearGuides() {
    if (!this.guides.length) return;
    this.guides = [];
    this.canvas.requestRenderAll();
  }

  drawGuides() {
    if (this.exporting) return;
    const overlays = [];
    if (state.settings.safeZone) overlays.push({ inset: 0.06, color: 'rgba(62,207,142,0.5)' });
    if (state.settings.bleed) overlays.push({ inset: -0.025, color: 'rgba(240,165,58,0.55)' });
    if (!this.guides.length && !overlays.length) return;

    const ctx = this.canvas.getContext();
    const rs = this.canvas.getRetinaScaling ? this.canvas.getRetinaScaling() : 1;
    const { width: W, height: H } = state.card;

    ctx.save();
    ctx.setTransform(rs, 0, 0, rs, 0, 0);
    const vt = this.canvas.viewportTransform;
    ctx.transform(vt[0], vt[1], vt[2], vt[3], vt[4], vt[5]);

    for (const o of overlays) {
      const dx = W * o.inset;
      const dy = H * o.inset;
      ctx.save();
      ctx.strokeStyle = o.color;
      ctx.lineWidth = 1.5 / this.zoom;
      ctx.setLineDash([8 / this.zoom, 6 / this.zoom]);
      ctx.strokeRect(dx, dy, W - dx * 2, H - dy * 2);
      ctx.restore();
    }

    if (this.guides.length && state.settings.guides) {
      ctx.strokeStyle = '#f0a53a';
      ctx.lineWidth = 1 / this.zoom;
      ctx.setLineDash([6 / this.zoom, 4 / this.zoom]);
      ctx.beginPath();
      for (const g of this.guides) {
        if (g.axis === 'x') {
          ctx.moveTo(g.at, -40 / this.zoom);
          ctx.lineTo(g.at, H + 40 / this.zoom);
        } else {
          ctx.moveTo(-40 / this.zoom, g.at);
          ctx.lineTo(W + 40 / this.zoom, g.at);
        }
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------ selection */

  selection() {
    return this.canvas ? this.canvas.getActiveObjects() : [];
  }

  active() {
    return this.canvas ? this.canvas.getActiveObject() : null;
  }

  emitSelection() {
    bus.emit(EVT.SELECTION, this.selection());
    bus.emit(EVT.OBJECTS, this.objects());
  }

  objects() {
    return this.canvas ? this.canvas.getObjects() : [];
  }

  select(objects) {
    const list = [].concat(objects).filter(Boolean);
    this.canvas.discardActiveObject();
    if (list.length === 1) {
      this.canvas.setActiveObject(list[0]);
    } else if (list.length > 1) {
      this.canvas.setActiveObject(new fabric.ActiveSelection(list, { canvas: this.canvas }));
    }
    this.canvas.requestRenderAll();
    this.emitSelection();
  }

  selectAll() {
    this.select(this.objects().filter((o) => o.selectable !== false && o.visible !== false));
  }

  /* -------------------------------------------------------------- objects */

  /** Centre an object on the card and add it to the canvas. */
  place(obj, { center = true, select = true } = {}) {
    if (center) {
      const w = obj.width * (obj.scaleX || 1);
      const h = obj.height * (obj.scaleY || 1);
      obj.set({
        left: Math.round((state.card.width - w) / 2),
        top: Math.round((state.card.height - h) / 2),
      });
    }
    this.canvas.add(obj);
    obj.setCoords();
    if (select) this.canvas.setActiveObject(obj);
    this.canvas.requestRenderAll();
    this.emitSelection();
    this.touch();
    return obj;
  }

  insert(kind) {
    const { width: W, height: H } = state.card;
    switch (kind) {
      case 'text':
        return this.place(
          makeText('New text', { width: Math.round(W * 0.72), fontSize: Math.round(H / 34), tcgName: 'Text' })
        );
      case 'heading':
        return this.place(
          makeText('CARD NAME', {
            width: Math.round(W * 0.78),
            fontSize: Math.round(H / 20),
            fontWeight: 'bold',
            fontFamily: 'Georgia',
            tcgName: 'Heading',
          })
        );
      case 'rect':
        return this.place(makeRect({ width: Math.round(W * 0.8), height: Math.round(H * 0.14) }));
      case 'roundrect':
        return this.place(
          makeRect({ width: Math.round(W * 0.8), height: Math.round(H * 0.14), rx: 18, ry: 18, tcgName: 'Rounded box' })
        );
      case 'ellipse':
        return this.place(makeEllipse({ rx: Math.round(W * 0.22), ry: Math.round(W * 0.22) }));
      case 'triangle':
        return this.place(makeTriangle({ width: Math.round(W * 0.3), height: Math.round(W * 0.28) }));
      case 'line':
        return this.place(makeLine([0, 0, Math.round(W * 0.8), 0]));
      case 'artbox':
        return this.place(makeArtBox({ width: Math.round(W * 0.84), height: Math.round(H * 0.42) }));
      default:
        return null;
    }
  }

  async addImage(url, options = {}) {
    const img = await makeImage(url, options);
    const maxW = state.card.width * (options.coverage || 0.8);
    if (img.width > maxW) img.scaleToWidth(maxW);
    const maxH = state.card.height * 0.9;
    if (img.getScaledHeight() > maxH) img.scaleToHeight(maxH);
    return this.place(img, { center: options.center !== false });
  }

  remove(objects = this.selection()) {
    const list = [].concat(objects).filter(Boolean);
    if (!list.length) return;
    this.canvas.discardActiveObject();
    list.forEach((o) => this.canvas.remove(o));
    this.canvas.requestRenderAll();
    this.emitSelection();
    this.touch();
  }

  async duplicate() {
    const objs = this.selection();
    if (!objs.length) return;
    const clones = [];
    for (const obj of objs) {
      const clone = await obj.clone(CUSTOM_PROPS);
      clone.set({
        left: (obj.left || 0) + 24,
        top: (obj.top || 0) + 24,
        tcgId: undefined,
        tcgSlot: undefined,
      });
      styleObject(clone);
      this.canvas.add(clone);
      clones.push(clone);
    }
    this.select(clones);
    this.touch();
  }

  async copy() {
    const objs = this.selection();
    if (!objs.length) return;
    this.clipboard = await Promise.all(objs.map((o) => o.clone(CUSTOM_PROPS)));
  }

  async paste() {
    if (!this.clipboard?.length) return;
    const pasted = [];
    for (const source of this.clipboard) {
      const clone = await source.clone(CUSTOM_PROPS);
      clone.set({ left: (clone.left || 0) + 28, top: (clone.top || 0) + 28, tcgId: undefined });
      styleObject(clone);
      this.canvas.add(clone);
      pasted.push(clone);
    }
    this.select(pasted);
    this.touch();
  }

  /* ---------------------------------------------------------------- order */

  order(action) {
    const objs = this.selection();
    if (!objs.length) return;
    const c = this.canvas;
    for (const obj of objs) {
      if (action === 'up') c.bringObjectForward(obj);
      else if (action === 'down') c.sendObjectBackwards(obj);
      else if (action === 'top') c.bringObjectToFront(obj);
      else if (action === 'bottom') c.sendObjectToBack(obj);
    }
    c.requestRenderAll();
    bus.emit(EVT.OBJECTS, this.objects());
    this.touch();
  }

  moveToIndex(obj, index) {
    this.canvas.moveObjectTo(obj, clamp(index, 0, this.objects().length - 1));
    this.canvas.requestRenderAll();
    bus.emit(EVT.OBJECTS, this.objects());
    this.touch();
  }

  /* -------------------------------------------------------------- grouping */

  toggleGroup() {
    const active = this.active();
    if (!active) return;

    if (active.type === 'group') {
      const items = active.removeAll ? active.removeAll() : active.getObjects();
      this.canvas.remove(active);
      items.forEach((o) => {
        styleObject(o);
        this.canvas.add(o);
      });
      this.select(items);
    } else if (this.selection().length > 1) {
      const items = this.selection().slice();
      this.canvas.discardActiveObject();
      items.forEach((o) => this.canvas.remove(o));
      const group = styleObject(new fabric.Group(items, { tcgKind: 'group', tcgName: 'Group' }));
      this.canvas.add(group);
      this.select(group);
    }
    this.touch();
  }

  /* ------------------------------------------------------------- alignment */

  align(mode) {
    const objs = this.selection();
    if (!objs.length) return;

    let bounds = { left: 0, top: 0, width: state.card.width, height: state.card.height };
    if (objs.length > 1) {
      const active = this.active();
      const bb = active.getBoundingRect();
      bounds = { left: bb.left, top: bb.top, width: bb.width, height: bb.height };
    }

    for (const obj of objs) {
      const bb = obj.getBoundingRect();
      let dx = 0;
      let dy = 0;
      if (mode === 'left') dx = bounds.left - bb.left;
      if (mode === 'right') dx = bounds.left + bounds.width - (bb.left + bb.width);
      if (mode === 'hcenter') dx = bounds.left + bounds.width / 2 - (bb.left + bb.width / 2);
      if (mode === 'top') dy = bounds.top - bb.top;
      if (mode === 'bottom') dy = bounds.top + bounds.height - (bb.top + bb.height);
      if (mode === 'vcenter') dy = bounds.top + bounds.height / 2 - (bb.top + bb.height / 2);
      obj.set({ left: obj.left + dx, top: obj.top + dy });
      obj.setCoords();
    }
    this.canvas.requestRenderAll();
    this.touch();
    bus.emit(EVT.SELECTION, this.selection());
  }

  nudge(dx, dy) {
    const objs = this.selection();
    if (!objs.length) return;
    for (const obj of objs) {
      obj.set({ left: obj.left + dx, top: obj.top + dy });
      obj.setCoords();
    }
    this.canvas.requestRenderAll();
    this.touch();
    bus.emit(EVT.SELECTION, objs);
  }

  /* --------------------------------------------------------------- helpers */

  /** Fold a scale transform back into concrete width/height for tidy numbers. */
  bakeScale(obj) {
    if (!obj) return;
    const bakeable = ['rect', 'triangle'];
    if (!bakeable.includes(obj.type)) return;
    const sx = obj.scaleX || 1;
    const sy = obj.scaleY || 1;
    if (sx === 1 && sy === 1) return;
    obj.set({
      width: Math.max(1, obj.width * sx),
      height: Math.max(1, obj.height * sy),
      scaleX: 1,
      scaleY: 1,
    });
    obj.setCoords();
  }

  /**
   * Shrink text until it fits its box. It never grows past the size the layer
   * was designed at (`tcgFitSize`), so long rules text stays readable and
   * short text keeps the template's intended look.
   */
  autoFitText(obj) {
    if (!obj || !obj.tcgAutoFit) return;
    const target = obj.tcgFitHeight || obj.height;
    const maxSize = obj.tcgFitSize || obj.fontSize;
    if (!obj.tcgFitSize) obj.set('tcgFitSize', maxSize);

    let size = Math.min(obj.fontSize, maxSize);
    obj.set('fontSize', size);
    obj.initDimensions?.();

    let guard = 0;
    while (obj.height > target && size > 6 && guard < 300) {
      size -= 1;
      obj.set('fontSize', size);
      obj.initDimensions?.();
      guard += 1;
    }
    while (obj.height < target && size < maxSize && guard < 600) {
      size += 1;
      obj.set('fontSize', size);
      obj.initDimensions?.();
      if (obj.height > target) {
        obj.set('fontSize', size - 1);
        obj.initDimensions?.();
        break;
      }
      guard += 1;
    }
    this.canvas.requestRenderAll();
  }

  findBySlot(slot) {
    return this.objects().filter((o) => o.tcgSlot === slot);
  }

  touch() {
    if (this.suspendEvents) return;
    state.setDirty(true);
    bus.emit(EVT.MODIFIED);
    bus.emit(EVT.OBJECTS, this.objects());
  }

  /* --------------------------------------------------------- serialisation */

  toJSON() {
    return this.canvas.toObject(CUSTOM_PROPS);
  }

  async loadJSON(json) {
    this.suspendEvents = true;
    try {
      await this.canvas.loadFromJSON(json);
      this.canvas.getObjects().forEach((o) => styleObject(o));
      this.applyCardClip();
      this.canvas.requestRenderAll();
      this.emitSelection();
    } finally {
      // A load that throws must still clear the flag. Latched on, it silences
      // touch() for the rest of the session: no dirty marker, no history, and
      // a save that quietly writes stale JSON.
      this.suspendEvents = false;
    }
  }

  clear() {
    this.suspendEvents = true;
    this.canvas.clear();
    this.canvas.backgroundColor = state.card.background;
    this.applyCardClip();
    this.canvas.requestRenderAll();
    this.suspendEvents = false;
    this.emitSelection();
  }

  /** Render the card to a data URL at the requested multiplier. */
  toDataURL({ multiplier = 2, format = 'png', quality = 0.94, transparent = false } = {}) {
    const canvas = this.canvas;
    const previousBg = canvas.backgroundColor;
    this.exporting = true;
    canvas.discardActiveObject();
    if (transparent) canvas.backgroundColor = '';
    canvas.renderAll();
    const url = canvas.toDataURL({
      format,
      quality,
      multiplier: multiplier / this.zoom,
      enableRetinaScaling: false,
    });
    canvas.backgroundColor = previousBg;
    this.exporting = false;
    canvas.requestRenderAll();
    return url;
  }
}

/* ------------------------------------------------------------------ utils */

function nearest(edges, targets, tolerance) {
  let best = null;
  for (const edge of edges) {
    for (const target of targets) {
      const delta = target - edge;
      if (Math.abs(delta) <= tolerance && (!best || Math.abs(delta) < Math.abs(best.delta))) {
        best = { delta, target: round(target, 1) };
      }
    }
  }
  return best;
}

export function isTypingTarget(node) {
  if (!node) return false;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable;
}

export const editor = new Editor();
