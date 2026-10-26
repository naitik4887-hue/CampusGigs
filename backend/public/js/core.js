// Shared state, helpers and small UI components used by every page.

export const state = {
  me: null, // logged-in student
  meta: null, // categories etc. from the server
  section: null, // 'services' | 'market' | null (for pages that belong to neither)
  lastSection: 'services',
  unread: 0,
};

export const $ = (sel, root = document) => root.querySelector(sel);

/* ------------------------------------------------------------------ */
/* DOM builder: text is never parsed as HTML, so user content is safe.  */
/* ------------------------------------------------------------------ */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/* ------------------------------------------------------------------ */
/* API                                                                  */
/* ------------------------------------------------------------------ */
export async function api(path, { method = 'GET', body } = {}) {
  const isBlob = typeof Blob !== 'undefined' && body instanceof Blob;
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': isBlob ? body.type : 'application/json' } : undefined,
    body: body ? (isBlob ? body : JSON.stringify(body)) : undefined,
  });
  if (res.status === 401) {
    location.href = '/login.html';
    const e = new Error('Please log in.');
    e.status = 401;
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || (res.status === 413 ? 'That file is too large.' : 'Something went wrong. Please try again.'));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export async function refreshMe() {
  const { user } = await api('/auth/me');
  state.me = user;
  updateVerifyMenu();
}

// Adds "(2) " to the browser tab title while there are unread messages.
export function applyUnreadTitle() {
  const base = document.title.replace(/^\(\d+\+?\)\s/, '');
  const n = state.unread || 0;
  document.title = n > 0 ? `(${n > 99 ? '99+' : n}) ${base}` : base;
}

export async function refreshUnread() {
  try {
    const { unread } = await api('/messages/unread-count');
    state.unread = unread;
    const badge = $('#unreadBadge');
    badge.hidden = unread === 0;
    badge.textContent = unread > 99 ? '99+' : String(unread);
    applyUnreadTitle();
  } catch (_) {
    /* ignore */
  }
}

export function updateVerifyMenu() {
  const el = $('#menuVerify');
  if (!el || !state.me) return;
  el.replaceChildren(state.me.idVerified ? 'College ID verified ✓' : 'Verify college ID');
}

/* ------------------------------------------------------------------ */
/* Section (Services / Marketplace) bookkeeping                        */
/* ------------------------------------------------------------------ */
const sectionListeners = [];
export const onSection = (fn) => sectionListeners.push(fn);
export function setSection(s) {
  state.section = s;
  if (s) state.lastSection = s;
  sectionListeners.forEach((fn) => fn(s));
}

// Pages can register a function that runs when the person leaves (used to stop timers).
let leaveFn = null;
export const onLeave = (fn) => {
  leaveFn = fn;
};
export function runLeave() {
  if (leaveFn) {
    leaveFn();
    leaveFn = null;
  }
}

/* ------------------------------------------------------------------ */
/* Formatting                                                           */
/* ------------------------------------------------------------------ */
const CURRENCY = '₹';
export const money = (n) => CURRENCY + Number(n).toLocaleString('en-IN');

export function priceLabel(l) {
  if (l.priceType === 'free') return 'Free';
  if (l.priceType === 'negotiable') return l.price == null ? 'Price negotiable' : money(l.price) + ' · negotiable';
  if (l.priceType === 'hourly') return money(l.price) + ' per hour';
  return money(l.price);
}
export const kindLabel = (k) => (k === 'offer' ? 'Offering' : 'Looking for');
export const modeLabel = (m) => ({ campus: 'On campus', online: 'Online', both: 'Campus or online' }[m] || m);
export const conditionLabel = (c) => ({ new: 'Brand new', like_new: 'Like new', good: 'Good', fair: 'Fair' }[c] || c);
export const firstName = (name) => String(name).split(' ')[0];
export const initials = (name) =>
  String(name).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
export const photoUrl = (id) => `/api/uploads/${id}`;

export function timeAgo(iso) {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr} hr ago`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d} day${d > 1 ? 's' : ''} ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function catColor(cat, section) {
  const list = section === 'item' ? state.meta.itemCategories : state.meta.serviceCategories;
  const i = Math.max(0, list.indexOf(cat));
  return section === 'item' ? `hsl(${170 + i * 22} 55% 34%)` : `hsl(${i * 40} 55% 42%)`;
}

/* ------------------------------------------------------------------ */
/* Small components                                                     */
/* ------------------------------------------------------------------ */
let toastTimer;
export function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

export const verifiedBadge = () => h('span', { class: 'verified', title: 'College ID verified' }, '✓ ID verified');

export const errorBox = (text) =>
  h('div', { class: 'notice error', role: 'alert' }, text, ' ', h('a', { href: '#/services' }, 'Back to services'));

export function emptyState({ title, text, actionText, href }) {
  return h(
    'div',
    { class: 'empty' },
    h('h3', null, title),
    h('p', null, text),
    actionText && h('a', { class: 'btn btn-primary', href }, actionText)
  );
}

export function skeletonGrid(n = 6) {
  return h(
    'div',
    { 'aria-hidden': 'true' },
    h('div', { class: 'skel skel-title' }),
    h(
      'div',
      { class: 'grid' },
      Array.from({ length: n }, () =>
        h('div', { class: 'skel-card' }, h('div', { class: 'skel skel-line tall' }), h('div', { class: 'skel skel-line w80' }), h('div', { class: 'skel skel-line w60' }))
      )
    )
  );
}

/** Field wrapper with label, optional hint and an inline error slot. */
export function field({ name, label, control, hint, counter }) {
  return h(
    'div',
    { class: 'field' },
    h('div', { class: 'field-row' }, h('label', { for: name }, label), counter || null),
    control,
    hint && h('div', { class: 'hint' }, hint),
    h('div', { class: 'field-error', 'data-error-for': name, role: 'alert' })
  );
}

/** Live "12 / 100" counter for an input or textarea. */
export function charCounter(input, max) {
  const span = h('span', { class: 'counter' }, `${input.value.length} / ${max}`);
  input.addEventListener('input', () => (span.textContent = `${input.value.length} / ${max}`));
  return span;
}

/** Shows per-field errors. Returns true when there were none. */
export function showFieldErrors(form, errors) {
  form.querySelectorAll('[data-error-for]').forEach((e) => (e.textContent = ''));
  form.querySelectorAll('[aria-invalid]').forEach((e) => e.removeAttribute('aria-invalid'));
  const names = Object.keys(errors);
  let firstFocusable = null;
  for (const name of names) {
    const out = form.querySelector(`[data-error-for="${name}"]`);
    if (out) out.textContent = errors[name];
    const input = form.querySelector(`[name="${name}"]`);
    if (input) {
      input.setAttribute('aria-invalid', 'true');
      firstFocusable = firstFocusable || input;
    }
  }
  if (firstFocusable) firstFocusable.focus();
  else if (names.length) form.querySelector(`[data-error-for="${names[0]}"]`)?.scrollIntoView({ block: 'center' });
  return names.length === 0;
}

/* ---------- dialogs (native <dialog>: focus trap + Esc for free) ---------- */
export function confirmDialog({ title, message, confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const dlg = h(
      'dialog',
      { class: 'dialog', 'aria-labelledby': 'dlgTitle' },
      h(
        'form',
        { method: 'dialog' },
        h('h2', { id: 'dlgTitle' }, title),
        h('p', null, message),
        h(
          'div',
          { class: 'dialog-actions' },
          h('button', { class: 'btn', value: 'cancel', type: 'submit' }, 'Cancel'),
          h('button', { class: 'btn ' + (danger ? 'btn-danger-solid' : 'btn-primary'), value: 'ok', type: 'submit' }, confirmText)
        )
      )
    );
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'ok');
      dlg.remove();
    });
    document.body.append(dlg);
    dlg.showModal();
  });
}

/** Asks for a short piece of text. Resolves to the text, or null if cancelled. */
export function promptDialog({ title, message, label, confirmText = 'Send', minLength = 3 }) {
  return new Promise((resolve) => {
    const ta = h('textarea', { id: 'dlgText', maxlength: 300, 'aria-label': label });
    const err = h('div', { class: 'field-error', role: 'alert' });
    let value = null;
    const form = h(
      'form',
      { method: 'dialog' },
      h('h2', { id: 'dlgTitle' }, title),
      h('p', null, message),
      ta,
      err,
      h(
        'div',
        { class: 'dialog-actions' },
        h('button', { class: 'btn', value: 'cancel', type: 'submit' }, 'Cancel'),
        h('button', { class: 'btn btn-danger-solid', value: 'ok', type: 'submit' }, confirmText)
      )
    );
    form.addEventListener('submit', (e) => {
      if (e.submitter && e.submitter.value === 'ok') {
        if (ta.value.trim().length < minLength) {
          e.preventDefault();
          err.textContent = 'Please write a short reason.';
          ta.focus();
          return;
        }
        value = ta.value.trim();
      }
    });
    const dlg = h('dialog', { class: 'dialog', 'aria-labelledby': 'dlgTitle' }, form);
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'ok' ? value : null);
      dlg.remove();
    });
    document.body.append(dlg);
    dlg.showModal();
    ta.focus();
  });
}

/* ------------------------------------------------------------------ */
/* Images: shrink to a JPEG in the browser before uploading             */
/* ------------------------------------------------------------------ */
export async function imageToJpegBlob(file, maxSide = 1200, quality = 0.82) {
  if (!file.type.startsWith('image/')) throw new Error('Please choose an image file.');
  let bitmap;
  try {
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (_) {
      bitmap = await createImageBitmap(file);
    }
  } catch (_) {
    throw new Error('That image type isn’t supported. Use a JPG or PNG photo.');
  }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; // PNGs with transparency become white instead of black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process that image.'))), 'image/jpeg', quality)
  );
}
