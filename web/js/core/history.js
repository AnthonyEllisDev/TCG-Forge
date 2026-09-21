/*
 * Undo / redo.
 *
 * Snapshots are plain JSON strings of the canvas plus the card setup, so a
 * step restores geometry and background as well as the layers themselves.
 */

import { bus, EVT } from '../util/bus.js';
import { debounce } from '../util/dom.js';
import { state } from './state.js';
import { editor } from './editor.js';

class History {
  constructor(limit = 80) {
    this.stack = [];
    this.index = -1;
    this.limit = limit;
    this.locked = false;
  }

  attach() {
    const record = debounce(() => this.record(), 260);
    bus.on(EVT.MODIFIED, record);
    this.reset();
  }

  snapshot() {
    return JSON.stringify({ card: { ...state.card }, canvas: editor.toJSON() });
  }

  reset() {
    this.stack = [this.snapshot()];
    this.index = 0;
    bus.emit(EVT.HISTORY, this.status());
  }

  record() {
    if (this.locked || !editor.canvas) return;
    const snap = this.snapshot();
    if (snap === this.stack[this.index]) return;
    this.stack = this.stack.slice(0, this.index + 1);
    this.stack.push(snap);
    if (this.stack.length > this.limit) this.stack.shift();
    this.index = this.stack.length - 1;
    bus.emit(EVT.HISTORY, this.status());
  }

  async apply(snapshot) {
    const data = JSON.parse(snapshot);
    this.locked = true;
    editor.suspendEvents = true;
    try {
      Object.assign(state.card, data.card || {});
      editor.canvas.setDimensions({ width: state.card.width, height: state.card.height });
      await editor.loadJSON(data.canvas);
      editor.canvas.backgroundColor = state.card.background || '';
      editor.applyCardClip();
      editor.applyZoom();
    } finally {
      // A step that fails to restore must still release the lock, or undo and
      // redo are dead for the rest of the session with nothing on screen to
      // say why.
      editor.suspendEvents = false;
      this.locked = false;
    }
    bus.emit(EVT.CARD, state.card);
    bus.emit(EVT.OBJECTS, editor.objects());
    bus.emit(EVT.HISTORY, this.status());
    state.setDirty(true);
  }

  async undo() {
    if (this.index <= 0) return false;
    this.index -= 1;
    await this.apply(this.stack[this.index]);
    return true;
  }

  async redo() {
    if (this.index >= this.stack.length - 1) return false;
    this.index += 1;
    await this.apply(this.stack[this.index]);
    return true;
  }

  status() {
    return {
      canUndo: this.index > 0,
      canRedo: this.index < this.stack.length - 1,
      depth: this.stack.length,
      index: this.index,
    };
  }
}

export const history = new History();
