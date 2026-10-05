# Sample decks

Test decks that cover the different shapes AI-made flashcard artifacts come in, plus edge cases.
`tests/test_extract.py` checks that every one of them is parsed correctly.

| File | What it exercises | Cards |
|---|---|---|
| `01-linux-commands-flip.html` | Classic 3D flip cards: static `.flashcard-front` / `.flashcard-back` DOM, “Card X of Y” counter, `<code>`, HTML entities (`&lt;`, `&amp;&amp;`), visual “Question/Answer” labels that must be ignored | 10 |
| `02-biology-js-array.html` | Cards in a JS array literal (not JSON): unquoted keys, mixed quotes, escaped quotes, multi-line template literal, comments, trailing commas, HTML in answers, `hint` + `category` fields, long explanatory answers | 12 |
| `03-spanish-vocab-react.jsx` | React artifact with lucide icons + Tailwind, unusual keys (`spanish` / `english`), cards nested under category keys, accents, a duplicate card | 11 |
| `04-aws-fragment.html` | HTML *fragment* (no `<html>`/`<body>`), `<details>/<summary>` cards and `.q` / `.a` pairs | 10 |
| `05-calculus-json-cdn.html` | Loads Tailwind, Google Fonts and KaTeX from CDNs (offline cache), cards in `<script type="application/json">`, LaTeX and numeric answers | 8 |
| `06-history-table-dl.html` | No card markup at all: a two-column `<table>` (header row skipped) and a `<dl>` | 10 |
| `07 networking Q&A notes.html` | UTF-8 BOM, CRLF line endings, spaces and `&` in the filename, `Q: … A: …` text, `term — definition` lists, alternative answers | 10 |
| `08-signals-quiz-typescript.tsx` | TypeScript React with interfaces and a shadcn import (`@/components/ui/card`) that only exists in the original artifact environment, `q`/`a` keys, true/false + yes/no answers | 8 |
| `09-pomodoro-no-cards.html` | A page with **no** flashcards — must not produce false positives | 0 |
| `10-日本語-kana.HTM` | Unicode filename, upper-case `.HTM`, malformed HTML, cards in `data-front` / `data-back` attributes | 10 |
| `11-docker-mcq-quiz.html` | Quiz-style data: answer given as `options[correct]` index, a letter (`"B"`) or `correctIndex`, plus explanations | 5 |

Copy them into `~/Flashcards` to try the app with them.
