# Lessons — core instructions for Claude

This file is a **reference**, not a changelog. It tells you the current
shape of the system, the rules that keep it working, and where to find a
real working example of every pattern in the codebase. When you touch
anything here, update this file to describe the **resulting state** —
not a story of what changed and why. If you're tempted to write "this
used to X, then Y happened, now it's Z," write only Z, plus a one-line
rule if Z exists to prevent a specific failure mode. Exception: keep a
terse "why" clause wherever it's load-bearing — i.e. removing it would
let a future edit reintroduce a bug that isn't obvious from the rule
alone (marked below as **Why:**).

**Before touching anything, read these two sections first:**
- [§5 Saving student progress](#5-saving-student-progress--the-one-rule-that-breaks-silently) — the single most common way this codebase breaks
- [§13 Verification checklist](#13-verification-checklist-run-this-after-any-change) — how to prove your change works before calling it done

## Contents
1. [Architecture](#1-architecture-one-backend-one-sheet)
2. [Identity & sign-in](#2-identity--sign-in)
3. [The shared Sheet](#3-the-shared-sheet)
4. [Client-side libraries](#4-client-side-libraries)
5. [Saving student progress](#5-saving-student-progress--the-one-rule-that-breaks-silently)
6. [Teacher answer-key view](#6-teacher-answer-key-view-unlockteacherview)
7. [Shared UI components](#7-shared-ui-components)
8. [Engagement & integrity tracking](#8-engagement--integrity-tracking)
9. [Teacher resets](#9-teacher-resets-give-attempts-back)
10. [Per-unit reference](#10-per-unit-reference)
11. [Grade tracks beyond 6/7/8](#11-grade-tracks-beyond-678)
12. [index.html](#12-indexhtml)
13. [Teacher dashboard](#13-teacher-dashboard)
14. [Content authoring references](#14-content-authoring-references)
15. [Standards line](#15-standards-line)
16. [Verification checklist](#16-verification-checklist-run-this-after-any-change)
17. [Status](#17-status)

---

## 1. Architecture: one backend, one Sheet

**Exactly one** backend for student progress tracking across the whole
repo: one Google Sheet + one Apps Script Web App deployment. Every
lesson activity, every grade, talks to it. **Never create a new Sheet
or Apps Script deployment per activity or project.** `Lessons/Projects/*`
is the one exception — an older, separate pattern with its own
`SHEET_API_URL` per project, deliberately left alone; don't extend it
and don't hold it to any rule in this file.

Adding a new activity = one new row in `ActivityCatalog` in the shared
Sheet. It never requires new backend code.

- **Canonical backend source**: `automation/apps-script/Code.gs` in
  this repo. After editing it, paste the full contents into the Apps
  Script editor (open from the Sheet: Extensions → Apps Script), then
  Deploy → Manage deployments → edit the existing deployment → New
  version (this keeps the `/exec` URL stable).
- **Spreadsheet ID**: `1-HLtX5AwskPx8hy_Ip2kjGMz5OUIS91M2x0FgEt75zA`
- **Apps Script Web App URL**: `https://script.google.com/macros/s/AKfycbyC7mb1TKfg3JvhiZftXMf7oXkzrBMWJczZSURC7sIfoIxYnZrrumYfx-j7JYTY0A9i/exec`
- **Deliberately client-side-only**: all scoring, flagging, filtering,
  and aggregation logic lives in `teacher-dashboard.html`'s own JS, not
  in `Code.gs`. Touch the backend only when the *data returned* needs
  to change (a new column, a new tab to join). Tuning a flag threshold
  or adding a new aggregate never needs a redeploy.

### Request flow
1. Student opens an activity page → sign-in gate → Google sign-in →
   front-end POSTs `{idToken, type: 'access-check', activityId}`.
2. Backend verifies the token via Google's `tokeninfo` endpoint (never
   trusts the front-end's claimed identity), checks `Teachers` then
   `Roster`, compares `Roster.Grade` to `ActivityCatalog.Grade`, and
   either denies or unlocks (returning any existing `Progress` row so
   the student resumes where they left off).
3. Every check/submission on the page POSTs `type: 'submission'` —
   appended into that same `Progress` row's `SubmissionsLog`, never a
   new row.
4. Teacher dashboard POSTs `type: 'teacher-data'` (read) or
   `type: 'teacher-reset'` (the one write path outside `submission`).
5. `index.html` POSTs `type: 'identify'` (email + role + grade only,
   no per-activity check).

---

## 2. Identity & sign-in

- Students sign in with **Sign in with Google** (Google Identity
  Services), restricted to `lincoln.edu.ni` accounts via the token's
  `hd` claim.
- OAuth Client ID (safe in front-end code):
  `478111261772-7l1qamohr0fjsa7ekosuhpj9jum1q4vc.apps.googleusercontent.com`
  — GCP project `lessons-progress-tracker`, consent screen type
  **External**, status **Testing** (only Test Users can sign in until
  published to Production).
- The OAuth `client_secret` is **never** needed (sign-in only needs the
  Client ID) — never commit it, never add it to any page.
- Every request is re-verified server-side; the front-end's claimed
  identity is never trusted directly.

### Persisted sign-in
`Lessons/token-cache.js` (shared by `lesson-auth.js` and `index.html`,
no other deps) caches the raw ID token in `localStorage`. Every gated
page tries the cache before showing the sign-in button. A cached token
is reused only while its own `exp` claim is still valid (~1hr, Google's
own lifetime — this never extends access past what Google already
granted). A backend rejection clears the cache immediately.

**Rule**: any new gated page must include `token-cache.js` **before**
`lesson-auth.js` in `<head>`. Omitting it doesn't error — it silently
disables persistence and the student is asked to sign in every visit.

### GIS is initialized imperatively, never declaratively
Every gated page's `<script src=".../gsi/client">` tag carries
`onload="onGoogleLibraryLoad()"`. `lesson-auth.js`/`index.html` only
call `google.accounts.id.initialize()` + `renderButton()` + `prompt()`
themselves, inside `showGateAndPromptSignIn()` — only once a
cached-token resume has failed or there was none to try. `#lesson-gate`
starts with the `hidden` attribute for exactly this reason.

**Rule**: never add a declarative `data-client_id`/`data-auto_select`
div to a gated page. **Why:** the declarative form auto-fires Google's
sign-in UI (including One Tap) on every load regardless of a
silently-resuming cached token, racing the cache check.

### Stale in-flight requests are explicitly discarded
Every `proceedWithToken()` call (`lesson-auth.js`, `index.html`,
`teacher-dashboard.html`) captures a `requestGeneration` number at start
and checks it's still current before touching the DOM; `resolved`
permanently retires every attempt once one succeeds. A failed attempt
that isn't already a retry gets exactly one retry with a longer timeout
(25s vs 15s) before giving up — most "failures" are a cold Apps Script
container. `#lesson-loading` (a small CSS spinner, visible by default,
hidden once gate or content shows) covers the silent-check window.

**Rule**: never remove the `requestGeneration`/`resolved` guards from a
`proceedWithToken`-style function. **Why:** without them, an earlier
attempt timing out *after* a later one already unlocked the page would
still run its failure handler and re-reveal the gate on top of
already-unlocked content.

### `hidden` doesn't always mean hidden
`#lesson-loading` has its own `display: flex` (to center the spinner) —
an ID selector beats the browser's default `[hidden] { display: none }`
on specificity, so `el.hidden = true` on it silently does nothing.
`hideLoadingIndicator()` sets `el.style.display = 'none'` directly
instead.

**Rule**: before adding `.hidden`/`[hidden]` toggling to any new
element, check whether it already has an explicit `display` rule on an
equal-or-higher-specificity selector — if so, toggle `style.display`
directly instead.

### Loading is hardened against a stuck spinner
`onGoogleLibraryLoad()`'s body is wrapped in try/catch
(`showGateWithError()` on failure — touches only the DOM, never
`google.accounts.id.*`, which may not exist yet either). A 10-second
`setTimeout` fallback shows an error state if the GIS script's own
`onload` never fires (network filter, ad blocker). `onDataLoaded()`'s
`populateFilters()`/`renderAll()` call (dashboard) is wrapped in
try/catch the same way, so a render bug surfaces as a visible message
instead of a silent partial render or a stuck spinner.

### Cache-busting
Every page references `token-cache.js`/`lesson-auth.js` with a `?v=`
query string. **Bump the number on every page that includes the file
you changed** — only bump the file you actually edited; they can sit
at different versions. **Why:** GitHub Pages' CDN and browsers cache
the old file for a while after a push, so live behavior can lag the
committed code unpredictably.

**Current versions**: `token-cache.js` → `2`, `lesson-auth.js` → `11`.
Verify before trusting this table stale: `grep -rhoE "lesson-auth\.js\?v=[0-9]+" Lessons/ --include="*.html" | sort -u`
(should print exactly one version — if it prints more than one, some
pages were missed on the last bump).

### Backend lock scope
`identify` and `teacher-data` never write, so they run before
`LockService.getScriptLock()` in `doPost` — only `access-check`/
`submission`/`teacher-reset` (which can append/update `Progress` or
`AccessLog`) hold the lock. A plain read is never blocked behind a
slow, unrelated write.

---

## 3. The shared Sheet

One spreadsheet, five tabs.

| Tab | Who fills it in | Purpose |
|---|---|---|
| `Roster` | **Manual** — teacher: `Email, StudentName, Grade, Teacher, Section, Status` | Who's allowed in, and their grade/teacher. Add/remove students directly in the Sheet. |
| `ActivityCatalog` | **Manual** — teacher: `ActivityId, Title, Grade, Unit, Active` | Drives the grade-gate check. One row per activity. |
| `Teachers` | **Manual** — `Email, Scope` (optional) | Gates the `teacher-data` endpoint. Being on `Roster.Teacher` does NOT by itself grant dashboard access — only an email listed on `Teachers` can. `Scope` blank/`All`/missing = unrestricted (sees every student). Any other value must exactly match a `Roster.Teacher` value — a typo (case/spelling) makes that teacher silently see nobody, not an error. |
| `Progress` | **Automatic** — Apps Script only | One row per (student, activity), upserted on every save. Columns: `Email, StudentName, Grade, Teacher, ActivityId, ActivityTitle, FirstStartedAt, LastSubmittedAt, ItemsTotal, ItemsAttempted, ItemsCorrect, ScorePct, Status, SubmissionsLog (JSON), FlagReason, ReviewedByTeacher, ReviewedAt`. Only the last two are ever hand-edited by a teacher. |
| `AccessLog` | **Automatic** — Apps Script only | **Denied access attempts only.** Allowed opens are never logged here (redundant with `Progress`, and a duplicate-row source of their own — see `checkAccess_` in `Code.gs`). Older rows may still say `Allowed`; not backfilled away. |

---

## 4. Client-side libraries

Two files, cleanly separated by responsibility:

- **`Lessons/lesson-shared.js`** — check/save mechanics only:
  `LessonProgress`, `LessonCheck`, `createCardSelect`,
  `createVocabMatch`.
- **`Lessons/lesson-auth.js`** — sign-in/gating/teacher-view only:
  `LessonSync.init()`, token flow, `unlockTeacherView()`,
  `patchSwitchTab()` (engagement tracking), paste/focus/right-click
  listeners.

A lesson page's `<head>` order matters: `token-cache.js` →
`lesson-auth.js` → GIS `<script>` → (MathLive/MathJax if needed) →
`lesson-shared.js`. Near the end of `<body>`: the page's own inline
`<script>` calls `LessonSync.init(activityId)`.

---

## 5. Saving student progress — the one rule that breaks silently

**This is the single most common way a page silently loses student
data. Read this section before writing or touching any check function.**

### The mechanism
- **`LessonSync.init(activityId)`** — call once, near the end of
  `<body>`, after the gate's HTML already exists. Wires the backend
  connection for this `ActivityCatalog` row. Nothing below reaches the
  Sheet without this having run.
- **`LessonProgress.record(key, label, answer, verdict, section, lockAfterSubmit)`**
  (also callable as `.record({label, answer, section})` via
  `LessonCheck.check`'s `record` object — see below) — the actual call
  that appends an entry to `Progress.SubmissionsLog` for this activity.
  `.preRegister(key, label, section)` marks a question "not attempted"
  from render time.
- **`LessonCheck.check(key, isCorrect, feedbackEl, messages, record)`**
  and **`LessonCheck.submit(feedbackEl, record, message)`** — the
  per-problem entry points a check function actually calls.

### THE RULE
- On `LessonCheck.check(...)`: **the 5th argument, `record`, is what
  triggers `LessonProgress.record(...)`.** It is optional in the
  function signature and **omitting it causes no error and no visible
  breakage.** The field still shows correct/incorrect feedback, still
  locks, still looks completely normal to the student — but the
  attempt is never saved. It never appears in `Progress`, never shows
  on the teacher dashboard, and is invisible to a teacher forever.
- On `LessonCheck.submit(feedbackEl, record, message)`: `record` is
  the **2nd** argument and is **required** — passing `null`/`undefined`
  silently skips recording the same way.
- `LessonCheck.show(feedbackEl, outcome, messages)` **never records by
  itself** — it only renders feedback. If a check function calls
  `.show()` directly instead of `.check()`/`.submit()`, it must follow
  up with its own explicit `LessonProgress.record(...)` call, or
  nothing is ever saved. See
  `Lessons/Sixth/Decimal-Operations/Vocabulary-Literacy.html`'s
  `checkWordSort()`/`checkTranslate()` for the correct paired pattern
  (`.show()` immediately followed by `LessonProgress.record(...)`).

### Canonical correct examples
- Simple 5-arg `.check()` call:
  `Lessons/Seventh/Integers/Vocabulary-Literacy.html`, `checkNumVocab()`
  — `{ label: p.q, answer: raw, section: '1. Number Vocabulary' }`.
- `.submit()` with `lockAfterSubmit`: any call site in
  `Lessons/Eighth/Literal-Equations/Practice-Set.html`.
- `.show()` + manual `.record()` pairing: `checkWordSort()` in
  `Lessons/Sixth/Decimal-Operations/Vocabulary-Literacy.html`.
- `renderCheckList()`/`checkListItem()` shared-registry pattern with
  `section` threaded through: any `Review.html`'s "Are You Ready?" tab.
- Non-`LessonCheck` completion event (drag-and-drop, no single right
  answer): `createVocabMatch()` in `lesson-shared.js` calls
  `LessonProgress.record(...)` directly on full completion — see
  §7 below.

### How to verify a new problem type/page pattern actually saves
**Never trust on-screen feedback alone.** Two ways, cheapest first:

1. **Static, repo-wide (catches every instance in one pass, use
   TypeScript's real parser — not a regex):**
   ```js
   // Node script sketch — walk every <script> block in every HTML file,
   // parse with ts.createSourceFile(src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS),
   // find every CallExpression whose expression text is
   // 'LessonCheck.check', assert arguments.length === 5;
   // do the same for 'LessonCheck.submit' asserting arguments.length >= 2
   // and that argument[1]'s text isn't the literal 'null'/'undefined'.
   ```
   **Why a real parser and not a regex paren-counter:** a regex that
   counts `(`/`)` to find argument boundaries is fooled by a regex
   literal or string inside the call containing an unbalanced-looking
   paren — e.g. `g.eq.replace(/\\\(|\\\)/g, '')` inside a real,
   correctly-5-argument `.check()` call. This produced dozens of false
   positives the one time it was tried; the AST approach produced zero.
   Node in this environment has no `acorn`/`espree` installed, but
   `typescript` is — `ts.createSourceFile(..., ts.ScriptKind.JS)`
   parses plain JS fine despite the name.
2. **Live**: open the teacher dashboard signed in as a teacher, or
   drive the check function directly in a headless browser
   (`LessonProgress.all()` after the check call should contain the new
   entry with the right `key`/`label`/`answer`/`verdict`/`section`) and
   confirm the attempt shows up in Full Submission Log / that
   activity's detail view.

---

## 6. Teacher answer-key view (`unlockTeacherView`)

`access-check` checks `Teachers` before `Roster`. An email on
`Teachers` gets `role: "teacher"` back — grade-gate skipped, no
`Progress` row created — and `lesson-auth.js`'s `unlockTeacherView()`
fills in every problem with its correct answer instead of the
interactive check flow.

### The two registry patterns — check every new page for one of these
- **`window.listRegistry`** — for the common
  `renderPracticeList()`/`checkPractice()` single-text-input pattern.
  Expose the page's local registry object as `window.listRegistry` (one
  line after declaring it). `unlockTeacherView`'s generic loop then
  fills every `${keyPrefix}-${i}-input`/`-feedback` pair automatically.
  Canonical examples: `Practice-Set.html`, `Word-Problems.html`,
  `Review.html` in most units.
- **`window.revealAnswerKey`** — for a page with a different problem
  shape (select dropdowns, multi-field answers, several unrelated
  check functions). Write a hand function that fills and locks every
  problem by hand; `unlockTeacherView` calls it if present. Canonical
  example: any `Vocabulary-Literacy.html`/`Test-Prep.html`.

**Rule**: never assume teacher view works on a page you haven't
checked — open its `<script>` and confirm one of the two exists. The
per-unit table in §10 records which pattern each page actually uses;
two visually-similar pages in the same unit (e.g. Decimal-Operations
vs. Operations-with-Fractions Test-Prep) can be wired differently
underneath.

### Rules for filling an answer field correctly
- **A plain `<input>`/`<select>` can never render LaTeX.** Only
  `<math-field>` parses it as real math. When the target isn't a
  `<math-field>` and `p.a` (a plain number) is defined, fill the input
  with `String(p.a)`, not a richer LaTeX `displayAnswer` — the
  feedback text below can still show the richer form.
- **The feedback text (not the input value) needs `\( \)` delimiters
  and a `triggerMathJax()` call.** `input.value` on a `<math-field>`
  renders LaTeX directly with no MathJax involved; `feedback.innerHTML`
  is plain text with no renderer of its own.
- **`displayAnswer` has two conventions** — most units store bare
  LaTeX (`"\dfrac{V}{\pi r^2}"`); every `Review.html` plus
  `Eighth/Linear-Equations/Vocabulary-Literacy.html` bakes its own
  `\( \)` wrapper in already. Strip a leading `\(`/trailing `\)` before
  using it as a `<math-field>`'s `.value` or before wrapping it once
  for feedback text — check which convention a given page uses
  (`grep 'displayAnswer: "\('`) rather than assuming.
- **Card-select fields** are a plain `<div>` of buttons, not a real
  `<select>` — `unlockTeacherView`'s reveal loop has a third branch
  that marks the matching `.card-select-option` `.selected` and
  disables the whole group, directly via the DOM (never through the
  page's own `createCardSelect()` instance — the loop only ever has
  the element id).

### The `TEACHER VIEW` banner and control lockout
`banner.className = 'teacher-view-banner'` (styled in
`lesson-shared.css`, never inline), prepended as `.app-container`'s
first child. After `revealAnswerKey()` runs, a final sweep disables
every still-enabled `<button>`/`.card-select-option` in
`.app-container`, **except** ones whose `onclick` matches
`SAFE_ONCLICK` (`next`/`prev`/`reveal`/`reset`/`toggle`/`switchtab`/
`switchsubtab`/`print`/`scroll`/`jump`/`open`/`show`/`close`,
case-insensitive) or that carry `.tab-btn`/`.sub-tab-btn` — carousel
nav, "Reveal Next Round/Step," Reset, and tab navigation all stay
usable. **Rule**: if a new interactive control's `onclick` name doesn't
naturally contain one of those safe words, add the keyword to
`SAFE_ONCLICK` in `lesson-auth.js` (bump its `?v=` — see §2) rather
than leaving it live or dead by accident.

### How to verify teacher view on a page you're not sure about
Drive `proceedWithToken` end-to-end in a headless browser: mock the
POST to `LESSON_SYNC_API_URL` to return
`{ok: true, allowed: true, role: 'teacher', student: {name: 'X'}}`,
seed `localStorage['lia_google_id_token']` with any syntactically valid
JWT (exp in the future — signature is never checked client-side), stub
`https://accounts.google.com/gsi/client` with an empty 200 response
(its own `onload` is what the cached-token resume is gated behind —
**aborting** that request means nothing runs at all, not even the
cached-token path), then load the page for real and check
`document.querySelector('.teacher-view-banner')` exists and every
`-input` field is filled + `disabled`.

---

## 7. Shared UI components

### Card-select — `createCardSelect(containerId, options, config)` in `lesson-shared.js`
Touch-friendly replacement for a `<select>`. Renders `options`
(`{value, label}`) as clickable `.card-select-option` buttons inside
`containerId`. Returns `{getValue, setValue, reset, disable}` — read
exactly like a `<select>`'s `.value`, except `getValue()` returns
`null` (not `''`) when nothing's picked. CSS: `.card-select-row` (one
labeled row per choice group — stack multiple groups vertically rather
than cramming them into one row), `.card-select`, `.card-select-option`
(+`.selected`/`:disabled`) in `lesson-shared.css`.

**Rule**: never use a raw `<select>` for student-facing graded content
on a new page — use `createCardSelect`. Exceptions: `Lessons/Projects/*`
(separate older pattern) and `teacher-dashboard.html`'s own admin
reset-scope picker (not student-facing).

**Where it's used**: see §10's capability matrix. Templated (rendered
per-array-item) selects are tracked in a parallel array indexed the
same as the source array; static selects go in a per-page
`cardSelects`-style registry object keyed by element id, so a shared
check/reveal function can tell a card-select apart from a plain
`<input>`/`<math-field>`.

**Gotcha**: converting an existing `<select>` to card-select is a good
moment to re-read the full check-function call it touches — several
pre-existing `LessonCheck.check(...)` calls omitting the 5th `record`
argument were only found because a card-select conversion touched that
code (see §5). Never assume the input swap alone preserves correct
saving.

### Vocabulary Match-Up — `createVocabMatch(config)` in `lesson-shared.js`
3-column drag-and-drop term/definition/example widget. One call per
page → keep the returned instance as a page-level `const vocabMatch`
(**the identifier name is fixed** — rendered `onclick`/`ondrop`
handlers call back through the literal string `vocabMatch`; renaming
the variable breaks them). Config:
`{termsId, defsId, exsId, feedbackId, terms: [{key, term, def, example}], progressKey, progressLabel, section}`.
`def`/`example` render as raw `innerHTML` — author them (can carry
LaTeX via `\\(...\\)` or `<strong>`), never populate from student
input. Tap-to-select is the touch fallback for devices where drag
doesn't work.

On full completion, calls `LessonProgress.record(progressKey,
progressLabel, "All N terms matched...", 'correct', section)` directly
— not through `LessonCheck.check()`, since this isn't a single
right/wrong answer. `vocabMatch.reveal()` is the teacher-view hook:
call it from the page's own `window.revealAnswerKey` alongside whatever
else that function already reveals.

**CSS gotcha**: `.match-slot`'s content is wrapped in a `<span>`, not
dropped straight into the flex container — `.match-slot` is
`display:flex; align-items:center`, and CSS flexbox turns each direct
child into its own flex item; a definition string with plain text plus
inline markup (e.g. `"...is <strong>not</strong> a function"`) would
otherwise split into separate flex items and break the layout.

**Where it's used**: see §10. Term/def/example content is always
sourced from that page's own Tab 1 glossary, never invented fresh.

### Math input — `<math-field>` (MathLive)
Loaded via
`<script src="https://cdn.jsdelivr.net/npm/mathlive@0.110.0/mathlive.min.js">`
(pin the version on any upgrade, same convention as the page's `mathjax@3`
include). **The dividing line for using it is "is this answer a plain
number," not "does the question involve fractions."** An answer like
`-1`, `5`, `0.25` stays a plain `<input type="text">` regardless of how
fraction-heavy the *question* looks; a fraction, algebraic expression,
equation, or inequality answer gets `<math-field>`. Never assume
`<math-field>` is present just because a unit is "converted" — check
that specific page's own `<head>` (see §10's matrix).

Every converted page defines its own copy (no shared JS module across
these static pages) of:
- **`readMathField(field)`** — `field.getValue('ascii-math')`, guarded
  by `typeof field.getValue === 'function'` first. **Why:** if MathLive
  never loaded (blocked network, ad blocker, cold CDN failure),
  `<math-field>` stays an undefined custom element with no such method
  — treat that as an empty answer, never let it throw.
- **`normalizeExpr(s)`** / **`answerMatches(val, accepted)`** — for
  fraction/expression answers. `answerMatches` normalizes **both**
  sides (`accepted.some(a => normalizeExpr(a) === normalizeExpr(val))`),
  never just the typed answer. **Why:** MathLive's ASCIIMath export
  always double-parenthesizes every fraction (`\frac{d}{t}` →
  `"(d)/(t)"`, always, however simple) — an `accepted[]` string
  hand-written without that convention in mind won't match unless it's
  normalized the same way. `normalizeExpr`'s `stripRedundantParens()`
  strips a `(...)` pair only when its content has no top-level `+`/`-`
  (preserves meaningfully-signed groups like `(-2.9)` in
  `-6.4+(-2.9)`) and also strips an explicit `*`/`·` multiplication
  mark (`8*x` → `8x`). Never reintroduce
  `p.accepted.includes(normalizeExpr(val))` (normalizes only one
  side) on a new page.
- For a mixed unit where some items are plain numbers and others are
  math notation in the *same* shared render/check template: mark the
  non-math items with a per-item `p.text = true` flag and branch both
  the render function (`p.text ? <input> : <math-field>`) and the
  check function (`p.text ? field.value : readMathField(field)`) —
  don't split into two templates. Canonical example:
  `Eighth/Linear-Equations/Review.html`.
- For a unit where a problem is pure fraction computation but graded
  as a decimal by mistake (a real trap, hit once on
  `Seventh/Operations-with-Rationals`): give the item an explicit
  `format`: `'fraction'` (math-field, exact fraction only, no decimal
  credit), `'decimal'` (plain input, unchanged), or `'mixed'`
  (math-field, either form accepted via `formatMatches(format, raw, p)`).
  `format` defaults to `'decimal'` where unset. Before writing a new
  page with a "just force everything to decimal" pattern, check
  whether any problem is pure-fraction with no decimal in sight.

**Inequality answers** (`Eighth/Linear-Inequalities`) use `<math-field>`
too — every solved (`x > 5`) or unsolved (`45n + 150 \leq 600`)
inequality field is a math-field; a plain final number (word-problem
answer, an Error Analysis step number) stays `<input>`. This unit
additionally defines, per page:
- `normalizeInequality(raw, variable)` / `checkInequality(raw, variable, operator, boundary)`
  — for a **solved** inequality (canonical `"<var><op><number>"` form,
  folds unicode `≥`/`≤` and sloppy `=>`/`=<` to ASCII, flips the
  operator if written `number OP variable`).
- `normalizeIneqExpr(s)` / `ineqAnswerMatches(val, accepted)` — for an
  **unsolved, translated** inequality (e.g. "at least 12" → `n>=12`),
  same `normalizeExpr`/`answerMatches` pattern as above. **Never use
  the solved-form checker for a translation item or vice versa** — a
  translation has exactly one right spelling; a solved inequality has
  several equivalent typings.
- `numberLineSvg(boundary, type, direction)` — a static, self-contained
  SVG number line (fixed −10 to 10 range, every graphed boundary in
  this unit is a whole number in that range), used both as a worked
  example (Explanation.html) and as the graded "Read the Graph" prompt.
  Not an interactive/draggable widget by design.

### Standards line
Every lesson page (all 7-8 page types per unit, not just the
student-facing five) has one line immediately after its `<h1>`:
`<p class="standards-line">Standards: <code(s)>...</p>`, styled via
`.standards-line` in `lesson-shared.css`. Identical text across every
page in one unit. See §15 for the sourcing rule and the current table.

---

## 8. Engagement & integrity tracking

All of this is **retrospective only — read when a teacher opens the
dashboard, never live/real-time monitoring.** There is no
push/websocket mechanism (Apps Script/Sheets can't do it) and no
architecture here should be extended into one without a separate,
deliberate decision.

### Tab views and completion
`lesson-auth.js` patches `window.switchTab` (a real `function`
declaration on every lesson page, so it's a genuine `window` property
to wrap) to log two more `SubmissionsLog` item types, independent of
`LessonCheck`/`LessonProgress`: `tab-<panelId>` (verdict `viewed`,
once per tab opened, including the first one visible at sign-in) and
`reached-end` (verdict `reached-end`, once the last `.tab-btn` opens).
This needs zero per-page wiring — it's generic, keyed off any page's
own `switchTab()`/`.tab-btn`/`.panel` markup.

### Student-facing disclosure
Every gate shows: *"Activity performed on this page is recorded so
your teacher can review your work."* Injected once per page by
`injectDisclosure()` (idempotent), called from `lesson-auth.js`'s
`init()`. `index.html` hand-carries the identical sentence separately
(its own gate isn't shared code) — if this sentence ever changes,
update both places.

### Paste detection, tab-focus tracking, right-click detection
Single shared listeners in `lesson-auth.js`, covering every page that
loads it with zero per-page wiring:
- **`onPaste(e)`** — `paste` on `document` (bubbles out of a
  `<math-field>`'s Shadow DOM too, since clipboard events are
  `composed`), only when `e.target` is `INPUT`/`TEXTAREA`/`MATH-FIELD`.
  Logs `{key: 'paste-<timestamp>', verdict: 'paste-detected', label: 'Pasted into an answer field'}`
  with an **empty `answer`** — the clipboard content itself is never
  read or logged. Debounced to 1 logged event per 2s.
- **`onVisibilityChange()`** — Page Visibility API. Logs a matched pair:
  `focus-lost-<timestamp>` (tab hidden) / `focus-back-<timestamp>` (tab
  visible again). The first "visible" state on load is never logged
  (it's not a "return").
- **`onContextMenu(e)`** — `contextmenu` on `document`, same
  `INPUT`/`TEXTAREA`/`MATH-FIELD` target restriction as paste. Logs
  `rightclick-<timestamp>` (verdict `rightclick-detected`). **Never
  calls `e.preventDefault()`** — the browser's context menu is never
  blocked, only the fact of the click is recorded.

All three use a unique key per occurrence (a timestamp suffix, never a
fixed key) since each is its own event, not a repeated attempt.
`teacher-dashboard.html`'s `isIntegrityKey(key)` (matches
`paste-`/`focus-lost-`/`focus-back-`/`rightclick-` prefixes) excludes
all of them from graded-item scoring the same way `tab-*`/`reached-end`
are excluded via a separate check — **any new event type added to
`SubmissionsLog` needs the same exclusion, or it corrupts scoring.**

**Cache-bust note**: this shipped across `lesson-auth.js` versions —
current version is `v11` (see §2); confirm the live number with the
same grep before trusting any version number quoted anywhere in this
file.

### Data-quality note for anything reading `Progress` columns
The raw `Progress.ItemsAttempted`/`ItemsCorrect`/`ScorePct` columns
count **every** logged `SubmissionsLog` item, including engagement/
integrity items. **Never read them directly** — always recompute from
`SubmissionsLog` itself after filtering out `tab-*`/`reached-end`/
`paste-*`/`focus-lost-*`/`focus-back-*`/`rightclick-*` keys first (see
`decorateRow()` in `teacher-dashboard.html` for the reference
implementation), or "attempted" is inflated and scores are wrong on
every activity.

### Scoring formula
1st-try correct = 1 point, 2nd-try correct = 0.5, never correct = 0 —
**except** any activity whose `activityId` ends `-test-prep`
(`isTestPrep` in `decorateRow()`), which is graded **attempt-1-only,
no partial credit for a correct 2nd try**. This diverges from the
on-screen check flow, which still visually allows 2 tries with a
reveal on several Test-Prep tabs — the gradebook simply never credits
a 2nd-try recovery there, by design. A key whose *final* verdict is
`'reflection'` is excluded from both numerator and denominator
(completion-tracked via `reflectionSubmitted`, not graded).

### The ten retrospective integrity/effort signals (`decorateRow()` + two cross-row passes)
Computed entirely from timestamps/attempt numbers/answer text already
in `SubmissionsLog` — no new instrumentation added by adding a signal.
Constants live at the top of `teacher-dashboard.html`:

| Signal | Constant(s) | Rule |
|---|---|---|
| Fast-guessing | `FAST_GUESS_SECONDS = 3` | 1st attempt under 3s after the previous event |
| Attempt-1 sacrifice | `SACRIFICE_MIN_SECONDS = 15` | fast 1st attempt, then a correct 2nd taking ≥15s |
| Reflection padding | (12-word floor, <40% distinct-word ratio) | `isPaddedReflection()`; never judges answers under 12 words |
| Idle gaps | `IDLE_GAP_MIN_MINUTES = 3`, `SESSION_GAP_MINUTES = 15` | a pause ≥3min but <15min between events, same session |
| Tab-skipping | `TAB_SKIP_SECONDS = 2` | two tab views <2s apart |
| Paste / tab-focus loss / right-click | see above | paste/right-click flagged on any occurrence; focus loss flagged only at `FOCUS_LOSS_FLAG_THRESHOLD = 3`+ |
| Low-effort reflection | `MIN_REFLECTION_WORDS = 4` | under 4 words, never already flagged as padded |
| Possible shared answers | `DUPLICATE_ANSWER_WINDOW_MINUTES = 15`, `DUPLICATE_ANSWER_MIN_LENGTH = 4` | two students, identical **wrong** answer, same activity+item, within the window — `applyDuplicateAnswerFlags()`, run once after every row is decorated |
| Possible answer lookup | `LOOKED_UP_SCORE_THRESHOLD = 90`, `LOOKED_UP_TIME_RATIO = 0.5`, `LOOKED_UP_MIN_PEERS = 3` | paste event + score ≥90% + time ≤50% of that activity's own peer average — `applyLookedUpFlags()`, needs ≥3 other scored peers on the same activity |

Each appends its own descriptive string (with its own count, e.g.
`"Fast-guessing on 2 items (<3s)"`) to the row's `flags` array.
`flagCategory(flagText)` buckets by substring match into one of twelve
categories for summary counts.

Two derived per-student aggregates: **Effort Score Index**
(`computeEffortScore`, 0-100: 40% average depth reached, 40% fraction
of non-padded reflections, 20% fraction of flag-free rows — tune
freely, not a validated formula) and **Attempt-2 Recovery Index**
(`computeRecoveryIndex`, of every first-try miss, what % were
eventually correct — `null`, not 0%, when the student never missed a
first try).

**Deliberately deferred** (need either new client-side instrumentation
or are inherently a live feature the "no live monitoring" rule
excludes): a Printable PDF/Report Generator, the *full* structured
per-distractor Item Diagnostics (a free-text "lite" version exists —
see §13's Item Diagnostics entry), true DevTools/concurrent-session
detection, Vocabulary flashcard rapid-flip tracking, any Live
Classroom View. Don't build these without a separate, explicit request.

---

## 9. Teacher resets (give attempts back)

Dashboard-only, never reachable from a lesson page. Three scopes on
one mechanism, all going through `applyTeacherReset_` in `Code.gs`
(`type: 'teacher-reset'`, inside `doPost`'s existing
`LockService`-guarded block).

- **item** — one key. **section** — every resettable key most recently
  logged under one tab/section name. **activity** — every resettable
  key on that student's row for that activity.
- "Resettable" excludes `tab-*`/`reached-end`/`paste-*`/`focus-lost-*`/
  `focus-back-*`/`rightclick-*` (`isResettableKey_` in `Code.gs`) —
  these never lock a field in the first place (no `<key>-input`
  element exists for them).
- A reset **appends** one new `SubmissionsLog` entry (never deletes/
  overwrites): `{key, label, answer: '', verdict: 'reset', section, resetScope, resetBy, timestamp}`.
  `label` is the item's own real label — never a generic string.
- **The reset is the unlock mechanism.** `restoreSubmissions()`
  (`lesson-auth.js`) does `if (s.verdict === 'reset') return;` before
  locking a field — a reset key just has nothing restored against it.
- **Attempt numbering restarts after a reset.** `Code.gs`'s
  `recordSubmission_` (via `attemptsSinceReset_`, walking a key's
  entries backward, stopping at the most recent `'reset'`) and
  `decorateRow()`'s scoring loop (slicing to only entries after the
  last reset) apply the **identical** rule — if either drifts, a
  resubmission's dashboard score stops matching what the student
  experienced. A reset-but-not-yet-re-attempted key contributes nothing
  to `gradedCount` (excluded entirely, not counted as 0).
- **`section` is required for a section-scoped reset to find its
  keys.** An entry logged before `section` was stored server-side
  can't be reset by section — only by item or whole-activity.
  `submissionDetailTable()` surfaces this gap explicitly before a
  teacher clicks anything (a note listing `skippedNoSection`), and
  `applyTeacherReset_`'s own `error` response names it when a section
  reset finds nothing to reset. `scope === 'activity'` is unaffected
  (never filters by section) — always the correct fallback.
- **A multi-item reset renders as one collapsed row/line, not N.**
  Every key one `applyTeacherReset_` call resets shares the exact same
  timestamp; `submissionDetailTable()` and the `allEvents` builder both
  group consecutive same-timestamp+scope+resetBy `'reset'` entries into
  one rendered row (`"N items reset"` with a `title` tooltip listing
  each). The underlying log still carries one entry per key — this only
  changes display.
- UI: a "Give attempts back" toolbar (section `<select>` + "Reset
  section" / "Reset entire activity" buttons) sits above the Attempts
  table in `submissionDetailTable()` — reused by Student Roster &
  Profiles, Unit & Lesson Deep Dive's By Activity, and Full Submission
  Log, so it appears in all three with one change. A per-item "Reset"
  link appears only on each key's most recent row via
  `teacherReset(email, activityId, scope, target, label, btn)`.
  `resetTagHtml(r)` renders a "Reset applied (scope)" tag next to any
  `scorePct` cell.
- **Not live** — takes effect only on the student's next page load.
- **Authorization** reuses `isTeacher_`/`getTeacherScope_`/
  `getScopedEmailSet_` — a scoped teacher can only reset their own
  students.
- **Scoped to locked items for now** —
  `restoreSubmissions()`'s DOM assumptions
  (`<key>-input`/`<key>-feedback` sharing a parent with the Check
  button) only cover the common single-input pattern. A reset always
  writes and scores correctly (backend doesn't care about DOM shape),
  but a select-dropdown item, multi-field Test-Prep question, or the
  Vocabulary Match-Up widget may have nothing visible to "give back."
  Check that specific page's own restore/lock behavior before assuming
  a reset does something a student can see.
- **`LessonCheck.submit()`'s `lockAfterSubmit` flag** (default
  true/omitted) is the separate, narrower alternative for a
  non-graded item that should never need a teacher's involvement to
  redo: pass `lockAfterSubmit: false` on an item deliberately meant to
  be freely resubmitted. Propagates end-to-end (`LessonProgress.record`'s
  6th arg → `Code.gs` stores it only when explicitly `false` →
  `restoreSubmissions()` pre-fills instead of locking). **This is
  infrastructure only** — deciding which items should use it is a
  per-item content call, never a blanket flip.

---

## 10. Per-unit reference

Every unit ships the same file set: `Review.html`,
`Vocabulary-Literacy.html`, `Explanation.html`, `Practice-Set.html`,
`Word-Problems.html`, `Test-Prep.html`, `Teacher-Guide.html` (7 files).
`Operations-with-Rationals` and `Literal-Equations` additionally have
`Guided-Solving-Ladder.html` (8 files). `Teacher-Guide.html` is the
only page in each unit left **ungated** (never linked from the student
index, so a student has no path to it). Every other page type is
gated, including `Explanation.html`.

**Before trusting any cell below on a page you're about to edit, verify
it directly** — `grep` for `<math-field`, `createCardSelect(`,
`createVocabMatch(`, `window.listRegistry`, `window.revealAnswerKey` in
that specific file. This table is a starting point, not a substitute
for checking the file.

### Capability matrix

| Unit | Grade | ActivityId prefix | Vocab Match-Up | Card-select | Math-field |
|---|---|---|---|---|---|
| Sixth/Decimal-Operations | 6 | `6-decimal-operations-*` | ✅ | ✅ | — (all decimal) |
| Sixth/Operations-with-Fractions | 6 | `6-operations-with-fractions-*` | ✅ | ✅ | ✅ |
| Seventh/Integers | 7 | `7-integers-*` | — (no tab shape to convert) | ✅ | — (all plain integers) |
| Seventh/Rational-Numbers | 7, 7-Honors (shared) | `7-rational-numbers-*` | — | ✅ | ✅ |
| Seventh/Operations-with-Rationals | 7 | `7-operations-with-rationals-*` | — | ✅ | ✅ (per-item `format`, see §7) |
| Eighth/Linear-Equations | 8 | `8-linear-equations-*` | ✅ | ✅ | ✅ |
| Eighth/Literal-Equations | 8 | `8-literal-equations-*` | ✅ | — (no dropdown items on this unit) | ✅ (original math-field pilot) |
| Eighth/Linear-Inequalities | 8 | `8-linear-inequalities-*` | — | ✅ (original card-select pilot) | ✅ |
| Seventh/Squares-Cubes-and-Roots | 7-Honors only | `7-squares-cubes-and-roots-*` | ✅ | ✅ | — (all plain integers) |
| Eighth/Linear-Functions | 8-PreAP only | `8-linear-functions-*` | ✅ | ✅ | ✅ |

### Answer-key mechanism per unit (window.listRegistry / window.revealAnswerKey)

| Unit | Notes |
|---|---|
| Seventh/Rational-Numbers | Practice-Set/Word-Problems/Review use `listRegistry`; Test-Prep and Vocabulary-Literacy are hand-written `revealAnswerKey`. |
| Sixth/Decimal-Operations | Practice-Set/Word-Problems/Review use `listRegistry` (local var `checkListRegistry`). Vocabulary-Literacy and Test-Prep are hand-written — Test-Prep has *two* unmerged registries (`estExactRegistry`, `submitListRegistry`) plus several one-off items. |
| Sixth/Operations-with-Fractions | Same shape as Decimal-Operations, **except** Test-Prep's two registries **are** merged into `listRegistry` via `Object.assign`. |
| Seventh/Integers | Practice-Set/Word-Problems use `listRegistry` (local var `listRegistry`), Review uses `checkListRegistry`. Vocabulary-Literacy/Test-Prep hand-written; Test-Prep also has `checkQCMulti` (checkbox multi-select) and `checkQCSigns` (4-select sign-group) patterns with their own reveal logic. |
| Seventh/Operations-with-Rationals | Same shape as Integers (including `checkQCMulti`), no sign-group pattern. Its Guided-Solving-Ladder exposes `window.listRegistry = { lex: { problems: ... } }` (one flat array, not grouped by key prefix) with synthesized `displayAnswer` on `mc`-type items. |
| Eighth/Linear-Equations | Review uses `listRegistry` (local var `checkListRegistry`). Vocabulary-Literacy/Practice-Set/Word-Problems are entirely hand-written. Test-Prep's `listRegistry` covers only its Mixed Practice tab; the rest is hand-written. Practice-Set's Strategy Challenge tab has nothing to reveal until a group is picked (harmless no-op). |
| Eighth/Literal-Equations | Review uses `listRegistry`. Practice-Set's `symRegistry`/Word-Problems' `wpRegistry` are both exposed as `listRegistry`; Practice-Set hand-writes Tab 4 (Live Number Check, depends on live slider values) and Tab 5 (Error Analysis). Test-Prep's `submitSymRegistry` covers Mixed Practice parts 1-2; part 3 + the rest is hand-written. Vocabulary-Literacy is entirely hand-written. Guided-Solving-Ladder: `window.listRegistry = exRegistry` — no hand-written reveal needed. |
| Eighth/Linear-Inequalities | Review uses `listRegistry` (adapted to accept a solved inequality via `p.ineq` or an unsolved translated one via `p.accepted`). Test-Prep's `listRegistry` covers Tab 1 + Tab 3 Mixed Practice; the rest is hand-written. Vocabulary-Literacy/Explanation/Practice-Set/Word-Problems are entirely hand-written (almost every tab has a different answer shape). |
| Seventh/Squares-Cubes-and-Roots | Practice-Set/Word-Problems use `listRegistry` (plus 3 hand-written critical-thinking textareas outside it). Review/Vocabulary-Literacy use the `checkListRegistry`-style pattern by hand. Test-Prep entirely hand-written (4 problem shapes, none sharing a registry). |
| Eighth/Linear-Functions | Practice-Set Tabs 1&3 (plain-number) use `listRegistry`; Tabs 2&4 (algebraic, math-field) are hand-written, same pattern as Literal-Equations. Word-Problems' two numeric tabs use `listRegistry`; its one algebraic item is hand-written. Vocabulary-Literacy/Test-Prep entirely hand-written. |

### Teacher-Guide.html — every unit has the identical 6-tab shape
`overview` → `lesson-guide` → `metacognition`(`-discussion`) →
`differentiation` (Sixth-grade units: folded into the pre-existing
`misconceptions` tab instead of a separate tab — see below) →
Challenge Bank (panel id varies: `challenge` on most units, `resources`
on the two Sixth-grade units, `paper` on Integers/Rational-Numbers/
Operations-with-Rationals — the tab label is always "Challenge Bank"
regardless of id) → `ixl-practice`. **`Eighth/Linear-Inequalities` is
the one exception with no Challenge Bank tab at all** (5 tabs, no
`challenge`/`resources`/`paper` panel) — it never had printables
content to consolidate and none was added. **Never add a 7th top-level
tab to a Teacher-Guide** without a deliberate content decision — every
new capability belongs inside one of the six.

- **Sixth-grade units** (`Decimal-Operations`, `Operations-with-Fractions`):
  no separate `differentiation` tab — the pre-existing `misconceptions`
  panel (id `misconceptions`) carries "Scaffolded Support Problems" and
  "Extension / Challenge Problems" subsections instead, alongside its
  original misconception content.
- **Every other unit**: a genuine `differentiation` panel with
  scaffolded-support + extension/challenge problems, both with real
  worked answers (not just IXL links).
- **Challenge Bank is digital-only, site-wide.** No unit's
  Teacher-Guide links to a `printables/*.html` file anymore. The
  `printables/` folders themselves still exist on disk for
  `Sixth/Decimal-Operations`, `Seventh/Integers`,
  `Seventh/Operations-with-Rationals`, `Seventh/Rational-Numbers`,
  `Eighth/Linear-Equations`, `Eighth/Literal-Equations` — nothing there
  was deleted, only the Teacher-Guide's links to them were removed. A
  unit's actual paper-test content is never transcribed into Challenge
  Bank; that unit's Test-Prep Mixed Practice tab (submit-only, no
  retry, no on-screen reveal) is the assessment instead, graded from
  the dashboard's submission log. `Sixth/Operations-with-Fractions`
  states plainly there's nothing in its Challenge Bank yet, rather than
  fabricating filler. `Seventh/Squares-Cubes-and-Roots` and
  `Eighth/Linear-Functions` each carry 5 original, hand-verified
  problems with `.challenge-box`/`.solution-toggle` click-to-reveal
  markup (copy this exact CSS/markup from an existing unit rather than
  inventing new styling).
- **Overview & Pacing table row count**: cross-check against
  `ls` on the unit's own folder before trusting it's complete — three
  units (`Literal-Equations`, `Squares-Cubes-and-Roots`,
  `Linear-Functions`) previously shipped with a missing `Review.html`
  row; `Literal-Equations` also needed `Guided-Solving-Ladder.html`
  added as an "Additional resource" row with a direct link (not folded
  into the regular sequence).

### Strategy Challenge (student-choice practice, two units)
`Eighth/Linear-Equations/Practice-Set.html` and
`Eighth/Linear-Inequalities/Practice-Set.html` let a student pick a
strategy group (A/B/C/D) via `chooseStrategyGroup(key)`; switching
groups across sessions/reloads is explicitly allowed by the page's own
text. **The flagship item's key is `strategy-${chosenStrategyGroup}`;
every "more practice" item's key must be scoped
`stm-${chosenStrategyGroup}-${i}`, never bare `stm-${i}`.** A bare key
collides across groups (each group's `more` array is index-parallel),
silently miscounting a fresh Group B attempt as a second attempt at
Group A's problem and capping the score at 0.5. Scope every
occurrence: the input/`math-field` id, its feedback div id, the
`LessonProgress.preRegister` call, the check function's own element
lookups and `LessonCheck.check` key, and the teacher-reveal `fillInput`
call. **Known limitations, not bugs**: the picker has no visual memory
across a reload (a returning student always sees the bare picker
again, though every attempt is safely saved server-side), and the
teacher-view reveal only ever shows whichever group is currently
selected in that browser session (no way to see all groups at once
without picking each via `chooseStrategyGroup()`).

---

## 11. Grade tracks beyond 6/7/8

**7th Grade Honors** and **8th Grade Pre-AP** are non-numeric `Grade`
codes — `7-Honors` and `8-PreAP` (exact spelling; `Roster.Grade`,
`ActivityCatalog.Grade`, and `index.html`'s `CURRICULUM` keys must all
match character-for-character).

- **`GRADE_KEY_BY_NUMBER`** (`index.html`) maps only numeric grades
  (6/7/8) to a `CURRICULUM` key ("Sixth"/"Seventh"/"Eighth") —
  `Number("7-Honors")` is `NaN`, so `gradeKey = GRADE_KEY_BY_NUMBER[Number(grade)] || grade`
  falls through to the raw grade string. `GRADE_ORDER` (unrestricted
  teacher view) is `["Sixth", "Seventh", "7-Honors", "Eighth", "8-PreAP"]`
  — the Honors/Pre-AP track sits immediately after its grade's regular
  track, teaching-sequence order, not alphabetical or insertion order.
- **`ActivityCatalog.Grade` can be comma-separated** (e.g.
  `7,7-Honors`) when two tracks share one activity verbatim.
  `resolveAccess_` in `Code.gs` splits on `,`, trims, checks
  membership. **`Seventh/Rational-Numbers` is shared this way** — its
  six `ActivityCatalog` rows (including `-explanation`) have `Grade`
  widened to `7,7-Honors`, and `index.html`'s `CURRICULUM["7-Honors"]`
  "Rational Numbers" entry points at the exact same
  `base`/`activityIds` as `CURRICULUM["Seventh"]`'s — there is no
  Honors-specific fork of this content anywhere. **Rule**: never split
  a shared value like `"7"` into two rows with different `ActivityId`s
  to give Honors its own copy — extend the existing row's `Grade` cell
  instead, unless the content genuinely differs.
- **`teacher-dashboard.html` uses the identical comma-list membership
  check** via its own `gradeListIncludes(gradeField, singleGrade)` —
  every grade comparison on that page (`filteredCatalog()`,
  `computeActivitySummaries()`'s `eligible` count,
  `computeStudentUnitCompletion()`'s `catalogForGrade`,
  `computeActivityStatusBreakdown()`'s `eligible`) goes through it.
  `populateFilters()`'s grade-pill list also splits on comma before
  deduping. `formatGradeLabel()` (comma-then-space) is display-only,
  used everywhere a unit/activity's own `Grade` cell renders as text.
  **Never reintroduce a bare `===`/`.includes()` against a
  Sheet-sourced grade value.**
- **`Roster.Grade`/`ActivityCatalog.Grade` values need `String()`
  before dedup/compare** — Google Sheets can return a numeric-looking
  cell as either a JS number or string depending on cell formatting;
  `populateFilters()`'s grade sets and every filter comparison coerce
  through `String(...)` on both sides first.

**7-Honors unit**: `Seventh/Squares-Cubes-and-Roots` — not shared,
genuinely new content (perfect squares/cubes 1-20/1-15, working
backward with roots). **8-PreAP unit**: `Eighth/Linear-Functions` —
not shared, genuinely new content (domain/range, slope, slope-intercept
form, function notation, real-world linear modeling), distinct from
`Linear-Equations` (single-unknown solving) and `Literal-Equations`
(formula rearrangement).

---

## 12. index.html

Own separate, non-shared gate implementation (doesn't include
`lesson-auth.js`) — calls the backend with `type: 'identify'` (email +
role + grade only).

- **Teacher** (on `Teachers`): unrestricted — every grade, every topic,
  every section including Teacher's Guide.
- **Student** (on `Roster`): only their own grade's panel, and within
  it only sections with an `activityId` entry in `CURRICULUM`.
  Teacher's Guide never shows for a student regardless of "wired"
  status. A topic with zero wired sections doesn't render as an empty
  card — it's omitted entirely.
- **`CURRICULUM` needs an `activityIds` block per topic** or a
  signed-in student won't see it, even once the pages themselves work
  — every wired topic across all five top-level grade keys (`Sixth`,
  `Seventh`, `7-Honors`, `Eighth`, `8-PreAP`) already has one.
- **`GRADE_ORDER`/each grade's `topics` array is teaching-sequence
  order**, not alphabetical or insertion order (see §11). Inserting a
  new topic: place it at its correct teaching-sequence position, not
  appended to the end, unless it's genuinely taught last.
- **`equalizeTopicCardHeads(panelEl)`** pins every visible
  `.topic-card-head` in a grade panel to the same `min-height` (the
  tallest one measured live), called after every render that can
  change which panel is visible and on a debounced `resize`. **Never
  call it against a `display:none` panel** — `offsetHeight` reads `0`
  there and zeroes out every head's `min-height`.
- **Guided-Solving-Ladder pages are deliberately not indexed** — no
  `SECTIONS` entry, no link, no "Coming soon" placeholder for either
  unit that has one. The pages themselves are still gated/wired and
  linked from their unit's own `Teacher-Guide.html`.

---

## 13. Teacher dashboard

`Lessons/teacher-dashboard.html` — standalone, teacher-only, never
linked from a lesson page. Signs in with the same
`token-cache.js`-backed flow as a lesson page (see §2), but with its
own hand-written gate (not `lesson-auth.js`). Calls the backend with
`type: 'teacher-data'`, receiving `rows` (every `Progress` row + raw
`SubmissionsLog`), `roster` (every `Roster` row — needed so
zero-submission students show up), `activityCatalog` (every
`ActivityCatalog` row — needed so zero-submission activities show up),
`accessLog` (returned but unused by current UI), and `scope` (`null` or
the matched teacher name).

**Field casing from the backend is always lowercase camelCase**
(`email`, `studentName`, `grade`, `activityId`, `scorePct`, etc. — see
`rowToDashboardRow_`/`getRosterForDashboard_`/
`getActivityCatalogForDashboard_` in `Code.gs`), **never** the raw
Sheet header casing (`Email`, `Grade`). Any mock/test data built to
exercise `onDataLoaded(result)` directly must use the lowercase keys or
every filter/grouping silently reads `undefined`.

**Per-teacher scoping is entirely server-side** — `getTeacherScope_`/
`getScopedEmailSet_` filter `rows`/`roster`/`accessLog` before they
ever leave `Code.gs`; a scoped teacher's browser never receives another
teacher's rows to filter out client-side. `activityCatalog` is never
filtered.

### Four top-level tabs, in this order
**Never re-introduce a fifth+ top-level tab** as the default way to add
a capability — it belongs inside one of these four as a new sub-tab
(`switchSubTab(panelId, subId)`, scoped via `:scope` to one panel's own
`.sub-nav`/`.sub-panel`), or is a sign it needs its own separate product
decision.

1. **Overview** — stat tiles, "Progress by unit" bar chart,
   lowest-scoring-activity/student charts, a Flags card (by category),
   a "When students work" 24-hour histogram
   (`computeHourHistogram()`/`renderHourHistogram()`). Summary only —
   no individual-student list or raw event feed (those live in
   per-student/per-activity detail views instead).
2. **Unit & Lesson Deep Dive** — sub-tabs **By Unit**
   (`computeUnitSummaries()`, groups `computeActivitySummaries()`'s own
   numbers, so it can't disagree with By Activity) and **By Activity**
   (`computeActivitySummaries()`; includes zero-submission activities;
   completion % against eligible roster). By Activity's detail view
   includes "Item Diagnostics, lite"
   (`computeDistractorAnalysis()`/`distractorAnalysisHtml()` — most
   common wrong answer per item, only for items with 2+ wrong attempts;
   free-text bucketing, not structured multiple-choice analysis).
3. **Student Roster & Profiles** — one list, `renderByStudent()`, one
   row per roster student including zero-`Progress` students. Columns:
   Student, Grade, Teacher, Activities started, Avg score, Effort Score
   Index, Lesson Completion % (`computeStudentUnitCompletion()` — a
   **different** metric from `completionPct` above: per-student
   per-unit "what fraction of this student's own wired units are they
   done with," not roster-wide participation), Attempt-2 Recovery
   Index, Flags, Last activity (reads "Stalled - Nd" past
   `STALLED_DAYS`).
4. **Integrity & Behavior Monitor** — sub-tabs **Engagement Funnel**
   (`computeActivityStatusBreakdown()`/`progressStatus()`: Not started
   / Opened only / In progress / Completed-Passed / Completed-Locked
   Out — the five-state read of "is this being opened, and are they
   passing it," replacing the old `AccessLog`-based Access Log tab
   which is gone entirely), **Flags & Behavior**
   (`renderIntegrityMonitor()` + `renderIntegrityScatter()`
   time-on-task-vs-score SVG scatter), **Full Submission Log**
   (`renderAllSubmissions()`, the original flat table, kept as the
   detail layer everything else summarizes from — the one view that
   still uses inline-expand `toggleDetail()` instead of a separate
   detail pane).

### Shared conventions across all four tabs
- **List-then-detail pattern**: `showListView(tabKey)`/
  `showDetailView(tabKey, html)`, keyed off `#<tabKey>-list`/
  `#<tabKey>-detail`. `lastUnitSummaries`/`lastActivitySummaries`/
  `lastStudentSummaries` cache each tab's rows so a click opens by
  array index without recomputing; `renderAll()` resets every tab to
  list view on every filter change/refresh.
- **`submissionDetailTable()`** is the one function shared by Student
  Roster & Profiles' per-activity rows, By Activity's per-student rows,
  and Full Submission Log — includes the "Give attempts back" toolbar
  (§9), a "Work sessions" table (`computeSessions(events, gapMinutes)`,
  `SESSION_GAP_MINUTES = 15`), and the per-item attempt breakdown.
- **`recentActivityHtml()`** — real paginated `<table>`
  (`RECENT_ACTIVITY_PAGE_SIZE = 10`), decodes `VERDICT_TEXT`/
  `GRADED_PILL`/`EVENT_PILL` into readable rows. Any new event type
  added to `SubmissionsLog` needs its own entry in whichever of those
  three applies, or it renders with a generic fallback.
- **`scoreBarsHtml(items, labelKey, scoreKey)`** — pass
  `scoreKey: 'scorePct'` explicitly when charting raw per-row
  `decorateRow()` output (only has `.scorePct`); the default
  `'avgScore'` is only valid for the aggregate summary objects
  (`compute*Summaries()`), which have `.avgScore`.
- **`groupColor(grade, teacher)`/`groupDot()`/`groupLegendHtml()`** —
  color-code students only where a table can mix groups (By Activity's
  detail table, Full Submission Log, Engagement Funnel's detail table);
  skip on a table that already shows an explicit Teacher/Grade column
  for one fixed group.
- **Grade/Teacher filters**: one-click pills (`renderFilterPills`), not
  `<select>`s. `currentGradeFilter` defaults to the first grade in
  sorted order on first load (`gradeFilterInitialized`), not "All" — a
  later Refresh leaves the teacher's own selection alone unless it no
  longer exists in fresh data. Teacher pill group is hidden entirely
  for a scoped account.
- **Activity filter** is a multi-select checkbox popover
  (`currentActivityFilter` is an array), not a pill row or `<select>`.
- **Default sort**: alphabetical everywhere (`sortState`:
  `activityTitle`/`unit`/`studentName` ascending), **except** Flags &
  Behavior, which defaults to `lastSubmittedAt` descending.
- **`GROUP_KEYS`/`sortItems()`/`compareValues()`** — By Unit/By Student
  group by `grade`, By Activity/Engagement Funnel group by `unit`;
  sorting always applies the group key first, then whatever column was
  clicked, so a table never interleaves groups even when sorted by
  score/name.

---

## 14. Content authoring references

**Check both of these before writing a new unit or adding IXL/standards
references to an existing one — never fabricate a code, a URL, or a
standard citation.**

- **`IXL/` (repo root)** — `IXL/README.md` indexes four grade-level
  snapshots (`5th/`, `6th/`, `7th-Accelerated/`, `Algebra-1/`, dated
  2026-09-09) of IXL's own published skill-alignment guide for this
  school's exact Savvas enVision edition: Topic → Lesson → IXL skill
  (name + link + 3-char code). **This is the only valid source for a
  Teacher-Guide's IXL Practice tab.** `ixl.com` is blocked by this
  environment's network policy, and a web search's claimed code cannot
  be trusted (tested: three different codes for the same skill in one
  query). Match by lesson **content**, not by book Topic/Lesson number
  alone — numbers don't always line up with this site's own unit names.
  If a taught skill has no real match, say so and leave it uncited —
  see `Seventh/Squares-Cubes-and-Roots`'s and `Eighth/Linear-Functions`'s
  own Teacher-Guide IXL panels for the pattern (name the specific
  unverifiable skill, don't omit the gap silently).
- **`Math Department Curriculum Map & Year Plan.xlsx` (repo root)** —
  one sheet per course, one row per teaching week, `Theme / Unit Title`
  + `Standards` (full CCSS/HSA/HSF codes with official text). Source of
  truth for §15's standards line. Match by lesson **name/content**,
  **never by embedded lesson number** (the book's numbering was updated
  this year — a number in the map can't be trusted against anything
  else). Read the **full, untruncated** cell text — a first pass that
  truncated to 200 chars silently dropped trailing standard sub-parts.
  Use `openpyxl` (`pip install openpyxl` first, not preinstalled) to
  read raw cell values. One unit can span several weekly rows; collect
  every standard from every genuinely-matching row before finalizing.

---

## 15. Standards line

Sourced **only** from the curriculum map above, matched by lesson
content, never fabricated. If a unit doesn't cleanly match anything,
leave a gap noted rather than forcing the nearest-sounding code.

| Unit | Standards line |
|---|---|
| Sixth/Decimal-Operations | `6.NS.B.2, 6.NS.B.3` |
| Sixth/Operations-with-Fractions | `5.NF.A.1, 6.NS.A.1` |
| Seventh/Integers | `7.NS.A.1a, 7.NS.A.1b, 7.NS.A.1c, 7.NS.A.1d` |
| Seventh/Rational-Numbers | `7.NS.A.1b, 7.NS.A.1c, 7.NS.A.1d, 7.NS.A.2a, 7.NS.A.2b, 7.NS.A.2c, 7.NS.A.2d` |
| Seventh/Operations-with-Rationals | `7.NS.A.1b, 7.NS.A.1c, 7.NS.A.1d, 7.NS.A.2a, 7.NS.A.2b, 7.NS.A.2c` |
| Seventh/Squares-Cubes-and-Roots (7-Honors) | `8.EE.A.2` |
| Eighth/Linear-Equations | `HSA.CED.A.1, HSA.REI.A.1, HSA.REI.B.3` |
| Eighth/Linear-Inequalities | `HSA.CED.A.1, HSA.REI.A.1, HSA.REI.B.3` (identical to Linear-Equations — both come from the same Algebra I Topic 1 map rows; the map's own standards don't distinguish equations from inequalities at this grain) |
| Eighth/Literal-Equations | `HSA.CED.A.4` |
| Eighth/Linear-Functions (8-PreAP) | `HSA.CED.A.2, HSS.ID.C.7, HSF-IF.A.1, HSF-IF.B.5, HSF-LE.A.2` |

Notes:
- `7.NS.A.1a` ("opposite quantities combine to make 0") belongs to
  Integers only — the map ties it to Integers-flavored add/subtract
  lessons specifically, not Rational-Numbers/Operations-with-Rationals,
  even though both add/subtract signed numbers.
- `Eighth/Linear-Functions`'s Teacher-Guide Overview tab still carries
  an older, separately-written "Standards & Objectives" text
  (`HSF.IF.A.2`) that predates this table and was never verified
  against the map (`HSF.IF.A.2` doesn't appear in either Algebra I
  sheet) — left alone, out of scope. Don't assume the two are supposed
  to match; re-verify both independently before "fixing" either.
- A brand-new unit: find its lessons' name-matching map row(s), pull
  every standard cited (full untruncated text), union them, add the
  `<p class="standards-line">` to every page type, and add a row here
  — or the next session re-derives it from scratch.

---

## 16. Verification checklist (run this after any change)

In order, cheapest first:

1. **Syntax, repo-wide**: walk every `.html` under `Lessons/`, extract
   every non-`src` `<script>` block, run each through `new Function(s)`.
   Zero errors expected across all 106+ files.
2. **Record-argument audit** (see §5) — the AST-based
   `LessonCheck.check`/`.submit` argument-count check. Zero short calls
   expected. Run this on **any** commit that touches a check function,
   even one that looks unrelated to saving.
3. **Cache-bust consistency**: `grep -rhoE "lesson-auth\.js\?v=[0-9]+" Lessons/ --include="*.html" | sort -u`
   and the same for `token-cache.js` — each must print exactly one
   version. If you edited either file, bump the version on every page
   that includes it first.
4. **Answer-key mechanism audit**: every graded page type
   (`Practice-Set`/`Word-Problems`/`Review`/`Test-Prep`/
   `Vocabulary-Literacy`/`Guided-Solving-Ladder`) must define
   `window.listRegistry` or `window.revealAnswerKey`, and must include
   `lesson-auth.js`.
5. **`LessonSync.init(activityId)` uniqueness**: every call site's
   `activityId` string must be unique site-wide — a collision means two
   pages share one `Progress` row.
6. **Live grading test** (Playwright, headless chromium at
   `/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell`
   — the regular `chromium-1194` binary intermittently throws "Old
   Headless mode has been removed"): navigate to the page, force-reveal
   `.app-container` and hide `#lesson-gate`/`#lesson-loading` via
   `page.evaluate`, drive the check function, read
   `LessonProgress.all()` and confirm the new entry's
   `key`/`label`/`answer`/`verdict`/`section` are correct.
7. **Live teacher-view test** (see §6's "How to verify" for the full
   mock-route recipe) — confirm the banner appears and every answer
   field is filled + disabled, with zero `pageerror` events.
8. **Live dashboard render test** — call `onDataLoaded(mockResult)`
   directly with lowercase-camelCase mock data (see §13's field-casing
   note), click through every top-level tab and sub-tab, open an
   activity and a student detail view, confirm zero `pageerror` events
   and substantial rendered HTML (not an empty panel).
9. **Panel-id / nav-tab consistency** on any page with tabs: every
   `switchTab('x')`/`switchDashTab('x')` call must have a matching
   `id="x"` panel, and vice versa (no orphans either direction).
   `switchSubTab('p', 'x')` is different — it looks up the **composite**
   id `${p}-${x}`, not bare `x` (see `switchSubTab` in
   `teacher-dashboard.html`), so the matching panel is `id="p-x"`, not
   `id="x"`. Check for orphans against whichever id the actual function
   looks up, not the raw call argument.

---

## 17. Status

**Done**: OAuth client + consent screen created, `hd`-domain check
validated live against a real `lincoln.edu.ni` account. Sheet has all 5
tabs. Apps Script deployed as a Web App. All 9 units (+2 Honors/Pre-AP)
fully wired end-to-end — sign-in, grading, progress sync, teacher
dashboard, teacher-view answer keys — and verified via the checklist
above.

**Open (needs a team decision, not further engineering)**:
`Lessons/Projects/*` remains on its own older, unmigrated pattern (its
own per-project `SHEET_API_URL` instead of the shared Sheet/Apps
Script backend). **Don't extend it and don't hold it to any rule in
this file.** Migrating it onto the shared backend is a real project —
rewriting each project's save calls to the shared `Code.gs` pipeline —
and needs to be discussed with the team before anyone starts it. This
is the only open item; everything else below is closed.

**Closed, by design**: `Vocabulary Match-Up` is intentionally not on
`Seventh/Integers`/`Operations-with-Rationals`/`Rational-Numbers` — see
§10's capability matrix. Each of those three units' vocabulary practice
is its own legitimate, already-graded multi-tab shape (not a single
"match the term" tab like the 6 units that got the widget); staying
different is fine and correct for these three, not a gap to close.

**Closed**: every progressive-reveal widget in
`Sixth/Decimal-Operations/Explanation.html` (`revealAddStep`/
`revealMultStep`, the four carousel `next*ExStep` functions, and the
three simple-counter `next{AddEx1,Ex2,MultWorked}Step` functions — 9
widgets total, more than this file once implied) has the same
"button after its container, disable + relabel to 'All steps revealed'
once exhausted" treatment every other unit's reveal widgets have,
verified live via Playwright (each widget's button correctly disables
at its cap and correctly re-enables on Reset, zero `pageerror` events).
Deliberately deferred integrity/reporting features are listed in §8.
