// js/parser.js
// Parser for Netscape bookmark exports (Chrome / Firefox / Edge "Bookmarks.html").
// Single named export. Never throws: every failure resolves to the same {ok:false} value.
// Uses only the DOMParser and URL globals; no imports.

const FAIL = {
  ok: false,
  error: "That file doesn't look like a Chrome bookmarks export",
};

export function parseNetscape(htmlText) {
  try {
    if (typeof htmlText !== 'string' || htmlText.trim() === '') return FAIL;

    // 'text/html' parsing is lenient and never yields a <parsererror> node.
    const doc = new DOMParser().parseFromString(htmlText, 'text/html');

    // Attempt 1 — structured walk starting from the first <DL>.
    const rootDL = doc.querySelector('dl');
    if (rootDL) {
      const ctx = { bookmarks: [], seen: new Set(), skipped: 0, folderCount: 0, order: 0 };
      walkRoot(rootDL, ctx);
      if (ctx.bookmarks.length > 0) {
        return { ok: true, bookmarks: ctx.bookmarks, folderCount: ctx.folderCount, skipped: ctx.skipped };
      }
    }

    // Attempt 2 — flat scan of every <a href> in document order (fresh ctx).
    const anchors = doc.querySelectorAll('a[href]');
    if (anchors.length > 0) {
      const ctx = { bookmarks: [], seen: new Set(), skipped: 0, folderCount: 0, order: 0 };
      anchors.forEach((a) => emitBookmark(a, [], ctx));
      if (ctx.bookmarks.length > 0) {
        return { ok: true, bookmarks: ctx.bookmarks, folderCount: 0, skipped: ctx.skipped };
      }
    }

    // Attempt 3 — nothing usable.
    return FAIL;
  } catch (_e) {
    return FAIL;
  }
}

// --- DOM helpers: manual .children iteration + UPPERCASE tagName checks (O(n); no :scope selectors) ---

function childrenOfTag(el, tag) {
  const out = [];
  const kids = el.children;
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].tagName === tag) out.push(kids[i]);
  }
  return out;
}

function firstChildOfTag(el, tag) {
  const kids = el.children;
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].tagName === tag) return kids[i];
  }
  return null;
}

// --- Walkers ---

// Root level: the personal-toolbar folder is hoisted (its children float to the root,
// it contributes no path segment and is not counted as a folder).
function walkRoot(rootDL, ctx) {
  const dts = childrenOfTag(rootDL, 'DT');
  for (let i = 0; i < dts.length; i++) {
    const dt = dts[i];
    const a = firstChildOfTag(dt, 'A');
    if (a) { emitBookmark(a, [], ctx); continue; }
    const h3 = firstChildOfTag(dt, 'H3');
    if (!h3) continue;
    const contentDL = resolveFolderDL(dt);
    if (isToolbarFolder(h3)) {
      if (contentDL) walkDL(contentDL, [], ctx);
    } else {
      const name = folderName(h3);
      ctx.folderCount++;
      if (contentDL) walkDL(contentDL, [name], ctx);
    }
  }
}

// Nested level: every H3 is a real folder (never hoisted).
function walkDL(dl, path, ctx) {
  const dts = childrenOfTag(dl, 'DT');
  for (let i = 0; i < dts.length; i++) {
    const dt = dts[i];
    const a = firstChildOfTag(dt, 'A');
    if (a) { emitBookmark(a, path, ctx); continue; }
    const h3 = firstChildOfTag(dt, 'H3');
    if (!h3) continue;
    const name = folderName(h3);
    ctx.folderCount++;
    const contentDL = resolveFolderDL(dt);
    if (contentDL) walkDL(contentDL, path.concat([name]), ctx);
  }
}

// A folder's content <DL> is either nested inside the <DT> or the <DT>'s next sibling
// (some exports explicitly close </DT> before the sibling <DL>). Empty <p> spacers are skipped.
function resolveFolderDL(dt) {
  const nested = firstChildOfTag(dt, 'DL');
  if (nested) return nested;
  let sib = dt.nextElementSibling;
  while (sib && sib.tagName === 'P' && !sib.textContent.trim()) {
    sib = sib.nextElementSibling;
  }
  return sib && sib.tagName === 'DL' ? sib : null;
}

function isToolbarFolder(h3) {
  return (h3.getAttribute('personal_toolbar_folder') || '').toLowerCase() === 'true';
}

function folderName(h3) {
  return h3.textContent.trim() || 'Folder';
}

// --- Bookmark emission ---

function emitBookmark(a, path, ctx) {
  const href = a.getAttribute('href');
  if (href == null || href.trim() === '') return; // missing href: silently ignored (not "skipped")

  let u;
  try {
    u = new URL(href);
  } catch (_e) {
    ctx.skipped++;
    return;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') { ctx.skipped++; return; }

  const url = u.href; // normalized
  const key = url + '|' + path.join('/');
  if (ctx.seen.has(key)) return; // duplicates are dropped but not counted as skipped
  ctx.seen.add(key);

  const host = u.hostname;
  const domain = (/^www\./i.test(host) && host.slice(4).includes('.')) ? host.slice(4) : host;

  const rawIcon = a.getAttribute('icon');
  const icon = rawIcon && rawIcon.startsWith('data:image/') ? rawIcon : null;

  const n = parseInt(a.getAttribute('add_date'), 10);
  const addDate = Number.isFinite(n) && n >= 0 ? n : null;

  ctx.bookmarks.push({
    title: a.textContent.trim() || host,
    url,
    domain,
    path: path.slice(),
    icon,
    addDate,
    order: ctx.order++,
  });
}
