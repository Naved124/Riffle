// Backend access. On the desktop the backend is Python, reached over Qt WebChannel
// (flashcard_viewer/bridge.py); on Android and in browsers it is the JavaScript port in ./core/.
let backend = null;
let jsMode = false;

export const ready = (async () => {
  if (window.qt && window.qt.webChannelTransport) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'qwebchannel.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('qwebchannel.js failed to load'));
      document.head.append(s);
    });
    backend = await new Promise((resolve) => {
      // eslint-disable-next-line no-undef
      new QWebChannel(window.qt.webChannelTransport, (channel) => resolve(channel.objects.backend));
    });
    return backend;
  }
  const { JsBackend } = await import('./core/backend.js');
  jsMode = true;
  backend = await new JsBackend().init();
  return backend;
})();

export const isJsBackend = () => jsMode;

/** Call a backend method. Rejects when the backend reports {error}. */
export function call(name, ...args) {
  if (!backend || typeof backend[name] !== 'function') return Promise.reject(new Error(`backend.${name} is not available`));
  if (jsMode) return Promise.resolve().then(() => backend[name](...args));
  return new Promise((resolve, reject) => {
    backend[name](...args, (raw) => {
      let v = raw;
      if (typeof raw === 'string') {
        try { v = JSON.parse(raw); } catch (_) { v = raw; }
      }
      if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.error === 'string' && Object.keys(v).length === 1) reject(new Error(v.error));
      else resolve(v);
    });
  });
}

/** Fire-and-forget call (no return value). */
export function fire(name, ...args) {
  if (backend && typeof backend[name] === 'function') backend[name](...args);
}

/** Subscribe to a backend signal. */
export function on(signal, fn) {
  if (!backend) return;
  if (jsMode) backend.on(signal, fn);
  else if (backend[signal]) backend[signal].connect(fn);
}
