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
let activeDismiss = null;

export function openModal({ title = '', body = '', buttons = [], onOpen, onClosed, wide = false } = {}) {
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
  activeDismiss = onClosed || null;
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
  // Escape and the ✕ bypass the buttons entirely, so every close has to run
  // through here: a dialog that owes its caller an answer would otherwise
  // leave a promise that can never settle.
  const closed = activeDismiss;
  activeDismiss = null;
  closed?.();
}

export function confirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let answer = false;
    openModal({
      title,
      onClosed: () => resolve(answer),
      body: el('p', { text: message, style: 'margin:0;color:var(--text-dim);line-height:1.6' }),
      buttons: [
        { label: 'Cancel', onClick: (close) => close() },
        {
          label: confirmLabel,
          primary: !danger,
          danger,
          onClick: (close) => { answer = true; close(); },
        },
      ],
    });
  });
}

export function promptDialog({ title = 'Enter a value', label = '', value = '', confirmLabel = 'OK', hint = '' }) {
  return new Promise((resolve) => {
    let answer = null;
    const input = el('input', { type: 'text', value, spellcheck: 'false' });
    const body = el('div', { class: 'stack' }, [
      el('label', { class: 'field' }, [el('span', { text: label }), input]),
      hint ? el('p', { class: 'hint', text: hint }) : null,
    ]);
    const accept = (close) => {
      answer = input.value.trim();
      close();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') accept(closeModal);
    });
    openModal({
      title,
      onClosed: () => resolve(answer),
      body,
      buttons: [
        { label: 'Cancel', onClick: (close) => close() },
        { label: confirmLabel, primary: true, onClick: accept },
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
