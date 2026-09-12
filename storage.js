export const operationId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
};
const emptyState = () => ({ config: null, cursor: 0, versions: new Map(), pending: new Map(), lastSync: null });
export function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('shiti-notebook', 2);
    request.onupgradeneeded = () => {
      for (const [name, keyPath] of [['questions', 'id'], ['sync-meta', 'key']]) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath });
    };
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => window.dispatchEvent(new Event('storage-blocked'));
  });
}
// State and questions always commit together, including edits made in other tabs.
function transaction(db, change) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['questions', 'sync-meta'], 'readwrite');
    const questions = tx.objectStore('questions'), meta = tx.objectStore('sync-meta');
    let result;
    const request = meta.get('state');
    request.onsuccess = () => {
      const state = request.result?.value || emptyState();
      const all = questions.getAll();
      all.onsuccess = () => {
        try { result = change(state, all.result, questions); meta.put({ key: 'state', value: state }); }
        catch (error) { reject(error); tx.abort(); }
      };
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('保存中断'));
  });
}
export function readSnapshot(db) { return transaction(db, (state, items) => ({ state, items })); }
export function saveRecords(db, records) {
  return transaction(db, (state, items, store) => {
    for (const record of records) {
      store.put(record);
      if (state.config) state.pending.set(record.id, { opId: operationId(), baseVersion: state.pending.get(record.id)?.baseVersion ?? state.versions.get(record.id) ?? 0 });
    }
  });
}
export function connectSync(db, config) {
  return transaction(db, (state, items) => {
    if (state.config?.serverId === config.serverId) { state.config = config; return; }
    Object.assign(state, emptyState(), { config });
    for (const item of items) state.pending.set(item.id, { opId: operationId(), baseVersion: 0 });
  });
}
export function disconnectSync(db) { return transaction(db, state => { Object.assign(state, emptyState()); }); }
export function createExchange(snapshot) {
  const { state, items } = snapshot;
  return { serverId: state.config.serverId, cursor: state.cursor, operations: [...state.pending].slice(0, 10).map(([id, pending]) => ({ ...pending, item: items.find(x => x.id === id) })).filter(x => x.item) };
}
export function applyExchange(db, sent, result, token) {
  return transaction(db, (state, items, store) => reconcileExchange(state, sent, result, token, item => store.put(item)));
}
export function reconcileExchange(state, sent, result, token, save) {
    if (state.config?.token !== token || state.config.serverId !== result.serverId) return false;
    const ack = new Set(result.acknowledgements);
    const acknowledged = new Map(sent.operations.filter(x => ack.has(x.opId)).map(x => [x.item.id, x]));
    const incoming = new Map(result.records.map(x => [x.item.id, x]));
    for (const [id, op] of acknowledged) {
      if (state.pending.get(id)?.opId === op.opId) state.pending.delete(id);
      else if (state.pending.has(id) && !result.conflictedOperations.includes(op.opId) && incoming.has(id) && incoming.get(id).version >= (state.versions.get(id) || 0)) state.pending.get(id).baseVersion = incoming.get(id).version;
    }
    for (const record of result.records) {
      if (record.version < (state.versions.get(record.item.id) || 0)) continue;
      if (!state.pending.has(record.item.id)) save(record.item);
      state.versions.set(record.item.id, record.version);
    }
    // Concurrent requests from two tabs must never rewind the shared cursor.
    state.cursor = Math.max(state.cursor, result.cursor); state.lastSync = Date.now();
    return true;
}
