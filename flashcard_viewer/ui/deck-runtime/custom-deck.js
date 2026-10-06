/* Runtime of decks made with the deck editor (inlined into each deck file, see js/core/deckgen.js).
 * Reads the cards from <script id="fv-deck-data">, renders their Markdown safely (everything is
 * escaped; links only http(s)/mailto, images only embedded data: images or https), and loads KaTeX
 * when a card has maths: from the app's bundled copy when running inside Riffle, otherwise
 * from a CDN. The editor's live preview drives it with {fvPreview: {...}} messages. */
(function () {
  'use strict';
  var KATEX_CDN = 'https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/';
  var IMAGE_RX = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
  // Code spans and maths, protected from other formatting. Same pattern as toPlain() in deckgen.js.
  var PROTECT_RX = /(`+)([\s\S]*?[^`])\1(?!`)|(?<!\\)\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<![\\$])\$(?=\S)(?:\\.|[^$\\\n])+?(?<=\S)\$(?![\d$])/g;
  var ICONS = {
    prev: 'M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z',
    next: 'M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
    flip: 'M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z',
    shuffle: 'M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z',
    restart: 'M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z',
    hint: 'M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z',
    check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
    close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z'
  };
  var icon = function (n) { return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + ICONS[n] + '"/></svg>'; };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  // ------------------------------------------------------------------ Markdown
  var images = {};

  function mathHtml(src) {
    var display = /^(\$\$|\\\[)/.test(src);
    var tex = src.replace(/^(\$\$|\\\[|\\\(|\$)/, '').replace(/(\$\$|\\\]|\\\)|\$)$/, '');
    return '<span class="fv-math' + (display ? ' fv-math-display' : '') + '" data-tex="' + esc(tex.trim()) + '"' +
      (display ? ' data-display=""' : '') + '>' + esc(src) + '</span>';
  }

  function imageSrc(ref) {
    if (ref.indexOf('img:') === 0) {
      var uri = images[ref.slice(4)];
      return typeof uri === 'string' && IMAGE_RX.test(uri) ? uri : '';
    }
    return /^https:\/\/[^\s"'<>]+$/i.test(ref) ? ref : '';
  }

  function inline(s) {
    var kept = [];
    var keep = function (html) { return '\u0000' + (kept.push(html) - 1) + '\u0000'; };
    s = s.replace(PROTECT_RX, function (m, ticks, code) {
      if (ticks) return keep('<code>' + esc(code.replace(/^ ([\s\S]*) $/, '$1')) + '</code>');
      return keep(mathHtml(m));
    });
    s = s.replace(/\\([\\`*_{}[\]()#+\-.!~>|$])/g, function (_, c) { return keep(esc(c)); });
    s = s.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, function (m, alt, ref) {
      var src = imageSrc(ref);
      return src ? keep('<img src="' + esc(src) + '" alt="' + esc(alt) + '" loading="lazy">') : keep(esc(alt));
    });
    s = s.replace(/\[([^\]\n]+)\]\(((?:https?:|mailto:)[^)\s]+)\)/g, function (m, text, href) {
      return keep('<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">') + text + keep('</a>');
    });
    s = esc(s);
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
      .replace(/(?<![A-Za-z0-9_*\\])\*(?=\S)([^*\n]*?\S)\*(?![A-Za-z0-9_*])/g, '<em>$1</em>')
      .replace(/(?<![A-Za-z0-9_\\])_(?=\S)([^_\n]*?\S)_(?![A-Za-z0-9_])/g, '<em>$1</em>');
    for (var guard = 0; guard < 4 && s.indexOf('\u0000') >= 0; guard++) {
      s = s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return kept[+i]; });
    }
    return s;
  }

  function md(src) {
    var lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    var out = [], para = [], i = 0, m;
    var flush = function () {
      if (para.length) out.push('<p>' + para.map(inline).join('<br>') + '</p>');
      para = [];
    };
    while (i < lines.length) {
      var line = lines[i];
      if (/^\s*```/.test(line)) {
        flush();
        var code = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
        i++;
        out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
        continue;
      }
      if ((m = /^\s*(\$\$|\\\[)\s*$/.exec(line))) {
        var close = m[1] === '$$' ? /^\s*\$\$\s*$/ : /^\s*\\\]\s*$/;
        var j = i + 1, body = [];
        while (j < lines.length && !close.test(lines[j])) body.push(lines[j++]);
        if (j < lines.length) {
          flush();
          out.push('<p>' + mathHtml(m[1] + body.join('\n') + (m[1] === '$$' ? '$$' : '\\]')) + '</p>');
          i = j + 1;
          continue;
        }
      }
      if ((m = /^\s*(#{1,6})\s+(.*)$/.exec(line))) { flush(); out.push('<h3>' + inline(m[2]) + '</h3>'); i++; continue; }
      if (/^\s*([-*+]|\d{1,3}[.)])\s+/.test(line)) {
        flush();
        var ordered = /^\s*\d/.test(line), items = [];
        while (i < lines.length && (m = /^\s*([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(lines[i])) && /^\d/.test(m[1]) === ordered) {
          items.push('<li>' + inline(m[2]) + '</li>');
          i++;
        }
        out.push(ordered ? '<ol>' + items.join('') + '</ol>' : '<ul>' + items.join('') + '</ul>');
        continue;
      }
      if (/^\s*>/.test(line)) {
        flush();
        var quote = [];
        while (i < lines.length && (m = /^\s*>\s?(.*)$/.exec(lines[i]))) { quote.push(inline(m[1])); i++; }
        out.push('<blockquote>' + quote.join('<br>') + '</blockquote>');
        continue;
      }
      if (!line.trim()) { flush(); i++; continue; }
      para.push(line);
      i++;
    }
    flush();
    return out.join('');
  }

  var plainLength = function (s) { return String(s || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').length; };
  var isLong = function (s) { return plainLength(s) > 140 || /(^|\n)\s*([-*+]\s|\d+[.)]\s|```|>|#)/.test(s || '') || /\n\s*\n/.test(s || ''); };

  // ------------------------------------------------------------------ KaTeX
  var katexPromise = null;
  function loadFrom(base) {
    return new Promise(function (resolve, reject) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = base + 'katex.min.css';
      document.head.appendChild(link);
      var s = document.createElement('script');
      s.src = base + 'katex.min.js';
      s.onload = function () { window.katex ? resolve(window.katex) : reject(new Error('no katex')); };
      s.onerror = function () { link.remove(); s.remove(); reject(new Error('katex failed to load')); };
      document.head.appendChild(s);
    });
  }
  function loadKatex() {
    if (window.katex) return Promise.resolve(window.katex);
    if (!katexPromise) {
      var vendor = typeof window.__fvVendor === 'string' ? window.__fvVendor : '';
      katexPromise = (vendor ? loadFrom(vendor + 'katex/') : Promise.reject(new Error('no vendor')))
        .catch(function () { return loadFrom(KATEX_CDN); });
      katexPromise.catch(function () { katexPromise = null; });
    }
    return katexPromise;
  }
  function renderMath(root) {
    var nodes = root.querySelectorAll('.fv-math:not(.fv-ready)');
    if (!nodes.length) return;
    loadKatex().then(function (katex) {
      nodes.forEach(function (el) {
        try {
          katex.render(el.getAttribute('data-tex') || '', el, { displayMode: el.hasAttribute('data-display'), throwOnError: false });
          el.classList.add('fv-ready');
        } catch (e) { /* leave the TeX source visible */ }
      });
    }, function () { /* offline and no bundled copy: the TeX source stays visible */ });
  }

  // ------------------------------------------------------------------ deck state
  var app = document.getElementById('fv-app');
  var deck = { title: '', emoji: '', description: '', cards: [] };
  var order = [];       // indices into deck.cards, in viewing order
  var pos = 0;
  var flipped = false;
  var hintOpen = false;
  var shuffled = false;
  var picks = {};       // card index -> chosen option (multiple choice)
  var previewing = false;

  function readDeck() {
    var el = document.getElementById('fv-deck-data');
    try { return JSON.parse(el ? el.textContent : '{}') || {}; } catch (e) { return {}; }
  }

  function setDeck(d, keepPlace) {
    deck = {
      title: String(d.title || ''), emoji: String(d.emoji || ''), description: String(d.description || ''),
      cards: (Array.isArray(d.cards) ? d.cards : []).filter(function (c) { return c && String(c.front || '').trim(); })
    };
    images = d.images && typeof d.images === 'object' ? d.images : {};
    var n = deck.cards.length;
    if (!keepPlace || order.length !== n) {
      order = deck.cards.map(function (_, i) { return i; });
      if (shuffled) shuffle(order);
    }
    pos = Math.max(0, Math.min(pos, n - 1));
  }

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // ------------------------------------------------------------------ rendering
  function renderShell() {
    var head = '';
    if (deck.emoji || deck.title || deck.description) {
      head = '<header class="fv-head">' + (deck.emoji ? '<div class="fv-emoji" aria-hidden="true">' + esc(deck.emoji) + '</div>' : '') +
        '<div class="fv-titles"><h1 class="fv-title">' + esc(deck.title || 'Untitled deck') + '</h1>' +
        (deck.description.trim() ? '<div class="fv-desc fv-md">' + md(deck.description) + '</div>' : '') + '</div></header>';
    }
    if (!deck.cards.length) {
      app.innerHTML = head + '<div class="fv-empty"><p>This deck has no cards yet.</p></div>';
      return;
    }
    app.innerHTML = head +
      '<div class="fv-bar"><span class="fv-count" aria-live="polite"></span><div class="fv-track"><div class="fv-fill"></div></div>' +
      '<button class="fv-btn fv-icon fv-small" data-act="shuffle" aria-pressed="' + shuffled + '" title="Shuffle (S)">' + icon('shuffle') + '</button>' +
      '<button class="fv-btn fv-icon fv-small" data-act="restart" title="Start over">' + icon('restart') + '</button></div>' +
      '<main class="fv-stage"><div class="fv-card" tabindex="0" role="button" aria-label="Flashcard. Press Space to flip.">' +
      '<section class="fv-face fv-front"></section><section class="fv-face fv-back" aria-hidden="true"></section></div></main>' +
      '<nav class="fv-nav">' +
      '<button class="fv-btn fv-icon fv-outlined" data-act="prev" title="Previous (←)">' + icon('prev') + '</button>' +
      '<button class="fv-btn fv-icon" data-act="hint" title="Hint (H)">' + icon('hint') + '</button>' +
      '<button class="fv-btn fv-filled" data-act="flip">' + icon('flip') + '<span>Show answer</span></button>' +
      '<button class="fv-btn fv-icon fv-outlined" data-act="next" title="Next (→)">' + icon('next') + '</button></nav>' +
      '<div class="fv-keys"><kbd>←</kbd> <kbd>→</kbd> move · <kbd>Space</kbd> flip · <kbd>H</kbd> hint · <kbd>S</kbd> shuffle</div>';
    renderMath(app.querySelector('.fv-head') || app);
    renderCard();
  }

  function renderCard(direction) {
    var cardEl = app.querySelector('.fv-card');
    if (!cardEl) return;
    var idx = order[pos];
    var c = deck.cards[idx] || {};
    var n = order.length;
    var mcq = c.type === 'mcq' && Array.isArray(c.choices) && c.choices.length >= 2;
    var chip = c.category && String(c.category).trim() ? '<span class="fv-chip">' + esc(c.category) + '</span>' : '';

    var front = '<div class="fv-label">' + (mcq ? 'Choose an answer' : 'Question') + chip + '</div>' +
      '<div class="fv-body fv-md' + (isLong(c.front) ? ' fv-long' : '') + '">' + md(c.front) + '</div>';
    if (mcq) {
      var picked = picks[idx];
      var answered = picked != null;
      front += '<div class="fv-options' + (answered ? ' fv-answered' : '') + '" role="group">';
      c.choices.forEach(function (o, k) {
        var cls = '';
        var mark = '';
        if (answered) {
          if (k === c.correct) { cls = ' fv-right'; mark = icon('check'); }
          else if (k === picked) { cls = ' fv-wrong'; mark = icon('close'); }
          else cls = ' fv-dim';
        }
        front += '<button class="fv-opt' + cls + '" data-opt="' + k + '"' + (answered ? ' aria-disabled="true"' : '') + '>' +
          '<span class="fv-letter">' + 'ABCDEFGH'[k] + '</span><span class="fv-otext fv-md">' + md(o) + '</span>' + mark + '</button>';
      });
      front += '</div>';
      if (answered) {
        front += picked === c.correct ? '<div class="fv-verdict fv-ok">Correct!</div>'
          : '<div class="fv-verdict fv-no">Not quite — the answer is ' + 'ABCDEFGH'[c.correct] + '.</div>';
      }
    }
    if (hintOpen && c.hint) front += '<div class="fv-hint"><b>Hint:</b> <span class="fv-md">' + md(c.hint) + '</span></div>';
    if (!mcq) front += '<div class="fv-tap">Tap the card or press Space to flip</div>';

    var answer = mcq ? (c.choices[c.correct] || '') : c.back;
    var back = '<div class="fv-label">Answer' + chip + '</div>' +
      '<div class="fv-body fv-md' + (isLong(answer) || c.explanation ? ' fv-long' : '') + '">' +
      (mcq ? '<p><strong>' + 'ABCDEFGH'[c.correct] + '.</strong></p>' : '') + md(answer) + '</div>';
    if (c.explanation && String(c.explanation).trim()) back += '<div class="fv-expl fv-md">' + md(c.explanation) + '</div>';

    if (direction) {
      cardEl.classList.add('fv-instant');
      flipped = false;
    }
    cardEl.querySelector('.fv-front').innerHTML = front;
    cardEl.querySelector('.fv-back').innerHTML = back;
    applyFlip();
    if (direction) {
      void cardEl.offsetWidth;
      cardEl.classList.remove('fv-instant');
      var stage = app.querySelector('.fv-stage');
      stage.classList.remove('fv-go-next', 'fv-go-prev');
      void stage.offsetWidth;
      stage.classList.add(direction > 0 ? 'fv-go-next' : 'fv-go-prev');
    }

    app.querySelector('.fv-count').textContent = (pos + 1) + ' / ' + n;
    app.querySelector('.fv-fill').style.width = ((pos + 1) / n * 100) + '%';
    app.querySelector('[data-act="prev"]').disabled = pos === 0;
    var nextBtn = app.querySelector('[data-act="next"]');
    nextBtn.innerHTML = icon(pos === n - 1 ? 'restart' : 'next');
    nextBtn.title = pos === n - 1 ? 'Start over' : 'Next (→)';
    var hintBtn = app.querySelector('[data-act="hint"]');
    hintBtn.hidden = !c.hint;
    hintBtn.setAttribute('aria-pressed', String(hintOpen));
    renderMath(cardEl);
  }

  function applyFlip() {
    var cardEl = app.querySelector('.fv-card');
    if (!cardEl) return;
    cardEl.classList.toggle('fv-flipped', flipped);
    cardEl.querySelector('.fv-front').setAttribute('aria-hidden', String(flipped));
    cardEl.querySelector('.fv-back').setAttribute('aria-hidden', String(!flipped));
    var label = app.querySelector('[data-act="flip"] span');
    if (label) label.textContent = flipped ? 'Show question' : 'Show answer';
  }

  // ------------------------------------------------------------------ actions
  function go(delta) {
    var n = order.length;
    if (!n) return;
    if (delta > 0 && pos === n - 1) { restart(); return; }
    var next = Math.max(0, Math.min(n - 1, pos + delta));
    if (next === pos) return;
    pos = next;
    hintOpen = false;
    renderCard(delta);
  }
  function flip() { flipped = !flipped; applyFlip(); }
  function restart() {
    pos = 0; picks = {}; hintOpen = false;
    if (shuffled) shuffle(order);
    renderCard(-1);
  }
  function toggleShuffle() {
    shuffled = !shuffled;
    var current = order[pos];
    order = deck.cards.map(function (_, i) { return i; });
    if (shuffled) {
      shuffle(order);
      order.splice(order.indexOf(current), 1);
      order.unshift(current);
      pos = 0;
    } else {
      pos = order.indexOf(current);
    }
    var b = app.querySelector('[data-act="shuffle"]');
    if (b) b.setAttribute('aria-pressed', String(shuffled));
    renderCard();
  }
  function toggleHint() {
    var c = deck.cards[order[pos]];
    if (!c || !c.hint) return;
    hintOpen = !hintOpen;
    if (flipped) { flipped = false; }
    renderCard();
  }
  function choose(k) {
    var idx = order[pos];
    var c = deck.cards[idx];
    if (!c || c.type !== 'mcq' || picks[idx] != null || k < 0 || k >= (c.choices || []).length) return;
    picks[idx] = k;
    renderCard();
  }

  app.addEventListener('click', function (e) {
    var t = e.target;
    var opt = t.closest && t.closest('.fv-opt');
    if (opt) { e.stopPropagation(); choose(+opt.getAttribute('data-opt')); return; }
    var btn = t.closest && t.closest('[data-act]');
    if (btn) {
      var act = btn.getAttribute('data-act');
      if (act === 'prev') go(-1);
      else if (act === 'next') go(1);
      else if (act === 'flip') flip();
      else if (act === 'hint') toggleHint();
      else if (act === 'shuffle') toggleShuffle();
      else if (act === 'restart') restart();
      return;
    }
    if (t.closest && t.closest('a')) return;
    if (t.closest && t.closest('.fv-card')) {
      if (swiped) return;
      var sel = window.getSelection && String(window.getSelection());
      if (sel) return;
      flip();
    }
  });

  // Swipe left / right on touch screens.
  var sx = 0, sy = 0, swiped = false, tracking = false;
  app.addEventListener('pointerdown', function (e) {
    tracking = e.pointerType !== 'mouse' && !!(e.target.closest && e.target.closest('.fv-stage'));
    swiped = false; sx = e.clientX; sy = e.clientY;
  });
  app.addEventListener('pointerup', function (e) {
    if (!tracking) return;
    tracking = false;
    var dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      swiped = true;
      go(dx < 0 ? 1 : -1);
      setTimeout(function () { swiped = false; }, 350);
    }
  });

  window.addEventListener('keydown', function (e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    var tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable)) return;
    var onButton = tag === 'BUTTON' || tag === 'A';
    var k = e.key;
    if (k === 'ArrowRight' || k === 'PageDown') { go(1); e.preventDefault(); }
    else if (k === 'ArrowLeft' || k === 'PageUp') { go(-1); e.preventDefault(); }
    else if ((k === ' ' || k === 'Enter') && !onButton) { flip(); e.preventDefault(); }
    else if (k === 'ArrowUp' || k === 'ArrowDown') { flip(); e.preventDefault(); }
    else if (k === 'h' || k === 'H') toggleHint();
    else if (k === 's' || k === 'S') toggleShuffle();
    else if (k === 'Home') { pos = 0; renderCard(-1); }
    else if (!flipped && /^[1-8]$/.test(k)) choose(+k - 1);
    else if (!flipped && /^[a-hA-H]$/.test(k) && k.toLowerCase() !== 'h') choose(k.toLowerCase().charCodeAt(0) - 97);
  });

  // ------------------------------------------------------------------ live preview (deck editor)
  var THEME_KEYS = /^--fv-[a-z-]+$/;
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!previewing || !d || typeof d !== 'object' || !d.fvPreview || e.source !== window.parent) return;
    var p = d.fvPreview;
    if (p.theme && typeof p.theme === 'object') {
      var root = document.documentElement;
      Object.keys(p.theme.vars || {}).forEach(function (k) { if (THEME_KEYS.test(k)) root.style.setProperty(k, String(p.theme.vars[k])); });
      root.setAttribute('data-fv-mode', p.theme.dark ? 'dark' : 'light');
    }
    if (p.deck) {
      var firstTime = !deck.cards.length && !order.length;
      setDeck(p.deck, !firstTime);
      if (typeof p.index === 'number') {
        var wanted = p.index;
        // Show the card being edited (by its position in the editor, counting only cards with a front).
        var at = order.indexOf(wanted);
        if (at >= 0 && at !== pos) { pos = at; flipped = !!p.back; hintOpen = false; }
        else if (at >= 0 && typeof p.back === 'boolean') flipped = p.back;
      }
      renderShell();
    }
  });

  // ------------------------------------------------------------------ start
  previewing = !!window.__fvPreview;
  setDeck(readDeck(), false);
  renderShell();
})();
