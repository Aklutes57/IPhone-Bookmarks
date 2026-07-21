// js/app.js — Bookmark Launcher application controller (ES module).
//
// Owns UI state, rendering, navigation/history, and all feature flows. Reads
// bookmarks/accounts through storage.js (IndexedDB) and parses Chrome exports
// through parser.js. localStorage key "bl.settings" and "bl.persistRequested"
// are owned here. Implements the master Integration Contract (IC-1..IC-15).

import { parseNetscape } from './parser.js';
import * as storage from './storage.js';

/* ============================ State ============================ */

const state = {
  accounts: new Map(),        // id -> account
  bookmarks: [],              // all bookmark records
  byId: new Map(),            // id -> bookmark
  byAccount: new Map(),       // accountId -> bookmark[] (sorted by order asc)
  view: { screen: 'home', accountFilter: 'all', folderPath: [], query: '', editMode: false },
  ui: { sheet: null },        // id of the open <dialog> sheet, or null
  ready: false,
  firstRun: false,
};

let settings = { v: 1, lastAccount: null, theme: 'system', helpSeen: false };

// Transient flow state.
let importDraft = { file: null, parseResult: null };
let importBusy = false;
let importReading = false;
let importBlocked = false;
let actionCtx = null;         // { kind:'link', bookmark } | { kind:'folder', name, path }
let bookmarkCtx = null;       // opts passed to openBookmarkModal
let pendingConfirm = null;    // { resolve } for the active confirmDialog

// Long-press tracking.
let lpTimer = null, lpStart = null, lpFired = false, lpTile = null;

// Service worker.
let swReg = null, lastUpdateCheck = 0, reloadedForUpdate = false;

// Misc timers.
let searchDebounce = null;
let toastTimer = null;

const BLANK_IMG = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
const SEP = '␟';

/* ============================ DOM cache ============================ */

const dom = {};
function $(id) { return document.getElementById(id); }

function cacheDom() {
  const ids = [
    'search-input', 'search-clear', 'account-chips',
    'breadcrumb', 'btn-folder-back', 'folder-title',
    'launcher', 'grid', 'no-results', 'no-results-term', 'empty-state', 'empty-import-btn',
    'overflow-menu', 'menu-import', 'menu-add-bookmark', 'menu-toggle-edit', 'menu-manage-accounts', 'menu-help',
    'import-sheet', 'import-close', 'import-form', 'import-dropzone', 'import-file-name', 'import-file-input',
    'import-account-label', 'import-label-list', 'import-replace-warn', 'import-summary', 'import-error',
    'import-cancel', 'import-confirm',
    'bookmark-modal', 'bookmark-modal-title', 'bookmark-close', 'bookmark-form', 'bookmark-id-input',
    'bookmark-title-input', 'bookmark-url-input', 'bookmark-account-select', 'bookmark-folder-select',
    'bookmark-newfolder', 'bookmark-newfolder-input', 'bookmark-error', 'bookmark-cancel', 'bookmark-save',
    'action-sheet', 'action-sheet-title', 'action-open', 'action-edit', 'action-delete', 'action-cancel',
    'confirm-dialog', 'confirm-title', 'confirm-message', 'confirm-cancel', 'confirm-ok',
    'manage-accounts', 'manage-accounts-back', 'manage-accounts-list', 'manage-add-account',
    'help-screen', 'help-close', 'toast-region',
    'tpl-tile-link', 'tpl-tile-folder', 'tpl-chip', 'tpl-account-row', 'tpl-toast',
  ];
  for (const id of ids) dom[id] = $(id);
  // Field wrappers for the bookmark modal.
  dom.urlWrap = dom['bookmark-url-input'].closest('.field');
  dom.accountWrap = dom['bookmark-account-select'].closest('.field');
  dom.folderWrap = dom['bookmark-folder-select'].closest('.field');
}

/* ============================ Utilities ============================ */

function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const nowSec = () => Math.floor(Date.now() / 1000);

function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (((h << 5) + h) + str.charCodeAt(i)) >>> 0;
  return h;
}

function letterInfo(str) {
  const s = (str || '').trim();
  const hue = djb2(s.toLowerCase()) % 360;
  let letter = '?';
  if (s) letter = String.fromCodePoint(s.codePointAt(0)).toUpperCase();
  return { letter, hue };
}

function norm(s) { return (s || '').trim().replace(/\s+/g, ' '); }
function normSeg(s) { return norm(s).replace(/\//g, ''); }
function plural(n, w) { return n === 1 ? w : w + 's'; }
function countLabel(n, w) { return `${n} ${plural(n, w)}`; }

function isPrefix(P, path) {
  if (path.length < P.length) return false;
  for (let i = 0; i < P.length; i++) if (path[i] !== P[i]) return false;
  return true;
}

function domainOf(u) {
  const host = u.hostname.toLowerCase();
  return (/^www\./i.test(host) && host.slice(4).includes('.')) ? host.slice(4) : host;
}

function byOrderTitleId(a, b) {
  if (a.order !== b.order) return a.order - b.order;
  const t = a.title.localeCompare(b.title);
  if (t) return t;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function humanizeTime(ts) {
  if (!ts) return '';
  const then = ts * 1000;
  const diff = Math.max(0, Date.now() - then);
  const min = 60000, hour = 3600000, day = 86400000;
  if (diff < min) return 'just now';
  if (diff < hour) { const m = Math.floor(diff / min); return `${m} ${plural(m, 'minute')} ago`; }
  if (diff < day) { const h = Math.floor(diff / hour); return `${h} ${plural(h, 'hour')} ago`; }
  if (diff < 2 * day) return 'yesterday';
  if (diff < 7 * day) { const d = Math.floor(diff / day); return `${d} ${plural(d, 'day')} ago`; }
  if (diff < 28 * day) { const w = Math.floor(diff / (7 * day)); return `${w} ${plural(w, 'week')} ago`; }
  return new Date(then).toLocaleDateString();
}

/* ============================ Settings / persistence ============================ */

function loadSettings() {
  try {
    const raw = localStorage.getItem('bl.settings');
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') {
        settings = {
          v: 1,
          lastAccount: (typeof p.lastAccount === 'string') ? p.lastAccount : null,
          theme: p.theme || 'system',
          helpSeen: !!p.helpSeen,
        };
      }
    }
  } catch { /* tolerant */ }
}

function saveSettings(patch) {
  settings = { ...settings, ...patch, v: 1 };
  try { localStorage.setItem('bl.settings', JSON.stringify(settings)); } catch { /* ignore */ }
}

function maybeRequestPersist() {
  try {
    if (!localStorage.getItem('bl.persistRequested')) {
      storage.requestPersistentStorage();
      localStorage.setItem('bl.persistRequested', '1');
    }
  } catch { /* ignore */ }
}

/* ============================ Indexes ============================ */

function rebuildIndexes() {
  state.byId = new Map();
  state.byAccount = new Map();
  for (const b of state.bookmarks) {
    state.byId.set(b.id, b);
    let arr = state.byAccount.get(b.accountId);
    if (!arr) { arr = []; state.byAccount.set(b.accountId, arr); }
    arr.push(b);
  }
  for (const arr of state.byAccount.values()) arr.sort((a, b) => a.order - b.order);
}

function upsertBookmarkInState(bm) {
  const idx = state.bookmarks.findIndex((b) => b.id === bm.id);
  if (idx >= 0) state.bookmarks[idx] = bm; else state.bookmarks.push(bm);
  rebuildIndexes();
}

function removeBookmarkFromState(id) {
  state.bookmarks = state.bookmarks.filter((b) => b.id !== id);
  rebuildIndexes();
}

function replaceAccountBookmarksInState(accountId, records) {
  const others = state.bookmarks.filter((b) => b.accountId !== accountId);
  state.bookmarks = others.concat(records);
  rebuildIndexes();
}

function nextOrder(accountId) {
  const arr = state.byAccount.get(accountId) || [];
  let max = -1;
  for (const b of arr) if (b.order > max) max = b.order;
  return max + 1;
}

function folderPathsOf(accountId) {
  const arr = state.byAccount.get(accountId) || [];
  const seen = new Set();
  const paths = [];
  for (const b of arr) {
    for (let i = 1; i <= b.path.length; i++) {
      const prefix = b.path.slice(0, i);
      const key = JSON.stringify(prefix);
      if (!seen.has(key)) { seen.add(key); paths.push(prefix); }
    }
  }
  paths.sort((a, b) => a.join('/').localeCompare(b.join('/')));
  return paths;
}

/* ============================ Derived selectors ============================ */

function workingSet(accountFilter) {
  return accountFilter === 'all' ? state.bookmarks : (state.byAccount.get(accountFilter) || []);
}

function childrenOf(accountFilter, folderPath) {
  const work = workingSet(accountFilter);
  const depth = folderPath.length;
  const directBookmarks = [];
  const folderMap = new Map(); // name -> { name, count, _leaves:[] }
  for (const b of work) {
    if (!isPrefix(folderPath, b.path)) continue;
    if (b.path.length === depth) {
      directBookmarks.push(b);
    } else {
      const name = b.path[depth];
      let f = folderMap.get(name);
      if (!f) { f = { name, count: 0, _leaves: [] }; folderMap.set(name, f); }
      f.count++;
      f._leaves.push(b);
    }
  }
  const folders = [];
  for (const f of folderMap.values()) {
    const leaves = f._leaves.slice().sort(byOrderTitleId);
    folders.push({ name: f.name, count: f.count, previewBookmarks: leaves.slice(0, 4) });
  }
  folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  directBookmarks.sort(byOrderTitleId);
  return { folders, bookmarks: directBookmarks };
}

function searchResults(accountFilter, query) {
  const work = workingSet(accountFilter);
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const b of work) {
    const title = b.title.toLowerCase();
    const domain = (b.domain || '').toLowerCase();
    let rank = -1;
    if (title.startsWith(q)) rank = 0;
    else if (domain.startsWith(q)) rank = 1;
    else if (title.includes(q)) rank = 2;
    else if (domain.includes(q)) rank = 3;
    if (rank >= 0) out.push({ b, rank });
  }
  out.sort((x, y) => (x.rank !== y.rank ? x.rank - y.rank : byOrderTitleId(x.b, y.b)));
  return out.map((x) => x.b);
}

function visibleAccounts() {
  const imports = [];
  let manual = null;
  for (const acc of state.accounts.values()) {
    if (acc.kind === 'import') imports.push(acc);
    else if (acc.kind === 'manual') manual = acc;
  }
  imports.sort((a, b) => a.createdAt - b.createdAt);
  const result = imports.slice();
  if (manual && (state.byAccount.get(manual.id) || []).length > 0) result.push(manual);
  return result;
}

function accountsSorted() {
  const accs = [...state.accounts.values()];
  accs.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'manual' ? 1 : -1;
    return a.createdAt - b.createdAt;
  });
  return accs;
}

/* ============================ Rendering ============================ */

let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => { renderScheduled = false; render(); });
}

function render() {
  const body = document.body;
  body.dataset.screen = state.view.screen;
  body.dataset.edit = state.view.editMode ? 'on' : 'off';
  body.dataset.firstrun = state.firstRun ? 'on' : 'off';
  dom.launcher.classList.toggle('is-editing', state.view.editMode);

  renderChips();

  const searching = state.view.query.trim() !== '';
  const inFolder = state.view.folderPath.length > 0;
  if (inFolder && !searching) {
    dom.breadcrumb.hidden = false;
    dom['folder-title'].textContent = state.view.folderPath[state.view.folderPath.length - 1];
  } else {
    dom.breadcrumb.hidden = true;
  }

  const noAccounts = state.accounts.size === 0;
  dom['empty-state'].hidden = !noAccounts;

  dom['menu-toggle-edit'].disabled = state.bookmarks.length === 0;
  dom['menu-toggle-edit'].setAttribute('aria-pressed', state.view.editMode ? 'true' : 'false');

  dom['search-clear'].hidden = state.view.query === '';
  if (document.activeElement !== dom['search-input']) dom['search-input'].value = state.view.query;

  if (noAccounts) {
    dom['no-results'].hidden = true;
    renderGrid([]);
    return;
  }

  if (searching) {
    const results = searchResults(state.view.accountFilter, state.view.query);
    if (results.length === 0) {
      dom['no-results'].hidden = false;
      dom['no-results-term'].textContent = state.view.query.trim();
      renderGrid([]);
    } else {
      dom['no-results'].hidden = true;
      renderGrid(results.map((bm) => ({ kind: 'link', bm })));
    }
  } else {
    dom['no-results'].hidden = true;
    const { folders, bookmarks } = childrenOf(state.view.accountFilter, state.view.folderPath);
    const cells = folders.map((f) => ({ kind: 'folder', folder: f }))
      .concat(bookmarks.map((bm) => ({ kind: 'link', bm })));
    renderGrid(cells);
  }
}

function renderChips() {
  const frag = document.createDocumentFragment();
  frag.appendChild(makeChip('all', 'All'));
  for (const acc of visibleAccounts()) frag.appendChild(makeChip(acc.id, acc.label));
  dom['account-chips'].replaceChildren(frag);
}

function makeChip(id, label) {
  const btn = dom['tpl-chip'].content.firstElementChild.cloneNode(true);
  btn.dataset.accountId = id;
  btn.setAttribute('aria-selected', state.view.accountFilter === id ? 'true' : 'false');
  const dot = btn.querySelector('.chip__dot');
  if (id === 'all') dot.style.display = 'none';
  else dot.style.setProperty('--tile-hue', String(djb2(label.toLowerCase()) % 360));
  btn.querySelector('.chip__label').textContent = label;
  return btn;
}

/* --- Keyed tile pool --- */
const tilePool = new Map(); // key -> li

function renderGrid(cells) {
  const frag = document.createDocumentFragment();
  const used = new Set();
  for (const cell of cells) {
    const key = cell.kind === 'folder' ? 'f:' + cell.folder.name : 'b:' + cell.bm.id;
    used.add(key);
    let li = tilePool.get(key);
    if (!li) {
      li = cell.kind === 'folder' ? buildFolderTile(cell.folder) : buildBookmarkTile(cell.bm);
      tilePool.set(key, li);
    } else if (cell.kind === 'folder') {
      populateFolderTile(li, cell.folder);
    } else {
      populateBookmarkTile(li, cell.bm);
    }
    frag.appendChild(li);
  }
  dom.grid.replaceChildren(frag);
  for (const k of [...tilePool.keys()]) if (!used.has(k)) tilePool.delete(k);
}

function bookmarkSig(bm) {
  return `${bm.url}${SEP}${bm.title}${SEP}${bm.domain}${SEP}${bm.icon ? 1 : 0}`;
}

function buildBookmarkTile(bm) {
  const li = dom['tpl-tile-link'].content.firstElementChild.cloneNode(true);
  li.dataset.id = bm.id;
  li.dataset.kind = 'link';
  li.dataset.key = 'b:' + bm.id;
  populateBookmarkTile(li, bm);
  return li;
}

function populateBookmarkTile(li, bm) {
  const sig = bookmarkSig(bm);
  if (li.dataset.sig === sig) return;
  li.dataset.sig = sig;
  li.dataset.id = bm.id;
  const a = li.querySelector('a.tile');
  a.href = bm.url;
  const info = letterInfo(bm.domain || bm.title);
  const letter = li.querySelector('.tile__letter');
  letter.textContent = info.letter;
  letter.style.setProperty('--tile-hue', String(info.hue));
  li.querySelector('.tile__label').textContent = bm.title;
  // Favicon chain reset.
  const img = li.querySelector('.tile__favicon');
  a.classList.remove('tile--hasicon');
  img.hidden = false;
  img.dataset.stage = '0';
  img.dataset.domain = bm.domain || '';
  if (bm.icon) img.dataset.icon = bm.icon; else delete img.dataset.icon;
  img.src = faviconUrl(0, bm.domain || '', bm.icon || null);
}

function faviconUrl(stage, domain, icon) {
  switch (stage) {
    case 0: return `https://icons.duckduckgo.com/ip3/${domain}.ico`;
    case 1: return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
    case 2: return icon || null;
    default: return null;
  }
}

function buildFolderTile(folder) {
  const li = dom['tpl-tile-folder'].content.firstElementChild.cloneNode(true);
  li.dataset.kind = 'folder';
  li.dataset.name = folder.name;
  li.dataset.key = 'f:' + folder.name;
  populateFolderTile(li, folder);
  return li;
}

function populateFolderTile(li, folder) {
  const previewIds = folder.previewBookmarks.map((p) => p.id).join(',');
  const sig = `${folder.name}${SEP}${folder.count}${SEP}${previewIds}`;
  if (li.dataset.sig === sig) return;
  li.dataset.sig = sig;
  li.dataset.name = folder.name;
  li.querySelector('.tile__label').textContent = folder.name;
  const btn = li.querySelector('.tile--folder');
  btn.title = `${folder.name} (${folder.count})`;
  const cells = li.querySelectorAll('.folder-mini__cell');
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const p = folder.previewBookmarks[i];
    if (p) {
      cell.classList.remove('folder-mini__cell--empty');
      const hue = djb2((p.domain || p.title || '').toLowerCase()) % 360;
      cell.style.backgroundColor = `hsl(${hue} 55% 46%)`;
      cell.src = p.icon || BLANK_IMG;
    } else {
      cell.classList.add('folder-mini__cell--empty');
      cell.style.backgroundColor = '';
      cell.src = BLANK_IMG;
    }
  }
}

/* ============================ Navigation / history ============================ */

function snapshot() {
  return {
    screen: state.view.screen,
    accountFilter: state.view.accountFilter,
    folderPath: state.view.folderPath.slice(),
    query: state.view.query,
    editMode: state.view.editMode,
  };
}

function pushNav() { history.pushState({ bl: true, view: snapshot(), sheet: state.ui.sheet }, ''); }
function syncNav() { history.replaceState({ bl: true, view: snapshot(), sheet: state.ui.sheet }, ''); }

function initHistory() {
  history.replaceState({ bl: true, view: snapshot(), sheet: state.ui.sheet }, '');
  window.addEventListener('popstate', onPopState);
}

function onPopState(e) {
  if (!e.state || !e.state.bl) return;
  const s = e.state;
  state.view.screen = s.view.screen;
  state.view.accountFilter = s.view.accountFilter;
  state.view.folderPath = s.view.folderPath.slice();
  state.view.query = s.view.query;
  state.view.editMode = s.view.editMode;
  reconcileSheet(s.sheet);
  render();
}

function reconcileSheet(target) {
  const cur = state.ui.sheet;
  if (cur && cur !== target) {
    const el = $(cur);
    if (el && el.open) el.close();
    if (cur === 'confirm-dialog') resolveConfirm(false);
    state.ui.sheet = null;
  }
  if (target && state.ui.sheet !== target) {
    const el = $(target);
    if (el && !el.open) el.showModal();
    state.ui.sheet = target;
  }
}

// Open a sheet: push a history entry if none open, else swap in place (IC-4).
function openSheet(id) {
  const el = $(id);
  if (!el) return;
  if (state.ui.sheet) {
    const cur = $(state.ui.sheet);
    if (cur && cur.open && cur !== el) cur.close();
    state.ui.sheet = id;
    if (!el.open) el.showModal();
    syncNav();
  } else {
    state.ui.sheet = id;
    if (!el.open) el.showModal();
    pushNav();
  }
}

// Close the open sheet by rewinding one history step.
function closeSheet() {
  if (!state.ui.sheet) return;
  if (state.ui.sheet === 'import-sheet' && importBusy) return; // busy blocks dismissal
  history.back();
}

// Close the open sheet while committing a view change into the current history
// entry (used when a flow already mutated view.accountFilter / folderPath).
function closeSheetInPlace() {
  const cur = state.ui.sheet;
  if (cur) { const el = $(cur); if (el && el.open) el.close(); }
  state.ui.sheet = null;
  syncNav();
}

function enterFolder(name) {
  state.view.folderPath = state.view.folderPath.concat([name]);
  pushNav();
  render();
}

function setAccountFilter(id) {
  state.view.accountFilter = id;
  state.view.folderPath = [];
  syncNav();
  render();
}

function setQuery(q) {
  state.view.query = q;
  syncNav();
  render();
}

function setEditMode(on) {
  state.view.editMode = on;
  syncNav();
  render();
}

function hidePopover() {
  try { if (dom['overflow-menu'].matches(':popover-open')) dom['overflow-menu'].hidePopover(); } catch { /* ignore */ }
}

/* ============================ Toasts ============================ */

function toast(msg, opts = {}) {
  dom['toast-region'].replaceChildren();
  clearTimeout(toastTimer);
  const el = dom['tpl-toast'].content.firstElementChild.cloneNode(true);
  el.querySelector('.toast__msg').textContent = msg;
  const actionBtn = el.querySelector('.toast__action');
  const duration = opts.duration != null ? opts.duration : 4000;
  if (typeof opts.action === 'function') {
    actionBtn.hidden = false;
    actionBtn.textContent = opts.actionLabel || 'Reload';
    actionBtn.addEventListener('click', (ev) => { ev.stopPropagation(); opts.action(); });
    if (duration === 0) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', (ev) => { if (ev.target !== actionBtn) opts.action(); });
    }
  }
  dom['toast-region'].appendChild(el);
  if (duration > 0) toastTimer = setTimeout(() => dismissToast(el), duration);
}

function dismissToast(el) {
  el.classList.add('is-leaving');
  el.addEventListener('animationend', () => el.remove(), { once: true });
  setTimeout(() => { if (el.isConnected) el.remove(); }, 500);
}

/* ============================ Confirm dialog ============================ */

function confirmDialog({ title, message, confirmLabel = 'Delete' }) {
  return new Promise((resolve) => {
    dom['confirm-title'].textContent = title || '';
    dom['confirm-message'].textContent = message || '';
    dom['confirm-ok'].textContent = confirmLabel;
    pendingConfirm = { resolve };
    openSheet('confirm-dialog');
  });
}

function resolveConfirm(val) {
  const p = pendingConfirm;
  pendingConfirm = null;
  if (p) p.resolve(val);
}

/* ============================ Grid interaction ============================ */

function onGridClick(e) {
  const moreBtn = e.target.closest('.tile__more');
  if (moreBtn) {
    const li = moreBtn.closest('[data-kind]');
    if (li) openActionSheet(li);
    return;
  }
  const li = e.target.closest('[data-kind]');
  if (!li) return;
  const kind = li.dataset.kind;
  if (kind === 'folder') {
    e.preventDefault();
    if (state.view.editMode && state.view.accountFilter !== 'all') openActionSheet(li);
    else enterFolder(li.dataset.name);
    return;
  }
  // link tile
  if (state.view.editMode) {
    e.preventDefault();
    openActionSheet(li);
  }
  // else: allow native anchor navigation (target=_blank)
}

function onGridPointerDown(e) {
  const tile = e.target.closest('[data-kind]');
  if (!tile) return;
  if (e.target.closest('.tile__more')) return;
  lpTile = tile;
  lpStart = { x: e.clientX, y: e.clientY };
  lpFired = false;
  clearTimeout(lpTimer);
  lpTimer = setTimeout(() => {
    lpFired = true;
    if (navigator.vibrate) { try { navigator.vibrate(10); } catch { /* ignore */ } }
    if (lpTile) openActionSheet(lpTile);
  }, 500);
}

function onGridPointerMove(e) {
  if (!lpStart) return;
  const dx = e.clientX - lpStart.x, dy = e.clientY - lpStart.y;
  if (dx * dx + dy * dy > 100) { clearTimeout(lpTimer); lpStart = null; }
}

function clearLongPress() { clearTimeout(lpTimer); lpStart = null; }

function onGridClickCapture(e) {
  if (lpFired) {
    e.preventDefault();
    e.stopPropagation();
    lpFired = false;
  }
}

/* ============================ Action sheet ============================ */

function openActionSheet(tileEl) {
  const kind = tileEl.dataset.kind;
  if (kind === 'link') {
    const bm = state.byId.get(tileEl.dataset.id);
    if (!bm) return;
    actionCtx = { kind: 'link', bookmark: bm };
    dom['action-sheet-title'].textContent = bm.title;
    dom['action-open'].hidden = false;
    dom['action-open'].textContent = 'Open in new tab';
    dom['action-edit'].hidden = false;
    dom['action-edit'].textContent = 'Edit';
    dom['action-delete'].hidden = false;
    dom['action-delete'].textContent = 'Delete';
  } else {
    const name = tileEl.dataset.name;
    const path = state.view.folderPath.concat([name]);
    actionCtx = { kind: 'folder', name, path };
    dom['action-sheet-title'].textContent = name;
    dom['action-open'].hidden = false;
    dom['action-open'].textContent = 'Open';
    const single = state.view.accountFilter !== 'all';
    dom['action-edit'].hidden = !single;
    dom['action-edit'].textContent = 'Edit';
    dom['action-delete'].hidden = !single;
    dom['action-delete'].textContent = 'Delete';
  }
  openSheet('action-sheet');
}

function onActionOpen() {
  if (!actionCtx) return;
  if (actionCtx.kind === 'link') {
    window.open(actionCtx.bookmark.url, '_blank', 'noopener');
    closeSheet();
  } else {
    // Close sheet and descend in-place (replace the sheet's history entry).
    const el = $('action-sheet');
    if (el && el.open) el.close();
    state.ui.sheet = null;
    state.view.folderPath = state.view.folderPath.concat([actionCtx.name]);
    syncNav();
    render();
  }
}

function onActionEdit() {
  if (!actionCtx) return;
  if (actionCtx.kind === 'link') {
    openBookmarkModal({ kind: 'link-edit', bookmark: actionCtx.bookmark });
  } else {
    const acc = state.accounts.get(state.view.accountFilter);
    openBookmarkModal({ kind: 'folder', path: actionCtx.path, name: actionCtx.name, account: acc });
  }
}

async function onActionDelete() {
  if (!actionCtx) return;
  if (actionCtx.kind === 'link') {
    const bm = actionCtx.bookmark;
    const ok = await confirmDialog({
      title: 'Delete bookmark',
      message: `Delete '${bm.title}'? This can't be undone.`,
    });
    if (!ok) return;
    try { await storage.deleteBookmark(bm.id); }
    catch { toast("Couldn't delete. Please try again."); return; }
    removeBookmarkFromState(bm.id);
    render();
    toast('Deleted.');
  } else {
    const acc = state.accounts.get(state.view.accountFilter);
    if (!acc) return;
    const path = actionCtx.path;
    const accBms = state.byAccount.get(acc.id) || [];
    const count = accBms.filter((b) => isPrefix(path, b.path)).length;
    const ok = await confirmDialog({
      title: 'Delete folder',
      message: `Delete '${actionCtx.name}' and its ${countLabel(count, 'bookmark')}? This can't be undone.`,
    });
    if (!ok) return;
    const remaining = accBms.filter((b) => !isPrefix(path, b.path));
    const updatedAcc = { ...acc, updatedAt: nowSec() };
    try { await storage.replaceAccountBookmarks(updatedAcc, remaining); }
    catch { toast("Couldn't delete. Please try again."); return; }
    state.accounts.set(acc.id, updatedAcc);
    replaceAccountBookmarksInState(acc.id, remaining);
    render();
    toast('Folder deleted.');
  }
}

/* ============================ Import flow ============================ */

function openImportSheet(prefillLabel) {
  importDraft = { file: null, parseResult: null };
  importBusy = false;
  importReading = false;
  importBlocked = false;
  dom['import-file-input'].value = '';
  dom['import-file-name'].hidden = true;
  dom['import-file-name'].textContent = '';
  dom['import-summary'].hidden = true;
  dom['import-summary'].textContent = '';
  dom['import-error'].hidden = true;
  dom['import-error'].textContent = '';
  dom['import-replace-warn'].hidden = true;
  dom['import-replace-warn'].textContent = '';
  dom['import-replace-warn'].classList.remove('field__error');
  dom['import-account-label'].value = prefillLabel || '';
  const frag = document.createDocumentFragment();
  for (const acc of state.accounts.values()) {
    if (acc.kind === 'import') {
      const o = document.createElement('option');
      o.value = acc.label;
      frag.appendChild(o);
    }
  }
  dom['import-label-list'].replaceChildren(frag);
  updateReplaceWarning();
  updateImportSubmitState();
  openSheet('import-sheet');
}

function showImportError(msg) {
  dom['import-error'].hidden = false;
  dom['import-error'].textContent = msg;
  dom['import-summary'].hidden = true;
}

async function handleImportFile(file) {
  importDraft.file = file;
  importDraft.parseResult = null;
  dom['import-file-name'].hidden = false;
  dom['import-file-name'].textContent = file.name;
  dom['import-error'].hidden = true;
  dom['import-error'].textContent = '';
  importReading = true;
  dom['import-summary'].hidden = false;
  dom['import-summary'].textContent = 'Reading file…';
  updateImportSubmitState();

  let text;
  try {
    text = await file.text();
  } catch {
    importReading = false;
    showImportError("Couldn't read that file. Please try again.");
    updateImportSubmitState();
    return;
  }
  const result = parseNetscape(text);
  importReading = false;
  if (!result.ok) {
    importDraft.parseResult = null;
    showImportError("This doesn't look like a bookmarks file exported from Chrome. Please choose the .html file you exported.");
    updateImportSubmitState();
    return;
  }
  importDraft.parseResult = result;
  dom['import-error'].hidden = true;
  dom['import-error'].textContent = '';
  let summary = `Found ${countLabel(result.bookmarks.length, 'bookmark')} in ${countLabel(result.folderCount, 'folder')}.`;
  if (result.skipped > 0) summary += ` Skipped ${result.skipped} unsupported ${plural(result.skipped, 'link')}.`;
  dom['import-summary'].hidden = false;
  dom['import-summary'].textContent = summary;
  updateReplaceWarning();
  updateImportSubmitState();
}

function updateReplaceWarning() {
  importBlocked = false;
  const warn = dom['import-replace-warn'];
  warn.hidden = true;
  warn.textContent = '';
  warn.classList.remove('field__error');
  const label = dom['import-account-label'].value.trim();
  if (!label) return;
  const lower = label.toLowerCase();
  let manualCollision = false;
  let importTarget = null;
  for (const acc of state.accounts.values()) {
    if (acc.label.toLowerCase() === lower) {
      if (acc.kind === 'manual') manualCollision = true;
      else if (acc.kind === 'import') importTarget = acc;
    }
  }
  if (manualCollision) {
    importBlocked = true;
    warn.hidden = false;
    warn.textContent = 'That name is used by your hand-added bookmarks. Please pick another name.';
    warn.classList.add('field__error');
    return;
  }
  if (importTarget) {
    const count = (state.byAccount.get(importTarget.id) || []).length;
    warn.hidden = false;
    warn.textContent = `This will replace the ${countLabel(count, 'bookmark')} under '${importTarget.label}'.`;
  }
}

function updateImportSubmitState() {
  const label = dom['import-account-label'].value.trim();
  const enabled = !!importDraft.parseResult && label !== '' && !importBlocked && !importBusy && !importReading;
  dom['import-confirm'].disabled = !enabled;
}

async function onImportSubmit() {
  if (importBusy || importReading) return;
  if (!importDraft.parseResult) return;
  const label = dom['import-account-label'].value.trim();
  if (!label || importBlocked) return;
  importBusy = true;
  updateImportSubmitState();

  const lower = label.toLowerCase();
  let existing = null;
  for (const acc of state.accounts.values()) {
    if (acc.kind === 'import' && acc.label.toLowerCase() === lower) { existing = acc; break; }
  }
  const now = nowSec();
  const fileName = importDraft.file ? importDraft.file.name : '';
  const account = existing
    ? { ...existing, fileName, updatedAt: now }
    : { id: uuid(), label, kind: 'import', fileName, createdAt: now, updatedAt: now };
  const records = importDraft.parseResult.bookmarks.map((b) => ({
    id: uuid(), accountId: account.id,
    title: b.title, url: b.url, domain: b.domain, path: b.path.slice(),
    icon: b.icon, addDate: b.addDate, order: b.order,
  }));

  try {
    await storage.replaceAccountBookmarks(account, records);
  } catch {
    importBusy = false;
    showImportError("Couldn't save your bookmarks. Please try again.");
    updateImportSubmitState();
    return;
  }

  state.accounts.set(account.id, account);
  replaceAccountBookmarksInState(account.id, records);
  state.firstRun = false;
  state.view.accountFilter = account.id;
  state.view.folderPath = [];
  maybeRequestPersist();
  saveSettings({ lastAccount: account.id });

  const n = records.length;
  const wasExisting = !!existing;
  importBusy = false;
  closeSheetInPlace();
  render();
  toast(wasExisting
    ? `Updated '${account.label}' — now ${countLabel(n, 'bookmark')}.`
    : `Imported ${countLabel(n, 'bookmark')} into '${account.label}'.`);
  importDraft = { file: null, parseResult: null };
}

/* ============================ Bookmark modal (add / edit / rename) ============================ */

function openBookmarkModal(opts) {
  const kind = opts.kind;
  bookmarkCtx = opts;
  dom['bookmark-modal'].dataset.kind = kind;
  dom['bookmark-error'].hidden = true;
  dom['bookmark-error'].textContent = '';
  dom['bookmark-newfolder'].hidden = true;
  dom['bookmark-newfolder-input'].value = '';
  dom['bookmark-form'].noValidate = true;

  if (kind === 'link-add' || kind === 'link-edit') {
    dom['bookmark-modal-title'].textContent = kind === 'link-add' ? 'Add bookmark' : 'Edit bookmark';
    dom.urlWrap.hidden = false;
    dom.accountWrap.hidden = false;
    dom.folderWrap.hidden = false;
    const bm = opts.bookmark || null;
    populateAccountSelect(bm ? bm.accountId : null);
    populateFolderSelect(dom['bookmark-account-select'].value, bm ? bm.path : (opts.folderPath || []));
    dom['bookmark-id-input'].value = bm ? bm.id : '';
    dom['bookmark-title-input'].value = bm ? bm.title : '';
    dom['bookmark-url-input'].value = bm ? bm.url : '';
  } else if (kind === 'folder') {
    dom['bookmark-modal-title'].textContent = 'Rename folder';
    dom.urlWrap.hidden = true;
    dom.accountWrap.hidden = true;
    dom.folderWrap.hidden = true;
    dom['bookmark-id-input'].value = '';
    dom['bookmark-title-input'].value = opts.name || (opts.path ? opts.path[opts.path.length - 1] : '');
  } else if (kind === 'account') {
    dom['bookmark-modal-title'].textContent = 'Rename account';
    dom.urlWrap.hidden = true;
    dom.accountWrap.hidden = true;
    dom.folderWrap.hidden = true;
    dom['bookmark-id-input'].value = opts.account.id;
    dom['bookmark-title-input'].value = opts.account.label;
  }
  openSheet('bookmark-modal');
}

function populateAccountSelect(selectedId) {
  const accs = accountsSorted();
  const frag = document.createDocumentFragment();
  let hasManual = false;
  for (const a of accs) {
    if (a.kind === 'manual') hasManual = true;
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = a.label;
    frag.appendChild(o);
  }
  if (!hasManual) {
    const o = document.createElement('option');
    o.value = '__manual__';
    o.textContent = 'My bookmarks';
    frag.appendChild(o);
  }
  dom['bookmark-account-select'].replaceChildren(frag);
  if (selectedId == null || selectedId === '__manual__') {
    const manual = accs.find((a) => a.kind === 'manual');
    dom['bookmark-account-select'].value = manual ? manual.id : '__manual__';
  } else {
    dom['bookmark-account-select'].value = selectedId;
  }
}

function populateFolderSelect(accountId, selectedPath) {
  const frag = document.createDocumentFragment();
  const top = document.createElement('option');
  top.value = '';
  top.textContent = 'Top';
  frag.appendChild(top);
  const realId = accountId === '__manual__' ? null : accountId;
  const paths = realId ? folderPathsOf(realId) : [];
  for (const p of paths) {
    const o = document.createElement('option');
    o.value = JSON.stringify(p);
    o.textContent = p.join(' / ');
    frag.appendChild(o);
  }
  const nf = document.createElement('option');
  nf.value = '__new__';
  nf.textContent = 'New folder…';
  frag.appendChild(nf);
  dom['bookmark-folder-select'].replaceChildren(frag);

  const sel = dom['bookmark-folder-select'];
  if (selectedPath && selectedPath.length > 0) {
    const wanted = JSON.stringify(selectedPath);
    sel.value = wanted;
    if (sel.value !== wanted) sel.value = '';
  } else {
    sel.value = '';
  }
  dom['bookmark-newfolder'].hidden = sel.value !== '__new__';
}

function showBookmarkError(msg) {
  dom['bookmark-error'].hidden = false;
  dom['bookmark-error'].textContent = msg;
}

function validateUrl(raw) {
  if (!raw) return { error: 'Please enter a web address.' };
  let s = raw;
  if (!/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return { error: "That doesn't look like a valid web address." }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'Only http and https links are supported.' };
  if (!u.hostname) return { error: "That doesn't look like a valid web address." };
  return { url: u };
}

function resolveFolderPathFromSelect() {
  const val = dom['bookmark-folder-select'].value;
  if (val === '__new__') {
    const seg = normSeg(dom['bookmark-newfolder-input'].value);
    if (!seg) return { error: 'Please enter a folder name.' };
    return { path: [seg] };
  }
  if (val === '') return { path: [] };
  try { return { path: JSON.parse(val) }; }
  catch { return { path: [] }; }
}

async function ensureManualAccount() {
  for (const a of state.accounts.values()) if (a.kind === 'manual') return a.id;
  const label = uniqueLabel('My bookmarks');
  const now = nowSec();
  const acc = { id: uuid(), label, kind: 'manual', createdAt: now, updatedAt: now };
  await storage.putAccount(acc);
  state.accounts.set(acc.id, acc);
  if (!state.byAccount.has(acc.id)) state.byAccount.set(acc.id, []);
  return acc.id;
}

function uniqueLabel(base) {
  const taken = new Set();
  for (const a of state.accounts.values()) taken.add(a.label.toLowerCase());
  if (!taken.has(base.toLowerCase())) return base;
  let n = 2;
  while (taken.has(`${base} (${n})`.toLowerCase())) n++;
  return `${base} (${n})`;
}

async function onBookmarkSave() {
  const kind = bookmarkCtx ? bookmarkCtx.kind : null;
  if (kind === 'link-add') return saveLinkAdd();
  if (kind === 'link-edit') return saveLinkEdit();
  if (kind === 'folder') return saveFolderRename();
  if (kind === 'account') return saveAccountRename();
}

async function saveLinkAdd() {
  const v = validateUrl(dom['bookmark-url-input'].value.trim());
  if (v.error) { showBookmarkError(v.error); return; }
  const pathRes = resolveFolderPathFromSelect();
  if (pathRes.error) { showBookmarkError(pathRes.error); return; }
  const u = v.url;
  const domain = domainOf(u);
  const title = dom['bookmark-title-input'].value.trim() || domain;
  let accountId = dom['bookmark-account-select'].value;
  if (accountId === '__manual__') accountId = await ensureManualAccount();
  const record = {
    id: uuid(), accountId, title, url: u.href, domain, path: pathRes.path,
    icon: null, addDate: nowSec(), order: nextOrder(accountId),
  };
  try { await storage.putBookmark(record); }
  catch { showBookmarkError("Couldn't save. Please try again."); return; }
  upsertBookmarkInState(record);
  state.firstRun = false;
  maybeRequestPersist();
  if (state.view.accountFilter !== 'all' && state.view.accountFilter !== accountId) {
    state.view.accountFilter = accountId;
  }
  state.view.folderPath = record.path.slice();
  closeSheetInPlace();
  render();
  toast('Added.');
}

async function saveLinkEdit() {
  const orig = state.byId.get(bookmarkCtx.bookmark.id) || bookmarkCtx.bookmark;
  const v = validateUrl(dom['bookmark-url-input'].value.trim());
  if (v.error) { showBookmarkError(v.error); return; }
  const pathRes = resolveFolderPathFromSelect();
  if (pathRes.error) { showBookmarkError(pathRes.error); return; }
  const u = v.url;
  let accountId = dom['bookmark-account-select'].value;
  if (accountId === '__manual__') accountId = await ensureManualAccount();
  const updated = { ...orig };
  updated.url = u.href;
  updated.domain = domainOf(u);
  updated.title = dom['bookmark-title-input'].value.trim() || updated.domain;
  updated.path = pathRes.path;
  if (accountId !== orig.accountId) {
    updated.accountId = accountId;
    updated.order = nextOrder(accountId);
  }
  try { await storage.putBookmark(updated); }
  catch { showBookmarkError("Couldn't save. Please try again."); return; }
  upsertBookmarkInState(updated);
  closeSheet();
  render();
  toast('Saved.');
}

async function saveFolderRename() {
  const newSeg = normSeg(dom['bookmark-title-input'].value);
  if (!newSeg) { showBookmarkError('Please enter a folder name.'); return; }
  const P = bookmarkCtx.path;
  const acc = bookmarkCtx.account || state.accounts.get(state.view.accountFilter);
  if (!acc || !P || !P.length) { showBookmarkError('Something went wrong.'); return; }
  const newP = P.slice(0, -1).concat([newSeg]);
  const accBms = state.byAccount.get(acc.id) || [];
  const updatedAll = accBms.map((b) => (
    isPrefix(P, b.path) ? { ...b, path: newP.concat(b.path.slice(P.length)) } : b
  ));
  const updatedAcc = { ...acc, updatedAt: nowSec() };
  try { await storage.replaceAccountBookmarks(updatedAcc, updatedAll); }
  catch { showBookmarkError("Couldn't save. Please try again."); return; }
  state.accounts.set(acc.id, updatedAcc);
  replaceAccountBookmarksInState(acc.id, updatedAll);
  if (isPrefix(P, state.view.folderPath)) {
    state.view.folderPath = newP.concat(state.view.folderPath.slice(P.length));
  }
  closeSheet();
  render();
  toast('Folder renamed.');
}

async function saveAccountRename() {
  const label = norm(dom['bookmark-title-input'].value);
  if (!label) { showBookmarkError('Please enter a name.'); return; }
  const acc = bookmarkCtx.account;
  const lower = label.toLowerCase();
  for (const a of state.accounts.values()) {
    if (a.id !== acc.id && a.label.toLowerCase() === lower) {
      showBookmarkError('That name is already used.');
      return;
    }
  }
  const updated = { ...acc, label, updatedAt: nowSec() };
  try { await storage.putAccount(updated); }
  catch { showBookmarkError("Couldn't save. Please try again."); return; }
  state.accounts.set(acc.id, updated);
  closeSheet();
  render();
  toast('Renamed.');
}

/* ============================ Manage accounts screen ============================ */

function openAccountsScreen() {
  renderManageList();
  openSheet('manage-accounts');
}

function renderManageList() {
  const frag = document.createDocumentFragment();
  for (const acc of accountsSorted()) {
    const row = dom['tpl-account-row'].content.firstElementChild.cloneNode(true);
    row.dataset.accountId = acc.id;
    row.querySelector('.account-row__dot').style.setProperty('--tile-hue', String(djb2(acc.label.toLowerCase()) % 360));
    row.querySelector('.account-row__name').textContent = acc.label;
    const count = (state.byAccount.get(acc.id) || []).length;
    const src = acc.kind === 'import' ? (acc.fileName || 'Imported') : 'Added by hand';
    row.querySelector('.account-row__count').textContent =
      `${countLabel(count, 'bookmark')} · ${src} · ${humanizeTime(acc.updatedAt)}`;
    frag.appendChild(row);
  }
  dom['manage-accounts-list'].replaceChildren(frag);
}

async function onAccountDelete(acc) {
  const count = (state.byAccount.get(acc.id) || []).length;
  const ok = await confirmDialog({
    title: 'Delete account',
    message: `Delete '${acc.label}' and its ${countLabel(count, 'bookmark')}? This can't be undone.`,
  });
  if (!ok) return;
  try { await storage.deleteAccountCascade(acc.id); }
  catch { toast("Couldn't delete. Please try again."); return; }
  state.accounts.delete(acc.id);
  state.bookmarks = state.bookmarks.filter((b) => b.accountId !== acc.id);
  rebuildIndexes();
  if (state.view.accountFilter === acc.id) {
    state.view.accountFilter = 'all';
    state.view.folderPath = [];
    saveSettings({ lastAccount: 'all' });
  }
  state.firstRun = state.accounts.size === 0;
  render();
  toast('Account deleted.');
}

/* ============================ Help ============================ */

function openHelpScreen() {
  saveSettings({ helpSeen: true });
  openSheet('help-screen');
}

/* ============================ Service worker (IC-1) ============================ */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;

  navigator.serviceWorker.register('./sw.js').then((reg) => {
    swReg = reg;
    lastUpdateCheck = Date.now();
    const offer = (w) => {
      if (w) toast('Update ready — tap to reload', { duration: 0, action: () => w.postMessage({ type: 'SKIP_WAITING' }) });
    };
    offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) offer(reg.waiting || nw);
      });
    });
  }).catch(() => { /* registration failures are non-fatal */ });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && swReg && Date.now() - lastUpdateCheck >= 30 * 60 * 1000) {
      lastUpdateCheck = Date.now();
      swReg.update().catch(() => {});
    }
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloadedForUpdate) return;
    reloadedForUpdate = true;
    location.reload();
  });
}

/* ============================ Event wiring ============================ */

function wireEvents() {
  // Grid: delegated favicon load/error (capture), click, long-press.
  dom.grid.addEventListener('load', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('tile__favicon')) return;
    const tile = img.closest('.tile');
    if (tile) tile.classList.add('tile--hasicon');
  }, true);
  dom.grid.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('tile__favicon')) return;
    advanceFavicon(img);
  }, true);
  dom.grid.addEventListener('click', onGridClickCapture, true);
  dom.grid.addEventListener('click', onGridClick);
  dom.grid.addEventListener('pointerdown', onGridPointerDown);
  dom.grid.addEventListener('pointermove', onGridPointerMove);
  dom.grid.addEventListener('pointerup', clearLongPress);
  dom.grid.addEventListener('pointercancel', clearLongPress);

  // Chips.
  dom['account-chips'].addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const id = chip.dataset.accountId;
    setAccountFilter(id);
    saveSettings({ lastAccount: id });
  });

  // Breadcrumb back.
  dom['btn-folder-back'].addEventListener('click', () => history.back());

  // Search.
  dom['search-input'].addEventListener('input', () => {
    clearTimeout(searchDebounce);
    const val = dom['search-input'].value;
    searchDebounce = setTimeout(() => setQuery(val), 120);
  });
  dom['search-clear'].addEventListener('click', () => {
    dom['search-input'].value = '';
    setQuery('');
    dom['search-input'].focus();
  });

  // Empty state.
  dom['empty-import-btn'].addEventListener('click', () => openImportSheet());

  // Overflow menu.
  dom['menu-import'].addEventListener('click', () => { hidePopover(); openImportSheet(); });
  dom['menu-add-bookmark'].addEventListener('click', () => { hidePopover(); openBookmarkModal({ kind: 'link-add' }); });
  dom['menu-toggle-edit'].addEventListener('click', () => {
    hidePopover();
    if (dom['menu-toggle-edit'].disabled) return;
    setEditMode(!state.view.editMode);
  });
  dom['menu-manage-accounts'].addEventListener('click', () => { hidePopover(); openAccountsScreen(); });
  dom['menu-help'].addEventListener('click', () => { hidePopover(); openHelpScreen(); });

  // Import sheet.
  dom['import-close'].addEventListener('click', () => closeSheet());
  dom['import-cancel'].addEventListener('click', () => closeSheet());
  dom['import-form'].noValidate = true;
  dom['import-form'].addEventListener('submit', (e) => { e.preventDefault(); onImportSubmit(); });
  dom['import-file-input'].addEventListener('change', () => {
    const f = dom['import-file-input'].files && dom['import-file-input'].files[0];
    if (f) handleImportFile(f);
    dom['import-file-input'].value = '';
  });
  dom['import-account-label'].addEventListener('input', () => { updateReplaceWarning(); updateImportSubmitState(); });
  dom['import-dropzone'].addEventListener('dragover', (e) => { e.preventDefault(); dom['import-dropzone'].classList.add('is-dragover'); });
  dom['import-dropzone'].addEventListener('dragleave', () => dom['import-dropzone'].classList.remove('is-dragover'));
  dom['import-dropzone'].addEventListener('drop', (e) => {
    e.preventDefault();
    dom['import-dropzone'].classList.remove('is-dragover');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleImportFile(f);
  });

  // Bookmark modal.
  dom['bookmark-close'].addEventListener('click', () => closeSheet());
  dom['bookmark-cancel'].addEventListener('click', () => closeSheet());
  dom['bookmark-form'].addEventListener('submit', (e) => { e.preventDefault(); onBookmarkSave(); });
  dom['bookmark-account-select'].addEventListener('change', () => {
    populateFolderSelect(dom['bookmark-account-select'].value, []);
  });
  dom['bookmark-folder-select'].addEventListener('change', () => {
    dom['bookmark-newfolder'].hidden = dom['bookmark-folder-select'].value !== '__new__';
  });

  // Action sheet.
  dom['action-open'].addEventListener('click', onActionOpen);
  dom['action-edit'].addEventListener('click', onActionEdit);
  dom['action-delete'].addEventListener('click', onActionDelete);
  dom['action-cancel'].addEventListener('click', () => closeSheet());

  // Confirm dialog.
  dom['confirm-ok'].addEventListener('click', () => { const p = pendingConfirm; pendingConfirm = null; if (p) p.resolve(true); closeSheet(); });
  dom['confirm-cancel'].addEventListener('click', () => { const p = pendingConfirm; pendingConfirm = null; if (p) p.resolve(false); closeSheet(); });

  // Manage accounts.
  dom['manage-accounts-back'].addEventListener('click', () => closeSheet());
  dom['manage-add-account'].addEventListener('click', () => openImportSheet());
  dom['manage-accounts-list'].addEventListener('click', (e) => {
    const row = e.target.closest('.account-row');
    if (!row) return;
    const acc = state.accounts.get(row.dataset.accountId);
    if (!acc) return;
    if (e.target.closest('.account-row__rename')) openBookmarkModal({ kind: 'account', account: acc });
    else if (e.target.closest('.account-row__reimport')) openImportSheet(acc.label);
    else if (e.target.closest('.account-row__delete')) onAccountDelete(acc);
  });

  // Help.
  dom['help-close'].addEventListener('click', () => closeSheet());

  // Esc/cancel on every dialog routes through history so DOM + state stay in sync.
  for (const id of ['import-sheet', 'bookmark-modal', 'action-sheet', 'confirm-dialog', 'manage-accounts', 'help-screen']) {
    dom[id].addEventListener('cancel', (e) => { e.preventDefault(); closeSheet(); });
  }
}

function advanceFavicon(img) {
  let stage = parseInt(img.dataset.stage || '0', 10);
  const domain = img.dataset.domain || '';
  const icon = img.dataset.icon || null;
  while (true) {
    stage++;
    if (stage >= 3) { img.dataset.stage = '3'; img.hidden = true; return; }
    if (stage === 2 && !icon) continue; // no stored icon → skip to hidden
    img.dataset.stage = String(stage);
    img.src = faviconUrl(stage, domain, icon);
    return;
  }
}

/* ============================ Startup ============================ */

async function boot() {
  cacheDom();
  loadSettings();
  wireEvents();

  try {
    await storage.init();
    const [accounts, bookmarks] = await Promise.all([storage.getAllAccounts(), storage.getAllBookmarks()]);
    state.accounts = new Map(accounts.map((a) => [a.id, a]));
    state.bookmarks = bookmarks;
    rebuildIndexes();
  } catch {
    state.accounts = new Map();
    state.bookmarks = [];
    rebuildIndexes();
    toast('Your browser is blocking local storage');
  }

  state.firstRun = state.accounts.size === 0;
  if (settings.lastAccount && settings.lastAccount !== 'all' && state.accounts.has(settings.lastAccount)) {
    state.view.accountFilter = settings.lastAccount;
  } else {
    state.view.accountFilter = 'all';
  }

  initHistory();
  render();
  registerServiceWorker();
  state.ready = true;
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
