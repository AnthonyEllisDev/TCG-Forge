/*
 * Editor core — owns the Fabric canvas, the card geometry, zooming,
 * smart guides and all object level operations. UI modules talk to this
 * module and listen on the event bus; they never touch Fabric directly.
 */

import { bus, EVT } from '../util/bus.js';
import { clamp, round } from '../util/dom.js';
import { state } from './state.js';
import { expandIcons } from './icons.js';
import {
  CUSTOM_PROPS,
  makeArtBox,
  makeEllipse,
  makeImage,
  makeLine,
  makeRect,
  makeText,
  makeTriangle,
  revertToLayout,
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
    // Where the card on the canvas sits in its set, while a run says so; null
    // means "the project's own card list" (see cardNumber()).
    this.numberContext = null;
    // The layers of a multi-selection in the order they were picked, and the
    // one chosen by hand as the key layer (see keyLayer()).
    this.picked = [];
    this.keyChoice = null;
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
    // Adding, deleting, reordering or switching cards moves every number on
    // the set without touching the canvas.
    bus.on(EVT.CARDS, () => this.applyNumbering());
    // Text measured before an icon font arrived measured its icons as blanks.
    bus.on(EVT.ICONS, () => this.remeasureText());
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
      this.applyConditions();
      // Typing on the canvas is an edit the moment it happens. Waiting for
      // editing to end left the project reading as saved while the caret was
      // still in the text, so Open, New and closing the tab went unasked.
      if (!this.suspendEvents) state.setDirty(true);
      bus.emit(EVT.OBJECTS, this.objects());
    });
    c.on('text:editing:exited', (e) => {
      // `{gem}` typed on the canvas becomes the icon once typing is done;
      // rewriting the text under the caret mid-word would fight the editor.
      this.expandIconsIn(e.target);
      this.touch();
    });

    c.on('selection:created', (e) => { this.notePicks(e); this.emitSelection(); });
    c.on('selection:updated', (e) => { this.notePicks(e); this.emitSelection(); });
    c.on('selection:cleared', () => { this.notePicks(); this.emitSelection(); });

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

    // Fabric 6 dropped isPartOfActiveSelection(), so asking an object whether
    // it is being dragged always answered "no" and every member of a multi-layer
    // drag snapped to itself at zero distance. Ask the mover for its members.
    const moving = new Set(obj.getObjects?.() || []);
    const others = this.canvas
      .getObjects()
      .filter((o) => o !== obj && o.visible !== false && !moving.has(o))
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
    const key = this.keyLayer();
    if (!this.guides.length && !overlays.length && !key) return;

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

    // The key layer of a multi-selection is what Match size and *Align to:
    // key layer* measure from, so it is marked where the user is looking.
    if (key) {
      const bb = key.getBoundingRect();
      const pad = 3 / this.zoom;
      ctx.strokeStyle = '#f0a53a';
      ctx.lineWidth = 2.5 / this.zoom;
      ctx.setLineDash([]);
      ctx.strokeRect(bb.left - pad, bb.top - pad, bb.width + pad * 2, bb.height + pad * 2);
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
    // Selecting again (after a distribute, or adding a layer from the Layers
    // panel) keeps who was picked first, and the key chosen by hand.
    const before = this.picked;
    const key = this.keyChoice;
    this.canvas.discardActiveObject();
    if (list.length === 1) {
      this.canvas.setActiveObject(list[0]);
    } else if (list.length > 1) {
      this.canvas.setActiveObject(new fabric.ActiveSelection(list, { canvas: this.canvas }));
    }
    this.picked = [...before.filter((o) => list.includes(o)), ...list.filter((o) => !before.includes(o))];
    this.keyChoice = list.length > 1 && list.includes(key) ? key : null;
    this.canvas.requestRenderAll();
    this.emitSelection();
  }

  /**
   * Keep the order the layers of a multi-selection were picked in. Fabric
   * holds them in stacking order, which says nothing about which one the user
   * meant to line the others up with; the first one picked is the key layer
   * unless another is chosen. A marquee picks its layers all at once, bottom
   * first.
   */
  notePicks(e) {
    const now = this.selection();
    // One layer picked is the start of the order: shift-clicking a second
    // makes a selection Fabric reports in stacking order, both at once.
    if (now.length < 2) {
      this.picked = now;
      this.keyChoice = null;
      return;
    }
    const kept = this.picked.filter((o) => now.includes(o));
    for (const obj of [...(e?.selected || []), ...now]) {
      if (now.includes(obj) && !kept.includes(obj)) kept.push(obj);
    }
    this.picked = kept;
    if (!now.includes(this.keyChoice)) this.keyChoice = null;
  }

  /**
   * The layer a multi-selection is measured against: the one chosen with
   * setKeyLayer(), else the first one picked. Null for one layer or none.
   */
  keyLayer() {
    const now = this.selection();
    if (now.length < 2) return null;
    if (this.keyChoice && now.includes(this.keyChoice)) return this.keyChoice;
    return this.picked.find((o) => now.includes(o)) || now[0];
  }

  /** Make one layer of the multi-selection its key layer. False if it is not in it. */
  setKeyLayer(obj) {
    if (!obj || this.selection().length < 2 || !this.selection().includes(obj)) return false;
    this.keyChoice = obj;
    this.canvas.requestRenderAll();
    bus.emit(EVT.SELECTION, this.selection());
    return true;
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
    const list = unlocked([].concat(objects).filter(Boolean));
    if (!list.length) return 0;
    this.canvas.discardActiveObject();
    list.forEach((o) => this.canvas.remove(o));
    this.canvas.requestRenderAll();
    this.emitSelection();
    this.touch();
    return list.length;
  }

  async duplicate() {
    const objs = this.memberSelection();
    if (!objs.length) return;
    const clones = [];
    for (const obj of objs) {
      const clone = await obj.clone(CUSTOM_PROPS);
      clone.set({
        left: (obj.left || 0) + 24,
        top: (obj.top || 0) + 24,
        tcgId: undefined,
        tcgSlot: undefined,
        // A copy is a new layer of the layout, as it looks now — not a
        // change the card on screen made to somebody else's layer.
        tcgBase: undefined,
      });
      styleObject(clone);
      this.canvas.add(clone);
      clones.push(clone);
    }
    this.select(clones);
    this.touch();
  }

  async copy() {
    const objs = this.memberSelection();
    if (!objs.length) return;
    this.clipboard = await Promise.all(objs.map((o) => o.clone(CUSTOM_PROPS)));
    if (objs.length > 1) this.select(objs);
  }

  /**
   * The selected layers with their positions on the card.
   *
   * Members of a multi-layer selection keep `left`/`top` relative to the
   * selection's centre, so a clone taken from them lands hundreds of pixels
   * off the card. Dropping the selection hands each member its own card
   * coordinates back; callers reselect whatever they want selected after.
   */
  memberSelection() {
    const objs = this.selection();
    // The caller selects them again; who was picked first must survive that.
    const { picked, keyChoice } = this;
    if (objs.length > 1) this.canvas.discardActiveObject();
    this.picked = picked;
    this.keyChoice = keyChoice;
    return objs;
  }

  async paste() {
    if (!this.clipboard?.length) return;
    const pasted = [];
    for (const source of this.clipboard) {
      const clone = await source.clone(CUSTOM_PROPS);
      // A pasted layer is a new layer, not a second home for the slot: two
      // layers in one slot meant the copy kept the first card's art or words
      // on every card.
      clone.set({
        left: (clone.left || 0) + 28,
        top: (clone.top || 0) + 28,
        tcgId: undefined,
        tcgSlot: undefined,
        tcgBase: undefined,
      });
      styleObject(clone);
      this.canvas.add(clone);
      pasted.push(clone);
    }
    this.select(pasted);
    this.touch();
  }

  /* ---------------------------------------------------------------- order */

  /**
   * Restack the selection as one block. Moving each layer on its own, in the
   * order they were picked, let one selected layer hop over another — raising
   * two neighbours did nothing, and sending them to the back swapped them. So
   * the layers go in stacking order, from the end they are moving towards, and
   * a layer only steps past one that is not selected.
   */
  order(action) {
    const objs = this.selection();
    if (!objs.length) return;
    const c = this.canvas;
    const picked = new Set(objs);
    const stack = () => c.getObjects();
    const bottomUp = [...objs].sort((a, b) => stack().indexOf(a) - stack().indexOf(b));
    const topDown = [...bottomUp].reverse();
    if (action === 'up') {
      for (const obj of topDown) {
        const above = stack()[stack().indexOf(obj) + 1];
        if (above && !picked.has(above)) c.bringObjectForward(obj);
      }
    } else if (action === 'down') {
      for (const obj of bottomUp) {
        const below = stack()[stack().indexOf(obj) - 1];
        if (below && !picked.has(below)) c.sendObjectBackwards(obj);
      }
    } else if (action === 'top') {
      bottomUp.forEach((obj) => c.bringObjectToFront(obj));
    } else if (action === 'bottom') {
      topDown.forEach((obj) => c.sendObjectToBack(obj));
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

  /**
   * Group the selection, or ungroup a group. Returns false — and changes
   * nothing — when a layer in the selection is a card field: the slot system
   * only looks at top-level layers, so a slot inside a group vanished from
   * Card Fields, and the next card switch saved the card without its words and
   * left them on screen over the next card.
   */
  toggleGroup() {
    const active = this.active();
    if (!active) return true;

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
      if (items.some((o) => o.tcgSlot)) return false;
      this.canvas.discardActiveObject();
      // A group is part of the layout, so a change the card on screen made to
      // one of its members for itself cannot come along into it.
      items.forEach((o) => revertToLayout(o));
      items.forEach((o) => this.canvas.remove(o));
      const group = styleObject(new fabric.Group(items, { tcgKind: 'group', tcgName: 'Group' }));
      this.canvas.add(group);
      this.select(group);
    }
    this.touch();
    return true;
  }

  /* ------------------------------------------------------------- alignment */

  /**
   * Line up the selection. One layer aligns to the card. Several align to
   * what `to` names (default: the *Align to* setting): 'selection' — their
   * own bounds; 'key' — the key layer, which stays where it is; 'card' — the
   * card, each layer on its own.
   */
  align(mode, { to = state.settings.alignTo } = {}) {
    const objs = unlocked(this.selection());
    if (!objs.length) return;

    let bounds = { left: 0, top: 0, width: state.card.width, height: state.card.height };
    let key = null;
    if (this.selection().length > 1 && to === 'key') {
      key = this.keyLayer();
      const bb = key.getBoundingRect();
      bounds = { left: bb.left, top: bb.top, width: bb.width, height: bb.height };
    } else if (objs.length > 1 && to !== 'card') {
      const active = this.active();
      const bb = active.getBoundingRect();
      bounds = { left: bb.left, top: bb.top, width: bb.width, height: bb.height };
    }

    for (const obj of objs) {
      if (obj === key) continue;
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
    // Select again so the selection box is drawn around where the layers
    // are now, not where they were.
    if (this.selection().length > 1) this.select(this.memberSelection());
    this.canvas.requestRenderAll();
    this.touch();
    bus.emit(EVT.SELECTION, this.selection());
  }

  /**
   * Space three or more layers evenly along one axis ('horizontal' or
   * 'vertical'). The gaps between neighbouring bounding boxes come out equal,
   * not the distances between their centres, which is what a row of cost pips
   * or icons of different widths needs. The layer that starts first stays put,
   * the last one ends where the furthest edge was, and the rest fill in by
   * where they start. Returns false, having moved nothing, below three layers.
   */
  distribute(axis = 'horizontal') {
    const movable = unlocked(this.selection());
    if (movable.length < 3) return false;
    const [start, size] = axis === 'vertical' ? ['top', 'height'] : ['left', 'width'];
    // Measure first: bounding rects are in card coordinates even for members
    // of a multi-layer selection, whose own left/top are not.
    const items = movable
      .map((obj, order) => ({ obj, order, bb: obj.getBoundingRect() }))
      .sort((a, b) => a.bb[start] - b.bb[start] || a.order - b.order);
    const from = items[0].bb[start];
    const to = Math.max(...items.map(({ bb }) => bb[start] + bb[size]));
    const total = items.reduce((sum, { bb }) => sum + bb[size], 0);
    const gap = (to - from - total) / (items.length - 1);

    // Dropping the selection hands every member its card coordinates back, and
    // selecting again afterwards redraws the selection box around where the
    // layers now are rather than where they were.
    const objs = this.memberSelection();
    let at = from;
    for (const { obj, bb } of items) {
      obj.set(start, obj[start] + (at - bb[start]));
      obj.setCoords();
      at += bb[size] + gap;
    }
    this.select(objs);
    this.touch();
    return true;
  }

  /**
   * Give every unlocked layer of a multi-selection the key layer's width,
   * height or both (`dimension`: 'width' | 'height' | 'both') — the size the
   * Properties boxes show, along the layer's own sides. Boxes and triangles
   * take it as width/height, pictures and groups as scale; a text box takes a
   * width (its height follows its words), so it sits out a height match. Each
   * layer keeps its top-left corner. Returns `{changed, skipped}`, or false
   * below two layers.
   */
  matchSize(dimension = 'width') {
    if (this.selection().length < 2) return false;
    const key = this.keyLayer();
    const width = key.getScaledWidth();
    const height = key.getScaledHeight();
    const wantW = dimension === 'width' || dimension === 'both';
    const wantH = dimension === 'height' || dimension === 'both';
    const others = unlocked(this.selection()).filter((obj) => obj !== key);
    // Members of a multi-selection hold selection-relative coordinates, and
    // the selection box must be redrawn around the new sizes: drop it, resize
    // in card coordinates, select again.
    const objs = this.memberSelection();
    let changed = 0;
    let skipped = 0;
    for (const obj of others) {
      const text = obj.type === 'textbox';
      if (text && !wantW) {
        skipped += 1;
        continue;
      }
      const before = `${obj.getScaledWidth()}x${obj.getScaledHeight()}`;
      const corner = obj.getPointByOrigin('left', 'top');
      if (wantW) {
        if (text) obj.set('width', Math.max(1, width) / (obj.scaleX || 1));
        else obj.set('scaleX', Math.max(1, width) / (obj.width || 1));
      }
      if (wantH && !text) obj.set('scaleY', Math.max(1, height) / (obj.height || 1));
      if (text) {
        obj.initDimensions?.();
        if (obj.tcgAutoFit) this.autoFitText(obj);
      }
      this.bakeScale(obj);
      obj.setPositionByOrigin(corner, 'left', 'top');
      obj.setCoords();
      if (`${obj.getScaledWidth()}x${obj.getScaledHeight()}` !== before) changed += 1;
      if (text && wantH) skipped += 1;
    }
    this.select(objs);
    if (changed) this.touch();
    return { changed, skipped };
  }

  nudge(dx, dy) {
    const objs = unlocked(this.selection());
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

  /** Turn `{name}` tokens in a text layer into icons. True if it changed. */
  expandIconsIn(obj) {
    if (!obj || !isTextObject(obj) || typeof obj.text !== 'string') return false;
    const text = expandIcons(obj.text);
    if (text === obj.text) return false;
    obj.set('text', text);
    if (obj.tcgAutoFit) this.autoFitText(obj);
    this.canvas.requestRenderAll();
    return true;
  }

  /** Measure every text layer again, as after a font arrives. */
  remeasureText() {
    if (!this.canvas) return;
    fabric.cache.clearFontCache();
    const walk = (list) => {
      for (const obj of list) {
        if (isTextObject(obj)) {
          obj.initDimensions?.();
          if (obj.tcgAutoFit) this.autoFitText(obj);
          obj.dirty = true;
        }
        if (obj.getObjects) walk(obj.getObjects());
      }
    };
    walk(this.objects());
    this.canvas.requestRenderAll();
  }

  findBySlot(slot) {
    return this.objects().filter((o) => o.tcgSlot === slot);
  }

  /**
   * Show or hide every layer whose `tcgShowIf` names a slot, by whether that
   * slot holds anything right now.
   *
   * This is what lets a spreadsheet leave a cell blank and lose the ornament
   * behind it — the gem under a cost, the plate under power and toughness —
   * rather than only the words. It runs on every change, so the card, the
   * batch renderer and the export all see the same answer without any of them
   * having to ask. A conditional layer's visibility belongs to its condition;
   * the Layers and Properties panels say so instead of offering a toggle that
   * would be overruled on the next keystroke.
   */
  applyConditions() {
    if (!this.canvas) return false;
    let changed = false;
    for (const obj of this.objects()) {
      const rule = parseShowIf(obj.tcgShowIf);
      if (!rule) continue;
      const shown = slotFilled(this.findBySlot(rule.slot)) !== rule.negate;
      if ((obj.visible !== false) === shown) continue;
      obj.set('visible', shown);
      changed = true;
    }
    if (changed) this.canvas.requestRenderAll();
    return changed;
  }

  /**
   * The position of the card on the canvas within its set, as `{n, total}`.
   * A batch, export or print run sets it per row; otherwise it is the active
   * card of the project's list (a project that has never been given a list is
   * one card on its own).
   */
  cardNumber() {
    if (this.numberContext) return this.numberContext;
    const cards = state.project.cards;
    if (!cards?.length) return { n: 1, total: 1 };
    return { n: (state.project.activeCard | 0) + 1, total: cards.length };
  }

  /** Point numbering at one row of a run, or back at the project with null. */
  setNumberContext(context) {
    this.numberContext = context;
    this.applyNumbering();
  }

  /**
   * Rewrite every numbered text layer (`tcgNumbering`, e.g. "{n:3}/{total}")
   * from the card's place in its set. The pattern is the truth and the text is
   * derived from it, the way a condition owns a layer's visibility: the text
   * cannot be typed into while a pattern is set, and it is not a card value.
   */
  applyNumbering() {
    if (!this.canvas) return false;
    const number = this.cardNumber();
    let changed = false;
    for (const obj of this.objects()) {
      if (!isTextObject(obj)) continue;
      const pattern = numberingOf(obj);
      obj.editable = !pattern;
      if (!pattern) continue;
      let text = formatNumbering(pattern, number);
      if (obj.tcgUppercase) text = text.toUpperCase();
      if (obj.text === text) continue;
      obj.set('text', text);
      if (obj.tcgAutoFit) this.autoFitText(obj);
      changed = true;
    }
    if (changed) this.canvas.requestRenderAll();
    return changed;
  }

  touch() {
    if (this.suspendEvents) return;
    this.applyConditions();
    this.applyNumbering();
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
      // A file written by hand, or by an older version, may not agree with
      // its own conditions; the slots are the truth.
      this.applyConditions();
      this.applyNumbering();
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

  /**
   * Run something that replaces the card — opening a project, applying a
   * template — and put everything back if it throws.
   *
   * Those paths set the card size, name and fields first and load the layers
   * last, and the load is the part that fails (an image the file names has
   * gone). Fabric leaves the old layers up when it does, so what the user saw
   * afterwards was their own card, resized and renamed after a file that never
   * opened, still marked saved — and the next Save wrote that over their
   * project.
   */
  async replaceCard(load) {
    const card = { ...state.card };
    const project = { ...state.project };
    const dirty = state.dirty;
    const background = this.canvas.backgroundColor;
    const layers = this.objects().slice();
    const json = JSON.stringify(this.toJSON());
    try {
      return await load();
    } catch (err) {
      Object.assign(state.card, card);
      Object.assign(state.project, project);
      const current = this.objects();
      if (current.length !== layers.length || current.some((o, i) => o !== layers[i])) {
        await this.loadJSON(JSON.parse(json)).catch((e) => console.error('[editor] could not put the card back', e));
      }
      this.canvas.backgroundColor = background;
      this.applyCardClip();
      this.applyZoom();
      state.dirty = dirty;
      bus.emit(EVT.CARD, state.card);
      bus.emit(EVT.PROJECT, state.project);
      bus.emit(EVT.CARDS, state.project.cards);
      bus.emit(EVT.OBJECTS, this.objects());
      throw err;
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

  /**
   * A small picture of the card for the card strip.
   *
   * Unlike an export this leaves the selection alone — it runs after every
   * edit, and dropping the selection each time would make the canvas
   * impossible to work on.
   */
  thumbnail(width = 96) {
    this.exporting = true;
    try {
      return this.canvas.toDataURL({
        format: 'jpeg',
        quality: 0.8,
        multiplier: width / state.card.width / this.zoom,
        enableRetinaScaling: false,
      });
    } finally {
      this.exporting = false;
    }
  }

  /**
   * Render the card to a data URL at the requested multiplier.
   * `squareCorners` leaves the rounded-corner clip off, for a picture that is
   * going to have bleed added around it (core/bleed.js).
   */
  toDataURL({ multiplier = 2, format = 'png', quality = 0.94, transparent = false, squareCorners = false } = {}) {
    const canvas = this.canvas;
    const previousBg = canvas.backgroundColor;
    const previousClip = canvas.clipPath;
    this.exporting = true;
    canvas.discardActiveObject();
    try {
      if (transparent) canvas.backgroundColor = '';
      if (squareCorners) canvas.clipPath = null;
      canvas.renderAll();
      // Fabric sizes the picture from the canvas element, which is a whole
      // number of screen pixels at the current zoom — so a 750 px card came
      // out 749 px wide. Ask for the card's own size instead; the half pixel
      // stops a product like 1499.9999 truncating to 1499.
      const scale = multiplier / this.zoom;
      return canvas.toDataURL({
        format,
        quality,
        multiplier: scale,
        width: (state.card.width * multiplier + 0.5) / scale,
        height: (state.card.height * multiplier + 0.5) / scale,
        enableRetinaScaling: false,
      });
    } finally {
      // A render that throws must not leave the guide suppressor latched on,
      // or the safe zone and smart guides stay invisible for the rest of the
      // session — and the transparent background must not stick either.
      canvas.backgroundColor = previousBg;
      canvas.clipPath = previousClip;
      this.exporting = false;
      canvas.requestRenderAll();
    }
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

/** `"cost"` → shown while cost is filled; `"!cost"` → shown while it is empty. */
export function parseShowIf(value) {
  const raw = String(value ?? '').trim();
  const negate = raw.startsWith('!');
  const slot = (negate ? raw.slice(1) : raw).trim();
  return slot ? { slot, negate } : null;
}

/**
 * Whether a slot holds anything. Text counts once it has a visible character;
 * placed artwork counts; the dashed placeholder a template ships in an empty
 * art slot does not, and neither does a slot no layer carries.
 */
function slotFilled(objects) {
  return objects.some((o) => {
    if (o.type === 'textbox' || o.type === 'i-text' || o.type === 'text') {
      return String(o.text ?? '').trim() !== '';
    }
    return o.type === 'image';
  });
}

const isTextObject = (o) => o.type === 'textbox' || o.type === 'i-text' || o.type === 'text';

/** A layer's numbering pattern, or '' when it has none (or it is a slot). */
function numberingOf(obj) {
  // A slot's text belongs to the card; a layer cannot be both.
  if (obj.tcgSlot) return '';
  return String(obj.tcgNumbering ?? '').trim();
}

/**
 * Fill a numbering pattern. `{n}` is the card's position in the set, `{total}`
 * the number of cards in it, and either takes a width to pad to with zeros —
 * `{n:3}` gives 007, the same token the batch filename pattern uses. Anything
 * else in braces is left as typed.
 */
export function formatNumbering(pattern, { n = 1, total = 1 } = {}) {
  return String(pattern ?? '').replace(/\{(n|total)(?::(\d{1,2}))?\}/g, (_, key, pad) =>
    String(key === 'n' ? n : total).padStart(Number(pad) || 1, '0'));
}

/**
 * The layers an arranging or deleting command may touch. A locked layer can
 * still be picked from the Layers panel (to inspect or unlock it), so the lock
 * has to be honoured by the commands themselves, not only by the canvas.
 */
function unlocked(objects) {
  return objects.filter((o) => o.selectable !== false);
}

export function isTypingTarget(node) {
  if (!node) return false;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable;
}

export const editor = new Editor();
