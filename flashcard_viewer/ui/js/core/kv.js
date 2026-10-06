// Minimal key-value store on IndexedDB (falls back to memory when IndexedDB is unavailable).
const DB = 'flashcard-viewer';
const STORE = 'kv';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbp;
}

const memory = new Map();
const tx = async (mode, fn) => {
  const db = await open();
  if (!db) return fn(null);
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = fn(store);
    t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
    t.onerror = () => reject(t.error);
  });
};

export const kv = {
  async get(key) {
    const db = await open();
    if (!db) return memory.get(key);
    return tx('readonly', (s) => s.get(key));
  },
  async set(key, value) {
    const db = await open();
    if (!db) { memory.set(key, value); return; }
    await tx('readwrite', (s) => s.put(value, key));
  },
  async del(key) {
    const db = await open();
    if (!db) { memory.delete(key); return; }
    await tx('readwrite', (s) => s.delete(key));
  },
  async keys() {
    const db = await open();
    if (!db) return [...memory.keys()];
    return tx('readonly', (s) => s.getAllKeys());
  },
};
