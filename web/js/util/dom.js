/* Tiny DOM helpers — keeps the rest of the code free of boilerplate. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const on = (target, type, handler, opts) => {
  if (!target) return () => {};
  target.addEventListener(type, handler, opts);
  return () => target.removeEventListener(type, handler, opts);
};

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const round = (value, places = 2) => {
  const f = 10 ** places;
  return Math.round(value * f) / f;
};

export function debounce(fn, wait = 180) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function throttle(fn, wait = 60) {
  let last = 0;
  let queued = null;
  return (...args) => {
    const now = performance.now();
    if (now - last >= wait) {
      last = now;
      fn(...args);
    } else {
      clearTimeout(queued);
      queued = setTimeout(() => {
        last = performance.now();
        fn(...args);
      }, wait - (now - last));
    }
  };
}

export const uid = (prefix = 'id') =>
  `${prefix}_${Math.random().toString(36).slice(2, 9)}`;

/** Normalise any CSS colour-ish string to #rrggbb for <input type="color">. */
export function toHex(value, fallback = '#000000') {
  if (!value || typeof value !== 'string') return fallback;
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) {
    return ('#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3]).toLowerCase();
  }
  const m = v.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const [r, g, b] = m[1].split(',').map((n) => parseFloat(n));
    return (
      '#' +
      [r, g, b]
        .map((n) => clamp(Math.round(n || 0), 0, 255).toString(16).padStart(2, '0'))
        .join('')
    );
  }
  return fallback;
}

export function isHex(value) {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(value || '').trim());
}

export function bytes(n) {
  if (!n && n !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** Read a File as a data URL. */
export function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/** Trigger a browser download without touching the server. */
export function downloadURL(url, filename) {
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
}

export function downloadText(text, filename, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  downloadURL(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function slugify(value, fallback = 'untitled') {
  const s = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || fallback;
}
