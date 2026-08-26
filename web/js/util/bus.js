/* Minimal pub/sub used to keep panels decoupled from the editor core. */

const listeners = new Map();

export const bus = {
  on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => bus.off(event, handler);
  },

  off(event, handler) {
    listeners.get(event)?.delete(handler);
  },

  emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const handler of Array.from(set)) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[bus] handler for "${event}" failed:`, err);
      }
    }
  },
};

/* Event names used across the app (documented in one place on purpose). */
export const EVT = {
  READY: 'app:ready',
  SELECTION: 'editor:selection',      // fabric objects array
  OBJECTS: 'editor:objects',          // layer list changed
  MODIFIED: 'editor:modified',        // anything that dirties the project
  CARD: 'editor:card',                // card size/background changed
  ZOOM: 'editor:zoom',
  HISTORY: 'history:changed',
  ASSETS: 'assets:changed',
  TEMPLATES: 'templates:changed',
  TEMPLATE_APPLIED: 'templates:applied',
  FONTS: 'fonts:changed',
  PROJECT: 'project:changed',
  STATUS: 'ui:status',
};
