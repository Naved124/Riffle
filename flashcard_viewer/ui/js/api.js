// Thin promise wrapper over the Qt WebChannel `backend` object (flashcard_viewer/bridge.py).
let backend = null;

export const ready = new Promise((resolve, reject) => {
  if (!window.qt || !window.qt.webChannelTransport) {
    reject(new Error('Qt WebChannel transport not available — run this UI inside Flashcard Viewer.'));
    return;
  }
  // eslint-disable-next-line no-undef
  new QWebChannel(window.qt.webChannelTransport, (channel) => {
    backend = channel.objects.backend;
    resolve(backend);
  });
});

/** Call a JSON-returning slot. Rejects when the slot returns {error}. */
export function call(name, ...args) {
  return new Promise((resolve, reject) => {
    if (!backend || typeof backend[name] !== 'function') {
      reject(new Error(`backend.${name} is not available`));
      return;
    }
    backend[name](...args, (raw) => {
      let v = raw;
      if (typeof raw === 'string') {
        try { v = JSON.parse(raw); } catch (_) { v = raw; }
      }
      if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.error === 'string' && Object.keys(v).length === 1) {
        reject(new Error(v.error));
      } else {
        resolve(v);
      }
    });
  });
}

/** Fire-and-forget slot (no return value). */
export function fire(name, ...args) {
  if (backend && typeof backend[name] === 'function') backend[name](...args);
}

/** Subscribe to a Qt signal. */
export function on(signal, fn) {
  if (backend && backend[signal]) backend[signal].connect(fn);
}
