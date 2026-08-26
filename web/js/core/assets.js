/*
 * Asset library — indexes the workspace/assets folders and registers any
 * fonts found there with the browser so they can be used on the canvas.
 */

import { api } from './api.js';
import { bus, EVT } from '../util/bus.js';
import { slugify } from '../util/dom.js';

/* Fonts that are safe to use with no network access. */
export const BUILTIN_FONTS = [
  'Georgia',
  'Times New Roman',
  'Palatino Linotype',
  'Book Antiqua',
  'Garamond',
  'Arial',
  'Helvetica',
  'Verdana',
  'Tahoma',
  'Trebuchet MS',
  'Segoe UI',
  'Impact',
  'Courier New',
  'Lucida Console',
  'system-ui',
];

class AssetLibrary {
  constructor() {
    this.index = {
      frames: [],
      backgrounds: [],
      icons: [],
      art: [],
      textures: [],
      fonts: [],
    };
    this.customFonts = new Map(); // family -> {family, path, source}
  }

  async refresh() {
    if (api.online) {
      try {
        const index = await api.listAssets();
        this.index = { ...this.index, ...index };
      } catch (err) {
        console.warn('[assets] refresh failed', err);
      }
    }
    await this.registerFonts();
    bus.emit(EVT.ASSETS, this.index);
    return this.index;
  }

  list(category, query = '') {
    const items = this.index[category] || [];
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        (item.group || '').toLowerCase().includes(q)
    );
  }

  count(category) {
    return (this.index[category] || []).length;
  }

  /* ---------------------------------------------------------------- fonts */

  async registerFonts() {
    const files = this.index.fonts || [];
    for (const file of files) {
      const family = fontFamilyName(file.name);
      if (this.customFonts.has(family)) continue;
      try {
        const face = new FontFace(family, `url("${api.fileURL(file.path)}")`);
        await face.load();
        document.fonts.add(face);
        this.customFonts.set(family, { family, path: file.path, source: 'workspace' });
      } catch (err) {
        console.warn(`[assets] could not load font ${file.file}`, err);
      }
    }
    bus.emit(EVT.FONTS, this.fontFamilies());
  }

  /** Register a font the user picked from disk without the backend. */
  async registerFontFromFile(file) {
    const family = fontFamilyName(file.name.replace(/\.[^.]+$/, ''));
    const buffer = await file.arrayBuffer();
    const face = new FontFace(family, buffer);
    await face.load();
    document.fonts.add(face);
    this.customFonts.set(family, { family, path: null, source: 'local' });
    bus.emit(EVT.FONTS, this.fontFamilies());
    return family;
  }

  fontFamilies() {
    return [...this.customFonts.keys()].sort().concat(BUILTIN_FONTS);
  }

  /* -------------------------------------------------------------- imports */

  /**
   * Import files into the workspace. With the backend running they are copied
   * into workspace/assets/<category>; otherwise they are kept in memory for
   * this session only.
   */
  async importFiles(fileList, category = 'art') {
    const results = [];
    for (const file of Array.from(fileList)) {
      const isFont = /\.(ttf|otf|woff2?)$/i.test(file.name);
      const targetCategory = isFont ? 'fonts' : category;

      if (api.online) {
        const dataURL = await fileToDataURL(file);
        const res = await api.uploadAsset({
          category: targetCategory,
          filename: file.name,
          dataURL,
        });
        results.push({ ...res, name: file.name });
      } else if (isFont) {
        const family = await this.registerFontFromFile(file);
        results.push({ name: file.name, family, local: true });
      } else {
        const url = URL.createObjectURL(file);
        const entry = {
          name: file.name.replace(/\.[^.]+$/, ''),
          file: file.name,
          path: null,
          url,
          group: 'session',
          size: file.size,
          local: true,
        };
        this.index[targetCategory] = [entry, ...(this.index[targetCategory] || [])];
        results.push(entry);
      }
    }
    await this.refresh();
    return results;
  }
}

function fontFamilyName(stem) {
  const clean = String(stem).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean || slugify(stem, 'Custom Font');
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export const assets = new AssetLibrary();
