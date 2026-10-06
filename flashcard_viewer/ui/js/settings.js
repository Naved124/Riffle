// Settings page: appearance, typography, icons, motion, decks, library, network, quiz, shortcuts, window, backup, about.
import { call, fire } from './api.js';
import { store, setSettings, emit } from './store.js';
import { checkForUpdates, promptUpdate, installUpdate, updateInfo, onUpdateInfo } from './update.js';
import { THEMES, VARIANTS, CATPPUCCIN_ACCENTS, previewColors, catppuccinAccentColor } from './themes.js';
import { $, $$, h, icon, fmtBytes, snackbar, dialog, confirmDialog, comboFromEvent, prettyCombo } from './util.js';

export const BUNDLED_FONTS = ['Roboto Flex', 'Roboto', 'Inter', 'Outfit', 'Lexend', 'Atkinson Hyperlegible', 'Comic Relief', 'Maple Mono', 'Comic Mono'];
export const BUNDLED_MONO = ['Maple Mono', 'Comic Mono'];
export const SHORTCUT_LABELS = {
  search: 'Search decks', openFile: 'Add deck files', newDeck: 'Create a deck', fullscreen: 'Fullscreen focus mode', focusMode: 'Focus mode (keep window)',
  quiz: 'Quiz the open deck', nextDeck: 'Next deck', prevDeck: 'Previous deck', zoomIn: 'Zoom in (deck)', zoomOut: 'Zoom out (deck)',
  zoomReset: 'Reset zoom', reload: 'Reload deck', favourite: 'Toggle favourite', library: 'Go to Library', quizPage: 'Go to Quiz',
  stats: 'Go to Stats', settings: 'Go to Settings', toggleSidebar: 'Show / hide deck list', cheatsheet: 'Shortcut cheat sheet',
};

let section = 'appearance';
let systemFonts = null;
const S = () => store.settings;

// ------------------------------------------------------------------ row builders
const row = (ic, title, desc, control) => h('div.s-row', ic ? icon(ic) : null, h('div.s-text', h('div.t', title), desc ? h('div.d', desc) : null), control);
const group = (...rows) => h('div.s-group', ...rows);
const groupTitle = (t) => h('div.s-group-title', t);

function sw(get, set) {
  const el = h('md-switch', { '.selected': !!get(), 'aria-label': 'toggle' });
  el.addEventListener('change', () => set(el.selected));
  return el;
}
function slider(get, set, { min, max, step, fmt = (v) => v, live = true }) {
  const val = h('span.slider-val', fmt(get()));
  const el = h('md-slider', { min, max, step, '.value': get(), labeled: false });
  el.addEventListener('input', () => { val.textContent = fmt(el.value); if (live) set(el.value); });
  el.addEventListener('change', () => set(el.value));
  return h('div.row.gap-s', el, val);
}
function select(get, set, options, attrs = {}) {
  const el = h('md-outlined-select', Object.assign({ '.menuPositioning': 'popover' }, attrs), options.map(([v, label]) => h('md-select-option', { value: v, '.selected': get() === v }, h('div', { slot: 'headline' }, label))));
  el.addEventListener('change', () => set(el.value));
  return el;
}
function seg(get, set, options) {
  const box = h('div.seg');
  const draw = () => {
    box.replaceChildren(...options.map(([v, label, ic]) => h('button', {
      class: get() === v ? 'on' : '', on: { click: () => { set(v); draw(); } },
    }, ic && get() !== v ? h('span.msi', { style: { fontSize: '18px' } }, ic) : null, label)));
  };
  draw();
  return box;
}

// ------------------------------------------------------------------ sections
const SECTIONS = [
  { id: 'appearance', icon: 'palette', title: 'Appearance', render: appearance },
  { id: 'typography', icon: 'text_fields', title: 'Fonts', render: typography },
  { id: 'icons', icon: 'interests', title: 'Icons', render: iconsSection },
  { id: 'motion', icon: 'animation', title: 'Motion', render: motion },
  { id: 'decks', icon: 'style', title: 'Deck display', render: decks },
  { id: 'library', icon: 'folder_open', title: 'Library & folders', render: library },
  { id: 'network', icon: 'cloud_off', title: 'Offline & network', render: network },
  { id: 'quiz', icon: 'psychology', title: 'Quiz', render: quiz },
  { id: 'shortcuts', icon: 'keyboard', title: 'Keyboard shortcuts', render: shortcuts },
  { id: 'window', icon: 'web_asset', title: 'Window & startup', render: windowSection },
  { id: 'backup', icon: 'settings_backup_restore', title: 'Backup & reset', render: backup },
  { id: 'about', icon: 'info', title: 'About', render: about },
];

function header(title, desc) {
  return [h('h1.headline-medium', title), desc ? h('p.body-medium.muted.s-desc', desc) : null];
}

function themeCard(t) {
  const a = S().appearance;
  const c = previewColors(t.id, a, store.systemScheme);
  const card = h('button.theme-card', {
    class: a.theme === t.id ? 'selected' : '', title: t.name,
    on: { click: () => { setSettings({ appearance: { theme: t.id } }); renderSection(); } },
  },
  h('div.tc-preview', { style: { background: c.bg } },
    h('div.tc-rail', { style: { background: c.container } }),
    h('div.tc-body', { style: { background: c.surface } },
      h('div.tc-line', { style: { background: c.text, width: '70%', opacity: 0.85 } }),
      h('div.tc-line', { style: { background: c.sub, width: '45%', opacity: 0.6 } }),
      h('div.row', { style: { gap: '4px', marginTop: 'auto' } },
        h('div.tc-btn', { style: { background: c.primary } }),
        h('div.tc-btn', { style: { background: c.tertiary, width: '14px' } })))),
  h('div.tc-name', t.custom ? icon('colorize') : null, t.name, t.glass ? h('span.tc-badge', 'blur') : null),
  h('div.tc-check', icon('check')));
  if (t.id === 'glass') {
    card.querySelector('.tc-preview').style.background = `linear-gradient(135deg, ${c.primary}, ${c.tertiary})`;
    card.querySelector('.tc-body').style.background = 'rgba(255,255,255,.35)';
    card.querySelector('.tc-body').style.backdropFilter = 'blur(6px)';
  }
  return card;
}

function appearance() {
  const a = S().appearance;
  const set = (p) => setSettings({ appearance: p });
  const theme = THEMES.find((t) => t.id === a.theme) || THEMES[0];
  const extra = [];
  if (theme.custom) {
    const color = h('input.color-input', { type: 'color', value: a.seed });
    const hex = h('md-outlined-text-field', { label: 'Hex', value: a.seed, style: { width: '130px' } });
    color.addEventListener('input', () => { hex.value = color.value; set({ seed: color.value }); });
    hex.addEventListener('change', () => { if (/^#?[0-9a-f]{6}$/i.test(hex.value)) { const v = hex.value.startsWith('#') ? hex.value : '#' + hex.value; color.value = v; set({ seed: v }); } });
    extra.push(row('colorize', 'Seed colour', 'The whole palette is generated from this colour (Material You).', h('div.row.gap', color, hex)));
  }
  if (!theme.palette && theme.id !== 'monochrome') {
    extra.push(row('auto_awesome', 'Scheme style', 'How colourful the generated palette is', select(() => a.variant, (v) => { set({ variant: v }); renderSection(); },
      Object.entries(VARIANTS).map(([k, [label]]) => [k, label]))));
  }
  if (theme.id === 'catppuccin') {
    const flav = select(() => a.catppuccinDark, (v) => { set({ catppuccinDark: v }); renderSection(); }, [['frappe', 'Frappé'], ['macchiato', 'Macchiato'], ['mocha', 'Mocha']]);
    extra.push(row('dark_mode', 'Dark flavour', 'Light mode always uses Latte', flav));
    const sw2 = h('div.swatches', CATPPUCCIN_ACCENTS.map((n) => h('button.swatch', {
      title: n, class: a.catppuccinAccent === n ? 'on' : '', style: { background: catppuccinAccentColor(n, a.catppuccinDark) },
      on: { click: () => { set({ catppuccinAccent: n }); renderSection(); } },
    })));
    extra.push(h('div.s-row.stack', h('div.s-text', h('div.t', 'Accent'), h('div.d', a.catppuccinAccent)), sw2));
  }
  if (theme.id === 'gruvbox') {
    extra.push(row('contrast', 'Background contrast', null, seg(() => a.gruvboxContrast, (v) => set({ gruvboxContrast: v }), [['soft', 'Soft'], ['medium', 'Medium'], ['hard', 'Hard']])));
  }
  const material = THEMES.filter((t) => t.group === 'Material');
  const popular = THEMES.filter((t) => t.group === 'Popular');
  return [
    ...header('Appearance', 'Material 3 theming for the whole app. Every theme works in light and dark.'),
    groupTitle('Mode'),
    group(
      row('brightness_6', 'Theme mode', null, seg(() => a.mode, (v) => set({ mode: v }), [['system', 'System', 'computer'], ['light', 'Light', 'light_mode'], ['dark', 'Dark', 'dark_mode']])),
      row('contrast', 'Contrast', 'Higher contrast makes text and outlines stronger', seg(() => a.contrast, (v) => set({ contrast: v }), [['standard', 'Standard'], ['medium', 'Medium'], ['high', 'High']])),
      row('brightness_1', 'AMOLED black', 'Pure black backgrounds in dark mode', sw(() => a.amoled, (v) => set({ amoled: v }))),
    ),
    groupTitle('Material themes'),
    group(h('div.theme-grid', material.map(themeCard)), ...extra.filter(() => !theme.palette)),
    groupTitle('Popular themes'),
    group(h('div.theme-grid', popular.map(themeCard)), ...extra.filter(() => !!theme.palette)),
    groupTitle('Glass effect'),
    group(
      theme.glass ? row('blur_on', 'Frosted glass surfaces', 'Always on for the Glass theme', h('md-switch', { '.selected': true, disabled: true }))
        : row('blur_on', 'Frosted glass surfaces', 'Translucent, blurred panels over a soft colour wash. Works with any theme.', sw(() => a.glass, (v) => { set({ glass: v }); renderSection(); })),
      a.glass || theme.glass ? row('lens_blur', 'Blur strength', null, slider(() => a.glassBlur, (v) => set({ glassBlur: v }), { min: 0, max: 48, step: 2, fmt: (v) => v + 'px' })) : null,
      a.glass || theme.glass ? row('opacity', 'Panel opacity', null, slider(() => a.glassOpacity, (v) => set({ glassOpacity: v }), { min: 0.2, max: 0.95, step: 0.05, fmt: (v) => Math.round(v * 100) + '%' })) : null,
    ),
    groupTitle('Shape & size'),
    group(
      row('rounded_corner', 'Corner roundness', 'Scales every M3 shape token', slider(() => a.corner, (v) => set({ corner: v }), { min: 0, max: 1.6, step: 0.1, fmt: (v) => Math.round(v * 100) + '%' })),
      row('zoom_in', 'Interface scale', 'Zooms the whole interface', slider(() => a.uiScale, (v) => { set({ uiScale: v }); fire('setUiZoom', v); }, { min: 0.75, max: 1.5, step: 0.05, fmt: (v) => Math.round(v * 100) + '%', live: false })),
      row('density_medium', 'Density', null, seg(() => a.density, (v) => set({ density: v }), [['comfortable', 'Comfortable'], ['compact', 'Compact']])),
    ),
  ];
}

async function loadSystemFonts() {
  if (!systemFonts) systemFonts = await call('systemFonts');
  return systemFonts;
}

// Searchable font picker (a plain dropdown can't cope with hundreds of system fonts).
const PICKER_LIMIT = 120;
function fontSelect(get, set, mono) {
  const label = () => get() || (mono ? 'System monospace' : 'System default');
  const name = h('span.ff-name', { style: { fontFamily: get() ? `"${get()}"` : '' } }, label());
  const field = h('button.font-field', { type: 'button', title: 'Choose font' }, name, h('md-icon', 'arrow_drop_down'));
  field.addEventListener('click', async () => {
    const fonts = await loadSystemFonts().catch(() => ({ all: [], mono: [] }));
    const bundled = mono ? BUNDLED_MONO : BUNDLED_FONTS;
    const system = (mono ? fonts.mono : fonts.all).filter((f) => !bundled.includes(f));
    let filter = 'all';
    let query = '';
    const list = h('div.fp-list', { role: 'listbox' });
    const count = h('div.body-small.muted.fp-count');
    const search = h('md-outlined-text-field', { label: `Search ${bundled.length + system.length} fonts`, style: { width: '100%' } });
    search.append(h('md-icon', { slot: 'leading-icon' }, 'search'));
    const chips = h('md-chip-set', [['all', 'All'], ['bundled', 'Bundled'], ['system', 'System']].map(([v, l]) => {
      const c = h('md-filter-chip', { label: l, '.selected': v === 'all' });
      c.addEventListener('click', () => { filter = v; chips.querySelectorAll('md-filter-chip').forEach((x) => { x.selected = x === c; }); draw(); });
      return c;
    }));
    let dlgRef = null;
    const choose = (f) => { set(f); name.textContent = f || label(); name.style.fontFamily = f ? `"${f}"` : ''; if (dlgRef) dlgRef.close('picked'); };
    const item = (f, tag) => h('button.fp-item', {
      type: 'button', role: 'option', class: f === get() ? 'on' : '', on: { click: () => choose(f) },
    }, h('span.fp-name', { style: { fontFamily: f ? `"${f}", var(--font)` : '' } }, f || (mono ? 'System monospace' : 'System default')),
    h('span.fp-sample', { style: { fontFamily: f ? `"${f}", var(--font)` : '' } }, mono ? 'chmod 755 && ls -la' : 'Aa Bb 123'),
    tag ? h('span.tc-badge', tag) : null, f === get() ? h('md-icon', 'check') : null);
    const draw = () => {
      const q = query.trim().toLowerCase();
      const match = (f) => !q || f.toLowerCase().includes(q);
      const b = filter === 'system' ? [] : bundled.filter(match);
      const sys = filter === 'bundled' ? [] : system.filter(match);
      const shown = sys.slice(0, PICKER_LIMIT);
      list.replaceChildren(...[
        mono && filter !== 'system' && !q ? item('', '') : null,
        ...b.map((f) => item(f, 'Bundled')),
        b.length && shown.length ? h('div.fp-sep', 'Installed on your system') : null,
        ...shown.map((f) => item(f, '')),
        !b.length && !shown.length ? h('div.list-empty.body-medium', 'No fonts match') : null,
      ].filter(Boolean));
      count.textContent = sys.length > PICKER_LIMIT ? `Showing ${PICKER_LIMIT} of ${sys.length} system fonts — type to narrow down` : '';
    };
    search.addEventListener('input', () => { query = search.value; draw(); });
    draw();
    await dialog({
      headline: mono ? 'Monospace font' : 'Choose a font', icon: 'font_download', wide: true,
      content: h('div.fp', search, chips, count, list),
      actions: [{ label: 'Close', value: 'close' }],
      onOpen: (dlg) => { dlgRef = dlg; setTimeout(() => search.focus(), 150); const on = list.querySelector('.fp-item.on'); if (on) on.scrollIntoView({ block: 'center' }); },
    });
  });
  return field;
}

function typography() {
  const a = S().appearance;
  const set = (p) => setSettings({ appearance: p });
  const headingSel = fontSelect(() => a.headingFont || a.font, (v) => set({ headingFont: v === a.font ? '' : v }), false);
  return [
    ...header('Fonts', 'Bundled Google & open fonts work offline. Your installed system fonts are listed below them.'),
    group(
      row('font_download', 'Interface font', null, fontSelect(() => a.font, (v) => { set({ font: v }); renderSection(); }, false)),
      row('title', 'Heading font', 'Used for titles and quiz questions', headingSel),
      row('code', 'Monospace font', 'Code, commands and keyboard hints', fontSelect(() => a.monoFont, (v) => set({ monoFont: v }), true)),
      row('format_size', 'Text size', null, slider(() => a.fontScale, (v) => set({ fontScale: v }), { min: 0.85, max: 1.3, step: 0.05, fmt: (v) => Math.round(v * 100) + '%' })),
      h('div.font-preview',
        h('div.headline-small', 'The quick brown fox jumps over the lazy dog'),
        h('p.body-large', { style: { margin: '8px 0' } }, 'Mitochondria are the powerhouse of the cell. ¿Dónde está el baño? 0123456789'),
        h('code', { style: { fontFamily: 'var(--font-mono)' } }, 'chmod 755 file && tail -f /var/log/syslog')),
    ),
    groupTitle('Decks'),
    group(row('format_shapes', 'Use these fonts inside decks', 'Overrides the deck’s own fonts (code stays monospace)', sw(() => S().decks.applyAppFont, (v) => { setSettings({ decks: { applyAppFont: v } }); emit('deck-config'); }))),
  ];
}

function iconsSection() {
  const a = S().appearance;
  const set = (p) => setSettings({ appearance: p });
  return [
    ...header('Icons', 'Material Symbols — the variable icon font used across the app.'),
    group(
      row('category', 'Icon style', null, seg(() => a.iconStyle, (v) => set({ iconStyle: v }), [['outlined', 'Outlined'], ['rounded', 'Rounded'], ['sharp', 'Sharp']])),
      row('format_color_fill', 'Filled icons', 'Fill every icon (active ones are always filled)', sw(() => a.iconFill, (v) => set({ iconFill: v }))),
      row('line_weight', 'Icon weight', null, slider(() => a.iconWeight, (v) => set({ iconWeight: v }), { min: 100, max: 700, step: 100 })),
      h('div.s-row', h('div.icon-preview', ['home', 'style', 'quiz', 'insights', 'settings', 'star', 'favorite', 'search', 'arrow_forward', 'chevron_left', 'tune', 'bolt', 'local_fire_department', 'psychology'].map((n) => icon(n)))),
    ),
  ];
}

function motion() {
  const m = S().motion;
  const set = (p) => setSettings({ motion: p });
  return [
    ...header('Motion', 'M3 motion: emphasized easing on page, card and dialog transitions.'),
    group(
      row('animation', 'Animations', null, sw(() => m.enabled, (v) => set({ enabled: v }))),
      row('speed', 'Animation speed', 'Lower is faster', slider(() => m.speed, (v) => set({ speed: v }), { min: 0.25, max: 2, step: 0.25, fmt: (v) => v + '×' })),
      row('motion_photos_off', 'Reduce motion', 'Removes movement, keeps simple fades', sw(() => m.reduce, (v) => set({ reduce: v }))),
      row('touch_app', 'Ripple effects', 'Ink ripples on buttons and list items', sw(() => m.rippleEffects, (v) => set({ rippleEffects: v }))),
    ),
  ];
}

function decks() {
  const d = S().decks;
  const set = (p) => { setSettings({ decks: p }); emit('deck-config'); };
  return [
    ...header('Deck display', 'How decks render inside the viewer. Decks keep their original design unless you change this.'),
    group(
      row('contrast', 'Match light / dark mode', 'Auto inverts decks whose background doesn’t match the app’s mode', select(() => d.applyTheme, (v) => set({ applyTheme: v }),
        [['off', 'Off — original colours'], ['auto', 'Auto — match app mode'], ['invert', 'Always invert']])),
      row('format_shapes', 'Use app fonts', 'Apply your interface and mono fonts inside decks', sw(() => d.applyAppFont, (v) => set({ applyAppFont: v }))),
      row('zoom_in', 'Deck zoom', 'Also adjustable with Ctrl + / Ctrl −', slider(() => d.zoom, (v) => set({ zoom: v }), { min: 0.5, max: 2, step: 0.05, fmt: (v) => Math.round(v * 100) + '%' })),
      row('autorenew', 'Auto-reload on change', 'Reload the open deck when its file is edited or replaced', sw(() => d.autoReload, (v) => set({ autoReload: v }))),
    ),
  ];
}

function mobileLibrary() {
  const l = S().library;
  const set = (p) => setSettings({ library: p });
  return [
    ...header('Library', 'Decks you add are stored inside the app, so they work offline. Add them with the + button, or share / open an .html file with Riffle from any other app.'),
    group(
      row('style', 'Decks in your library', null, h('span.title-medium', String(store.decks.length))),
      h('div.s-row', h('md-filled-tonal-button', { on: { click: () => emit({ type: 'add-files' }) } }, h('md-icon', { slot: 'icon' }, 'add'), 'Add decks')),
    ),
    group(
      row('sort', 'Sort decks by', null, select(() => l.sort, (v) => { set({ sort: v }); emit('decks'); },
        [['name', 'Name'], ['recent', 'Recently opened'], ['modified', 'Recently added'], ['studied', 'Most studied'], ['progress', 'Least mastered']])),
      row('star', 'Favourites first', 'Pin starred decks to the top', sw(() => l.favouritesFirst, (v) => { set({ favouritesFirst: v }); emit('decks'); })),
    ),
    h('p.body-small.muted', 'Tip: use Backup & reset → Export backup to move your decks, edits and stats to another phone.'),
  ];
}

function library() {
  if (store.platform !== 'desktop') return mobileLibrary();
  const l = S().library;
  const set = (p, rescan) => setSettings({ library: p }, { immediate: !!rescan }).then(() => rescan && emit('rescan'));
  const folders = l.folders.map((f) => h('div.folder-row', icon('folder'), h('span.fp', { title: f }, f),
    f === l.mainFolder ? h('span.chip-main', 'Main') : h('md-text-button', { on: { click: () => { set({ mainFolder: f }); renderSection(); } } }, 'Make main'),
    h('md-icon-button', { title: 'Open', on: { click: () => call('openPath', f) } }, icon('open_in_new')),
    h('md-icon-button', {
      title: 'Stop watching', disabled: l.folders.length === 1,
      on: { click: async () => { const rest = l.folders.filter((x) => x !== f); await set({ folders: rest, mainFolder: l.mainFolder === f ? rest[0] : l.mainFolder }, true); renderSection(); } },
    }, icon('close'))));
  return [
    ...header('Library & folders', 'Every .html, .htm, .jsx and .tsx file in these folders appears in your library automatically.'),
    groupTitle('Watched folders'),
    group(...folders, h('div.s-row', h('md-outlined-button', {
      on: {
        click: async () => {
          const d = await call('chooseFolder');
          if (d && !l.folders.includes(d)) { await set({ folders: [...l.folders, d] }, true); renderSection(); }
        },
      },
    }, h('md-icon', { slot: 'icon' }, 'create_new_folder'), 'Add folder'),
    h('span.body-small.muted', 'Dropped files are copied into the main folder.'))),
    group(
      row('account_tree', 'Include sub-folders', null, sw(() => l.recursive, (v) => set({ recursive: v }, true))),
      row('sort', 'Sort decks by', null, select(() => l.sort, (v) => { set({ sort: v }); emit('decks'); },
        [['name', 'Name'], ['recent', 'Recently opened'], ['modified', 'Recently modified'], ['studied', 'Most studied'], ['progress', 'Least mastered']])),
      row('star', 'Favourites first', 'Pin starred decks to the top', sw(() => l.favouritesFirst, (v) => { set({ favouritesFirst: v }); emit('decks'); })),
    ),
  ];
}

function network() {
  if (store.platform === 'web') {
    return [...header('Offline & network', 'In a web browser, CDN files are cached by the browser itself. The desktop and Android apps keep their own offline copies.')];
  }
  const n = S().network;
  const cacheRow = h('div.s-row', icon('storage'), h('div.s-text', h('div.t', 'Offline cache'), h('div.d#cache-info', 'Calculating…')),
    h('md-outlined-button', {
      on: {
        click: async () => {
          if (!(await confirmDialog('Clear offline cache?', 'Decks that load libraries or fonts from the internet will need a connection the next time you open them.', 'Clear', 'delete_sweep'))) return;
          const info = await call('clearCache');
          $('#cache-info').textContent = `${info.files} files · ${fmtBytes(info.bytes)}`;
          snackbar('Offline cache cleared');
        },
      },
    }, 'Clear'));
  call('cacheInfo').then((info) => { const el = $('#cache-info'); if (el) el.textContent = `${info.files} files · ${fmtBytes(info.bytes)}`; });
  const opt = (v, title, desc) => h('label.s-row', { style: { cursor: 'pointer' } },
    h('md-radio', { name: 'netmode', value: v, '.checked': n.mode === v, on: { change: () => setSettings({ network: { mode: v } }) } }),
    h('div.s-text', h('div.t', title), h('div.d', desc)));
  return [
    ...header('Offline & network', 'Some decks load Tailwind, fonts or math libraries from a CDN. The app can keep copies so they work without internet.'),
    group(
      opt('offline-first', 'Offline-first (recommended)', 'Use cached copies; download and cache anything new when online.'),
      opt('online', 'Always online', 'Decks load from the internet like a normal browser. Nothing is cached.'),
      opt('offline', 'Strictly offline', 'Never touch the network. Only already-cached files load.'),
    ),
    group(cacheRow),
    h('p.body-small.muted', 'Links you click inside a deck always open in your web browser.'),
  ];
}

function quiz() {
  const q = S().quiz;
  const set = (p) => setSettings({ quiz: p });
  const exp = h('md-outlined-text-field', { label: 'Correct answer', value: 'The mitochondria' });
  const ans = h('md-outlined-text-field', { label: 'Your answer', value: 'mitocondria' });
  const verdict = h('span.verdict-chip', '…');
  const test = async () => {
    const r = await call('gradeAnswer', JSON.stringify({ type: 'typed', answer: exp.value }), JSON.stringify(ans.value));
    verdict.className = 'verdict-chip ' + r.verdict;
    verdict.textContent = `${{ correct: 'Correct', close: 'Close', wrong: 'Wrong' }[r.verdict]} · ${Math.round(r.score * 100)}%`;
    verdict.title = r.note || '';
  };
  exp.addEventListener('input', test);
  ans.addEventListener('input', test);
  setTimeout(test, 50);
  const typeSw = (t) => sw(() => q.types[t], (v) => {
    const types = { ...S().quiz.types, [t]: v };
    if (!Object.values(types).some(Boolean)) { snackbar('Keep at least one question type'); renderSection(); return; }
    set({ types });
  });
  return [
    ...header('Quiz', 'Typed answers are graded by similarity — typos, word order and filler words are forgiven; numbers and negations must match.'),
    groupTitle('Questions'),
    group(
      row('format_list_numbered', 'Questions per quiz', null, slider(() => q.questions, (v) => set({ questions: v }), { min: 5, max: 50, step: 5 })),
      row('keyboard', 'Typed answers', 'Best for terms, commands and short facts', typeSw('typed')),
      row('format_list_bulleted', 'Multiple choice', 'Distractors come from other cards in the deck', typeSw('mc')),
      row('rule', 'True / false', 'Shows an answer that may be wrong', typeSw('tf')),
      row('swap_horiz', 'Vary how questions are asked', 'Sometimes work backwards from the answer, fill in a blank, or start from the explanation', sw(() => q.vary, (v) => set({ vary: v }))),
      row('shuffle', 'Shuffle questions', null, sw(() => q.shuffle, (v) => set({ shuffle: v }))),
      row('priority_high', 'Weak cards first', 'Cards you keep missing are asked first', sw(() => q.weakFirst, (v) => set({ weakFirst: v }))),
    ),
    groupTitle('Answer matching'),
    group(
      row('tune', 'Strictness', 'How similar a typed answer must be to count as correct', slider(() => q.threshold, (v) => set({ threshold: v }), { min: 0.5, max: 0.95, step: 0.05, fmt: (v) => Math.round(v * 100) + '%', live: false })),
      row('translate', 'Ignore accents', 'Treat “nino” as “niño” (you still get a hint)', sw(() => q.stripAccents, (v) => set({ stripAccents: v }))),
      h('div.s-row.stack', h('div.s-text', h('div.t', 'Try it'), h('div.d', 'Test the matcher with the current strictness'))),
      h('div.tester', exp, ans, verdict),
    ),
    groupTitle('During the quiz'),
    group(
      row('timer', 'Time limit per question', null, select(() => String(q.timer), (v) => set({ timer: +v }), [['0', 'No limit'], ['10', '10 seconds'], ['15', '15 seconds'], ['30', '30 seconds'], ['60', '1 minute']])),
      row('volume_up', 'Sound effects', null, sw(() => q.sounds, (v) => set({ sounds: v }))),
      row('lightbulb', 'Show explanations', 'When a deck provides them', sw(() => q.showExplanations, (v) => set({ showExplanations: v }))),
      row('fast_forward', 'Auto-advance when correct', null, sw(() => q.autoAdvance, (v) => set({ autoAdvance: v }))),
    ),
    groupTitle('Quiz prompts'),
    group(
      row('flag', 'Offer a quiz when I finish a deck', 'Detected from the deck’s “12 / 12” style counter', sw(() => q.promptOnFinish, (v) => set({ promptOnFinish: v }))),
      row('hourglass_top', 'Offer a quiz after studying for', '0 = never', slider(() => q.promptAfterMinutes, (v) => set({ promptAfterMinutes: v }), { min: 0, max: 30, step: 1, fmt: (v) => (v ? v + ' min' : 'Off') })),
    ),
  ];
}

function captureShortcut(action) {
  let combo = S().shortcuts[action];
  const box = h('div.capture-box', prettyCombo(combo));
  const onKey = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const c = comboFromEvent(e);
    if (!c || c === 'Escape' || c === 'Enter') return;
    combo = c;
    box.textContent = prettyCombo(c);
  };
  return dialog({
    headline: SHORTCUT_LABELS[action] || action, icon: 'keyboard',
    content: h('div', h('p.body-medium.muted', { style: { marginTop: 0 } }, 'Press the new key combination.'), box),
    actions: [{ label: 'Cancel', value: 'cancel' }, { label: 'Save', value: 'ok', primary: true }],
    onOpen: (dlg) => { window.addEventListener('keydown', onKey, true); dlg.addEventListener('close', () => window.removeEventListener('keydown', onKey, true)); },
  }).then((v) => {
    if (v !== 'ok') return;
    const clash = Object.entries(S().shortcuts).find(([k, c]) => c === combo && k !== action);
    const patch = { [action]: combo };
    if (clash) { patch[clash[0]] = ''; snackbar(`Removed it from “${SHORTCUT_LABELS[clash[0]]}”`); }
    setSettings({ shortcuts: patch });
    renderSection();
  });
}

function shortcuts() {
  const sc = S().shortcuts;
  return [
    ...header('Keyboard shortcuts', 'Click a shortcut to change it. They work even while a deck has focus.'),
    group(...Object.keys(SHORTCUT_LABELS).map((k) => row(null, SHORTCUT_LABELS[k], null,
      h('button.kbd-btn', { on: { click: () => captureShortcut(k) } }, sc[k] ? prettyCombo(sc[k]) : '—')))),
    h('div.row.gap', h('md-outlined-button', {
      on: { click: async () => { await call('resetSettings', 'shortcuts').then((d) => { store.settings.shortcuts = d.shortcuts; }); renderSection(); snackbar('Shortcuts reset'); } },
    }, 'Reset to defaults')),
  ];
}

function windowSection() {
  const w = S().window, g = S().general;
  const desktop = store.platform === 'desktop';
  return [
    ...header(desktop ? 'Window & startup' : 'Startup'),
    group(
      !desktop ? null : row('web_asset', 'Custom title bar', 'Material title bar with search. Turn off to use your desktop’s window decorations.', sw(() => w.customTitlebar, (v) => setSettings({ window: { customTitlebar: v } }, { immediate: true }).then(() => emit('titlebar')))),
      row('start', 'Start on', null, select(() => g.startPage, (v) => setSettings({ general: { startPage: v } }), [['library', 'Library'], ['lastDeck', 'Last opened deck'], ['stats', 'Stats']])),
      !desktop ? null : row('filter_1', 'Single window', 'Opening a deck from the file manager reuses the running window', sw(() => g.singleInstance, (v) => setSettings({ general: { singleInstance: v } }))),
      row('delete', 'Confirm before removing decks', null, sw(() => g.confirmDelete, (v) => setSettings({ general: { confirmDelete: v } }))),
    ),
  ];
}

function backup() {
  return [
    ...header('Backup & reset', store.platform === 'desktop'
      ? 'Backups contain settings, favourites, renamed decks, edited cards and all stats — not the deck files themselves.'
      : 'Backups contain your decks, settings, favourites, edited cards and all stats in one .json file.'),
    group(
      row('backup', 'Export backup', store.platform === 'desktop' ? 'Save everything to a .zip file' : 'Save everything to a .json file', h('md-outlined-button', { on: { click: async () => { const f = await call('exportBackup'); if (f) snackbar(`Backup saved to ${f}`); } } }, 'Export')),
      row('restore', 'Restore backup', 'Replaces current settings and stats', h('md-outlined-button', {
        on: {
          click: async () => {
            if (!(await confirmDialog('Restore a backup?', 'Your current settings and statistics will be replaced.', 'Choose file', 'restore'))) return;
            const r = await call('importBackup');
            if (r) { store.settings = r.settings; emit('settings'); emit('rescan'); snackbar('Backup restored'); renderSection(); }
          },
        },
      }, 'Restore')),
      row('table_view', 'Export stats', 'CSV for spreadsheets or JSON', h('div.row.gap-s',
        h('md-outlined-button', { on: { click: async () => { const f = await call('exportStats', 'csv'); if (f) snackbar(`Exported to ${f}`); } } }, 'CSV'),
        h('md-outlined-button', { on: { click: async () => { const f = await call('exportStats', 'json'); if (f) snackbar(`Exported to ${f}`); } } }, 'JSON'))),
    ),
    groupTitle('Danger zone'),
    group(
      row('restart_alt', 'Reset all statistics', 'Study time, quiz history, streaks and weak cards', h('md-outlined-button', {
        on: { click: async () => { if (await confirmDialog('Reset all statistics?', 'This cannot be undone. Consider exporting a backup first.', 'Reset everything', 'warning')) { await call('resetStats', ''); emit('stats-changed'); snackbar('All statistics reset'); } } },
      }, 'Reset stats')),
      row('settings_backup_restore', 'Reset all settings', 'Watched folders are kept', h('md-outlined-button', {
        on: {
          click: async () => {
            if (!(await confirmDialog('Reset all settings?', 'Themes, fonts, quiz options and shortcuts go back to defaults.', 'Reset', 'warning'))) return;
            store.settings = await call('resetSettings', '');
            emit('settings');
            fire('setUiZoom', 1);
            renderSection();
            snackbar('Settings reset');
          },
        },
      }, 'Reset settings')),
    ),
  ];
}

function updatesGroup() {
  const g = S().general;
  if (store.storeInstall) {
    return group(h('div.s-row', icon('system_update'),
      h('div.s-text', h('div.t', 'Updates'), h('div.d', 'This copy came from the Microsoft Store, which keeps it up to date.'))));
  }
  const status = h('div.d', 'Not checked yet');
  const showInfo = (m) => {
    if (m.state === 'error') { status.textContent = m.message; return; }
    if (m.installed) { status.textContent = `Version ${m.latest} is installed. Restart to finish.`; btn.replaceChildren('Restart now'); return; }
    status.textContent = m.newer ? `Version ${m.latest} is available` : `You're on the latest version (${m.current})`;
    btn.replaceChildren(m.newer ? (m.canInstall ? 'Update now' : 'Open release page') : 'Check now');
  };
  const btn = h('md-filled-tonal-button', {
    on: {
      click: async () => {
        const known = updateInfo();
        if (known && known.installed) { fire('restartApp'); return; }
        if (known && known.newer) { installUpdate(known); return; }
        btn.disabled = true;
        status.textContent = 'Checking…';
        const m = await checkForUpdates();
        btn.disabled = false;
        if (!btn.isConnected) return;
        showInfo(m);
        if (m.state === 'checked' && m.newer) promptUpdate(m);
      },
    },
  }, 'Check now');
  if (updateInfo()) showInfo(updateInfo());
  else if (g.lastUpdateCheck) status.textContent = `Last checked ${new Date(g.lastUpdateCheck).toLocaleString()}`;
  const off = onUpdateInfo((m) => (btn.isConnected ? showInfo(m) : off()));
  return group(
    h('div.s-row', icon('system_update'), h('div.s-text', h('div.t', 'Updates'), status), btn),
    row('autorenew', 'Check for updates automatically', 'When the app starts, at most every 6 hours. Nothing is installed without asking.',
      sw(() => g.checkUpdates, (v) => setSettings({ general: { checkUpdates: v } }))),
  );
}

function about() {
  return [
    ...header('About'),
    ...(store.platform === 'web' ? [] : [updatesGroup()]),
    h('div.card', h('div.row.gap', h('img', { src: 'icon.png', width: 64, height: 64 }),
      h('div', h('div.headline-small', 'Riffle'), h('div.body-medium.muted', `Version ${store.version} · Material 3 app for HTML flashcard decks`))),
    h('table.info-table', { style: { marginTop: '16px' } },
      h('tr', h('td', 'Settings'), h('td.selectable.mono', store.configDir)),
      h('tr', h('td', 'Data & stats'), h('td.selectable.mono', store.dataDir)),
      h('tr', h('td', 'Built with'), h('td', 'PyQt6 + Qt WebEngine, Material Web, Material Color Utilities, Material Symbols'))),
    h('div.row.gap', { style: { marginTop: '12px' } },
      h('md-outlined-button', { on: { click: () => call('openPath', store.dataDir) } }, h('md-icon', { slot: 'icon' }, 'folder_open'), 'Open data folder'),
      h('md-outlined-button', { on: { click: () => emit('cheatsheet') } }, h('md-icon', { slot: 'icon' }, 'keyboard'), 'Shortcuts'))),
  ];
}

// ------------------------------------------------------------------ render
export function renderSection() {
  const sec = SECTIONS.find((s) => s.id === section) || SECTIONS[0];
  const body = $('#settings-body');
  const top = body.scrollTop;
  body.replaceChildren(h('div.s-section', sec.render()));
  body.scrollTop = top;
  $$('.snav-item').forEach((b) => b.classList.toggle('active', b.dataset.id === section));
}

export function openSettings(id) {
  if (id) section = id;
  renderSection();
  $('#settings-body').scrollTop = 0;
}

export function initSettings() {
  $('#settings-nav').replaceChildren(h('h2.title-large', 'Settings'), ...SECTIONS.map((s) => h('button.snav-item', {
    dataset: { id: s.id }, on: { click: () => { section = s.id; renderSection(); $('#settings-body').scrollTop = 0; } },
  }, icon(s.icon), h('span', s.title))));
}
