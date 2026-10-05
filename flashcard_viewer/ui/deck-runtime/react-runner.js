/* Runs an AI-generated React artifact (.jsx / .tsx) fully offline.
 * React 18, Babel, Tailwind (browser build) and lucide-react are bundled; imports that only
 * exist in the original artifact environment (shadcn "@/components/ui/*", framer-motion, ...) get lightweight stand-ins.
 */
(async function () {
  const me = document.currentScript;
  const src = me.dataset.src;
  const name = me.dataset.name || 'deck.jsx';
  const rootEl = document.getElementById('root');
  const h = React.createElement;

  const showError = (title, err) => {
    const msg = String((err && (err.stack || err.message)) || err);
    rootEl.innerHTML = '';
    const box = document.createElement('div');
    box.style.cssText = 'font:14px/1.5 system-ui,sans-serif;margin:32px;padding:20px 24px;border-radius:16px;' +
      'background:#fdecea;color:#5f2120;border:1px solid #f5c2c0;max-width:860px';
    box.innerHTML = '<h2 style="margin:0 0 8px;font-size:18px"></h2><p style="margin:0 0 12px"></p><pre style="white-space:pre-wrap;font-size:12px;margin:0"></pre>';
    box.querySelector('h2').textContent = title;
    box.querySelector('p').textContent = 'Flashcard Viewer could not run this React deck. The quiz may still work if cards were found in the source.';
    box.querySelector('pre').textContent = msg;
    rootEl.appendChild(box);
    try { window.parent.postMessage({ fv: 'error', message: title + ': ' + msg.split('\n')[0] }, '*'); } catch (_) { /* */ }
  };

  const cx = (...a) => a.filter(Boolean).join(' ');
  // Minimal tailwind-merge: the deck's own classes override the stand-in's defaults.
  const groupOf = (c) => {
    const b = c.replace(/^(hover|focus|dark|disabled|md|lg|sm):/, '');
    if (/^bg-/.test(b)) return 'bg';
    if (/^text-(xs|sm|base|lg|xl|\d?xl|left|right|center|justify)$/.test(b)) return 'text-size';
    if (/^text-/.test(b)) return 'text-color';
    if (/^border-(?!\d|[xytblr]-|[xytblr]$)/.test(b) && !/^border-(solid|dashed|none)$/.test(b)) return 'border-color';
    if (/^rounded/.test(b)) return 'rounded';
    if (/^shadow/.test(b)) return 'shadow';
    if (/^(h|w)-/.test(b)) return b.slice(0, 2);
    if (/^p[xytblr]?-/.test(b)) return b.split('-')[0];
    return null;
  };
  const merge = (base, own) => {
    if (!own) return base;
    const taken = new Set(own.split(/\s+/).map(groupOf).filter(Boolean));
    return cx(base.split(/\s+/).filter((c) => !taken.has(groupOf(c))).join(' '), own);
  };
  const esm = (obj) => Object.assign({ __esModule: true, default: obj }, obj);

  // ---------- shadcn/ui stand-ins (Tailwind classes, same API surface) ----------
  const el = (tag, base) => React.forwardRef(({ className, asChild, variant, size, children, ...p }, ref) =>
    h(tag, Object.assign({ ref, className: merge(base, className) }, p), children));
  const btnVariants = {
    default: 'bg-slate-900 text-white hover:bg-slate-800',
    destructive: 'bg-red-600 text-white hover:bg-red-700',
    outline: 'border border-slate-300 bg-white hover:bg-slate-100 text-slate-900',
    secondary: 'bg-slate-100 text-slate-900 hover:bg-slate-200',
    ghost: 'hover:bg-slate-100',
    link: 'underline-offset-4 hover:underline text-slate-900',
  };
  const Button = React.forwardRef(({ className, variant = 'default', size, asChild, ...p }, ref) =>
    h('button', Object.assign({ ref, className: merge(cx('inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none',
      size === 'sm' ? 'h-9 px-3' : size === 'lg' ? 'h-11 px-8' : size === 'icon' ? 'h-10 w-10' : 'h-10 px-4 py-2',
      btnVariants[variant] || btnVariants.default), className) }, p)));
  const TabsCtx = React.createContext(null);
  const Tabs = ({ defaultValue, value, onValueChange, className, children }) => {
    const [v, setV] = React.useState(defaultValue);
    const cur = value !== undefined ? value : v;
    const set = (x) => { setV(x); onValueChange && onValueChange(x); };
    return h(TabsCtx.Provider, { value: { cur, set } }, h('div', { className }, children));
  };
  const TabsTrigger = ({ value, className, children }) => {
    const c = React.useContext(TabsCtx);
    return h('button', { className: cx('px-3 py-1.5 text-sm rounded-md', c && c.cur === value ? 'bg-white shadow' : 'opacity-70', className),
      onClick: () => c && c.set(value) }, children);
  };
  const TabsContent = ({ value, className, children }) => {
    const c = React.useContext(TabsCtx);
    return c && c.cur === value ? h('div', { className }, children) : null;
  };
  const Progress = ({ value = 0, className }) => h('div', { className: cx('relative h-2 w-full overflow-hidden rounded-full bg-slate-200', className) },
    h('div', { className: 'h-full bg-slate-900 transition-all', style: { width: Math.max(0, Math.min(100, value)) + '%' } }));
  const Switch = ({ checked, onCheckedChange, className }) => h('button', {
    role: 'switch', 'aria-checked': !!checked, onClick: () => onCheckedChange && onCheckedChange(!checked),
    className: cx('inline-flex h-6 w-11 items-center rounded-full transition', checked ? 'bg-slate-900' : 'bg-slate-300', className),
  }, h('span', { className: cx('h-5 w-5 rounded-full bg-white shadow transition', checked ? 'translate-x-5' : 'translate-x-0.5') }));
  const Slider = ({ value, defaultValue, min = 0, max = 100, step = 1, onValueChange, className }) => h('input', {
    type: 'range', min, max, step, defaultValue: (defaultValue || [])[0], value: value ? value[0] : undefined,
    onChange: (e) => onValueChange && onValueChange([+e.target.value]), className: cx('w-full', className),
  });
  const Checkbox = ({ checked, onCheckedChange, className, ...p }) => h('input', Object.assign({ type: 'checkbox', checked: !!checked,
    onChange: (e) => onCheckedChange && onCheckedChange(e.target.checked), className }, p));
  const shadcn = {
    Card: el('div', 'rounded-xl border border-slate-200 bg-white text-slate-950 shadow'),
    CardHeader: el('div', 'flex flex-col space-y-1.5 p-6'),
    CardTitle: el('h3', 'font-semibold leading-none tracking-tight'),
    CardDescription: el('p', 'text-sm text-slate-500'),
    CardContent: el('div', 'p-6 pt-0'),
    CardFooter: el('div', 'flex items-center p-6 pt-0'),
    Button, Tabs, TabsTrigger, TabsContent, Progress, Switch, Slider, Checkbox,
    TabsList: el('div', 'inline-flex items-center rounded-lg bg-slate-100 p-1'),
    Badge: el('span', 'inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold'),
    Input: el('input', 'flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm'),
    Textarea: el('textarea', 'flex min-h-[80px] w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm'),
    Label: el('label', 'text-sm font-medium'),
    Separator: el('div', 'h-px w-full bg-slate-200 my-2'),
    Alert: el('div', 'relative w-full rounded-lg border p-4'),
    AlertTitle: el('h5', 'mb-1 font-medium'),
    AlertDescription: el('div', 'text-sm'),
    ScrollArea: el('div', 'overflow-auto'),
    Skeleton: el('div', 'animate-pulse rounded-md bg-slate-200'),
  };
  const passthrough = (label) => React.forwardRef(({ children, className, ...p }, ref) => h('div', { ref, className }, children));
  const shadcnProxy = new Proxy(shadcn, {
    get: (t, k) => (k === '__esModule' ? true : k === 'default' ? t : (t[k] || (t[k] = passthrough(String(k))))),
  });

  // ---------- framer-motion stand-in: maps `animate` to CSS transitions ----------
  const MOTION_PROPS = ['initial', 'animate', 'exit', 'transition', 'variants', 'whileHover', 'whileTap', 'whileInView',
    'whileFocus', 'whileDrag', 'layout', 'layoutId', 'drag', 'dragConstraints', 'onAnimationComplete', 'viewport'];
  const toStyle = (a, variants) => {
    if (typeof a === 'string' && variants) a = variants[a];
    if (!a || typeof a !== 'object') return {};
    const s = {}; const tf = [];
    const px = (v) => (typeof v === 'number' ? v + 'px' : v);
    const deg = (v) => (typeof v === 'number' ? v + 'deg' : v);
    for (const [k, v] of Object.entries(a)) {
      if (Array.isArray(v)) continue;
      if (k === 'x') tf.push(`translateX(${px(v)})`);
      else if (k === 'y') tf.push(`translateY(${px(v)})`);
      else if (k === 'scale') tf.push(`scale(${v})`);
      else if (k === 'rotate') tf.push(`rotate(${deg(v)})`);
      else if (k === 'rotateX' || k === 'rotateY') tf.push(`${k}(${deg(v)})`);
      else if (k !== 'transition') s[k] = v;
    }
    if (tf.length) s.transform = tf.join(' ');
    return s;
  };
  const motionCache = {};
  const motionComponent = (tag) => motionCache[tag] || (motionCache[tag] = React.forwardRef((props, ref) => {
    const p = Object.assign({}, props);
    const anim = toStyle(p.animate, p.variants);
    const dur = (p.transition && p.transition.duration) || 0.4;
    MOTION_PROPS.forEach((k) => delete p[k]);
    p.style = Object.assign({ transition: `all ${dur}s ease` }, p.style || {}, anim);
    p.ref = ref;
    return h(tag, p);
  }));
  const motion = new Proxy({}, { get: (_, tag) => motionComponent(String(tag)) });
  const framer = { motion, m: motion, AnimatePresence: ({ children }) => h(React.Fragment, null, children),
    useAnimation: () => ({ start: () => Promise.resolve(), stop() {} }), useMotionValue: (v) => ({ get: () => v, set() {} }),
    useTransform: () => 0, useInView: () => true };

  // ---------- module map ----------
  const lucide = window.LucideReact || {};
  const Fallback = ({ size = 24, className }) => h('svg', { width: size, height: size, viewBox: '0 0 24 24', className,
    fill: 'none', stroke: 'currentColor', strokeWidth: 2 }, h('circle', { cx: 12, cy: 12, r: 9 }));
  const lucideProxy = new Proxy(lucide, {
    get: (t, k) => (k === '__esModule' ? true : k === 'default' ? t : (t[k] || t[String(k).replace(/Icon$/, '')] || Fallback)),
  });
  const unknownModule = (mod) => new Proxy({}, {
    get: (_, k) => {
      if (k === '__esModule') return true;
      if (typeof k !== 'string') return undefined;
      if (/^[A-Z]/.test(k) || k === 'default') {
        return ({ children }) => h('div', { title: `${mod} is not available offline`, style: { outline: '1px dashed #999', padding: 8 } }, children || `[${mod}.${k}]`);
      }
      return () => undefined;
    },
  });
  const reactMod = esm(React);
  const domMod = esm(ReactDOM);
  const requireShim = (mod) => {
    if (mod === 'react' || mod === 'react/jsx-runtime') return reactMod;
    if (mod === 'react-dom' || mod === 'react-dom/client') return domMod;
    if (mod === 'lucide-react') return lucideProxy;
    if (mod.startsWith('@/components/') || mod.startsWith('@/lib/utils') || mod.startsWith('components/ui')) {
      return mod.endsWith('utils') ? esm({ cn: cx }) : shadcnProxy;
    }
    if (mod === 'framer-motion' || mod === 'motion/react') return esm(framer);
    if (/\.(css|scss|less)$/.test(mod)) return {};
    console.warn('[flashcard-viewer] stubbed import:', mod);
    return unknownModule(mod);
  };

  class Boundary extends React.Component {
    constructor(p) { super(p); this.state = { err: null }; }
    static getDerivedStateFromError(err) { return { err }; }
    render() {
      if (this.state.err) {
        return h('pre', { style: { margin: 32, padding: 16, background: '#fdecea', color: '#5f2120', borderRadius: 12, whiteSpace: 'pre-wrap' } },
          'This React deck crashed while rendering:\n\n' + (this.state.err.stack || this.state.err));
      }
      return this.props.children;
    }
  }

  try {
    const res = await fetch(src);
    const code = await res.text();
    const ts = /\.tsx?$/i.test(name);
    const presets = [];
    if (ts) presets.push(['typescript', { isTSX: true, allExtensions: true }]);
    presets.push(['react', { runtime: 'classic' }]);
    const out = Babel.transform(code, { filename: name, presets, plugins: ['transform-modules-commonjs'], sourceType: 'module' }).code;
    const module = { exports: {} };
    // eslint-disable-next-line no-new-func
    new Function('require', 'module', 'exports', 'React', out)(requireShim, module, module.exports, React);
    const ex = module.exports;
    const Comp = ex.default || ex.App || Object.values(ex).find((v) => typeof v === 'function');
    if (!Comp) throw new Error('This file has no default export (export default function App() {...}).');
    ReactDOM.createRoot(rootEl).render(h(Boundary, null, h(Comp)));
  } catch (e) {
    showError('Could not run this React deck', e);
  }
})();
