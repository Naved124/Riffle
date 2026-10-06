"""A tolerant parser for JavaScript *literals* embedded in source code.

AI-made flashcard decks usually keep their cards in something like::

    const cards = [
      { question: 'It\\'s…', answer: `multi
      line`, icon: <Brain />, },   // comment
    ];

That is not JSON: keys are unquoted, strings use three quote styles, there are
comments and trailing commas, and some values are arbitrary expressions. This
module parses arrays/objects/strings/numbers and *skips* any expression it does
not understand (returning ``UNKNOWN``) so one odd value never loses the deck.
"""

from __future__ import annotations

import re

__all__ = ["UNKNOWN", "ParseError", "parse_literal_at", "find_literal_arrays"]


class _Unknown:
    def __repr__(self) -> str:  # pragma: no cover - debug helper
        return "UNKNOWN"


UNKNOWN = _Unknown()


class ParseError(ValueError):
    pass


_IDENT_START = re.compile(r"[A-Za-z_$À-￿]")
_IDENT = re.compile(r"[A-Za-z0-9_$À-￿]*")
_NUMBER = re.compile(r"-?(?:0[xX][0-9a-fA-F_]+|(?:\d[\d_]*\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)n?")
_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "v": "\v", "0": "\0"}


class _Parser:
    def __init__(self, src: str, pos: int):
        self.s = src
        self.i = pos
        self.n = len(src)

    # -- low level -------------------------------------------------------
    def ws(self) -> None:
        s, n = self.s, self.n
        while self.i < n:
            c = s[self.i]
            if c in " \t\r\n\ufeff\u00a0":
                self.i += 1
            elif s.startswith("//", self.i):
                j = s.find("\n", self.i)
                self.i = n if j < 0 else j + 1
            elif s.startswith("/*", self.i):
                j = s.find("*/", self.i + 2)
                self.i = n if j < 0 else j + 2
            else:
                break

    def peek(self) -> str:
        return self.s[self.i] if self.i < self.n else ""

    def expect(self, ch: str) -> None:
        self.ws()
        if self.peek() != ch:
            raise ParseError(f"expected {ch!r} at {self.i}")
        self.i += 1

    # -- values ----------------------------------------------------------
    def value(self):
        self.ws()
        c = self.peek()
        if c == "[":
            return self.array()
        if c == "{":
            return self.obj()
        if c in "'\"":
            return self.string(c)
        if c == "`":
            return self.template()
        start = self.i
        m = _NUMBER.match(self.s, self.i)
        if m and m.group(0) not in ("-", ""):
            self.i = m.end()
            if self._at_value_end():
                txt = m.group(0).replace("_", "").rstrip("n")
                try:
                    if txt.lower().startswith(("0x", "-0x")):
                        return int(txt, 16)
                    f = float(txt)
                    return int(f) if f.is_integer() and "." not in txt and "e" not in txt.lower() else f
                except ValueError:
                    pass
            self.i = start
        if _IDENT_START.match(c or " "):
            m = _IDENT.match(self.s, self.i + 1)
            word = self.s[self.i:m.end()]
            self.i = m.end()
            if self._at_value_end():
                return {"true": True, "false": False, "null": None, "undefined": None}.get(word, UNKNOWN)
            self.i = start
        self.skip_expression()
        return UNKNOWN

    def _at_value_end(self) -> bool:
        save = self.i
        self.ws()
        ok = self.peek() in (",", "]", "}", ")", ";", "")
        self.i = save
        return ok

    def string(self, q: str) -> str:
        s, n = self.s, self.n
        self.i += 1
        out = []
        while self.i < n:
            c = s[self.i]
            if c == "\\":
                self.i += 1
                if self.i >= n:
                    break
                e = s[self.i]
                if e == "u":
                    if s.startswith("{", self.i + 1):
                        j = s.find("}", self.i)
                        out.append(chr(int(s[self.i + 2:j], 16)))
                        self.i = j + 1
                        continue
                    out.append(chr(int(s[self.i + 1:self.i + 5], 16)))
                    self.i += 5
                    continue
                if e == "x":
                    out.append(chr(int(s[self.i + 1:self.i + 3], 16)))
                    self.i += 3
                    continue
                if e == "\r" and s.startswith("\n", self.i + 1):
                    self.i += 2
                    continue
                if e == "\n":
                    self.i += 1
                    continue
                out.append(_ESCAPES.get(e, e))
                self.i += 1
            elif c == q:
                self.i += 1
                return "".join(out)
            elif c == "\n" and q != "`":
                raise ParseError("newline in string")
            else:
                out.append(c)
                self.i += 1
        raise ParseError("unterminated string")

    def template(self) -> str:
        # Template literals: keep ${...} placeholders verbatim.
        s, n = self.s, self.n
        self.i += 1
        out = []
        while self.i < n:
            c = s[self.i]
            if c == "\\":
                e = s[self.i + 1:self.i + 2]
                out.append(_ESCAPES.get(e, e))
                self.i += 2
            elif c == "`":
                self.i += 1
                return "".join(out)
            elif c == "$" and s.startswith("{", self.i + 1):
                start = self.i
                self.i += 1
                self._skip_balanced()
                out.append(s[start:self.i])
            else:
                out.append(c)
                self.i += 1
        raise ParseError("unterminated template")

    def array(self) -> list:
        self.i += 1
        out = []
        while True:
            self.ws()
            c = self.peek()
            if c == "]":
                self.i += 1
                return out
            if c == "":
                raise ParseError("unterminated array")
            if c == ",":  # hole
                self.i += 1
                continue
            if self.s.startswith("...", self.i):
                self.i += 3
                self.skip_expression()
            else:
                out.append(self.value())
            self.ws()
            c = self.peek()
            if c == ",":
                self.i += 1
            elif c != "]":
                raise ParseError(f"bad array separator {c!r} at {self.i}")

    def obj(self) -> dict:
        self.i += 1
        out: dict = {}
        while True:
            self.ws()
            c = self.peek()
            if c == "}":
                self.i += 1
                return out
            if c == "":
                raise ParseError("unterminated object")
            if self.s.startswith("...", self.i):
                self.i += 3
                self.skip_expression()
            else:
                key = self.key()
                self.ws()
                c = self.peek()
                if c == ":":
                    self.i += 1
                    out[key] = self.value()
                elif c in ",}":  # shorthand {a, b}
                    out[key] = UNKNOWN
                elif c == "(":  # method  name() { ... }
                    self._skip_balanced()
                    self.ws()
                    if self.peek() == "{":
                        self._skip_balanced()
                    out[key] = UNKNOWN
                else:
                    raise ParseError(f"bad object entry at {self.i}")
            self.ws()
            c = self.peek()
            if c == ",":
                self.i += 1
            elif c != "}":
                raise ParseError(f"bad object separator {c!r} at {self.i}")

    def key(self) -> str:
        c = self.peek()
        if c in "'\"":
            return self.string(c)
        if c == "[":  # computed key
            start = self.i
            self._skip_balanced()
            return self.s[start:self.i]
        m = re.compile(r"[A-Za-z0-9_$À-￿]+").match(self.s, self.i)
        if not m:
            raise ParseError(f"bad key at {self.i}")
        self.i = m.end()
        return m.group(0)

    # -- skipping arbitrary expressions -------------------------------------
    def _skip_balanced(self) -> None:
        """Skip a bracketed group starting at the current char ({, [ or ()."""
        pairs = {"{": "}", "[": "]", "(": ")"}
        stack = [pairs[self.s[self.i]]]
        self.i += 1
        self._skip_until(stack)

    def _skip_until(self, stack: list, stop_at_depth0: str = "") -> None:
        s, n = self.s, self.n
        pairs = {"{": "}", "[": "]", "(": ")"}
        while self.i < n:
            self.ws()
            if self.i >= n:
                break
            c = s[self.i]
            if not stack and c in stop_at_depth0:
                return
            if c in "'\"":
                try:
                    self.string(c)
                except ParseError:
                    self.i += 1
                continue
            if c == "`":
                self.template()
                continue
            if c in pairs:
                stack.append(pairs[c])
            elif c in ")]}":
                if not stack:
                    return
                if c != stack.pop():
                    raise ParseError("mismatched bracket")
                if not stack and not stop_at_depth0:
                    self.i += 1
                    return
            self.i += 1
        if stack:
            raise ParseError("unbalanced expression")

    def skip_expression(self) -> None:
        """Skip one expression: stop at , ] } ) or ; at depth 0."""
        start = self.i
        self._skip_until([], stop_at_depth0=",]});")
        if self.i == start:
            raise ParseError(f"empty expression at {start}")


def parse_literal_at(src: str, pos: int):
    """Parse the literal starting at ``src[pos]``; return ``(value, end)``."""
    p = _Parser(src, pos)
    v = p.value()
    return v, p.i


# An array of objects, or an array of string rows like [["Topic", "question", "answer"], ...]
_ARRAY_OF_OBJECTS = re.compile(r"\[\s*(?://[^\n]*\n\s*|/\*.*?\*/\s*)*(?:\{|\[\s*['\"`])", re.S)


def find_literal_arrays(src: str):
    """Yield ``(value, start, end, label)`` for every top-level array literal of
    objects (or string rows) in ``src``. ``label`` is the name it is assigned to or the object
    key it sits under (e.g. ``animals`` in ``{animals: [...]}``), if any."""
    pos = 0
    while True:
        m = _ARRAY_OF_OBJECTS.search(src, pos)
        if not m:
            return
        start = m.start()
        try:
            value, end = parse_literal_at(src, start)
        except (ParseError, ValueError, IndexError):
            pos = start + 1
            continue
        before = src[max(0, start - 80):start]
        lm = re.search(r"([A-Za-z_$][\w$]*|['\"][^'\"]+['\"])\s*(?::\s*[\w<>\[\]\s|]*?)?\s*[:=]\s*(?:Object\.freeze\(\s*)?$", before)
        label = lm.group(1).strip("'\"") if lm else ""
        yield value, start, end, label
        pos = end
