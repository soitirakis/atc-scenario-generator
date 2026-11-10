// Session records in the browser's IndexedDB: local to this browser, no login, no server.
// When IndexedDB is unavailable (private mode, blocked site data), records are kept in memory
// for this page only and `available` is false, so the UI can say so; export still works.
const DB = 'atc-scenario-generator', STORE = 'records', VERSION = 1;

const req = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

function memoryStore(reason) {
  const m = new Map();
  return {
    available: false, reason,
    list: async () => [...m.values()].sort((a, b) => b.savedAt.localeCompare(a.savedAt)),
    get: async id => m.get(id) || null,
    put: async r => { m.set(r.id, r); },
    remove: async id => { m.delete(id); }
  };
}

/** Open the record store: IndexedDB if it works, otherwise a memory store with the reason. */
export async function openRecords(idb = globalThis.indexedDB) {
  if (!idb) return memoryStore('This browser gives the page no IndexedDB storage.');
  let db;
  try {
    db = await new Promise((resolve, reject) => {
      const r = idb.open(DB, VERSION);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'id' }); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('the store is blocked by another tab'));
    });
  } catch (e) {
    return memoryStore(`The browser refused storage (${(e && (e.name || e.message)) || 'unknown error'}), for example in a private window.`);
  }
  const tx = mode => db.transaction(STORE, mode).objectStore(STORE);
  return {
    available: true, reason: '',
    list: async () => (await req(tx('readonly').getAll())).sort((a, b) => b.savedAt.localeCompare(a.savedAt)),
    get: async id => (await req(tx('readonly').get(id))) || null,
    put: async r => { await req(tx('readwrite').put(r)); },
    remove: async id => { await req(tx('readwrite').delete(id)); }
  };
}
