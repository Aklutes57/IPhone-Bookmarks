/**
 * storage.js — IndexedDB persistence layer for Bookmark Launcher.
 *
 * This module OWNS IndexedDB and nothing else. It has no UI, never touches
 * localStorage (the `bl.settings` blob is app.js's responsibility), never
 * sorts, never generates ids or timestamps, and performs no validation.
 * Callers supply fully-formed records (id, timestamps, order already set) and
 * remain responsible for ordering and validation. Every write here resolves
 * only when its transaction commits; native DOMExceptions (e.g.
 * QuotaExceededError) propagate with `.name` intact.
 */

/**
 * @typedef {Object} Account
 * @property {string} id
 * @property {string} label
 * @property {'import'|'manual'} kind
 * @property {string} [fileName]
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} Bookmark
 * @property {string} id
 * @property {string} accountId
 * @property {string} title
 * @property {string} url
 * @property {string} domain
 * @property {string[]} path
 * @property {string} [icon]
 * @property {number|null} addDate
 * @property {number} order
 * @property {number} [hueOverride]
 */

/**
 * @typedef {Object} Usage
 * @property {string} key    // the exact bookmark URL string
 * @property {number} count
 * @property {number} lastAt
 */

const DB_NAME = 'bookmark-launcher';
const DB_VERSION = 2;
const STORE_ACCOUNTS = 'accounts';
const STORE_BOOKMARKS = 'bookmarks';
const STORE_USAGE = 'usage';
const INDEX_ACCOUNT_ID = 'accountId';

/** @type {Promise<IDBDatabase>|null} */
let dbPromise = null;
/** @type {((event: IDBVersionChangeEvent) => void)|null} */
let versionChangeHandler = null;

/**
 * Register (or clear with null) a handler invoked when another tab requests a
 * version change. This connection is closed first; the handler lets app.js
 * surface a reload prompt.
 * @param {((event: IDBVersionChangeEvent) => void)|null} fn
 */
export function setVersionChangeHandler(fn) {
  versionChangeHandler = typeof fn === 'function' ? fn : null;
}

/**
 * Resolve a read request to its result.
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function promisify(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error));
  });
}

/**
 * Resolve only on transaction 'complete'; reject on 'abort' with the first
 * observed request error, else the transaction error, else a synthetic
 * AbortError.
 * @param {IDBTransaction} tx
 * @returns {Promise<void>}
 */
function txDone(tx) {
  return new Promise((resolve, reject) => {
    let firstError = null;
    tx.addEventListener('error', (e) => {
      if (!firstError) firstError = e.target && e.target.error;
    });
    tx.addEventListener('abort', () => {
      reject(firstError || tx.error || new DOMException('Transaction aborted', 'AbortError'));
    });
    tx.addEventListener('complete', () => resolve());
  });
}

/**
 * Lazily open the singleton database connection (never at module eval).
 * @returns {Promise<IDBDatabase>}
 */
function getDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!self.indexedDB) {
      reject(new DOMException('IndexedDB unavailable', 'InvalidStateError'));
      return;
    }
    let request;
    try {
      request = self.indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    request.addEventListener('upgradeneeded', (event) => {
      const db = request.result;
      if (event.oldVersion < 1) {
        db.createObjectStore(STORE_ACCOUNTS, { keyPath: 'id' });
        const bookmarks = db.createObjectStore(STORE_BOOKMARKS, { keyPath: 'id' });
        bookmarks.createIndex(INDEX_ACCOUNT_ID, 'accountId', { unique: false });
      }
      if (event.oldVersion < 2) {
        db.createObjectStore(STORE_USAGE, { keyPath: 'key' });
      }
    });
    request.addEventListener('success', () => {
      const db = request.result;
      db.onversionchange = (event) => {
        db.close();
        dbPromise = null;
        if (versionChangeHandler) versionChangeHandler(event);
      };
      resolve(db);
    });
    request.addEventListener('error', () => reject(request.error));
    // 'blocked' is intentionally left pending (no reject): another connection
    // is holding an older version open; we wait rather than fail.
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

/**
 * Open the database eagerly so startup failures surface deterministically.
 * @returns {Promise<void>}
 */
export async function init() {
  await getDB();
}

/**
 * @returns {Promise<Account[]>} all accounts, in store order (unsorted).
 */
export async function getAllAccounts() {
  const db = await getDB();
  const tx = db.transaction(STORE_ACCOUNTS, 'readonly');
  return promisify(tx.objectStore(STORE_ACCOUNTS).getAll());
}

/**
 * @returns {Promise<Bookmark[]>} all bookmarks, in store order (unsorted).
 */
export async function getAllBookmarks() {
  const db = await getDB();
  const tx = db.transaction(STORE_BOOKMARKS, 'readonly');
  return promisify(tx.objectStore(STORE_BOOKMARKS).getAll());
}

/**
 * Upsert one account.
 * @param {Account} account
 * @returns {Promise<void>}
 */
export async function putAccount(account) {
  const db = await getDB();
  const tx = db.transaction(STORE_ACCOUNTS, 'readwrite');
  tx.objectStore(STORE_ACCOUNTS).put(account);
  return txDone(tx);
}

/**
 * Upsert one bookmark.
 * @param {Bookmark} bookmark
 * @returns {Promise<void>}
 */
export async function putBookmark(bookmark) {
  const db = await getDB();
  const tx = db.transaction(STORE_BOOKMARKS, 'readwrite');
  tx.objectStore(STORE_BOOKMARKS).put(bookmark);
  return txDone(tx);
}

/**
 * Delete one bookmark by id.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteBookmark(id) {
  const db = await getDB();
  const tx = db.transaction(STORE_BOOKMARKS, 'readwrite');
  tx.objectStore(STORE_BOOKMARKS).delete(id);
  return txDone(tx);
}

/**
 * Upsert many bookmarks in ONE transaction. All requests are issued
 * synchronously; only the commit is awaited. No chunking (one txn for 10k+).
 * @param {Bookmark[]} bookmarks
 * @returns {Promise<void>}
 */
export async function bulkPutBookmarks(bookmarks) {
  const db = await getDB();
  const tx = db.transaction(STORE_BOOKMARKS, 'readwrite');
  const store = tx.objectStore(STORE_BOOKMARKS);
  for (const bookmark of bookmarks) store.put(bookmark);
  return txDone(tx);
}

/**
 * Atomically replace every bookmark belonging to account.id with `bookmarks`
 * and upsert `account`, in ONE transaction across both stores. Existing rows
 * are removed via an index key-cursor; the new rows and account are written
 * synchronously once the cursor is exhausted. Empty cases commit cleanly.
 * @param {Account} account
 * @param {Bookmark[]} bookmarks
 * @returns {Promise<void>}
 */
export async function replaceAccountBookmarks(account, bookmarks) {
  const db = await getDB();
  const tx = db.transaction([STORE_ACCOUNTS, STORE_BOOKMARKS], 'readwrite');
  const bookmarksStore = tx.objectStore(STORE_BOOKMARKS);
  const accountsStore = tx.objectStore(STORE_ACCOUNTS);
  const cursorReq = bookmarksStore.index(INDEX_ACCOUNT_ID).openKeyCursor(IDBKeyRange.only(account.id));
  cursorReq.addEventListener('success', () => {
    const cursor = cursorReq.result;
    if (cursor) {
      bookmarksStore.delete(cursor.primaryKey);
      cursor.continue();
    } else {
      for (const bookmark of bookmarks) bookmarksStore.put(bookmark);
      accountsStore.put(account);
    }
  });
  return txDone(tx);
}

/**
 * Delete an account and all of its bookmarks in ONE transaction across both
 * stores, using the same index key-cursor delete pattern.
 * @param {string} accountId
 * @returns {Promise<void>}
 */
export async function deleteAccountCascade(accountId) {
  const db = await getDB();
  const tx = db.transaction([STORE_ACCOUNTS, STORE_BOOKMARKS], 'readwrite');
  const bookmarksStore = tx.objectStore(STORE_BOOKMARKS);
  const accountsStore = tx.objectStore(STORE_ACCOUNTS);
  const cursorReq = bookmarksStore.index(INDEX_ACCOUNT_ID).openKeyCursor(IDBKeyRange.only(accountId));
  cursorReq.addEventListener('success', () => {
    const cursor = cursorReq.result;
    if (cursor) {
      bookmarksStore.delete(cursor.primaryKey);
      cursor.continue();
    } else {
      accountsStore.delete(accountId);
    }
  });
  return txDone(tx);
}

/**
 * @returns {Promise<Usage[]>} all usage records, in store order (unsorted).
 */
export async function getAllUsage() {
  const db = await getDB();
  const tx = db.transaction(STORE_USAGE, 'readonly');
  return promisify(tx.objectStore(STORE_USAGE).getAll());
}

/**
 * Upsert one usage record. Caller supplies the fully-formed {key, count, lastAt}.
 * @param {Usage} record
 * @returns {Promise<void>}
 */
export async function putUsage(record) {
  const db = await getDB();
  const tx = db.transaction(STORE_USAGE, 'readwrite');
  tx.objectStore(STORE_USAGE).put(record);
  return txDone(tx);
}

/**
 * Delete many usage records by key in ONE transaction.
 * @param {string[]} keys
 * @returns {Promise<void>}
 */
export async function deleteUsageKeys(keys) {
  const db = await getDB();
  const tx = db.transaction(STORE_USAGE, 'readwrite');
  const store = tx.objectStore(STORE_USAGE);
  for (const key of keys) store.delete(key);
  return txDone(tx);
}

/**
 * Atomically replace the ENTIRE database (accounts, bookmarks, usage) in ONE
 * transaction across all three stores: each store is cleared, then every
 * supplied record is put synchronously. Restore primitive for full backups.
 * If a record cannot be structured-cloned (e.g. a poisoned value) the put
 * throws synchronously; the transaction is aborted so nothing commits and the
 * returned promise rejects — pre-call contents are preserved. Callers supply
 * fully-formed, validated records.
 * @param {Account[]} accounts
 * @param {Bookmark[]} bookmarks
 * @param {Usage[]} usage
 * @returns {Promise<void>}
 */
export async function replaceAll(accounts, bookmarks, usage) {
  const db = await getDB();
  const tx = db.transaction([STORE_ACCOUNTS, STORE_BOOKMARKS, STORE_USAGE], 'readwrite');
  const accountsStore = tx.objectStore(STORE_ACCOUNTS);
  const bookmarksStore = tx.objectStore(STORE_BOOKMARKS);
  const usageStore = tx.objectStore(STORE_USAGE);
  try {
    accountsStore.clear();
    bookmarksStore.clear();
    usageStore.clear();
    for (const account of accounts) accountsStore.put(account);
    for (const bookmark of bookmarks) bookmarksStore.put(bookmark);
    for (const record of usage) usageStore.put(record);
  } catch (err) {
    // A synchronous put failure (e.g. DataCloneError) leaves the transaction
    // active; abort it so the cleared/partial writes never commit.
    try { tx.abort(); } catch { /* already inactive/aborting */ }
    return txDone(tx);
  }
  return txDone(tx);
}

/**
 * Request persistent storage. Never rejects; resolves a boolean. Wraps
 * navigator.storage?.persist?.() (app.js decides when to call it).
 * @returns {Promise<boolean>}
 */
export async function requestPersistentStorage() {
  try {
    const granted = await navigator.storage?.persist?.();
    return granted === true;
  } catch {
    return false;
  }
}
