/* Application state: card setup, current project, and persisted UI settings. */

import { bus, EVT } from '../util/bus.js';

const SETTINGS_KEY = 'tcgforge.settings.v1';

export const CARD_PRESETS = {
  poker:  { label: 'Poker / TCG', inches: [2.5, 3.5] },
  bridge: { label: 'Bridge',      inches: [2.25, 3.5] },
  tarot:  { label: 'Tarot',       inches: [2.75, 4.75] },
  square: { label: 'Square',      inches: [2.75, 2.75] },
  mini:   { label: 'Mini',        inches: [1.75, 2.5] },
};

export function presetSize(name, dpi = 300) {
  const preset = CARD_PRESETS[name];
  if (!preset) return null;
  return {
    width: Math.round(preset.inches[0] * dpi),
    height: Math.round(preset.inches[1] * dpi),
  };
}

const defaultSettings = {
  snap: true,
  guides: true,
  checker: true,
  embedImages: false,
  safeZone: false,
  bleed: false,
  dockLeft: 320,
  dockRight: 340,
  collapsed: {},
  assetCategory: 'frames',
  lastExportScale: 2,
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...defaultSettings, ...JSON.parse(raw) } : { ...defaultSettings };
  } catch {
    return { ...defaultSettings };
  }
}

export const state = {
  /* card geometry, in pixels at the chosen dpi */
  card: {
    width: 750,
    height: 1050,
    dpi: 300,
    radius: 36,
    background: '#12161f',
    preset: 'poker',
  },

  /* current project */
  project: {
    name: 'Untitled Card',
    path: null,        // workspace-relative path once saved
    templateId: null,
    fields: [],        // template field definitions currently in play
  },

  settings: loadSettings(),
  dirty: false,

  setDirty(value = true) {
    if (this.dirty === value) return;
    this.dirty = value;
    bus.emit(EVT.PROJECT, this.project);
  },

  saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      /* private mode / storage disabled — settings simply do not persist */
    }
  },

  set(key, value) {
    this.settings[key] = value;
    this.saveSettings();
  },
};
