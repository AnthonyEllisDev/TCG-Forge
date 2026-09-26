/*
 * Undo / redo.
 *
 * Snapshots are plain JSON strings of the canvas plus the card setup, so a
 * step restores geometry and background as well as the layers themselves.
 */

import { bus, EVT } from '../util/bus.js';
import { state } from './state.js';
import { editor } from './editor.js';

class History {
  constructor(limit = 80) {
    this.stack = [];
    this.index = -1;
    this.limit = limit;
    this.locked = false;
    this._pending = null;   // the debounced record not yet taken
  }

  attach() {
    bus.on(EVT.MODIFIED, () => {
      clearTimeout(this._pending);
      this._pending = setTimeout(() => this.flush(), 260);
    });
    this.reset();
  }

  /**
   * Record whatever is still waiting out the debounce.
   *
   * An edit made less than a debounce ago is on screen but not yet on the
   * stack, so an undo that ignored it stepped back past it to the edit before,
   * and the one after it could never be redone. Undo and redo flush first.
   */
  flush() {
    if (!this._pending) return;
    clearTimeout(this._pending);
    this._pending = null;
    this.record();
  }

  snapshot() {
    return JSON.stringify({ card: { ...state.card }, canvas: editor.toJSON() });
  }

  reset() {
    // A record still waiting from the previous canvas must not land on top of
    // the new one's first step.
    clearTimeout(this._pending);
    this._pending = null;
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
    this.flush();
    if (this.index <= 0) return false;
    this.index -= 1;
    await this.apply(this.stack[this.index]);
    return true;
  }

  async redo() {
    this.flush();
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
