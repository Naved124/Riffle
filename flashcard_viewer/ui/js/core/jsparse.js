// Tolerant parser for JavaScript *literals* (port of flashcard_viewer/jsparse.py).
// Parses arrays/objects/strings/numbers and skips expressions it does not understand.

export const UNKNOWN = Symbol('UNKNOWN');

class ParseError extends Error {}

const IDENT_START = /[A-Za-z_$À-￿]/;
const IDENT_CHAR = /[A-Za-z0-9_$À-￿]/;
const NUMBER = /-?(?:0[xX][0-9a-fA-F_]+|(?:\d[\d_]*\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)n?/y;
const ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
const PAIRS = { '{': '}', '[': ']', '(': ')' };

class Parser {
  constructor(src, pos) { this.s = src; this.i = pos; this.n = src.length; }

  ws() {
    const s = this.s;
    while (this.i < this.n) {
      const c = s[this.i];
      if (' \t\r\n﻿ '.includes(c)) this.i++;
      else if (s.startsWith('//', this.i)) { const j = s.indexOf('\n', this.i); this.i = j < 0 ? this.n : j + 1; }
      else if (s.startsWith('/*', this.i)) { const j = s.indexOf('*/', this.i + 2); this.i = j < 0 ? this.n : j + 2; }
      else break;
    }
  }

  peek() { return this.i < this.n ? this.s[this.i] : ''; }

  atValueEnd() {
    const save = this.i;
    this.ws();
    const ok = [',', ']', '}', ')', ';', ''].includes(this.peek());
    this.i = save;
    return ok;
  }

  value() {
    this.ws();
    const c = this.peek();
    if (c === '[') return this.array();
    if (c === '{') return this.obj();
    if (c === "'" || c === '"') return this.string(c);
    if (c === '`') return this.template();
    const start = this.i;
    NUMBER.lastIndex = this.i;
    const m = NUMBER.exec(this.s);
    if (m && m[0] !== '-' && m[0] !== '') {
      this.i = start + m[0].length;
      if (this.atValueEnd()) {
        const txt = m[0].replace(/_/g, '').replace(/n$/, '');
        const v = /^-?0x/i.test(txt) ? parseInt(txt, 16) : Number(txt);
        if (!Number.isNaN(v)) return v;
      }
      this.i = start;
    }
    if (c && IDENT_START.test(c)) {
      let j = this.i + 1;
      while (j < this.n && IDENT_CHAR.test(this.s[j])) j++;
      const word = this.s.slice(this.i, j);
      this.i = j;
      if (this.atValueEnd()) {
        if (word === 'true') return true;
        if (word === 'false') return false;
        if (word === 'null' || word === 'undefined') return null;
        return UNKNOWN;
      }
      this.i = start;
    }
    this.skipExpression();
    return UNKNOWN;
  }

  string(q) {
    const s = this.s;
    this.i++;
    let out = '';
    while (this.i < this.n) {
      const c = s[this.i];
      if (c === '\\') {
        this.i++;
        if (this.i >= this.n) break;
        const e = s[this.i];
        if (e === 'u') {
          if (s[this.i + 1] === '{') {
            const j = s.indexOf('}', this.i);
            out += String.fromCodePoint(parseInt(s.slice(this.i + 2, j), 16));
            this.i = j + 1;
            continue;
          }
          out += String.fromCharCode(parseInt(s.slice(this.i + 1, this.i + 5), 16));
          this.i += 5;
          continue;
        }
        if (e === 'x') { out += String.fromCharCode(parseInt(s.slice(this.i + 1, this.i + 3), 16)); this.i += 3; continue; }
        if (e === '\r' && s[this.i + 1] === '\n') { this.i += 2; continue; }
        if (e === '\n') { this.i++; continue; }
        out += ESCAPES[e] ?? e;
        this.i++;
      } else if (c === q) {
        this.i++;
        return out;
      } else if (c === '\n' && q !== '`') {
        throw new ParseError('newline in string');
      } else {
        out += c;
        this.i++;
      }
    }
    throw new ParseError('unterminated string');
  }

  template() {
    const s = this.s;
    this.i++;
    let out = '';
    while (this.i < this.n) {
      const c = s[this.i];
      if (c === '\\') { const e = s[this.i + 1] || ''; out += ESCAPES[e] ?? e; this.i += 2; }
      else if (c === '`') { this.i++; return out; }
      else if (c === '$' && s[this.i + 1] === '{') {
        const start = this.i;
        this.i++;
        this.skipBalanced();
        out += s.slice(start, this.i);
      } else { out += c; this.i++; }
    }
    throw new ParseError('unterminated template');
  }

  array() {
    this.i++;
    const out = [];
    for (;;) {
      this.ws();
      const c = this.peek();
      if (c === ']') { this.i++; return out; }
      if (c === '') throw new ParseError('unterminated array');
      if (c === ',') { this.i++; continue; }
      if (this.s.startsWith('...', this.i)) { this.i += 3; this.skipExpression(); }
      else out.push(this.value());
      this.ws();
      const d = this.peek();
      if (d === ',') this.i++;
      else if (d !== ']') throw new ParseError(`bad array separator ${d} at ${this.i}`);
    }
  }

  obj() {
    this.i++;
    const out = new Map();
    for (;;) {
      this.ws();
      const c = this.peek();
      if (c === '}') { this.i++; return out; }
      if (c === '') throw new ParseError('unterminated object');
      if (this.s.startsWith('...', this.i)) { this.i += 3; this.skipExpression(); }
      else {
        const key = this.key();
        this.ws();
        const d = this.peek();
        if (d === ':') { this.i++; out.set(key, this.value()); }
        else if (d === ',' || d === '}') out.set(key, UNKNOWN);
        else if (d === '(') {
          this.skipBalanced();
          this.ws();
          if (this.peek() === '{') this.skipBalanced();
          out.set(key, UNKNOWN);
        } else throw new ParseError(`bad object entry at ${this.i}`);
      }
      this.ws();
      const e = this.peek();
      if (e === ',') this.i++;
      else if (e !== '}') throw new ParseError(`bad object separator at ${this.i}`);
    }
  }

  key() {
    const c = this.peek();
    if (c === "'" || c === '"') return this.string(c);
    if (c === '[') { const start = this.i; this.skipBalanced(); return this.s.slice(start, this.i); }
    let j = this.i;
    while (j < this.n && IDENT_CHAR.test(this.s[j])) j++;
    if (j === this.i) throw new ParseError(`bad key at ${this.i}`);
    const k = this.s.slice(this.i, j);
    this.i = j;
    return k;
  }

  skipBalanced() {
    const stack = [PAIRS[this.s[this.i]]];
    this.i++;
    this.skipUntil(stack, '');
  }

  skipUntil(stack, stopAtDepth0) {
    const s = this.s;
    while (this.i < this.n) {
      this.ws();
      if (this.i >= this.n) break;
      const c = s[this.i];
      if (!stack.length && stopAtDepth0.includes(c)) return;
      if (c === "'" || c === '"') {
        try { this.string(c); } catch (_) { this.i++; }
        continue;
      }
      if (c === '`') { this.template(); continue; }
      if (PAIRS[c]) stack.push(PAIRS[c]);
      else if (')]}'.includes(c)) {
        if (!stack.length) return;
        if (c !== stack.pop()) throw new ParseError('mismatched bracket');
        if (!stack.length && !stopAtDepth0) { this.i++; return; }
      }
      this.i++;
    }
    if (stack.length) throw new ParseError('unbalanced expression');
  }

  skipExpression() {
    const start = this.i;
    this.skipUntil([], ',]});');
    if (this.i === start) throw new ParseError(`empty expression at ${start}`);
  }
}

export function parseLiteralAt(src, pos) {
  const p = new Parser(src, pos);
  const v = p.value();
  return [v, p.i];
}

// An array of objects, or an array of string rows like [["Topic", "question", "answer"], ...]
const ARRAY_OF_OBJECTS = /\[\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*(?:\{|\[\s*['"`])/g;
const LABEL = /([A-Za-z_$][\w$]*|['"][^'"]+['"])\s*(?::\s*[\w<>[\]\s|]*?)?\s*[:=]\s*(?:Object\.freeze\(\s*)?$/;

/** Yield [value, start, end, label] for each top-level array literal of objects. Objects are Maps. */
export function* findLiteralArrays(src) {
  let pos = 0;
  for (;;) {
    ARRAY_OF_OBJECTS.lastIndex = pos;
    const m = ARRAY_OF_OBJECTS.exec(src);
    if (!m) return;
    const start = m.index;
    let value, end;
    try {
      [value, end] = parseLiteralAt(src, start);
    } catch (_) {
      pos = start + 1;
      continue;
    }
    const before = src.slice(Math.max(0, start - 80), start);
    const lm = LABEL.exec(before);
    const label = lm ? lm[1].replace(/^['"]|['"]$/g, '') : '';
    yield [value, start, end, label];
    pos = end;
  }
}
