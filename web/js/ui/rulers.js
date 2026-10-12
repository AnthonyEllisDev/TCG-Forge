/*
 * Rulers round the work area, and the card's own guides: placed by dragging
 * from a ruler, moved by their marks on it, and listed in Card Setup for the
 * keyboard (and for typing an exact position).
 *
 * The top ruler measures across the card, so it carries the marks of the
 * vertical guides — and, like every drawing program's ruler, it is also what
 * a horizontal guide is pulled down from. The left ruler is the same turned.
 * Everything here is in card pixels; the guides themselves are the editor's
 * (editor.addGuide() and friends), so this module only measures the screen.
 */

import { $, el, on } from '../util/dom.js';
import { bus, EVT } from '../util/bus.js';
import { state } from '../core/state.js';
import { editor } from '../core/editor.js';

const MARK_REACH = 5;      // screen px either side of a mark that grab it
const REMOVE_PAST = 8;     // screen px past the card's end that remove a guide
const STEPS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500];
const NAMES = { x: 'Vertical', y: 'Horizontal' };
const FROM = { x: 'the left edge', y: 'the top edge' };

let area = null;
let top = null;
let left = null;
let pointer = null;   // card position under the mouse, for the ruler's hairline
let drag = null;      // {axis, index|null, ruler, pointerId, at, remove}
let listKey = '';

export function initRulers() {
  area = $('#canvasArea');
  top = $('#rulerTop');
  left = $('#rulerLeft');
  if (!area || !top || !left) return;

  for (const ruler of [top, left]) {
    on(ruler, 'pointerdown', startDrag);
    on(ruler, 'pointermove', moveDrag);
    on(ruler, 'pointerup', endDrag);
    on(ruler, 'pointercancel', cancelDrag);
    on(ruler, 'lostpointercapture', cancelDrag);
    on(ruler, 'dblclick', removeAtMark);
  }
  window.addEventListener('keydown', (e) => {
    if (drag && e.key === 'Escape') {
      e.stopPropagation();
      cancelDrag();
    }
  }, true);

  const scroll = $('#canvasScroll');
  scroll?.addEventListener('scroll', draw, { passive: true });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(draw).observe(area);
  window.addEventListener('resize', draw);
  bus.on(EVT.ZOOM, draw);
  bus.on(EVT.CARD, () => {
    draw();
    renderList();
  });
  bus.on(EVT.GUIDES, () => {
    draw();
    renderList();
  });
  bus.on('editor:pointer', (p) => {
    pointer = p;
    draw();
  });

  initList();
  showRulers(editor.guidesShown());
}

/** Turns rulers and guides on or off (Ctrl+; and the Card Setup box). */
export function showRulers(shown) {
  state.set('rulers', !!shown);
  area?.classList.toggle('no-rulers', !shown);
  const box = $('#showRulers');
  if (box) box.checked = !!shown;
  editor.canvas?.requestRenderAll();
  // The fit leaves room for the rulers either way; only the drawing changes.
  draw();
}

/* ---------------------------------------------------------------- measure */

/** Where the card is on screen: its top-left corner and pixels per card px. */
function cardOnScreen() {
  const canvas = editor.canvas?.lowerCanvasEl;
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const scale = rect.width / state.card.width || editor.zoom || 1;
  return { x: rect.left, y: rect.top, scale };
}

/** The card position (along `axis`) of a pointer event. */
function cardAt(e, axis) {
  const card = cardOnScreen();
  if (!card) return NaN;
  return axis === 'x' ? (e.clientX - card.x) / card.scale : (e.clientY - card.y) / card.scale;
}

const sizeOf = (axis) => (axis === 'x' ? state.card.width : state.card.height);

/** The guide whose mark is under the pointer on this ruler, or null. */
function markUnder(e, ruler) {
  const axis = ruler === top ? 'x' : 'y';
  const card = cardOnScreen();
  if (!card) return null;
  const at = cardAt(e, axis);
  const list = editor.cardGuides()[axis];
  let best = null;
  list.forEach((value, index) => {
    const off = Math.abs(value - at) * card.scale;
    if (off <= MARK_REACH && (!best || off < best.off)) best = { axis, index, off };
  });
  return best;
}

/* ---------------------------------------------------------------- dragging */

function startDrag(e) {
  if (e.button !== 0 || drag || !editor.guidesShown()) return;
  const ruler = e.currentTarget;
  const mark = markUnder(e, ruler);
  // A mark moves its own guide; anywhere else pulls a new one out, parallel
  // to the ruler: down from the top ruler, across from the left one.
  const axis = mark ? mark.axis : ruler === top ? 'y' : 'x';
  drag = { axis, index: mark ? mark.index : null, ruler, pointerId: e.pointerId, at: NaN, remove: false, moved: false };
  ruler.setPointerCapture?.(e.pointerId);
  ruler.classList.add('dragging');
  e.preventDefault();
  if (mark) follow(e);
}

function moveDrag(e) {
  if (!drag) {
    // Not dragging: show the hand over a mark, so marks can be found.
    const ruler = e.currentTarget;
    ruler.classList.toggle('on-mark', editor.guidesShown() && !!markUnder(e, ruler));
    return;
  }
  if (e.pointerId !== drag.pointerId) return;
  drag.moved = true;
  follow(e);
}

/** Puts the dragged guide under the pointer, snapped, or marks it for removal. */
function follow(e) {
  const { axis } = drag;
  const card = cardOnScreen();
  const raw = cardAt(e, axis);
  const size = sizeOf(axis);
  const past = Number.isFinite(raw) && card && (raw * card.scale < -REMOVE_PAST || (raw - size) * card.scale > REMOVE_PAST);
  // A new guide still over the ruler it came from has not been placed yet.
  const onRuler = drag.index === null && overRuler(e, drag.ruler);
  drag.remove = !!past || onRuler;
  // Whole card pixels, unless it snaps to something that is not.
  drag.at = Math.min(Math.max(editor.snapGuide(axis, Math.round(raw)), 0), size);
  editor.showGuideDraft(drag.remove ? { axis, at: NaN, replaces: drag.index } : { axis, at: drag.at, replaces: drag.index });
  draw();
}

function overRuler(e, ruler) {
  const r = ruler.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
}

function endDrag(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const done = drag;
  finish();
  if (!done.moved && done.index !== null) return;   // a click on a mark
  if (done.index === null) {
    if (!done.remove && Number.isFinite(done.at)) editor.addGuide(done.axis, done.at);
  } else if (done.remove) {
    editor.removeGuide(done.axis, done.index);
  } else if (Number.isFinite(done.at)) {
    editor.moveGuide(done.axis, done.index, done.at);
  }
}

function cancelDrag() {
  if (drag) finish();
}

function finish() {
  const { ruler, pointerId } = drag;
  drag = null;
  ruler.classList.remove('dragging');
  if (ruler.hasPointerCapture?.(pointerId)) ruler.releasePointerCapture(pointerId);
  editor.showGuideDraft(null);
  draw();
}

function removeAtMark(e) {
  const mark = markUnder(e, e.currentTarget);
  if (mark) editor.removeGuide(mark.axis, mark.index);
}

/* ---------------------------------------------------------------- drawing */

let frame = 0;
function draw() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (!area || area.classList.contains('no-rulers')) return;
    paint(top, 'x');
    paint(left, 'y');
  });
}

function colours() {
  const css = getComputedStyle(document.documentElement);
  const read = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  return {
    bg: read('--bg-dock', '#121722'),
    card: read('--bg-raised', '#1d2534'),
    tick: read('--text-faint', '#64708a'),
    label: read('--text-dim', '#9aa6bd'),
    guide: read('--guide', '#2fb8d6'),
    pointer: read('--gold', '#f0a53a'),
  };
}

/** The tick spacing, in card px, that keeps labels about 60 screen px apart. */
function stepFor(scale) {
  return STEPS.find((s) => s * scale >= 60) || STEPS[STEPS.length - 1];
}

function paint(ruler, axis) {
  const card = cardOnScreen();
  const box = ruler.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(box.width * dpr));
  const h = Math.max(1, Math.round(box.height * dpr));
  if (ruler.width !== w) ruler.width = w;
  if (ruler.height !== h) ruler.height = h;
  const ctx = ruler.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const c = colours();
  const along = axis === 'x' ? box.width : box.height;
  const across = axis === 'x' ? box.height : box.width;
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, box.width, box.height);
  if (!card) return;

  // Screen offset of card position 0 along this ruler.
  const origin = axis === 'x' ? card.x - box.left : card.y - box.top;
  const size = sizeOf(axis);
  const pos = (at) => origin + at * card.scale;
  // Draw as if the ruler were horizontal; the left one is turned.
  ctx.save();
  if (axis === 'y') {
    ctx.translate(across, 0);
    ctx.rotate(Math.PI / 2);
  }
  ctx.fillStyle = c.card;
  ctx.fillRect(pos(0), 0, size * card.scale, across);

  const step = stepFor(card.scale);
  const minor = step / 5;
  const first = Math.floor(-origin / card.scale / minor) * minor;
  const last = (along - origin) / card.scale;
  ctx.strokeStyle = c.tick;
  ctx.fillStyle = c.label;
  ctx.lineWidth = 1;
  ctx.font = '9px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.beginPath();
  for (let at = first; at <= last; at += minor) {
    const x = Math.round(pos(at)) + 0.5;
    const major = Math.abs(at / step - Math.round(at / step)) < 1e-6;
    ctx.moveTo(x, across);
    ctx.lineTo(x, across - (major ? across * 0.6 : across * 0.25));
    if (major) ctx.fillText(String(Math.round(at)), x + 2, 1);
  }
  ctx.stroke();

  // Marks for this ruler's guides: a small wedge pointing at the card.
  if (editor.guidesShown()) {
    ctx.fillStyle = c.guide;
    editor.cardGuides()[axis].forEach((at, i) => {
      if (drag && drag.index === i && drag.axis === axis) return;
      wedge(ctx, pos(at), across);
    });
  }
  // The guide being dragged, with its position.
  if (drag && drag.axis === axis && Number.isFinite(drag.at) && !drag.remove) {
    ctx.fillStyle = c.guide;
    wedge(ctx, pos(drag.at), across);
    const text = String(Math.round(drag.at * 10) / 10);
    ctx.font = 'bold 10px system-ui, sans-serif';
    const tw = ctx.measureText(text).width + 6;
    const tx = Math.min(Math.max(pos(drag.at) + 6, 0), along - tw);
    ctx.fillRect(tx, 1, tw, across - 8);
    ctx.fillStyle = c.bg;
    ctx.fillText(text, tx + 3, 2);
  }
  // Where the mouse is.
  if (pointer && !drag) {
    const x = Math.round(pos(axis === 'x' ? pointer.x : pointer.y)) + 0.5;
    ctx.strokeStyle = c.pointer;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, across);
    ctx.stroke();
  }
  ctx.restore();
}

function wedge(ctx, x, across) {
  ctx.beginPath();
  ctx.moveTo(x - 4, across - 7);
  ctx.lineTo(x + 4, across - 7);
  ctx.lineTo(x, across);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(Math.round(x) - 0.5, 0, 1, across - 7);
}

/* ---------------------------------------------------------- Card Setup list */

function initList() {
  const box = $('#showRulers');
  const list = $('#guideList');
  if (!box || !list) return;
  on(box, 'change', () => showRulers(box.checked));
  on($('#guideAddV'), 'click', () => addAndFocus('x'));
  on($('#guideAddH'), 'click', () => addAndFocus('y'));
  on($('#guideClear'), 'click', () => {
    editor.removeAllGuides();
    $('#guideAddV')?.focus();
  });
  // Typing a position moves the guide as it is typed, like every box in the
  // panels (a later click on the canvas would otherwise lose it).
  on(list, 'input', (e) => {
    const input = e.target.closest?.('input[data-guide-at]');
    if (!input || input.value.trim() === '') return;
    const [axis, index] = input.dataset.guideAt.split(':');
    const value = Number(input.value);
    if (Number.isFinite(value)) editor.moveGuide(axis, Number(index), value);
  });
  // Leaving a box that was emptied (or pulled past the card) shows the
  // guide's real place again.
  on(list, 'focusout', () => setTimeout(renderList, 0));
  on(list, 'click', (e) => {
    const button = e.target.closest?.('[data-guide-remove]');
    if (!button) return;
    const [axis, index] = button.dataset.guideRemove.split(':');
    editor.removeGuide(axis, Number(index));
    // The rows were rebuilt; stay on the list rather than drop to the page.
    const rows = [...list.querySelectorAll('[data-guide-remove]')];
    (rows[Math.min(Number(index), rows.length - 1)] || $('#guideAddV'))?.focus();
  });
  renderList();
}

function addAndFocus(axis) {
  const index = editor.addGuide(axis, sizeOf(axis) / 2);
  if (index < 0) return;
  const input = document.getElementById(`guideAt_${axis}_${index}`);
  input?.focus();
  input?.select?.();
}

function renderList() {
  const list = $('#guideList');
  if (!list) return;
  const guides = editor.cardGuides();
  const key = `${guides.x.length}:${guides.y.length}`;
  if (key !== listKey) {
    listKey = key;
    list.innerHTML = '';
    for (const axis of ['x', 'y']) {
      guides[axis].forEach((_, i) => {
        const name = `${NAMES[axis]} guide ${i + 1}`;
        list.append(
          el('div', { class: 'guide-row', dataset: { guide: `${axis}:${i}` } }, [
            el('span', { class: 'guide-axis', text: `${NAMES[axis]} ${i + 1}`, 'aria-hidden': 'true' }),
            el('input', {
              type: 'number',
              id: `guideAt_${axis}_${i}`,
              min: '0',
              step: '1',
              dataset: { guideAt: `${axis}:${i}` },
              'aria-label': `${name}, pixels from ${FROM[axis]}`,
            }),
            el('button', {
              type: 'button',
              class: 'btn tiny',
              dataset: { guideRemove: `${axis}:${i}` },
              'aria-label': `Remove ${name.toLowerCase()}`,
              title: 'Remove this guide',
              text: '×',
            }),
          ])
        );
      });
    }
    if (!guides.x.length && !guides.y.length) list.append(el('p', { class: 'guide-empty', text: 'No guides on this card.' }));
  }
  for (const input of list.querySelectorAll('input[data-guide-at]')) {
    const [axis, index] = input.dataset.guideAt.split(':');
    input.max = String(sizeOf(axis));
    if (input !== document.activeElement) input.value = String(guides[axis][Number(index)] ?? '');
  }
  const clear = $('#guideClear');
  if (clear) clear.disabled = !guides.x.length && !guides.y.length;
}
