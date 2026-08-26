/* Toasts and the single reusable modal. */

import { $, el } from '../util/dom.js';

/* ---------------------------------------------------------------- toasts */

export function toast(message, kind = 'info', duration = 2800) {
  const host = $('#toasts');
  if (!host) return;
  const node = el('div', { class: `toast ${kind}`, text: message });
  host.append(node);
  setTimeout(() => {
    node.classList.add('fade');
    setTimeout(() => node.remove(), 260);
  }, duration);
}

/* ----------------------------------------------------------------- modal */

let activeClose = null;

export function openModal({ title = '', body = '', buttons = [], onOpen, wide = false } = {}) {
  const root = $('#modalRoot');
  const bodyEl = $('#modalBody');
  const footEl = $('#modalFoot');

  $('#modalTitle').textContent = title;
  bodyEl.innerHTML = '';
  footEl.innerHTML = '';

  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.append(body);

  for (const btn of buttons) {
    footEl.append(
      el('button', {
        class: `btn ${btn.primary ? 'primary' : ''} ${btn.danger ? 'danger' : ''}`,
        text: btn.label,
        onClick: () => btn.onClick?.(closeModal, bodyEl),
      })
    );
  }

  root.querySelector('.modal').classList.toggle('wide', !!wide);
  root.hidden = false;
  activeClose = closeModal;
  onOpen?.(bodyEl);

  const firstInput = bodyEl.querySelector('input, textarea, select');
  firstInput?.focus();
  firstInput?.select?.();
  return closeModal;
}

export function closeModal() {
  const root = $('#modalRoot');
  if (root) root.hidden = true;
  activeClose = null;
}

export function confirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    openModal({
      title,
      body: el('p', { text: message, style: 'margin:0;color:var(--text-dim);line-height:1.6' }),
      buttons: [
        { label: 'Cancel', onClick: (close) => { close(); resolve(false); } },
        {
          label: confirmLabel,
          primary: !danger,
          danger,
          onClick: (close) => { close(); resolve(true); },
        },
      ],
    });
  });
}

export function promptDialog({ title = 'Enter a value', label = '', value = '', confirmLabel = 'OK', hint = '' }) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'text', value, spellcheck: 'false' });
    const body = el('div', { class: 'stack' }, [
      el('label', { class: 'field' }, [el('span', { text: label }), input]),
      hint ? el('p', { class: 'hint', text: hint }) : null,
    ]);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        closeModal();
        resolve(input.value.trim());
      }
    });
    openModal({
      title,
      body,
      buttons: [
        { label: 'Cancel', onClick: (close) => { close(); resolve(null); } },
        { label: confirmLabel, primary: true, onClick: (close) => { close(); resolve(input.value.trim()); } },
      ],
    });
  });
}

export function initDialogs() {
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeModal();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activeClose) {
      e.preventDefault();
      closeModal();
    }
  });
}
