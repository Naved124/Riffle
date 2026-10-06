// Theme engine: produces the full set of M3 colour roles (--md-sys-color-*) for
// - Material themes generated from a seed colour (material-color-utilities), and
// - popular editor palettes (Catppuccin, Gruvbox, Monokai, ...) mapped onto M3 roles.
import {
  Hct, argbFromHex, hexFromArgb, MaterialDynamicColors as MDC,
  SchemeTonalSpot, SchemeVibrant, SchemeExpressive, SchemeFidelity, SchemeContent,
  SchemeNeutral, SchemeMonochrome, SchemeRainbow, SchemeFruitSalad,
} from '../vendor/material.js';

// ---------------------------------------------------------------- colour math
const hx = (h) => {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const toHex = (rgb) => '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
export const mix = (a, b, t) => { const A = hx(a), B = hx(b); return toHex(A.map((v, i) => v + (B[i] - v) * t)); };
const lum = (h) => {
  const c = hx(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
export const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const ensure = (fg, bg, min) => {
  if (contrast(fg, bg) >= min) return fg;
  const target = lum(bg) > 0.4 ? '#000000' : '#ffffff';
  for (let t = 0.1; t <= 1.0001; t += 0.1) {
    const c = mix(fg, target, t);
    if (contrast(c, bg) >= min) return c;
  }
  return target;
};

// ---------------------------------------------------------------- palettes
// Each palette: dark?, bg, lowest, low, cont, high, highest, text, sub, outline, outlineVar,
// primary, secondary, tertiary, error, good, warn
const CATPPUCCIN = {
  latte: { dark: false, rosewater: '#dc8a78', flamingo: '#dd7878', pink: '#ea76cb', mauve: '#8839ef', red: '#d20f39', maroon: '#e64553', peach: '#fe640b', yellow: '#df8e1d', green: '#40a02b', teal: '#179299', sky: '#04a5e5', sapphire: '#209fb5', blue: '#1e66f5', lavender: '#7287fd', text: '#4c4f69', subtext1: '#5c5f77', subtext0: '#6c6f85', overlay2: '#7c7f93', overlay1: '#8c8fa1', overlay0: '#9ca0b0', surface2: '#acb0be', surface1: '#bcc0cc', surface0: '#ccd0da', base: '#eff1f5', mantle: '#e6e9ef', crust: '#dce0e8' },
  frappe: { dark: true, rosewater: '#f2d5cf', flamingo: '#eebebe', pink: '#f4b8e4', mauve: '#ca9ee6', red: '#e78284', maroon: '#ea999c', peach: '#ef9f76', yellow: '#e5c890', green: '#a6d189', teal: '#81c8be', sky: '#99d1db', sapphire: '#85c1dc', blue: '#8caaee', lavender: '#babbf1', text: '#c6d0f5', subtext1: '#b5bfe2', subtext0: '#a5adce', overlay2: '#949cbb', overlay1: '#838ba7', overlay0: '#737994', surface2: '#626880', surface1: '#51576d', surface0: '#414559', base: '#303446', mantle: '#292c3c', crust: '#232634' },
  macchiato: { dark: true, rosewater: '#f4dbd6', flamingo: '#f0c6c6', pink: '#f5bde6', mauve: '#c6a0f6', red: '#ed8796', maroon: '#ee99a0', peach: '#f5a97f', yellow: '#eed49f', green: '#a6da95', teal: '#8bd5ca', sky: '#91d7e3', sapphire: '#7dc4e4', blue: '#8aadf4', lavender: '#b7bdf8', text: '#cad3f5', subtext1: '#b8c0e0', subtext0: '#a5adcb', overlay2: '#939ab7', overlay1: '#8087a2', overlay0: '#6e738d', surface2: '#5b6078', surface1: '#494d64', surface0: '#363a4f', base: '#24273a', mantle: '#1e2030', crust: '#181926' },
  mocha: { dark: true, rosewater: '#f5e0dc', flamingo: '#f2cdcd', pink: '#f5c2e7', mauve: '#cba6f7', red: '#f38ba8', maroon: '#eba0ac', peach: '#fab387', yellow: '#f9e2af', green: '#a6e3a1', teal: '#94e2d5', sky: '#89dceb', sapphire: '#74c7ec', blue: '#89b4fa', lavender: '#b4befe', text: '#cdd6f4', subtext1: '#bac2de', subtext0: '#a6adc8', overlay2: '#9399b2', overlay1: '#7f849c', overlay0: '#6c7086', surface2: '#585b70', surface1: '#45475a', surface0: '#313244', base: '#1e1e2e', mantle: '#181825', crust: '#11111b' },
};
export const CATPPUCCIN_ACCENTS = ['rosewater', 'flamingo', 'pink', 'mauve', 'red', 'maroon', 'peach', 'yellow', 'green', 'teal', 'sky', 'sapphire', 'blue', 'lavender'];

function catppuccin(flavour, accent) {
  const c = CATPPUCCIN[flavour];
  const sec = accent === 'blue' || accent === 'sapphire' ? 'lavender' : 'blue';
  const ter = accent === 'pink' || accent === 'flamingo' ? 'peach' : 'pink';
  return {
    dark: c.dark, bg: c.base, lowest: c.crust, low: c.mantle, cont: c.dark ? mix(c.base, c.surface0, 0.5) : mix(c.mantle, c.crust, 0.5),
    high: c.dark ? c.surface0 : c.crust, highest: c.dark ? c.surface1 : c.surface0, text: c.text, sub: c.subtext0,
    outline: c.overlay0, outlineVar: c.dark ? c.surface2 : c.surface1, primary: c[accent] || c.mauve, secondary: c[sec], tertiary: c[ter],
    error: c.red, good: c.green, warn: c.yellow,
  };
}

const GRUVBOX = {
  dark: { hard: '#1d2021', medium: '#282828', soft: '#32302f', bg1: '#3c3836', bg2: '#504945', bg3: '#665c54', bg4: '#7c6f64', fg: '#ebdbb2', fg3: '#bdae93', fg4: '#a89984', red: '#fb4934', green: '#b8bb26', yellow: '#fabd2f', blue: '#83a598', purple: '#d3869b', aqua: '#8ec07c', orange: '#fe8019' },
  light: { hard: '#f9f5d7', medium: '#fbf1c7', soft: '#f2e5bc', bg1: '#ebdbb2', bg2: '#d5c4a1', bg3: '#bdae93', bg4: '#a89984', fg: '#3c3836', fg3: '#665c54', fg4: '#7c6f64', red: '#9d0006', green: '#79740e', yellow: '#b57614', blue: '#076678', purple: '#8f3f71', aqua: '#427b58', orange: '#af3a03' },
};
function gruvbox(dark, level) {
  const g = dark ? GRUVBOX.dark : GRUVBOX.light;
  const bg = g[level] || g.medium;
  return {
    dark, bg, lowest: dark ? mix(bg, '#000000', 0.25) : mix(bg, '#ffffff', 0.4), low: dark ? mix(bg, '#000000', 0.12) : mix(bg, g.bg1, 0.25),
    cont: mix(bg, g.bg1, 0.5), high: g.bg1, highest: dark ? g.bg2 : mix(g.bg1, g.bg2, 0.5), text: g.fg, sub: g.fg4,
    outline: dark ? g.bg4 : g.bg4, outlineVar: dark ? g.bg2 : g.bg2, primary: g.yellow, secondary: g.aqua, tertiary: g.orange,
    error: g.red, good: g.green, warn: g.yellow,
  };
}

const P = (o) => o; // readability
const PALETTES = {
  monokai: P({ dark: true, bg: '#272822', lowest: '#1e1f1c', low: '#22231e', cont: '#2d2e27', high: '#3e3d32', highest: '#49483e', text: '#f8f8f2', sub: '#cfcfc2', outline: '#75715e', outlineVar: '#49483e', primary: '#a6e22e', secondary: '#66d9ef', tertiary: '#f92672', error: '#f92672', good: '#a6e22e', warn: '#e6db74' }),
  monokaiPro: P({ dark: true, bg: '#2d2a2e', lowest: '#19181a', low: '#221f22', cont: '#363337', high: '#403e41', highest: '#5b595c', text: '#fcfcfa', sub: '#c1c0c0', outline: '#727072', outlineVar: '#5b595c', primary: '#ffd866', secondary: '#78dce8', tertiary: '#ff6188', error: '#ff6188', good: '#a9dc76', warn: '#fc9867' }),
  monokaiLight: P({ dark: false, bg: '#faf4f2', lowest: '#ffffff', low: '#f5eeec', cont: '#efe8e6', high: '#e8e0de', highest: '#ddd5d3', text: '#29242a', sub: '#5f5960', outline: '#918c8e', outlineVar: '#d0c9c7', primary: '#e16032', secondary: '#1c8ca8', tertiary: '#7058be', error: '#e14775', good: '#269d69', warn: '#cc7a0a' }),
  nord: P({ dark: true, bg: '#2e3440', lowest: '#242933', low: '#292e39', cont: '#343a46', high: '#3b4252', highest: '#434c5e', text: '#eceff4', sub: '#d8dee9', outline: '#616e88', outlineVar: '#4c566a', primary: '#88c0d0', secondary: '#81a1c1', tertiary: '#b48ead', error: '#bf616a', good: '#a3be8c', warn: '#ebcb8b' }),
  nordLight: P({ dark: false, bg: '#eceff4', lowest: '#ffffff', low: '#e5e9f0', cont: '#dfe3eb', high: '#d8dee9', highest: '#cdd3de', text: '#2e3440', sub: '#4c566a', outline: '#7b88a1', outlineVar: '#c2c9d6', primary: '#5e81ac', secondary: '#4c8a8f', tertiary: '#a3688f', error: '#bf616a', good: '#5e8a4c', warn: '#b48a2b' }),
  dracula: P({ dark: true, bg: '#282a36', lowest: '#191a21', low: '#21222c', cont: '#2e303e', high: '#343746', highest: '#44475a', text: '#f8f8f2', sub: '#bfbfd0', outline: '#6272a4', outlineVar: '#44475a', primary: '#bd93f9', secondary: '#8be9fd', tertiary: '#ff79c6', error: '#ff5555', good: '#50fa7b', warn: '#ffb86c' }),
  alucard: P({ dark: false, bg: '#fffbeb', lowest: '#ffffff', low: '#f7f2de', cont: '#f0ead3', high: '#e9e2c9', highest: '#dfd8bd', text: '#1f1f1f', sub: '#4f4b3d', outline: '#7a7461', outlineVar: '#cfc7ab', primary: '#644ac9', secondary: '#036a96', tertiary: '#a3144d', error: '#cb3a2a', good: '#14710a', warn: '#a34d14' }),
  tokyonight: P({ dark: true, bg: '#1a1b26', lowest: '#13131c', low: '#16161e', cont: '#1f2030', high: '#24283b', highest: '#2f3549', text: '#c0caf5', sub: '#a9b1d6', outline: '#565f89', outlineVar: '#3b4261', primary: '#7aa2f7', secondary: '#7dcfff', tertiary: '#bb9af7', error: '#f7768e', good: '#9ece6a', warn: '#e0af68' }),
  tokyonightDay: P({ dark: false, bg: '#e1e2e7', lowest: '#f2f3f7', low: '#d9dbe2', cont: '#d0d5e3', high: '#c8ccda', highest: '#bcc1d3', text: '#3760bf', sub: '#6172b0', outline: '#8990b3', outlineVar: '#b6bfe2', primary: '#2e7de9', secondary: '#007197', tertiary: '#9854f1', error: '#f52a65', good: '#587539', warn: '#8c6c3e' }),
  rosepine: P({ dark: true, bg: '#191724', lowest: '#12101b', low: '#1f1d2e', cont: '#211f31', high: '#26233a', highest: '#403d52', text: '#e0def4', sub: '#908caa', outline: '#6e6a86', outlineVar: '#403d52', primary: '#ebbcba', secondary: '#9ccfd8', tertiary: '#c4a7e7', error: '#eb6f92', good: '#31748f', warn: '#f6c177' }),
  rosepineMoon: P({ dark: true, bg: '#232136', lowest: '#1b1928', low: '#2a273f', cont: '#2d2a43', high: '#393552', highest: '#44415a', text: '#e0def4', sub: '#908caa', outline: '#6e6a86', outlineVar: '#44415a', primary: '#ea9a97', secondary: '#9ccfd8', tertiary: '#c4a7e7', error: '#eb6f92', good: '#3e8fb0', warn: '#f6c177' }),
  rosepineDawn: P({ dark: false, bg: '#faf4ed', lowest: '#fffaf3', low: '#f4ede8', cont: '#f2e9e1', high: '#ebe2da', highest: '#dfdad9', text: '#575279', sub: '#797593', outline: '#9893a5', outlineVar: '#cecacd', primary: '#d7827e', secondary: '#286983', tertiary: '#907aa9', error: '#b4637a', good: '#56949f', warn: '#ea9d34' }),
  solarizedDark: P({ dark: true, bg: '#002b36', lowest: '#00212b', low: '#00262f', cont: '#04313c', high: '#073642', highest: '#0d4250', text: '#93a1a1', sub: '#839496', outline: '#586e75', outlineVar: '#174652', primary: '#268bd2', secondary: '#2aa198', tertiary: '#d33682', error: '#dc322f', good: '#859900', warn: '#b58900' }),
  solarizedLight: P({ dark: false, bg: '#fdf6e3', lowest: '#fffdf6', low: '#f8f0db', cont: '#f3ebd5', high: '#eee8d5', highest: '#e4dcc4', text: '#586e75', sub: '#657b83', outline: '#93a1a1', outlineVar: '#d9d1b9', primary: '#268bd2', secondary: '#2aa198', tertiary: '#d33682', error: '#dc322f', good: '#859900', warn: '#b58900' }),
  everforest: P({ dark: true, bg: '#2d353b', lowest: '#232a2e', low: '#293136', cont: '#2f383e', high: '#343f44', highest: '#3d484d', text: '#d3c6aa', sub: '#9da9a0', outline: '#7a8478', outlineVar: '#475258', primary: '#a7c080', secondary: '#83c092', tertiary: '#d699b6', error: '#e67e80', good: '#a7c080', warn: '#dbbc7f' }),
  everforestLight: P({ dark: false, bg: '#fdf6e3', lowest: '#fffbef', low: '#f4f0d9', cont: '#efebd4', high: '#e6e2cc', highest: '#e0dcc7', text: '#5c6a72', sub: '#829181', outline: '#939f91', outlineVar: '#d8d3ba', primary: '#8da101', secondary: '#35a77c', tertiary: '#df69ba', error: '#f85552', good: '#8da101', warn: '#dfa000' }),
};

// ---------------------------------------------------------------- theme catalogue
export const THEMES = [
  { id: 'baseline', name: 'Baseline', group: 'Material', seed: '#6750A4' },
  { id: 'ocean', name: 'Ocean', group: 'Material', seed: '#0061A4' },
  { id: 'forest', name: 'Forest', group: 'Material', seed: '#386A20' },
  { id: 'sunset', name: 'Sunset', group: 'Material', seed: '#C2410C' },
  { id: 'rose', name: 'Rose', group: 'Material', seed: '#BC004B' },
  { id: 'teal', name: 'Teal', group: 'Material', seed: '#006A6A' },
  { id: 'sand', name: 'Sand', group: 'Material', seed: '#7D5700' },
  { id: 'monochrome', name: 'Monochrome', group: 'Material', seed: '#5f6368', variant: 'monochrome' },
  { id: 'custom', name: 'Custom colour', group: 'Material', custom: true },
  { id: 'glass', name: 'Glass', group: 'Material', seed: '#4f6bed', variant: 'vibrant', glass: true },
  { id: 'catppuccin', name: 'Catppuccin', group: 'Popular', palette: (dark, a) => catppuccin(dark ? a.catppuccinDark || 'mocha' : 'latte', a.catppuccinAccent || 'mauve') },
  { id: 'gruvbox', name: 'Gruvbox', group: 'Popular', palette: (dark, a) => gruvbox(dark, a.gruvboxContrast || 'medium') },
  { id: 'monokai', name: 'Monokai', group: 'Popular', palette: (dark) => (dark ? PALETTES.monokai : PALETTES.monokaiLight) },
  { id: 'monokaipro', name: 'Monokai Pro', group: 'Popular', palette: (dark) => (dark ? PALETTES.monokaiPro : PALETTES.monokaiLight) },
  { id: 'nord', name: 'Nord', group: 'Popular', palette: (dark) => (dark ? PALETTES.nord : PALETTES.nordLight) },
  { id: 'dracula', name: 'Dracula', group: 'Popular', palette: (dark) => (dark ? PALETTES.dracula : PALETTES.alucard) },
  { id: 'tokyonight', name: 'Tokyo Night', group: 'Popular', palette: (dark) => (dark ? PALETTES.tokyonight : PALETTES.tokyonightDay) },
  { id: 'rosepine', name: 'Rosé Pine', group: 'Popular', palette: (dark) => (dark ? PALETTES.rosepine : PALETTES.rosepineDawn) },
  { id: 'rosepinemoon', name: 'Rosé Pine Moon', group: 'Popular', palette: (dark) => (dark ? PALETTES.rosepineMoon : PALETTES.rosepineDawn) },
  { id: 'solarized', name: 'Solarized', group: 'Popular', palette: (dark) => (dark ? PALETTES.solarizedDark : PALETTES.solarizedLight) },
  { id: 'everforest', name: 'Everforest', group: 'Popular', palette: (dark) => (dark ? PALETTES.everforest : PALETTES.everforestLight) },
];

export const VARIANTS = {
  tonalSpot: ['Tonal spot', SchemeTonalSpot], vibrant: ['Vibrant', SchemeVibrant], expressive: ['Expressive', SchemeExpressive],
  fidelity: ['Fidelity', SchemeFidelity], content: ['Content', SchemeContent], neutral: ['Neutral', SchemeNeutral],
  monochrome: ['Monochrome', SchemeMonochrome], rainbow: ['Rainbow', SchemeRainbow], fruitSalad: ['Fruit salad', SchemeFruitSalad],
};
const CONTRAST = { standard: 0, medium: 0.5, high: 1 };

const ROLES = ['primary', 'onPrimary', 'primaryContainer', 'onPrimaryContainer', 'inversePrimary', 'secondary', 'onSecondary',
  'secondaryContainer', 'onSecondaryContainer', 'tertiary', 'onTertiary', 'tertiaryContainer', 'onTertiaryContainer', 'error',
  'onError', 'errorContainer', 'onErrorContainer', 'background', 'onBackground', 'surface', 'onSurface', 'surfaceVariant',
  'onSurfaceVariant', 'outline', 'outlineVariant', 'shadow', 'scrim', 'inverseSurface', 'inverseOnSurface', 'surfaceTint',
  'surfaceDim', 'surfaceBright', 'surfaceContainerLowest', 'surfaceContainerLow', 'surfaceContainer', 'surfaceContainerHigh',
  'surfaceContainerHighest'];
const kebab = (s) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());

function fromSeed(seed, dark, variant, contrastLevel) {
  const Ctor = (VARIANTS[variant] || VARIANTS.tonalSpot)[1];
  const scheme = new Ctor(Hct.fromInt(argbFromHex(seed)), dark, contrastLevel);
  const t = {};
  for (const r of ROLES) {
    const dc = MDC[r];
    if (dc && dc.getArgb) t[r] = hexFromArgb(dc.getArgb(scheme));
  }
  t.good = dark ? '#7dd38f' : '#1e7d34';
  t.warn = dark ? '#f0b45a' : '#8f5b00';
  return t;
}

function fromPalette(p, contrastLevel) {
  const dark = p.dark;
  const onAccent = (c) => {
    const darkInk = dark ? p.lowest : mix(p.text, '#000000', 0.5);
    return contrast(darkInk, c) >= contrast('#ffffff', c) ? darkInk : '#ffffff';
  };
  const container = (c) => mix(p.bg, c, dark ? 0.28 : 0.2);
  const onContainer = (c) => ensure(dark ? mix(c, '#ffffff', 0.35) : mix(c, '#000000', 0.45), container(c), 4.5 + contrastLevel * 2.5);
  const k = contrastLevel;
  const t = {
    primary: p.primary, onPrimary: onAccent(p.primary), primaryContainer: container(p.primary), onPrimaryContainer: onContainer(p.primary),
    inversePrimary: dark ? mix(p.primary, '#000000', 0.4) : mix(p.primary, '#ffffff', 0.4),
    secondary: p.secondary, onSecondary: onAccent(p.secondary), secondaryContainer: container(p.secondary), onSecondaryContainer: onContainer(p.secondary),
    tertiary: p.tertiary, onTertiary: onAccent(p.tertiary), tertiaryContainer: container(p.tertiary), onTertiaryContainer: onContainer(p.tertiary),
    error: p.error, onError: onAccent(p.error), errorContainer: container(p.error), onErrorContainer: onContainer(p.error),
    background: p.bg, onBackground: p.text, surface: p.bg, onSurface: k ? mix(p.text, dark ? '#ffffff' : '#000000', 0.5 * k) : p.text,
    surfaceVariant: p.highest, onSurfaceVariant: k ? mix(p.sub, p.text, 0.6 * k) : p.sub,
    outline: k ? mix(p.outline, p.text, 0.45 * k) : p.outline, outlineVariant: k ? mix(p.outlineVar, p.outline, 0.6 * k) : p.outlineVar,
    shadow: '#000000', scrim: '#000000', inverseSurface: p.text, inverseOnSurface: p.bg, surfaceTint: p.primary,
    surfaceDim: dark ? p.lowest : mix(p.bg, p.highest, 0.6), surfaceBright: dark ? p.highest : p.lowest,
    surfaceContainerLowest: p.lowest, surfaceContainerLow: p.low, surfaceContainer: p.cont, surfaceContainerHigh: p.high,
    surfaceContainerHighest: p.highest, good: p.good, warn: p.warn,
  };
  // Ensure readable accent text on the surfaces it is used on.
  t.primary = ensure(t.primary, p.bg, 3);
  return t;
}

function amoledize(t) {
  return Object.assign(t, {
    background: '#000000', surface: '#000000', surfaceDim: '#000000', surfaceContainerLowest: '#000000', surfaceContainerLow: '#0b0b0d',
    surfaceContainer: '#111114', surfaceContainerHigh: '#18181c', surfaceContainerHighest: '#222227', surfaceBright: '#2a2a30',
    inverseOnSurface: '#000000',
  });
}

/** Resolve the colour roles for the given appearance settings. */
export function resolveTheme(a, systemScheme) {
  const theme = THEMES.find((x) => x.id === a.theme) || THEMES[0];
  const dark = (a.mode === 'system' ? systemScheme : a.mode) === 'dark';
  const c = CONTRAST[a.contrast] ?? 0;
  let tokens;
  if (theme.palette) {
    tokens = fromPalette(theme.palette(dark, a), c);
  } else {
    const seed = theme.custom ? (a.seed || '#6750A4') : theme.seed;
    const variant = theme.variant || a.variant || 'tonalSpot';
    tokens = fromSeed(seed, dark, variant, c);
  }
  const isDark = theme.palette ? theme.palette(dark, a).dark : dark;
  if (a.amoled && isDark) amoledize(tokens);
  return { tokens, dark: isDark, glass: !!(a.glass || theme.glass), theme };
}

/** Small set of colours for theme preview cards. */
export function previewColors(themeId, a, systemScheme) {
  const { tokens } = resolveTheme(Object.assign({}, a, { theme: themeId, amoled: false }), systemScheme);
  return {
    bg: tokens.surfaceContainerLow, surface: tokens.surface, primary: tokens.primary, onPrimary: tokens.onPrimary,
    text: tokens.onSurface, sub: tokens.onSurfaceVariant, container: tokens.secondaryContainer, tertiary: tokens.tertiary,
  };
}

export function catppuccinAccentColor(name, flavour) { return CATPPUCCIN[flavour || 'mocha'][name]; }

const DECK_COLORS = ['primary', 'on-primary', 'primary-container', 'on-primary-container', 'secondary-container',
  'on-secondary-container', 'tertiary-container', 'on-tertiary-container', 'surface', 'on-surface', 'on-surface-variant',
  'surface-container-low', 'surface-container', 'surface-container-high', 'surface-container-highest', 'outline',
  'outline-variant', 'error', 'error-container', 'on-error-container'];

/** The current theme as --fv-* variables, for decks made with the deck editor (see custom-deck.css). */
export function deckThemeVars() {
  const cs = getComputedStyle(document.documentElement);
  const vars = {};
  for (const k of DECK_COLORS) {
    const v = cs.getPropertyValue('--md-sys-color-' + k).trim();
    if (v) vars['--fv-' + k] = v;
  }
  const extra = { '--fv-good': '--c-good', '--fv-font': '--font', '--fv-mono': '--font-mono', '--fv-corner': '--corner', '--fv-font-scale': '--font-scale' };
  for (const [to, from] of Object.entries(extra)) {
    const v = cs.getPropertyValue(from).trim();
    if (v) vars[to] = v;
  }
  return { vars, dark: document.documentElement.classList.contains('dark') };
}

/** Apply tokens + appearance variables to the document. */
export function applyTheme(a, systemScheme) {
  const r = resolveTheme(a, systemScheme);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(r.tokens)) {
    if (k === 'good' || k === 'warn') continue;
    root.style.setProperty('--md-sys-color-' + kebab(k), v);
  }
  root.style.setProperty('--c-good', r.tokens.good);
  root.style.setProperty('--c-warn', r.tokens.warn);
  root.style.setProperty('--c-bad', r.tokens.error);
  root.style.colorScheme = r.dark ? 'dark' : 'light';
  root.classList.toggle('dark', r.dark);
  root.classList.toggle('glass', r.glass);
  root.style.setProperty('--glass-blur', (a.glassBlur ?? 24) + 'px');
  root.style.setProperty('--glass-alpha', String(a.glassOpacity ?? 0.62));
  const q = (f) => `"${f}"`;
  const font = a.font ? `${q(a.font)}, "Roboto Flex", Roboto, system-ui, sans-serif` : '';
  if (font) root.style.setProperty('--font', font);
  root.style.setProperty('--font-heading', a.headingFont ? `${q(a.headingFont)}, ${font || 'sans-serif'}` : 'var(--font)');
  root.style.setProperty('--font-mono', a.monoFont ? `${q(a.monoFont)}, ui-monospace, monospace` : 'ui-monospace, monospace');
  root.style.setProperty('--font-scale', String(a.fontScale || 1));
  root.style.setProperty('--corner', String(a.corner ?? 1));
  const iconFam = { outlined: 'Material Symbols Outlined', rounded: 'Material Symbols Rounded', sharp: 'Material Symbols Sharp' }[a.iconStyle] || 'Material Symbols Rounded';
  root.style.setProperty('--icon-font', `"${iconFam}"`);
  root.style.setProperty('--icon-fill', a.iconFill ? '1' : '0');
  root.style.setProperty('--icon-wght', String(a.iconWeight || 400));
  document.body.classList.toggle('compact', a.density === 'compact');
  return r;
}
