/*
 * Backend client.
 *
 * The app is designed to work in two modes:
 *   1. served by launch.py  -> full read/write access to the workspace folder
 *   2. opened as a file://  -> everything still runs, but saving falls back to
 *      browser downloads and the asset library stays empty until files are
 *      imported manually. `api.online` tells the UI which mode it is in.
 */

import { bus, EVT } from '../util/bus.js';

class ForgeAPI {
  constructor() {
    this.online = false;
    this.info = null;
    this.base = '';
  }

  async request(path, options = {}) {
    const res = await fetch(this.base + path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      throw new Error(`Bad response from ${path} (${res.status})`);
    }
    if (!res.ok || data.ok === false) {
      throw new Error(data?.error || `Request failed: ${path} (${res.status})`);
    }
    return data;
  }

  post(path, body) {
    return this.request(path, { method: 'POST', body: JSON.stringify(body) });
  }

  /** Probe the backend once at startup. Never throws. */
  async connect() {
    try {
      const data = await this.request('/api/status');
      this.online = true;
      this.info = data;
    } catch {
      this.online = false;
      this.info = null;
    }
    bus.emit(EVT.STATUS, { online: this.online, info: this.info });
    return this.online;
  }

  async listAssets() {
    if (!this.online) return {};
    const data = await this.request('/api/assets');
    return data.assets || {};
  }

  async listTemplates() {
    if (!this.online) return [];
    const data = await this.request('/api/templates');
    return data.templates || [];
  }

  async listProjects() {
    if (!this.online) return [];
    const data = await this.request('/api/projects');
    return data.projects || [];
  }

  async readJSON(path) {
    const data = await this.request(`/api/read?path=${encodeURIComponent(path)}`);
    return JSON.parse(data.content);
  }

  writeJSON(path, value, { backup = false } = {}) {
    return this.post('/api/write', {
      path,
      content: JSON.stringify(value, null, 2),
      backup,
    });
  }

  uploadAsset({ category, filename, dataURL, group }) {
    return this.post('/api/upload', { category, filename, data: dataURL, group });
  }

  exportImage({ filename, dataURL, folder = '', overwrite = false }) {
    return this.post('/api/export', { filename, data: dataURL, folder, overwrite });
  }

  trash(path) {
    return this.post('/api/trash', { path });
  }

  /** Absolute URL for a workspace-relative asset path. */
  fileURL(path) {
    if (!path) return '';
    if (/^(data:|blob:|https?:|file:)/i.test(path)) return path;
    return `/files/${String(path).replace(/^\/+/, '')}`;
  }

  get workspacePath() {
    return this.info?.workspace || '';
  }
}

export const api = new ForgeAPI();
