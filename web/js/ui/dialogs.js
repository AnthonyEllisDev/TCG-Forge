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
let lastFocus = null;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables() {
  const root = $('#modalRoot');
  if (!root || root.hidden) return [];
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter(
    (node) => node.offsetParent !== null || node === document.activeElement
  );
}

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
  lastFocus = document.activeElement;
  activeClose = closeModal;
  activeDismiss = onClosed || null;
  onOpen?.(bodyEl);

  const firstInput = bodyEl.querySelector('input, textarea, select');
  if (firstInput) {
    firstInput.focus();
    firstInput.select?.();
  } else {
    (footEl.querySelector('.btn.primary') || focusables()[0])?.focus();
  }
  return closeModal;
}

/** Whether a dialog is on screen, so the editor's own keys can stand aside. */
export function isModalOpen() {
  return !!activeClose;
}

export function closeModal() {
  const root = $('#modalRoot');
  if (root) root.hidden = true;
  activeClose = null;
  // Whatever opened the dialog gets the keyboard back; otherwise focus is left
  // on a button that no longer exists and the next Tab restarts from the top.
  const restore = lastFocus;
  lastFocus = null;
  if (restore && document.contains(restore)) restore.focus?.();
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
      return;
    }
    // aria-modal only marks the rest of the page inert for assistive tech; it
    // does nothing to Tab, so the trap has to be built by hand or the keyboard
    // walks off into the editor behind the dialog.
    if (e.key !== 'Tab' || !activeClose) return;
    const items = focusables();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const here = document.activeElement;
    if (!$('#modalRoot').contains(here)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && here === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && here === last) {
      e.preventDefault();
      first.focus();
    }
  });
}
