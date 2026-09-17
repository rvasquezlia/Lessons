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
- [§16 Verification checklist](#16-verification-checklist-run-this-after-any-change) — how to prove your change works before calling it done

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
18. [Paired/team activities](#18-pairedteam-activities)

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

A **paired/team** activity (two students, one Driver/one Navigator,
mirrored progress) runs on this exact same one backend — see §18. It is
a different pattern from `Lessons/Projects/*` above: a paired activity
lives under its grade folder like any other page and uses this backend
directly, not a separate `SHEET_API_URL`.

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
- **`Lessons/privacy-policy.html` and `Lessons/terms-of-service.html`**
  are the public Privacy Policy/Terms of Service pages the consent
  screen's own configuration requires a link to before this app can
  move from Testing to Production. Both are **deliberately public/
  ungated** (Google's own review, and a prospective sign-in user, need
  to read them without first signing in — unlike every other page this
  file documents) and **generic** — no project-specific implementation
  detail, just what data is collected (a Google account's name/email
  via sign-in, restricted to the school's domain, plus academic
  activity) and how it's used. **Deliberately not indexed** — no
  `<meta name="robots" content="noindex, nofollow">`, not in
  `index.html`'s `CURRICULUM`/any nav, same direct-link-only pattern as
  the four STREAM project pages (§12) — only linked to each other and
  back to `index.html`. Built with `lesson-shared.css`'s real
  `.app-container`/`header`/`.panel` shell like every other page on the
  site, not a one-off design.

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

**Current versions**: `token-cache.js` → `2`, `lesson-auth.js` → `14`.
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
| `Progress` | **Automatic** — Apps Script only | One row per (student, activity), upserted on every save. Columns: `Email, StudentName, Grade, Teacher, ActivityId, ActivityTitle, FirstStartedAt, LastSubmittedAt, ItemsTotal, ItemsAttempted, ItemsCorrect, ScorePct, Status, SubmissionsLog (JSON), FlagReason, ReviewedByTeacher, ReviewedAt`, plus an optional `ReviewValid` (`'valid'`/`'invalid'`/blank — see §13's "Marking a flag reviewed"). None of these five are ever hand-edited directly — the Teacher Dashboard's own review UI writes `ReviewedByTeacher`/`ReviewedAt`/`ReviewValid` via a `teacher-review` backend request. |
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
`SAFE_ONCLICK` (`next`/`prev`/`change`/`choose`/`load`/`reveal`/`reset`/
`toggle`/`switchtab`/`switchsubtab`/`print`/`scroll`/`jump`/`open`/
`show`/`close`, case-insensitive) or that carry
`.tab-btn`/`.sub-tab-btn` — carousel nav, a student-choice picker like
Strategy Challenge's group buttons, "Reveal Next Round/Step," Reset,
and tab navigation all stay usable for a teacher, on the principle that
a teacher should always be free to navigate/browse a page exactly as a
student would, and only a genuine Check/Submit-style grading action
(meaningless once every field is already auto-filled) gets disabled.
**Rule**: matched by substring against the button's real onclick text,
not by what "sounds like" navigation — `change` exists specifically
because the site's actual carousel convention is a shared
`change(dir)`-style handler (`changeRn`, `changeAddEx`, ...), **not** a
literal `next`/`prev` function name (that's rare); a first pass that
assumed the literal-name convention silently disabled every carousel's
Prev/Next buttons for every teacher on every unit that uses it, plus
every `chooseStrategyGroup`/`loadWBProblem`-style picker, with no
per-widget state check anywhere to blame — the button was disabled
purely because its onclick text never matched the regex. Before adding
a new interactive control, check whether its function name will
actually match one of these words; if not, `grep` site-wide for that
same keyword first (e.g. `onclick="[a-zA-Z0-9_]*load[a-zA-Z0-9_]*\(`)
to confirm it won't also catch something that genuinely grades an
answer, then add it to `SAFE_ONCLICK` in `lesson-auth.js` (bump its
`?v=` — see §2) rather than leaving the new control live or dead by
accident. **A page with its own local copy of this regex for a
different purpose** (the canonical paired-activity example's
`lockForNavigator()`, §18 — blocking a read-only Navigator, not a
teacher) should **not** blindly mirror every keyword added here: `load`
is safe for a teacher (nothing it matches ever persists, since a
teacher's `ready` flag never becomes `true`) but would be wrong for a
Navigator, whose `loadGardenTokens()`-style functions do mutate locally
even though the backend rejects saving it — judge each addition against
what the specific lockout is actually protecting.

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
  Not an interactive/draggable widget by design. **Not the same
  function as `renderNumberLine()` below** — different name, different
  file, unrelated to Linear-Inequalities specifically.

### Number line — `renderNumberLine(containerId, opts)` in `lesson-shared.js`
A more general, reusable SVG number line (arbitrary `min`/`max`/`step`,
optional `arrows`/`ranges`/`points`) — 8 pages across Rational-Numbers,
Operations-with-Rationals, Integers, and Linear-Equations call it.
**Rule**: the tick-label loop steps by an integer count and rounds each
value to 6 decimal places before it's ever put in `<text>` — a
fractional `step` (e.g. `0.2`) accumulated via repeated `+=` hits
ordinary binary floating point noise (`0.6000000000000001` instead of
`0.6`, a real bug once shown to a student: `Seventh/Rational-Numbers/
Test-Prep.html`'s 0-to-1 fraction/decimal number line). Never revert to
plain accumulation (`for (let v = min; v <= max; v += step)`) when
touching this loop.

### Standards line
Every lesson page (all 7-8 page types per unit, not just the
student-facing five) has one line immediately after its `<h1>`:
`<p class="standards-line">Standards: <code(s)>...</p>`, styled via
`.standards-line` in `lesson-shared.css`. Identical text across every
page in one unit. See §15 for the sourcing rule and the current table.

### Component states, touch targets, and dark mode
- **`:focus-visible`** — every interactive shared component
  (`button`, `.card-select-option`, `.tab-btn`, `.dot`, `.pv-column`,
  every form control) gets a real, themed 3px focus ring on keyboard
  navigation only (never on a mouse/touch click, since `:focus-visible`
  — not plain `:focus` — is what's used). A button already filled with
  a primary-colored background gets a white ring + colored glow instead
  (a primary-on-primary ring would be nearly invisible) — see
  `.btn-lg:focus-visible` and its neighbors in `lesson-shared.css` for
  the exact selector list. **Rule**: a new shared interactive class
  needs adding to one of these two selector groups, or it keeps only
  the browser's own inconsistent default outline.
- **Touch targets** — `.card-select-option` (the touch-friendly
  `<select>` replacement, §7 above) has an explicit `min-height: 44px`
  so a short one-word option never shrinks below the standard mobile
  minimum tap size. Every other shared button already clears 44px from
  its own padding/font-size. **Not yet audited**: a page's own locally-
  defined buttons (e.g. `.row-check-btn`, defined per-page rather than
  in this shared file) and anything canvas-based (the paired-activity
  example's Konva drag tokens, §18) — a deliberately deferred, later,
  file-by-file pass, not a gap in this file's own components.
- **Colorblind-safe feedback** — `.feedback-msg.success`/`.error`
  already differed by more than color (the message text itself always
  says "Correct!" or gives specific guidance, never color-only); a
  `::before` checkmark/X now makes the distinction visible at a glance
  too, without reading the text. **Gotcha**: `.feedback-msg.locked`
  (§9) already claims `::before` for a "Locked - " prefix — a message
  that's both, e.g. `success locked`, needs the *combined* 3-class
  selector (`.feedback-msg.success.locked::before`, content `"✓
  Locked - "`) to render both cues at once; the plain 2-class
  `.success::before`/`.locked::before` rules have equal specificity, so
  without the combined rule one would silently win over the other
  depending purely on source order. Follow this exact pattern (combined
  selector for every state that can co-occur) before adding a new
  `::before`-based cue to `.feedback-msg` anywhere.
- **Dark mode** — a `.theme-toggle-btn` (plain SVG sun/moon icons, no
  emoji, fixed top-right on every page) is injected automatically by
  `lesson-shared.js`'s `ThemeToggle` module on every page that loads
  it — no per-page markup needed. Click toggles a `data-theme="dark"`/
  `"light"` attribute on `<html>`, persisted to `localStorage`
  (`lia_theme`); a first-ever visit with nothing stored yet matches the
  device's own `prefers-color-scheme` instead of defaulting to light
  regardless, same "respect what's already there" principle as
  `token-cache.js`. The attribute is set synchronously at script-load
  time (this script has no `defer`/`async` and sits in `<head>` per
  this section's own ordering rule), before `<body>` is even parsed —
  no flash of the wrong theme on load.
  - **Scope: this file's own shared components only.** Every hardcoded
    color used by a class defined in `lesson-shared.css` has a
    `[data-theme="dark"]`-scoped override (search the file for that
    exact string to see the whole block, appended at the end) — but a
    page's own local `<style>` block (a digit-box grid, a catalog
    card, the paired-activity example's Konva canvas, a Teacher-Guide's
    printable-styled sections, ...) is **not** covered and keeps its
    original light styling even while the rest of the page around it
    goes dark. Extending dark mode into page-specific content is a
    separate, later, file-by-file pass — expect a page with heavy local
    styling to look like a light card floating inside a dark shell
    until that pass happens, not a bug in this mechanism.
  - **`teacher-dashboard.html`/`projects-dashboard.html`/`Teacher-
    Help.html` load `lesson-shared.css` but never `lesson-shared.js`**
    (§13) — loading the whole file would also auto-inject
    `TeacherPrint`'s "Print Class Progress" bar the moment it finds any
    `.tab-btn` element, which `teacher-dashboard.html`'s own nav tabs
    are (they use `switchDashTab()`, not the lesson-page `switchTab()`
    that bar expects — the bar would render with an empty checklist, a
    real bug, not a hypothetical one). All three pages instead carry
    their own standalone copy of just the `ThemeToggle` module (a
    `<script>` in `<head>`, before `<body>` — same "no flash of the
    wrong theme" ordering as `lesson-shared.js`'s own copy), duplicated
    rather than shared, matching this codebase's existing
    "self-contained dashboard page" convention (see `projects-
    dashboard.html`'s own `STREAM_PILLAR_RULES` duplication). Each adds
    a small `[data-theme="dark"]` block for its own hardcoded (non
    `var()`) colors — `teacher-dashboard.html`'s `.pill.neutral`/
    `.pill.progress`/`.detail-row td`/the shared `.info-bar` class (see
    below); `projects-dashboard.html`'s `details.deliverables-toggle
    summary`; `Teacher-Help.html`'s `.chip.*`/`.note-box`/`code.k`. Any
    other selector in these three files already uses
    `lesson-shared.css`'s own shared custom properties and flips
    automatically once `[data-theme="dark"]` is set — check for `var(
    --...)` usage before assuming a new hardcoded color needs its own
    override.
  - **`teacher-dashboard.html`'s `.info-bar` class** — the small utility
    bars `pairingHtml()`/`reviewToolbarHtml()`/`submissionDetailTable()`'s
    reset toolbar each render (§9/§13/§18) used to be inline
    `style="background:#f8fafc..."` on each call site — converted to a
    shared `.info-bar` class (`.tint-blue` variant for `pairingHtml()`'s
    lighter tint) specifically so dark mode can override them in one
    place instead of five. Any new small inline-styled info box in this
    file should use (or extend) this class rather than a fresh inline
    background, or it silently stays light-mode-only.
  - **`index.html` (§12) keeps its own separate `:root` block** (not
    shared with `lesson-shared.css` — this page loads neither shared
    file, its own separate gate implementation) — it has its own
    `[data-theme="dark"]` redefinition of the same variable names
    (`--bg`/`--card`/`--text`/`--border`/`--dark-heading`) plus its own
    six `--c-*`/`--c-*-bg` topic-chip pairs, inverted the same
    dark-tinted-background-plus-lighter-foreground way as every other
    pastel badge on the site. It also carries its own duplicated
    `.theme-toggle-btn` CSS and `ThemeToggle` module (no shared file to
    load at all) — a third copy of both, alongside the three dashboard-
    style pages' copies above. **Every dashboard-adjacent page (all
    four now) has real, working dark mode** — the one remaining gap is
    genuinely page-local lesson-page content (a digit-box grid, a
    catalog card, a Konva canvas, ...), unchanged from the scope note
    above.
  - **`--text` is deliberately a mid-gray (`#717a85`), never a near-
    white, in dark mode** — `body { color: var(--text); }` (light-mode,
    unedited) means every element on the page inherits this as its
    default text color unless it sets its own, including page-local
    content the scope note above says is untouched. A near-white value
    here read as literally invisible white-on-white text the one time
    it shipped (a live regression: "No answers in here" on a page-local
    vocabulary card whose background correctly stayed light-mode white,
    while its inherited text went light too). `#717a85` was chosen
    because it clears ~4:1 contrast against **both** an untouched white
    card and this file's own new dark surfaces — never as sharp as a
    true near-white would look against a fully dark page, but never
    invisible either. **Never brighten this toward white** without
    first doing the full page-local dark-mode pass the scope note
    above describes — until every light-background component the whole
    site actually has gets its own explicit dark treatment, `--text`
    has to stay conservative enough to survive landing on one that
    doesn't.
  - **Never redefine `--primary` itself for dark mode.** It's used both
    as a *background* (header, `.app-container`'s border, several
    buttons — where the original dark navy is correct and unchanged in
    both themes, since a dark background reads fine on a dark page too)
    and, separately, as *text color* on a handful of headings that
    assumed a white card behind them (`.section-title`, `.ladder-
    result`, `.qa .a`, ...) — redefining the variable itself would fix
    the text cases but break the background cases (a light-mode-correct
    dark navy header would turn an unreadably light blue). Every text
    use instead gets its own explicit override to a lighter blue
    (`--dark-heading: #7dd3fc`, defined once, reused by every heading
    selector) — **if a new shared component uses `var(--primary)` as
    its own text color, add its selector to that same override group
    rather than touching the variable.**
  - **Every color-coded pastel badge/tag/box** (`.type-tag.*`,
    `.pill-*`, `.resolve-box.*`, `.kcc-box`, `.running-box`, `.flow-
    math.final`/`.running`) is inverted to a dark-tinted background
    with a lighter version of its own saturated color, never just
    "the same colors, dimmed" — keeps the same color-coding legible
    (still identifiably the same hue family) against a dark surface.
  - **`lesson-shared.css`/`lesson-shared.js` don't use the `?v=`
    cache-bust convention** §2 requires for `token-cache.js`/
    `lesson-auth.js` — no version query string exists on either
    reference anywhere on the site today, so this change (like any
    future edit to either shared file) propagates on GitHub Pages' own
    normal CDN cache schedule rather than being forced immediately.
    Not addressed here — retrofitting `?v=` onto both files would touch
    the `<head>` of 77 (`lesson-shared.css`) and 66
    (`lesson-shared.js`) pages, a separate, much larger, deliberate
    change of its own.

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
excludes): the *full* structured per-distractor Item Diagnostics (a
free-text "lite" version exists — see §13's Item Diagnostics entry),
true DevTools/concurrent-session detection, Vocabulary flashcard
rapid-flip tracking, any Live Classroom View. Don't build these without
a separate, explicit request. **Closed**: a Printable PDF/Report
Generator — see §13's CSV gradebook export (a filtered CSV, not a
formatted PDF/printable page; a real print-formatted report is still
open if that specific format is ever wanted).

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
  table in `submissionDetailTable()` — reused by Students' own student
  detail view, Unit & Lesson Deep Dive's By Activity, and Full
  Submission Log, so it appears in all three with one change. A per-item "Reset"
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
- **Unpairing a team** (a paired activity's own teacher-only mechanism,
  separate from this reset flow) is §18's `teacher-unpair` — same
  dashboard-only, next-page-load-only, scoped-authorization shape as
  the reset above, but removes a `Pairs` row instead of touching
  `SubmissionsLog`.

---

## 10. Per-unit reference

Every unit ships the same file set: `Review.html`,
`Vocabulary-Literacy.html`, `Explanation.html`, `Practice-Set.html`,
`Word-Problems.html`, `Test-Prep.html`, `Teacher-Guide.html` (7 files).
`Operations-with-Rationals` and `Literal-Equations` additionally have
`Guided-Solving-Ladder.html` (8 files). Every page type in every unit
is gated, including `Explanation.html` and `Teacher-Guide.html`.

**`Teacher-Guide.html` uses the dashboards' hand-written teacher-only
gate, not `lesson-auth.js`.** It used to be left completely ungated
(never linked from the student index, relying on obscurity alone) —
now every one of the 10 `Teacher-Guide.html` files carries the exact
same gate `teacher-dashboard.html`/`projects-dashboard.html`/
`Teacher-Help.html` use: `token-cache.js` plus a hand-rolled sign-in
flow that POSTs `type: 'teacher-data'` purely as a teacher-only check
(the response body beyond `ok` is ignored — this page has no data of
its own to show). This is deliberately **not** the same
`lesson-auth.js`/`unlockTeacherView()` pattern every other lesson page
uses, since a Teacher's Guide has no student-facing check flow for a
role split to apply to — it only ever needs a yes/no "is this a
teacher" answer, exactly like the two dashboards. The gate markup is
`#lesson-loading`/`#lesson-gate`/`.lesson-gate-body` (all styled by
`lesson-shared.css`, already loaded on every Teacher-Guide.html), and
`<div class="app-container" id="guide-app" hidden>` wraps the existing
content unchanged. **Rule**: never add a real "answer key" reveal to a
Teacher-Guide.html's own gate — a signed-in teacher already sees the
Guide's real content as soon as the gate passes, there's nothing to
auto-fill.

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
- **`Sixth/Laudato-Si-EcoGarden/index.html` (§18) is deliberately not in
  `CURRICULUM` either** — no topic card, not browsable from this page at
  all. Access is by direct link only (the teacher hands out the URL) —
  the page itself is still fully gated/wired (Google sign-in, shared
  backend, pairing) exactly as if it were indexed; only its discovery
  path differs. Don't re-add a `CURRICULUM` entry for it without asking
  first — this was a deliberate access-control choice, not an oversight.
- **A teacher-only nav row** (`#teacher-nav-links`, hidden by default,
  unhidden inside `renderForTeacher()`) sits under the header subtitle —
  links to `teacher-dashboard.html`, `projects-dashboard.html`, and
  `Teacher-Help.html`. A student never sees it (`renderForStudent()`
  never unhides it). Same `.dash-nav-links`/`.dash-nav-link` CSS class
  names as the three teacher-only pages below, each page keeping its own
  copy in its own `<style>` block (this page's own convention: no shared
  CSS file with the dashboards).

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

**`Lessons/Teacher-Help.html`** — a fourth teacher-only page, alongside
this dashboard, `projects-dashboard.html`, and (for a signed-in teacher)
`index.html`. Same gate pattern as this file (hand-written, `type:
'teacher-data'` used purely as the teacher-only check — it ignores
every field of the response except `ok`/`scope`, since this page has no
data of its own to show). A reference covering getting started
(sign-in and what a teacher account unlocks), grades and the 7 per-unit
page types, the Teacher Dashboard's four tabs and flags, STREAM
projects and pairing, which Sheet tabs a teacher edits directly, and an
FAQ — written for a teacher reading it, not a developer, and worded in
plain classroom terms rather than backend/implementation language (no
raw file paths, Sheet-mechanics framing kept to only what a teacher
genuinely edits by hand). **Uses the site's own real content shell, not
a bespoke design** — `<nav class="nav-tabs">`/`<button class="tab-btn"
onclick="switchTab(...)">`/`<div class="panel">` (the exact same
tabbed-page pattern every `Teacher-Guide.html` and lesson page already
uses, including a page-local `switchTab()` copied from that same
convention), `.section-title`/`.howto-box`/`.notebook-box`/
`.explainer-box`/`.data-table` from `lesson-shared.css` for headings,
callouts, and tables. Its only genuinely page-local components are the
FAQ accordion (`details.help-faq` — no shared `<details>` style exists
anywhere else on the site to reuse) and the color-coded `.chip`/
`.role-pill` badges (deliberately reusing index.html's own per-section
colors, so "Vocabulary & Literacy" reads as the same color here and on
the index page). **No emoji, ever, on this page or anywhere else new
gets added to the site** — an earlier version used emoji as decorative
section-header icons; the site's own writing convention doesn't use
them (a plain `" - "` is this site's own stand-in for an em dash,
already used throughout this very file — that convention stays, only
the emoji were the actual defect). **Keep it in sync by hand** whenever
a dashboard-facing feature changes (a new flag type, a new tab, a new
Sheet column a teacher might touch) — nothing generates its content
from the dashboards' own code.

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

**Cross-page nav row** — same `.dash-nav-links` header row as
`projects-dashboard.html`/`Teacher-Help.html`/index.html's teacher-only
row (see §12); links to the other two teacher pages plus the Lessons
Index, never to this page itself. **Each link carries a small
stroke-style SVG icon** (`.nav-icon`, 16x16, `stroke="currentColor"`)
identifying its *destination* — home for the Lessons Index, a bar-chart
glyph for a dashboard, a flask for the STREAM Projects Dashboard, a
help-circle for Teacher Help — rather than a directional arrow or a
bare `?` character. Matches the visual language the `ThemeToggle`
sun/moon icons already established on these same four pages. **Rule**:
because the icon encodes the destination, not the direction, the exact
same markup is correct on every page that links to it — never invent a
"back" vs. "forward" variant of an icon for the same destination.

**CSV gradebook export** — an "Export CSV" button next to Refresh calls
`exportGradebookCsv()`, which exports exactly `filteredRows()` (the same
Grade/Teacher/Activity/Flagged-only-filtered set every tab's own table
already reads from) as a UTF-8-BOM CSV (Student, Grade, Teacher,
Activity, Score %, Items Attempted, Items Correct, Status, Last
Submitted, Flags, Reviewed, Review Classification). Client-side only —
no backend call.

### Marking a flag reviewed (Valid concern / Not an issue)
`ReviewedByTeacher`/`ReviewedAt` existed as real `Progress` columns with
no UI to set them until a `teacher-review` request type
(`applyTeacherReview_` in `Code.gs`) and a matching dashboard UI closed
that gap. A flagged row can be marked reviewed and classified
`'valid'` (a real concern, followed up on) or `'invalid'` (a false
alarm) — or unmarked (`''` clears all three fields). This never touches
`SubmissionsLog`/scoring — it's a note for whoever reads the dashboard
next, not a correction to the record.

- **`ReviewValid`** is an optional `Progress` column (add it as a new
  header, anywhere after `ReviewedAt` is the natural spot, if you want
  the classification persisted — `colMap_()` looks columns up by name,
  not position, so where it sits doesn't matter to the code; everything
  degrades cleanly without it, same pattern as `Day2Code`/`TeamId`: reviewed/
  unreviewed still works, the row's classification just reads as
  `''`/"Not an issue" until the column exists).
- **`reviewToolbarHtml(r)`** — the full toolbar (status pill + Mark
  Valid/Mark Not an issue buttons, or the reviewed pill + Undo),
  prepended inside `submissionDetailTable()` so it shows on every detail
  view that function already serves (Student Roster, By Activity, Full
  Submission Log) — same "one shared function, three call sites" pattern
  the reset toolbar (§9) uses.
- **`reviewCellHtml(r)`** — the compact version (buttons or a pill,
  no label) for the Flags & Behavior list row itself, so a teacher can
  classify a flag without opening its detail view first.
- **`teacherReview(email, activityId, reviewValid, btn)`** — the one
  client function both call, mirroring `teacherReset()`'s shape exactly
  (fetch, `decorateRow(result.progress)` back into `allRows`, `renderAll()`).
- Requires a `Code.gs` redeploy (§1) to take effect live.

### Duplicate-answer flag skips known teammates
`applyDuplicateAnswerFlags()` (§8) now excludes a match against anyone
`teammatesForRow()` already reports as this row's own teammate before
counting it — a paired/team activity mirrors the Driver's every
submission onto each teammate's row by design (§18), so two teammates
converging on the same wrong answer is expected, not suspicious.
`allPairs` must be populated (inside `onDataLoaded`) **before**
`applyDuplicateAnswerFlags()` runs, not after — the two were reordered
for this reason.

### Home, quick-switch, and the three real destinations
The dashboard used to open straight into a flat row of four
equally-weighted tabs (Overview/Unit & Lesson Deep Dive/Student
Roster/Integrity & Behavior Monitor) with no ranking or entry point. A
first pass only bolted a landing page in front of that same row without
touching it — clicking through still dropped a teacher into the
identical wall of stat tiles and a 10-column roster table. The rule
going forward: **a redesign changes what the destination itself shows,
not just how you get there.**

**`#home`** is the default `.panel.active` on load: a search card
(see below) plus three tiles — **My Class** (`switchDashTab('overview')`),
**Students** (`switchDashTab('students')`), **Flags to Review**
(`switchDashTab('integrity')` + `switchSubTab('integrity', 'flags')`)
— plus a secondary row of plain links into By Unit, By Activity,
Engagement Funnel, and Full Submission Log (the drill-in views below)
and a link out to `Teacher-Help.html` for roster/Sheet management.
**These three tiles are the only real top-level destinations now** —
By Unit/By Activity/Engagement Funnel/Full Submission Log are never
shown as an equal fourth option anywhere; they're reached only as
drill-in links from inside one of the three (or from Home's own
secondary row). Internally the four original panel ids (`overview`/
`unit-lesson`/`students`/`integrity`) and their render functions are
unchanged — only which ones get top-level buttons, and what each one's
own content looks like, changed.

- **`#nav-tabs` is now a lightweight three-button "quick switch"**
  (My Class/Students/Flags to Review, same `data-tab`/`.tab-btn`
  wiring `switchDashTab()` already had — only the CSS and the button
  count changed), not a fourth-tab-wide nav bar. It sits next to
  `#crumb-bar` and lets a teacher jump directly between the three real
  destinations without returning Home first; hidden together with the
  crumb bar while on Home (see the `switchDashTab()` note below).
  `unit-lesson` has no quick-switch button of its own — while inside a
  drill-in view, no pill is highlighted, which is the intended signal
  that you're one level deeper than the three main destinations.
- **`renderHome()`** (called from `renderAll()`, after the other six
  render passes so it never disagrees with the tab it links into) reads
  the exact same `filteredRows()`/`filteredRoster()`/
  `computeStudentSummaries()` every other view already reads from —
  there is no separate "Home filter state"; the filter bar above the
  (hidden-on-Home) quick-switch row already applies to every panel
  including this one.
- **Score and completion are shown as two separate numbers everywhere
  a "who needs a look" list appears** (Home's My Class tile stat row
  and Students tile preview rows, My Class's own attention cards) —
  never collapsed into one, and a ranked list uses *whichever of the
  two is worse* (`Math.min(avgScore, overallCompletionPct)`), since a
  student can be acing every attempted item while barely having started
  the unit, or the reverse, and only showing score would hide the
  second case entirely.
- **`switchDashTab(tabId)`** toggles `#nav-tabs`/`#crumb-bar`
  visibility: hidden/hidden on Home, shown/shown on every other tab.
  `#crumb-bar`'s one link (`&larr; Teacher Dashboard Home`) is the way
  back. **Rule**: `#nav-tabs[hidden]` needs its own
  `display: none !important` override in this file's own `<style>` —
  `lesson-shared.css`'s `.nav-tabs { display: flex; ... }` is an
  author-stylesheet rule of equal specificity to the browser's built-in
  `[hidden] { display: none }`, and author rules beat user-agent ones
  regardless of specificity order, so the plain `hidden` attribute
  silently does nothing without it. Same trap §2 already documents for
  `#lesson-loading` — check for a competing explicit `display` rule
  before assuming `hidden`/`.hidden` alone will work on any new element
  here.
- **Student search is a live, filter-independent autocomplete dropdown**
  (`renderHomeSearchResults()`/`handleHomeSearchKeydown()`/
  `selectHomeSearchResult()`), not a single-match Enter-to-jump input.
  An earlier version jumped straight to whichever student's name
  happened to sort first among substring matches (typing "rio" silently
  opened "Briones" instead of the "Rio Onda" a teacher actually meant,
  with no way to pick the other) — this shows every match as a clickable
  row (arrow keys + Enter also work) and never navigates on typing
  alone. It also searches the **full active `roster`**, not
  `lastStudentSummaries` (which is already scoped to the current Grade/
  Teacher filter, so a student outside that filter used to be invisible
  to search) — `selectHomeSearchResult()` widens `currentGradeFilter`/
  `currentTeacherFilter` to include whoever gets picked, calls
  `populateFilters(); renderAll();`, then looks them up in the freshly
  rebuilt `lastStudentSummaries` before opening their detail view.
  **Rule**: any future rewrite of this search must keep reading from
  `roster` (not a filter-scoped list) for the candidate set — that's
  the actual fix, not the dropdown UI on its own.
- **`openExportPreview()`** — "Export CSV" (in the always-visible filter
  bar, not Home-specific) no longer downloads immediately; it shows a
  modal naming the current Grade/Teacher filter, the exact student/row
  count `filteredRows()` will export, and the full `EXPORT_COLUMNS`
  list, with "Download CSV (N)" calling the original
  `exportGradebookCsv()` only once confirmed. Built/torn down on demand
  (`#export-preview-backdrop`, closed by its own Cancel button,
  clicking the backdrop, or Escape) rather than static markup, same
  pattern as every other on-demand overlay on this page.
- **`projects-dashboard.html` was checked and doesn't need this** — it
  has no tab bar at all (`.section-title`-separated sections on one
  scrollable page, `<details>` for Deliverables), so there's no "which
  of several tabs has what I want" problem for a Home-style landing
  screen to solve there.

### The three real destinations (plus two drill-in-only views)
**Never re-introduce a fourth top-level quick-switch button** as the
default way to add a capability — it belongs inside one of the three
real destinations as a new sub-tab (`switchSubTab(panelId, subId)`,
scoped via `:scope` to one panel's own `.sub-nav`/`.sub-panel`) or a
new drill-in link, or is a sign it needs its own separate product
decision. The four original panel ids still exist internally
(`overview`/`unit-lesson`/`students`/`integrity`) — only `unit-lesson`
is drill-in-only with no quick-switch button of its own.

1. **My Class** (panel id `overview`) — leads with `renderOverviewAttention()`'s
   four "needs a look" cards (Flags to review, Stalled/not-started,
   lowest average score by activity, lowest average score by student —
   each linking straight into the view with the full detail) before a
   compact four-tile stat strip (Active students, Activities, Average
   score, Avg Effort Score Index). The full chart set (Progress by unit,
   the two lowest-score bar charts, the "When students work" histogram)
   lives inside a closed-by-default `<details class="overview-more">`
   — still there, just not competing with the attention cards for
   attention on first look. Two `.drilldown-links` buttons ("See full
   breakdown by unit/activity") route into the panel below. No
   individual-student list or raw event feed here — those live in
   per-student/per-activity detail views instead.
2. **Students** (panel id `students`) — one list, `renderByStudent()`,
   one row per roster student including zero-`Progress` students.
   Columns: Grade, Student, Teacher, Activities started, Avg score,
   Lesson Completion % (`computeStudentUnitCompletion()` — a
   **different** metric from `completionPct` above: per-student
   per-unit "what fraction of this student's own wired units are they
   done with," not roster-wide participation), Flags, Last activity
   (reads "Stalled - Nd" past `STALLED_DAYS`). **Effort Score Index and
   Attempt-2 Recovery Index are deliberately not roster columns** — a
   10-column table was hard to scan at a glance, and both numbers are
   still shown (unchanged) inside `openStudentDetail()`'s own stat
   rows, one click away; a one-line hint above the table says so
   explicitly rather than silently dropping them. **Rule**: don't
   re-add a metric to this table just because it used to be there —
   check whether it's already surfaced in the detail view first, and if
   so, a table column is usually redundant, not a restoration.
3. **Flags to Review** (panel id `integrity`) — **Flags & Behavior**
   (`renderIntegrityMonitor()` + `renderIntegrityScatter()`
   time-on-task-vs-score SVG scatter) is the sub-tab shown by default
   and the one the section title/quick-switch button both name; the
   other two sub-tabs render with `.sub-tab-btn.secondary` (visually
   lighter, not equal-weight) since they're supporting drill-ins, not
   the destination itself:
   - **Engagement Funnel** (`computeActivityStatusBreakdown()`/
     `progressStatus()`: Not started / Opened only / In progress /
     Completed-Passed / Completed-Locked Out — the five-state read of
     "is this being opened, and are they passing it," replacing the old
     `AccessLog`-based Access Log tab which is gone entirely).
   - **Full Submission Log** (`renderAllSubmissions()`, the original
     flat table, kept as the detail layer everything else summarizes
     from — the one view that still uses inline-expand `toggleDetail()`
     instead of a separate detail pane).

**Drill-in only, no quick-switch button:**

- **Unit & Lesson Deep Dive** (panel id `unit-lesson`) — sub-tabs **By
  Unit** (`computeUnitSummaries()`, groups `computeActivitySummaries()`'s
  own numbers, so it can't disagree with By Activity) and **By
  Activity** (`computeActivitySummaries()`; includes zero-submission
  activities; completion % against eligible roster). By Activity's
  detail view includes "Item Diagnostics, lite"
  (`computeDistractorAnalysis()`/`distractorAnalysisHtml()` — most
  common wrong answer per item, only for items with 2+ wrong attempts;
  free-text bucketing, not structured multiple-choice analysis). Reached
  from My Class's own `.drilldown-links`, Home's secondary row, or
  directly (`switchDashTab('unit-lesson')` + `switchSubTab(...)`).

### Shared conventions across the four content panels
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
  for a scoped account. **The Grade pill row is built from `roster`
  alone, never from `activityCatalog`.** `ActivityCatalog` always lists
  every track (6/7/7-Honors/8/8-PreAP) regardless of who's actually
  enrolled — an earlier version folded its grades into the pill set too
  (to fold a shared row's comma-separated `Grade` cell into the right
  pills), which meant a teacher with only 6th-grade students still saw
  all 5 grade pills. A roster student's own `Grade` cell is always a
  single value (only `ActivityCatalog.Grade` is ever comma-widened for
  a shared activity — see §11), so no splitting is needed on the
  roster side. `projects-dashboard.html`'s own copy of
  `populateFilters()` had the identical bug and got the identical fix.
- **Activity filter** is a multi-select checkbox popover
  (`currentActivityFilter` is an array), not a pill row or `<select>`.
  `renderActivityOptions()` groups the popover's option list by Unit
  (`activityUnitByTitle`, a title → Unit map rebuilt alongside
  `availableActivityTitles` in every `populateFilters()` call) via a
  `.multiselect-group-label` divider row per unit — a flat alphabetical
  list of a dozen+ activities was hard to scan even after the Grade
  filter narrowed it down. The "no catalog data" fallback (activity
  titles pulled from `allRows` instead of `activityCatalog`) has no Unit
  to offer, so those bucket under "Unassigned."
  - **`.multiselect-toggle`'s width is `min-width`+`max-width` set to
    the same `350px`, not just `max-width` alone.** A `<button>` sizes
    to its own content by default — an earlier version only raised
    `max-width` (220px → 550px), which did nothing for the common short
    "All Activities" label (a `max-width` can only ever shrink a box,
    never grow one past its content) and rendered no wider than before.
    `min-width` is what actually forces the box open regardless of what
    it currently says. **350px, not the full ~2.5x of the original
    220px `max-width`**, because `.app-container` caps at `1200px`
    site-wide (`lesson-shared.css`) — past ~400-420px the Grade pills +
    a wider Activity toggle + the Flagged-only checkbox + Export CSV/
    Refresh no longer fit on one line for a scoped (single-Teacher)
    account, which is the common case; 350px was measured to clear that
    with margin. An unrestricted "All"-scope account with several
    Teacher pills at a narrow viewport can still wrap the buttons to a
    second line — the same graceful-overflow behavior (`.filter-bar`'s
    own `flex-wrap`) the bar already had before any of this, not a
    regression. **Rule**: before widening any filter-bar control
    further, measure against the 1200px cap (`getBoundingClientRect()`
    on `.filter-bar`'s own children) rather than assuming more room is
    available just because the viewport is wider — the viewport stops
    mattering once `.app-container`'s own max-width is reached.
  - **Clicking a Grade/Teacher pill never closes an already-open
    Activity popover.** The generic "close on any outside click"
    listener explicitly exempts `.filter-pill` targets
    (`!e.target.closest('.filter-pill')`) — a pill is technically
    outside `#activity-multiselect`, and closing the popover the
    instant one was clicked hid the very re-narrowing
    (`populateFilters()` → `catalogForGrade` → `availableActivityTitles`)
    that click had just correctly triggered, reading as "the grade
    filter isn't doing anything" when it silently was. Keeping the
    popover open lets a teacher watch the option list actually narrow
    in place.
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

**Closed**: `Lessons/Projects/*` — all three folders — remains on its
own older, unmigrated pattern (its own per-project `SHEET_API_URL`
instead of the shared Sheet/Apps Script backend), completely untouched.
**Don't extend it and don't hold it to any rule in this file.** All
three now have a shared-backend, paired-activity **port** alongside the
original as a separate page, built new rather than by editing the
original (§18): `Sixth/Laudato-Si-EcoGarden/index.html` (the canonical
example), `Seventh/Ethical-Auditor-Community-Engineer/index.html`
(`7-ethical-auditor-community-engineer`, standards `7.NS.A.1b, 7.NS.A.1c,
7.NS.A.1d, 7.NS.A.2a, 7.NS.A.2b, 7.NS.A.2c, 7.NS.A.2d` — matches
Rational-Numbers, since the project is entirely positive/negative
rational-number budgeting), and `Eighth/Youth-Festival-Logistics/index.html`
(`8-youth-festival-logistics`, standards `HSA.CED.A.1, HSA.REI.A.1,
HSA.REI.B.3` — matches Linear-Equations, since its content is
single-unknown algebraic equation solving, not inequalities). A fourth
activity, `Eighth/Ethical-Linear-Budgeting/index.html`
(`8-ethical-linear-budgeting`, standards `HSA.CED.A.2, HSS.ID.C.7,
HSF-IF.A.1, HSF-IF.B.5, HSF-LE.A.2` — matches Linear-Functions, since
the project models a charity's budget with `f(x) = mx + b`), sits on
this exact same shared-backend paired pattern but is **not** a port of
any `Lessons/Projects/*` original — it's a brand-new 8-PreAP build from
a teacher-supplied brief, using Ethical-Auditor's mechanical skeleton as
its template (see §18's own paragraph for the full breakdown). **All
four are deliberately not in `index.html`'s `CURRICULUM`** —
direct-link-only, same access-control choice as Eco-Garden, for the
same reason (see §12) — don't add a `CURRICULUM` entry for any of them
without asking first.

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

---

## 18. Paired/team activities

A paired activity is two students working one shared activity together
on the same one backend as everything else in §1 — no second Sheet, no
second Apps Script deployment. One student is the **Driver** (types
answers, drags/builds things, submits); the other is the **Navigator**
(read-only — sees the same progress mirrored to their own screen, can
navigate tabs, can never answer or edit). Pairing is **teacher-assigned
in the Sheet only** — there is no in-app "invite a partner" flow, and a
pair's role never changes itself; only a teacher can remove one (see
"Unpairing" below). Mirroring is **refresh-based, not live** — same
"no push/websocket, retrospective only" principle as §8's engagement
tracking; a Navigator sees the Driver's latest saved state on their own
next page load/reload, not instantly as the Driver types.

**Canonical example**: `Sixth/Laudato-Si-EcoGarden/index.html` — a
2-day STREAM project (decimal rounding/exact operations on a store
ledger, then a Konva.js canvas garden-layout builder and sign studio).
It is a from-scratch port of `Lessons/Projects/Laudato-Si-EcoGarden/index.html`
(the older, separate `SHEET_API_URL` pattern — see §1) onto this
backend, built as a **new file**; the original under `Projects/` is
untouched and stays on its own pattern per §1/§17. Its identity/save
layer changed (`gradeAttempt()` and `restoreState()`'s body are
otherwise unchanged from the original, since neither needed to know
pairing exists at all), plus one deliberate content fix carried only on
this copy: `lockGarden()`/`lockSign()` originally allowed locking with
zero real effort — `seedDefaultSignElements()` pre-seeds one default
text element on load, satisfying `lockSign()`'s only guard
(`signElementNodes().length >= 1`) before a student touches anything,
and `lockGarden()` never checked how many of the loaded items were
actually placed. Both now require genuine engagement before allowing a
lock: `lockGarden()` requires every purchased item to be placed
(`placedCount === tokens.length`, using the existing `#garden-lock-msg`
element for the blocking message); `lockSign()` blocks only the exact
untouched-starter state (still 1 element, still the literal default
text, still the default `wood` material with no accent color) via
`LessonCheck.incomplete()`, so any genuine edit, addition, or
material/color change passes normally. **Rule**: if a future project
reuses this "lock in your creative work" pattern, check whether its own
completion guard is similarly satisfied by a pre-seeded default or an
empty-but-technically-valid state before assuming "at least one
element" is actually "did the work."

**Second port**: `Seventh/Ethical-Auditor-Community-Engineer/index.html`
follows the identical pattern (gate/auth in `<head>`, `SHEET_API_URL`/
`startTeam`/`fetchWithTimeout` replaced with `LessonSync.saveProjectState`/
`checkDay2Code`, `window.onLessonUnlock`/`lockForNavigator`/
`window.onTeacherUnlock` block at the end). Its own unlimited-attempt
helper is `gradeAttempt()`/`checkMC()` (not Eco-Garden's inline pattern,
but the same shape) — every `if (outcome === 'correct')` block that
disables a field is guarded with `!window.teacherPreviewMode`, exactly
like Eco-Garden's. It needed no Eco-Garden-style "genuine effort" fix —
its one free-form lock (`lockInfographicArt()`) already requires a typed
report title with nothing pre-seeded, so the existing guard was already
meaningful. Its top progress-bar "Print My Progress" button was removed
the same way Eco-Garden's was (the `printEngineeringReport()` function
itself is left in place, unused, matching precedent exactly rather than
deviating).

**Third port**: `Eighth/Youth-Festival-Logistics/index.html` follows
the same pattern again, including a second Konva.js canvas (the Event
Flyer Studio, analogous to Eco-Garden's sign studio) with the same
navigator-lockout treatment (`pointer-events: none` on
`#flyer-stage-container`/`#flyer-layers` under `.navigator-locked` —
the sticker picker is real `<button>`s, already covered by the generic
sweep) and the same genuine-effort fix: `seedDefaultFlyerElements()`
pre-adds one "Youth Festival" text node on load, so `lockFlyer()`
blocks locking the exact untouched-starter state (1 element, that
literal text, default `poster` material, no accent color) the same way
Eco-Garden's `lockSign()` does. **Deliberate refinement over the
Eco-Garden precedent**: Eco-Garden's own `lockSign()`/`lockGarden()`
apply for real even in Teacher Preview (a teacher can genuinely lock
the canvas there) — both this port and the Ethical-Auditor port instead
guard the lock itself with `!window.teacherPreviewMode`
(`applyFlyerLockedUI()` / `lockInfographicArt()`'s `infographicLocked`
line), so a teacher can keep re-designing after clicking "Lock" too.
Prefer this guarded version in any future port of this pattern.

**Fourth build (not a port)**: `Eighth/Ethical-Linear-Budgeting/index.html`
is the one activity in this family that isn't a port of an existing
`Lessons/Projects/*` original — there is no older, separate-backend
version of it anywhere. It's a brand-new 8-PreAP project built from a
short teacher-supplied worksheet brief (linear function budget modeling
for a charity: `f(x) = mx + b`, fixed cost as y-intercept, variable cost
as slope), using `Ethical-Auditor-Community-Engineer`'s mechanical
skeleton as its template (gate/pairing/Teacher-Preview/certificate+badge
canvas code/vocab match-up engine, and its SVG-based Infographic Studio
specifically — chosen over Youth-Festival's Konva canvas since there's
no drag-and-drop layout content here, only a poster). ActivityId
`8-ethical-linear-budgeting`; standards line reused verbatim from
`Eighth/Linear-Functions` (`HSA.CED.A.2, HSS.ID.C.7, HSF-IF.A.1,
HSF-IF.B.5, HSF-LE.A.2`) since the content directly reinforces that same
standard set. All content is new: 6-term Vocabulary Match-Up (Linear
Function/Slope/Y-Intercept/Function Notation/Fixed Cost/Variable Cost),
a food-bank linear-model station using a real `<math-field>`
(`f(x) = 2.5x + 1200`, read/compared via `readMathField()`/
`answerMatches()` exactly like `Eighth/Linear-Functions/Practice-Set.html`
— see §7's Math input section), evaluate/slope-intercept/eco-packaging
stations, two 4-and-3-item Mixed Practice sets, a renamed "Linear
Function Challenge" 2-column drag-match (5 scenario→function pairs,
replacing Ethical-Auditor's "Rational Number Challenge" engine
verbatim-but-renamed), an Engineering budget-structure-percent station,
a Math solve-for-x station, and a Technology "What-If Calculator"
station: an ungraded slider sandbox (still no `LessonCheck` call on the
slider itself) immediately followed by a genuine graded target question
— "drag the slider until the total reads $2,950.00 - how many meals is
that?" (`checkWhatIfTarget()`, key `whatiftarget`, `section: 'Day 2 -
What-If Calculator (Technology)'`) — that requires actually using the
tool rather than just reading a definition. **This activity is not a
grandfathered pilot** (see the standing rule in §18) and carries no
entry in `PILOT_PILLAR_GAPS` — every one of the six pillars has real,
correctly-tagged graded content, `whatiftarget` included in
`missingDay2Work()`'s gate alongside every other Day 2 station. The
Infographic Studio's two ledger-style cards were repurposed
from Ethical-Auditor's surplus/deficit framing into "FIXED COST"/
"VARIABLE COST" cards populated from `solvedKeys` instead. Certificate
citation is Luke 14:28 ("...does not first sit down and count the
cost?"), tying directly to the brief's own "Counting the Cost" framing,
in place of Ethical-Auditor's Matthew 25:21. `printEngineeringReport()`/
`attemptsText()` and the `<div id="print-report">` element were dropped
entirely rather than left as unused dead code (the only deliberate
deviation from the otherwise exact "leave the dead function in place"
precedent the other three ports follow — justified here because this
is a new build, not a literal port of an original that already shipped
with that function). `STREAM_PILLAR_RULES` (`teacher-dashboard.html`
and `projects-dashboard.html`, kept in sync — see below) gained three
more keywords this build needed to categorize its own section names:
`sustainab` (Science, for the eco-packaging/slope-change station's
`Day 1 - Sustainability` section), `charity` (Religion, for the
`Day 1 - Research` station), and `model`/`solv` (Math, for
`Day 1 - Linear Model`/`Day 2 - Solving for Meals`) — same "widen when a
new project's sections don't hit the existing keywords" precedent as
the `flyer`/`optimization` additions below (that pass also caught
`teacher-dashboard.html`'s own copy of `STREAM_PILLAR_RULES` having
drifted out of sync with `projects-dashboard.html`'s, missing both
`flyer` and `optimization` — now reconciled, both files carry the
identical array again).

### Two new Sheet tabs (both optional — every function below degrades
to a no-op/null when the tab doesn't exist yet, so an activity with no
pairing is completely unaffected)
- **`Pairs`** — `Email, PartnerEmail, ActivityId, Role, TeamId`. `TeamId`
  is the newest column (optional — every function that reads it degrades
  cleanly to the original 2-person behavior when the column doesn't
  exist at all, or a row's own cell is blank). Two shapes, chosen per
  row:
  - **Blank `TeamId` (a classic 2-person pair)** — unchanged from the
    original design. One row **per student**, a pair is two rows, not
    one (Alex's row names Sam as `PartnerEmail` with `Role` = `Driver`;
    Sam's row names Alex back with `Role` = `Navigator`).
  - **`TeamId` set (a 3+-person team)** — one row **per student**, all
    sharing the exact same `TeamId` value for that `ActivityId`
    (`PartnerEmail` is ignored/blank on these rows — teammates come from
    the shared `TeamId` instead). One `Driver`, the rest `Navigator` —
    nothing caps the group size at 3; a 4th or 5th row with the same
    `TeamId` works identically at the backend/dashboard level, though no
    paired page's own UI has been exercised past 3.
  `Role` is matched case-insensitively (`normalizeRole_`
  lowercases/trims); `Email`/`PartnerEmail` are matched via
  `normalizeEmail_` too, since a teacher's hand-typed `PartnerEmail`
  cell won't always match Google's own token-reported casing for that
  student's future sign-ins exactly — this is also why
  `getOrCreateProgressRow_`/`recordSubmission_`'s own Email row-matching
  was hardened from strict `===` to `normalizeEmail_`-based comparison
  (broadening-only, every existing non-paired activity matches exactly
  as before).
- **`ProjectState`** — `Email, ActivityId, StateJSON, UpdatedAt`. Free-
  form app-state storage (a canvas layout, a cart, anything that
  doesn't fit the per-item `SubmissionsLog` model) — upsert-only, one
  row per (student, activity), **never** written into `Progress`/
  `SubmissionsLog` itself. Used by any activity calling
  `LessonSync.saveProjectState(stateJson)`, paired or not — pairing and
  free-form state storage are two independent, separately-optional
  capabilities that happen to be used together on the canonical
  example.

### Backend mechanics (`Code.gs`)
- `getTeammates_(email, activityId)` — the one place group membership is
  actually resolved. Returns every OTHER student on this one's team, as
  `[{email, role}, ...]`: for a blank-`TeamId` row, a real second lookup
  of the partner's own row (so their real `Role` comes back correctly,
  never assumed as "whatever role I'm not"); for a `TeamId`-set row,
  every other `Pairs` row sharing that exact `TeamId` + `ActivityId`.
  `getPairingWithPartnerName_` (the `access-check`-facing version) calls
  this and resolves each teammate's real `StudentName` from `Roster`.
- `access-check`'s response gains two optional fields, both `undefined`
  (dropped by `JSON.stringify`, so every existing page's response shape
  is byte-for-byte unchanged) unless the signed-in student has a `Pairs`/
  `ProjectState` row for this activity: `pairing: {role, partnerEmail,
  partnerName, teammates}` and `projectState` (the raw `StateJSON`
  string, or `undefined`). `teammates` is the new, general array (1
  entry for a classic pair, 2+ for a team); `partnerEmail`/`partnerName`
  stay as the **first** teammate, kept only so a paired page written
  before `teammates` existed — and reading only these two fields — still
  shows *a* real partner instead of breaking; a page updated to show
  every teammate reads the array instead (see the four existing paired
  pages' own `window.onLessonUnlock` for the pattern).
- `submission` and `project-state-save` (new request type, mirrors
  `submission`'s shape) both: (1) reject a Navigator's own write
  server-side — `{ok:false, error:"..."}` — **defense in depth**, since
  a Navigator's inputs/buttons are already disabled client-side and
  never call `LessonCheck.check()`/`.submit()`/`saveProjectState()` in
  the first place, but the backend never trusts the front-end's claimed
  role any more than it trusts its claimed identity (§2); (2) on a
  Driver's successful write, mirror the identical item/state onto every
  teammate's own `Progress`/`ProjectState` row (looped over
  `getTeammates_()`'s result — 1 partner for a classic pair, 2+ for a
  team) via `mirrorSubmissionToPartner_`/a second `saveProjectState_`
  call per teammate — each teammate keeps their own normal row, so the
  dashboard, `decorateRow()`, scoring, and every other per-student view
  work completely unchanged for a paired/team student. Nothing about
  §5's "the record argument is what saves it" rule changes — a paired
  page's check functions still call `LessonCheck.check()`/`.submit()`
  exactly as any other page's would; mirroring happens entirely
  server-side, after the normal save. **Known interaction, not a bug**:
  since every teammate's `SubmissionsLog` ends up with byte-identical
  mirrored entries, a wrong answer on a paired/team activity will
  always also trip `teacher-dashboard.html`'s "Possible shared answers"
  duplicate-detector (§8) against the teammate(s) it mirrored to — that
  flag is designed to catch two *independent* students converging on
  the same wrong answer, and can't currently tell that apart from a
  mirror of its own making; read a paired/team row's flags with that in
  mind rather than as evidence of anything suspicious.
- `check-day2-code` — read-only, no lock, for an activity that wants
  the original "teacher gives a short passcode to unlock day 2" UX
  instead of (or alongside) a graded gate. Compares against that
  activity's own `ActivityCatalog.Day2Code` cell (a new, optional
  column — blank for every activity that doesn't use it, including
  every pre-existing row). `LessonSync.checkDay2Code(code)` is the
  client-side call.
- `teacher-unpair` — teacher-only, dashboard-only, removes **this one
  student** from their pairing (`unpair_()`) so a teacher can re-pair
  them (an absent partner/teammate, or the wrong student added to a
  team by mistake). Two different scopes depending on that student's
  own row: a `TeamId`-set row removes only that student's own row
  (every remaining teammate's own teammate list shrinks automatically
  via `getTeammates_()` — no cascade, a trio just becomes a pair); a
  blank-`TeamId` row still removes **both** sides symmetrically, exactly
  as the original design did, since each side's row references the
  other directly via `PartnerEmail` and leaving one behind would dangle
  that reference. Reuses `isTeacher_`/`getTeacherScope_`/
  `getScopedEmailSet_` — a scoped teacher can only unpair their own
  students. Not live — the freed student(s) just have no `Pairs` row (or
  one fewer teammate) on their next page load, and a student with none
  left is treated exactly like "never paired" (see below). Removing a
  pairing never touches `Progress`/`SubmissionsLog`/`ProjectState` —
  everything already mirrored stays exactly as it was.
- `teacher-data`'s response gains `pairs: getPairsForDashboard_(emailSet)`
  — every `Pairs` row for the scoped teacher's own students (or every
  row, unrestricted scope), same shape as one `Pairs` Sheet row, now
  including its `teamId` (`''` for a classic pair or a pre-`TeamId`
  sheet).

### Client-side mechanics
- **`window.onLessonUnlock(result)`** — a new, optional hook in
  `lesson-auth.js`'s `proceedWithToken()`, called once right after the
  existing `unlock(student, progress)` call succeeds for a **student**
  (a teacher never reaches it — see `window.onTeacherUnlock` below for
  the teacher-side equivalent hook). `undefined` on every page that
  doesn't define it — a no-op everywhere else on the site. A paired/
  project page defines it to read `result.pairing`/`result.projectState`
  and apply whatever its own page needs (restore free-form state, lock
  out a Navigator) — see the canonical example's own handler for the
  full pattern. **All four existing paired pages' handlers read
  `result.pairing.teammates`** (1 entry for a classic pair, 2+ for a
  team) to build their `pairing-status` text — a `teammates.length > 1`
  branch renders `"Team: <name> (<role>), <name> (<role>), ..."`
  instead of the single-partner `"Partner: <name> (<role>)"` line. The
  hidden `team-name-2` field still only ever holds the **first**
  teammate's name (kept only for a page reading it directly, e.g.
  Teacher Preview); a third, `team-name-3`, holds the **second**
  teammate's name when one exists. **The certificate/stamp/badge
  renderers now support 3+ names** — `window.allTeamNames` (set here,
  right alongside `team-name-2`/`team-name-3`) is `[selfName, ...every
  teammate's name]`; `getAllTeamNames()` (falls back to the three hidden
  inputs for Teacher Preview, which sets those directly and never calls
  this hook) and `joinNames()` (Oxford-comma-style: `"A"` / `"A & B"` /
  `"A, B & C"`) are the two small helpers every one of
  `downloadCertificate()`/`downloadSoloBadge(memberNum)`/
  `downloadStamp()` on all four paired pages now goes through instead of
  reading `team-name-1`/`team-name-2` directly. The certificate's name
  line shrinks its own font (34px down to a 22px floor, `ctx.measureText`
  against the canvas's own fixed width) so three names don't overflow —
  a per-line adjustment, every other line's size is untouched. A 3rd
  **and 4th** "Download Badge - Team Member N" button exists on every
  page, both `hidden` by default, unhidden here only when
  `teammates.length > 1` (3rd) / `teammates.length > 2` (4th) — a real
  3-/4-person team — `downloadSoloBadge(3)`/`downloadSoloBadge(4)` read
  the same `getAllTeamNames()` array, so neither needs any
  special-casing beyond its own button's visibility. **The
  reconstruction path (`window.onTeacherUnlock`'s `pendingView` branch —
  see above) toggles both buttons too**, from `pendingView.teammates
  .length` — this was missed on the first pass (only the live
  `onLessonUnlock` path toggled them), so a teacher opening a real
  trio/quad's saved work via "Open & download real files" couldn't
  reach member 3/4's own badge; fixed before it shipped. **Still not
  done**: no 5th+ button — extend the identical pattern (one more
  hidden button in the markup + a `teammates.length > 3` check in
  *both* `onLessonUnlock` and the `pendingView` branch, in all four
  files) if a 5-person team is ever actually used. The certificate/
  stamp already scale to any team size with no changes needed.
- **`window.onTeacherUnlock(result)`** — a second, separate optional
  hook, called instead of the generic `unlockTeacherView()` (§6) when a
  **teacher** signs in, if the page defines it. Exists for a page where
  §6's "fill every answer, then lock everything" behavior is wrong for
  the content — a project has no single fixed answer key (it varies by
  what a team bought/built), so a teacher instead wants **unrestricted
  free play**: both days unlocked immediately (no typed passcode, no
  Day-1-first gate), fields that never lock even after a correct
  answer, and nothing saved. `undefined` on every page that doesn't
  define it, so `unlockTeacherView()` runs exactly as before everywhere
  else. Saving needs no separate guard — `lesson-auth.js` calls
  `showAppContainer()` (never `unlock()`) ahead of this hook, so `ready`
  stays `false` and `LessonProgress.record()`/`LessonSync.saveProjectState()`
  already no-op on their own existing `!ready` check. **Locking does**
  need an explicit guard, since it's driven by each check function's
  own local `if (outcome === 'correct')` block, never by anything
  `ready`-gated — the canonical example sets a page-local
  `window.teacherPreviewMode = true` flag in its `onTeacherUnlock` and
  every such block checks it before disabling a field, while still
  setting the same internal tracking flags (`roundLocked`, etc.)
  unconditionally, since those also gate downstream button enablement
  (an Estimated Total check's button, say) unrelated to whether the
  field itself stays editable. A page can optionally expose its own
  "Show the Method Guide"-style toggle for the **formulas** behind each
  check (never live numbers, since there's no fixed answer to reveal) —
  see the canonical example's `toggleEcoGardenMethodGuide()`.
- **`LessonSync.saveProjectState(stateJson)`** / **`LessonSync.checkDay2Code(code)`**
  — the two generic helpers exposed alongside `LessonSync.init`, for
  exactly the two new request types above. Both no-op/fail gracefully
  if called before sign-in resolves; both keep `idToken` inside
  `lesson-auth.js`'s own closure, so a page can't build a competing
  request shape against it.
- **Navigator lockout is client-side UX only** (the backend rejection
  above is the real boundary) — the canonical example's
  `lockForNavigator()` disables every `<input>`/`<select>`/`<textarea>`/
  `<math-field>` and every `<button>` whose `onclick` doesn't match
  §6's `SAFE_ONCLICK` list (so tab navigation and Print still work),
  then adds a `navigator-locked` class to `.app-container`. A page with
  raw-pointer surfaces that sweep can't reach — native HTML5
  drag-and-drop, a Konva canvas, a click-driven tray/pool of items —
  adds a page-local CSS rule scoping `pointer-events: none` to just
  those containers under `.navigator-locked`, rather than touching the
  drag/canvas code itself. **Never gate a Navigator by reusing an
  activity's own "this section is finished" lock flag** (e.g. forcing
  `day1Locked`/`gardenLocked` true) — that would misrepresent the
  Driver's real progress to anything reading those flags; gate on
  `pairing.role === 'navigator'` directly instead.
- **No pairing row is a fully supported, non-error state** — a signed-in
  student with no `Pairs` row for that activity (not yet paired by the
  teacher, or just unpaired) is treated as a **solo Driver**: full
  read/write access, its own `Progress`/`ProjectState` row, nothing
  lost once the teacher does pair them later. A page should say so
  plainly (see the canonical example's `pairing-status` text) rather
  than erroring or blocking.

### Teacher dashboard
- `allPairs` (populated from `teacher-data`'s new `pairs` field) is
  looked up per detail row via `pairingForRow(r)` — matches on
  `r.email`/`r.activityId`, same key shape as a `Progress` row.
  `teammatesForRow(r)` builds on top of it, mirroring `Code.gs`'s
  `getTeammates_()` client-side: a blank `teamId` returns that row's own
  `partnerEmail` (with their real role looked up from *their* own
  `allPairs` row, never assumed); a set `teamId` returns every other
  `allPairs` row sharing that exact `teamId` + `activityId`.
- `submissionDetailTable(r)` (Students' own per-student detail rows,
  By Activity's per-student rows, Full Submission Log — same
  shared function as §9/§13) prepends a "Paired activity" block — role
  pill, every teammate's name + role (`teammatesForRow(r)` +
  `partnerNameFor()`, resolved from `roster` — "Partnered with `<name>`"
  for exactly one teammate, "Team with `<name> (<role>)`, ..." plus a
  "(team of N)" note for 2+), and an **Unpair** button
  (`teacherUnpair(email, activityId, btn)`) — whenever a pairing exists
  for that row, **before** the "no graded items logged yet" early
  return, so it still shows even if the Driver hasn't submitted
  anything yet. Nothing renders for a non-paired row — `allPairs` is
  `[]` for every activity/teacher with no `Pairs` tab rows at all.
  `teacherUnpair()`'s confirm dialog and its own optimistic `allPairs`
  update both branch on that student's own `teamId` too, matching
  `unpair_()`'s server-side branch exactly (remove only this row for a
  team, both sides for a classic pair) — never assume symmetric removal
  once `teamId` support exists.
- **`allProjectStates`** (populated from `teacher-data`'s new
  `projectStates` field, backed by `Code.gs`'s
  `getProjectStatesForDashboard_`) — every `ProjectState` row the scoped
  teacher can see, `{email, activityId, stateJson, updatedAt}`. `[]` for
  every teacher/activity with no `ProjectState` tab rows, same
  degrade-to-no-op pattern as `allPairs`.
- **Project Insights** — `projectInsightsHtml(a)`, appended to By
  Activity's detail view (`openActivityDetail`) right after the
  per-student attempts table. Detected generically, never by hardcoding
  an `activityId`: `looksLikeProject(rows)` checks whether any row's
  final answer for some item matches the `" - N attempt(s)"` suffix
  `gradeAttempt()` itself embeds on a correct answer — so any future
  page reusing that same unlimited-attempt pattern (§10's "Per-unit
  reference" doesn't cover project-shaped pages) gets this panel for
  free, and every ordinary graded page (which never produces that
  suffix) renders nothing here. Three cards:
  - **Attempts to reach the answer** — average attempts/item and total
    items solved across every student on this activity, plus a ranked
    table (`computeAttemptInsights`) of the items with the **highest
    average attempts** (top 5) — the ones worth reinforcing with the
    whole class, each item's own final attempt count parsed straight
    from its answer text (`parseAttemptCount`), no new instrumentation.
  - **STREAM pillar progress** — `computeStreamPillarBreakdown` tags
    each graded item's `section` against `STREAM_PILLAR_RULES` (keyword
    match, e.g. `/math|ledger|budget|division|decimal/i` → `Math (M)`),
    then reports students-with-activity and item-completion % per
    pillar it actually found. A pillar with zero matching sections
    normally simply doesn't appear — never padded with a fabricated
    0% — **except** for a pillar/activity pair listed in
    `PILOT_PILLAR_GAPS` (see "Pilot projects' by-design pillar gaps"
    below), which appears anyway, pinned to 100% with a badge marking
    it as intentionally content-free rather than a real measurement.
    **A pillar's completion % counts
    a `'correct'` verdict *and* a `'reflection'` verdict as done** — a
    pillar measures engagement with that STREAM area, not
    right-vs-wrong, and a project's own creative/reflective checks
    (Garden Grid Layout, Creation Sign, an Infographic/Flyer lock, a
    real reflection question) are genuinely un-gradeable
    `LessonCheck.submit()` calls with no `correct` field, which always
    log as `'reflection'` (§8's scoring formula still excludes
    `'reflection'` from `ItemsAttempted`/`ItemsCorrect`/`ScorePct` —
    that's a different, unchanged metric measuring being right, not
    having done the work). Before this rule only counted `'correct'`,
    so a project's own creative/reflective checks could never
    contribute to their pillar's percentage even when every student had
    genuinely submitted them — caught migrating pre-existing Eco-Garden
    data where every team had completed the Garden Layout/Creation Sign
    steps but those pillars still read 0%.
  - **A certificate/badge download never counts toward a pillar, even
    though it also logs verdict `'reflection'`.**
    `isCelebrationDownloadKey(key)` (`key === 'certificate-download'` or
    `/^solo-badge-\d+$/`) is checked before `pillarsForSection()` in
    `computeStreamPillarBreakdown()` and skips the entry entirely — a
    certificate/badge download is a one-click reward available once a
    team has already finished everything else, not itself STREAM work,
    so it shouldn't inflate whichever pillar its section (`Day N -
    Celebrate`, which the Religion regex also happens to match via
    `celebrate`) would otherwise tag it under. **Rule**: never let a
    celebration/download action be the only thing backing a pillar's
    number — a pillar with only a download behind it should read "No
    data yet," not a percentage that isn't really measuring the pillar
    it claims to. A project's *real* Religion-pillar content is its own
    separate reflection question or cross-pillar creative check (see
    the next bullet) — `Sixth/Laudato-Si-EcoGarden`'s is its Creation
    Sign check, not the certificate download.
  - **One item can count toward more than one pillar.**
    `pillarsForSection(section)` returns *every* `STREAM_PILLAR_RULES`
    match for that section string, not just the first — `computeStream
    PillarBreakdown()` then credits the same submission's
    attempted/correct tally to each pillar it names. Most sections
    still only ever match one rule; a genuinely cross-pillar task
    should say so in its own `section` string so both rules fire.
    `Sixth/Laudato-Si-EcoGarden`'s Creation Sign check is the working
    example: the page's own heading and instructions already call it
    "Art & Religion: Creation Sign Studio" and include a real verse
    picker (`#sign-verse-select`/`VERSES`, e.g. Psalm 104:24) a student
    inserts before locking it in — the `LessonCheck.submit()` call's
    `section` was `'Day 2 - Creation Sign'` (Art only, via `sign`) even
    though its own `label` already said `'Creation Sign (Art &
    Religion)'`. Widened to `'Day 2 - Creation Sign (Art & Religion)'`
    so the section string itself matches both the Art regex (`sign`)
    and the Religion regex (`religion`), and the dashboard's tagging
    finally agrees with what the page already told the student.
    **Rule**: when a check's own `label` already names two pillars,
    make sure its `section` string contains a keyword for each one too
    — a `label` is display-only and never reaches
    `pillarsForSection()`, only `section` does.
  - **Pilot projects' by-design pillar gaps read as 100% + a badge, not
    "No data yet."** The three STREAM ports (Eco-Garden, Ethical-
    Auditor, Youth-Festival-Logistics) shipped with real students
    already using them before every pillar had graded content behind
    it — retrofitting new content onto work students already completed
    doesn't make sense, so `PILOT_PILLAR_GAPS` (`teacher-dashboard.html`
    and `projects-dashboard.html`, kept in sync by hand like
    `STREAM_PILLAR_RULES`) lists each activityId's known, deliberate
    no-content pillars: Technology (an ungraded "what-if"-style sandbox
    tool) on all three, plus Science specifically on Eco-Garden (no
    Science station exists on that unit at all). A pillar on this list
    renders 100% with a "Pilot - no content" pill
    (`teacher-dashboard.html`'s Project Insights table) or a dashed
    "100%\*" chip / dashed muted ring (`projects-dashboard.html`'s
    per-project chips and STREAM hero, via `pilotGapInfo()`) instead of
    a real percentage or "No data yet." **`PILOT_PILLAR_GAPS` is closed
    to exactly these three activityIds** — never add a fourth, including
    a future project or `Eighth/Ethical-Linear-Budgeting` (8-PreAP,
    which is *not* on this list — see below and the standing rule that
    follows it). Every other pillar on these three activities has real
    graded content correctly tagged (see the retagging fixes below) —
    Technology (and Science on Eco-Garden) are the only pillars
    anywhere on the site that use this exception.
  - **Retagging fixes that closed every other pillar gap on the three
    pilot ports, plus a real Technology item added to Ethical-Linear-
    Budgeting** — the pilot retags were all real, already-existing
    content whose `section` string just didn't contain a
    `STREAM_PILLAR_RULES` keyword yet; no new questions were needed on
    any of the three ports. `Seventh/Ethical-Auditor-Community-
    Engineer`: Ledger Audit items → `(Science)`, Sustainable Center
    Budget items → `(Engineering)`, the Stewardship reflection →
    `(Engineering)`. `Eighth/Youth-Festival-Logistics`: the booth-size
    items (Stations 4A/4B) → `(Engineering)`, the electrical-load items
    (Stations 5A/5B) → `(Science & Engineering)` — split out of the
    plain Math-only Logistics Stations section; the ticket/break-even/
    vendor-hours items stay Math-only. `Eighth/Ethical-Linear-Budgeting`
    (8-PreAP, not a pilot and not on `PILOT_PILLAR_GAPS` — real students
    hadn't used it yet when this was found, so it's held to the full
    standing rule below, no exception): the Option for the Poor item →
    added `(Religion)` alongside its existing Science tag (the item is
    genuinely a Catholic-Social-Teaching critical-thinking question, not
    Science, even though it sits in the Sustainability station), the
    budget-structure item → `(Engineering)` (was matching Math only via
    the literal word "budget"), both Mixed Practice sets → `(Math)`
    (the bare "Mixed Practice" section name matched nothing at all),
    and — since the What-If Calculator itself had no graded content to
    retag — a genuine new graded item, `checkWhatIfTarget()` (key
    `whatiftarget`, `section: 'Day 2 - What-If Calculator (Technology)'`,
    added to `missingDay2Work()`'s Day 2 completion gate), that requires
    dragging the slider to a specific target total and typing the
    resulting number of meals. After these fixes, Ethical-Linear-
    Budgeting has real, correctly-tagged graded content behind all six
    pillars with zero exceptions — verified live via Playwright (the
    check records the right key/section/verdict, and the dashboard's
    STREAM pillar table shows a real 100% for every pillar, no pilot
    badge on any of them).
  - **Deliverables** — `deliverableSummaryHtml(email, activityId)` reads
    that student's own `ProjectState.StateJSON` (**not**
    `SubmissionsLog`) and renders whichever of `cartOrder`/`grandTotal`/
    `tokens`+`gardenElements`/`sign` fields are present, defensively
    (every field optional — `StateJSON`'s shape is whatever that
    specific project's own `buildStatePayload()` produces, never
    standardized across projects), plus an **"Open & download real
    files"** button (see below) next to the text summary.

**Getting a student's actual, full-resolution deliverable (not a
stored copy).** The certificate/badge/garden/sign/flyer/infographic a
student downloads is never a stored image anywhere — the download
button re-renders it live, in the browser, from the same state
variables (`cartOrder`, `tokens`, `gardenElements`, `sign`, `flyer`,
`infographicConfig`, ...) that are already sitting in
`ProjectState.StateJSON`. Since the dashboard already has that exact
JSON in memory (`allProjectStates`), a teacher can reconstruct a
student's real page and use the *same* download buttons the student
has, rather than a separately-stored, necessarily-lower-quality copy.
**Never build a second, stored-image mechanism for this** (one was
tried and reverted — see git history around "Capture real canvas/
infographic snapshots" — a low-res JPEG saved into `ProjectState`
purely so it would fit a Sheet cell; strictly worse than reconstruction
in every way once reconstruction existed) — extend this mechanism
instead of adding a parallel one.

- **`openStudentWorkForDownload(email, activityId, studentName)`**
  (identical copy in `teacher-dashboard.html` and
  `projects-dashboard.html`, wired to the button `deliverableSummaryHtml()`
  renders) — looks up that student's `stateJson` in `allProjectStates`,
  writes `{activityId, studentName, teammates: [{name, role}], stateJson}`
  to `sessionStorage['lia_teacher_view_state']`, then
  `window.open()`s that project's own page (`PROJECT_PAGE_URLS`, one
  entry per known project — extend it when a new paired project ships).
  `teammates` comes from `teammatesForRow()`/`partnerNameFor()` (see
  above) so the reconstructed page can populate every team member's
  name, not just the one being opened — `projects-dashboard.html`
  carries its own copies of `pairingForRow()`/`teammatesForRow()`/
  `partnerNameFor()` for this (it had none before; §13's "Teacher
  dashboard" pairing functions were teacher-dashboard-only until this).
- **Delivery mechanism: `sessionStorage`, not a URL param or a new
  backend call.** Per the HTML Living Standard, a same-origin tab
  opened via `window.open()`/`target="_blank"` gets a **copy** of the
  opener's `sessionStorage` at open time — verified live in this
  environment's own headless Chromium, not just asserted from the spec.
  This keeps the whole handoff client-side (no `Code.gs` change, no
  redeploy, nothing written anywhere new) and self-cleaning (a one-time
  read — see below).
- **Each of the four project pages' `window.onTeacherUnlock` hook**
  (§18's teacher-preview hook) checks for a pending handoff *matching
  its own `activityId`* first, before falling through to the generic
  Teacher Preview (empty, free-play) setup below it. If found: reads
  `sessionStorage`, **immediately removes the key** (one-time use — a
  refreshed or reopened tab never re-triggers it), sets
  `window.allTeamNames`/`team-name-1`/`team-name-2`/`team-name-3` from
  the handoff's own `studentName`/`teammates` (not from any live
  pairing lookup on this page, since a teacher's own sign-in never goes
  through `onLessonUnlock`), then calls `restoreState(JSON.parse(...))`
  — **the exact same function a normal student reload already calls**,
  not a new reconstruction path. `restoreState()` on every one of these
  four pages already fully rebuilds everything needed (Konva canvas
  elements from `gardenElements`/`sign.elements`/`flyer.elements`;
  `window.infographicConfig` + a `renderInfographicArt()` call for the
  SVG-based pages; `day1Locked`/`day2Unlocked` correctly re-gating Day 2
  access) purely because that's what it was already built to do for a
  student's own reload — reusing it here needed zero changes to
  `restoreState()` itself on any page. A distinct
  `.teacher-preview-banner` ("VIEWING `<name>`'S SAVED WORK...") makes
  clear this is a read-only reconstruction, not free play.
- **Nothing this teacher does here can get saved over the student's
  real record** — `window.teacherPreviewMode = true` is set exactly as
  the generic Teacher Preview path already does, and `lesson-auth.js`
  calls `showAppContainer()` (never `unlock()`) ahead of either branch
  of `onTeacherUnlock`, so `ready` stays `false` and
  `LessonSync.saveProjectState()`/`LessonProgress.record()` already
  no-op on their own pre-existing `!ready` guard — this reconstruction
  needed no new save-blocking guard of its own.
- **Verifying this on a Konva-canvas page in an environment where the
  CDN is blocked** (this one included — `cdn.jsdelivr.net` returns 403
  through this sandbox's proxy): a minimal `Konva` stub (a `Proxy`-
  wrapped node whose only real methods are the handful actually read
  back — `getClassName`/`toDataURL`/`getChildren`/`x`/`y`/`width`/
  `height`/`text`/`fill`/`nodes`/`position` — everything else a
  chainable no-op) routed in via Playwright's `page.route()` is enough
  to prove `onTeacherUnlock`/`restoreState()` run end-to-end with zero
  page errors; it can't verify actual pixel output, only that the
  reconstruction logic itself doesn't throw. The SVG-based pages
  (Ethical Auditor, Ethical Linear Budgeting) need no such stub and
  were verified with a real, full-resolution rendered image.

**Downloading every student's certificate for one activity at once.**
`downloadAllCertificatesForActivity(activityId)` (identical copy in
both dashboards — `teacher-dashboard.html`'s Deliverables card header
inside `projectInsightsHtml()`; `projects-dashboard.html`'s
Deliverables `<details>` toggle) — **certificate only**, not
badges/stamps/gardens/infographics, which still need the one-at-a-time
"Open & download real files" button above (every project's Certificate
is the one deliverable every one of the four pages has in common).
- **Sequential, one tab at a time, never parallel** — opening every
  student's tab at once is far more likely to trip a browser's popup
  blocker than opening them one at a time as each previous one finishes
  and self-closes. `writeTeacherViewHandoff()` (shared by this and
  `openStudentWorkForDownload()`) gained an `autoDownload` field for
  this — `'certificate'` today, the only value read anywhere.
- **On the project-page side**, the exact same `pendingView` branch
  described above additionally checks `pendingView.autoDownload ===
  'certificate'` right after `restoreState()` — if set, it calls
  `downloadCertificate()` itself (fire-and-forget, since
  `onTeacherUnlock` isn't `async`), checks `window.certificateDownloaded`
  afterward (a student who hasn't finished Day 2 can't generate one —
  `downloadCertificate()`'s own existing guard just returns without
  setting it, never throws), reports `{type:
  'lia-batch-download-done', email, ok}` back via
  `window.opener.postMessage()`, then `window.close()`s itself ~1.2s
  later (not immediately — closing right away can cancel an
  in-progress browser download).
- **On the dashboard side**, each iteration opens one tab, listens for
  that exact `email`'s `message` event (a **10-second timeout**
  resolves it as skipped if no message ever arrives — a hung/failed tab
  can't stall the whole batch forever), tallies success/skip, then
  moves to the next candidate. If `window.open()` itself returns falsy
  (the browser blocked the tab), the loop **stops immediately** and
  tells the teacher exactly which student it stopped at, how many
  succeeded so far, and that re-running "Download all" after allowing
  pop-ups is safe (each run is independent — no dedup/resume state is
  kept between runs, so re-running simply redoes every candidate again).
- **Verified in isolation, not as one fully-integrated real-multi-tab
  test** — real cross-tab `window.open()` timing in headless automation
  doesn't reliably mirror a real browser's user-gesture/popup-blocker
  behavior, so the two sides were proven independently instead: the
  project-page side (stub `window.opener`/`window.close`, confirm the
  real `postMessage` payload and self-close call), and the dashboard
  side (stub `window.open` to simulate a fast success, a silent
  timeout, and an outright block, confirming sequential pacing,
  correct tallying, and the exact alert text in each case). Both
  dashboards' copies tested identically since they're kept in sync by
  hand.

### Projects Dashboard (`Lessons/projects-dashboard.html`)
A separate, standalone, teacher-only page — never a 5th top-level tab on
`teacher-dashboard.html` (see §13's rule against that) — for the
cross-project view a single activity's Project Insights panel can't
give: one page showing every STREAM project at once. Own hand-written
gate identical in shape to `teacher-dashboard.html`'s own (same
`token-cache.js`-backed flow, same `type: 'teacher-data'` call, no
`lesson-auth.js`), linked from `teacher-dashboard.html`'s header
("STREAM Projects Dashboard →") and linking back.

- **STREAM pillar hero** — six SVG rings (S-T-R-E-A-M, always all six,
  never fewer) aggregated across every project activity currently in
  view (same Grade/Teacher pill filters as the main dashboard). A
  pillar with no matching graded content anywhere in view renders as a
  dim "No data yet" ring rather than a fabricated 0% — same principle
  §18's `computeStreamPillarBreakdown()` already established.
- **Project cards** — one per detected project activity, each with a
  mini version of the same pillar breakdown, an attempts-per-item stat,
  and a collapsible `<details>` Deliverables table (`deliverableSummaryHtml`).
- **A project activity is detected two ways**: `isKnownProjectId()`
  matches the three known ports' `ActivityId` prefixes directly (so a
  card renders even before any student has started it), and
  `looksLikeProject()` (the same detection `teacher-dashboard.html`
  uses) catches any future project this page doesn't know about yet,
  once real submitted data exists for it.
- **Deliberately duplicated, not shared, logic**: `decorateProjectRow()`
  (a light version of `decorateRow()` — just the filtered graded-item
  list, none of the integrity/effort flagging engine, which belongs to
  the main dashboard only), `STREAM_PILLAR_RULES`,
  `computeStreamPillarBreakdown()`, `deliverableSummaryHtml()`,
  `pairingForRow()`/`teammatesForRow()`/`partnerNameFor()`/
  `writeTeacherViewHandoff()`/`openStudentWorkForDownload()`/
  `downloadAllCertificatesForActivity()`/`PROJECT_PAGE_URLS` (the
  "open/download a student's real deliverable" mechanism — see above),
  `gradeListIncludes()`/`formatGradeLabel()`/`isActiveStatus()` are all
  copied here rather than imported from `teacher-dashboard.html` —
  matches the site's existing "every dashboard-shaped page is
  self-contained" convention (no shared module beyond
  `lesson-shared.js`/`lesson-auth.js`). **Keep `STREAM_PILLAR_RULES` in
  sync by hand** between the two files if it's ever tuned in one — the
  match keywords, specifically; this page's own copy additionally
  carries a `color` field per rule (one hex color per pillar, reused
  verbatim from `lesson-shared.css`'s own color-coded pastel-badge
  palette — `.type-tag.*`/`.pill-*` — rather than inventing a new one),
  applied to the STREAM hero rings' `stroke` and letter `color` and to
  each project card's `mini-pillar-chip` badges. `teacher-dashboard.html`
  never renders rings/chips (its Project Insights panel is a plain
  table), so its own copy of the array has no `color` field and never
  needs one — this is the one field that's deliberately **not** kept in
  sync between the two. **Gotcha**: `computeStreamPillarBreakdown()`
  here returns raw `Set` objects in each pillar's `.students` field
  (unlike `teacher-dashboard.html`'s own version of the same function,
  which already converts to `.size` before returning) — every call site
  reading `data.students` must do `.size` itself, or it renders the
  literal string `"[object Set] students"` instead of a count (a real
  regression once shipped, since fixed).
- **`STREAM_PILLAR_RULES` keywords were widened past the original set**
  (`flyer` added to Art, `optimization` added to Math for the second and
  third project ports; `sustainab`/`charity`/`model`/`solv` added for
  the fourth build, Ethical Linear Budgeting — see §18's own paragraph
  on it) once each new project's own section names didn't hit the
  existing keywords at all — see each project's own section list before
  assuming a new one's content will show up here automatically; a
  section name with no matching keyword is simply excluded, not an
  error to chase. **A real gap found migrating pre-existing Youth
  Festival Logistics data**: `flyer`/`optimization` alone left most of
  that unit's own content untagged — `Day 1 - Logistics Stations`,
  `Day 1 - Check Your Understanding`, `Day 2 - Bonus Challenge`, and
  `Day 2 - Exit Ticket` matched nothing at all (10 of ~14 graded items
  per team), so Math/Religion read "No data yet" or badly undercounted
  even for teams that had genuinely finished the unit. Fixed two ways,
  same pattern as the Eco-Garden Creation Sign fix: widened Math to add
  `logistics|understanding|challenge|ticket` (this unit's actual station/
  concept-check/exit-ticket work is fundamentally algebra content, per
  its own Linear-Equations standards mapping), widened Religion to add
  `ethical`, and — since `reflect4`/`reflect5`/`bonusreflect`
  (`index.html`'s own `submitReflection()` calls) already had labels
  naming a pillar their `section` string didn't ("Precision and
  **Stewardship**", "**Ethical** Impact of Planning") — widened those
  three `section` strings themselves to
  `Day 2 - Exit Ticket (Stewardship)` /
  `Day 2 - Exit Ticket (Ethical Impact)` /
  `Day 2 - Bonus Challenge (Stewardship)` so the dashboard's tagging
  finally agrees with what the page already told the student, exactly
  per this section's own "label is display-only, only section reaches
  `pillarsForSection()`" rule above. `deliverableSummaryHtml()` also gained two more
  optional fields — `state.flyer` (Youth Festival Logistics) and
  `state.infographicConfig` (Ethical Auditor, reused as-is by Ethical
  Linear Budgeting) — kept in sync with `teacher-dashboard.html`'s own
  copy, which gained the identical two fields at the same time.

### Standing rule: every future STREAM project must cover all six pillars
Only the three pilot ports (Eco-Garden, Ethical-Auditor, Youth-
Festival-Logistics) were allowed to ship with a genuinely content-free
pillar or two (see "Pilot projects' by-design pillar gaps" above),
because they predate this rule and real students were already using
them by the time the gap was found. **Every STREAM project designed
from here on does not get that exception** — `Eighth/Ethical-Linear-
Budgeting` (8-PreAP) is the first project actually held to it: it
wasn't a pilot port, real students hadn't started it yet when its
pillar coverage was audited, so instead of a `PILOT_PILLAR_GAPS` badge
it got retagging fixes plus one genuine new graded item (the What-If
Calculator's target question — see above) until all six pillars had
real content, with zero exceptions. That's the model going forward:
every graded item's `section` string must resolve to at least one
`STREAM_PILLAR_RULES` pillar (check with `pillarsForSection()`/a quick
regex test before the page ships, not after), and all six pillars
(S/T/R/E/A/M) must have at least one real graded item behind them. **If
a new project can't satisfy both of these, it cannot be created** —
don't ship it with a planned gap and a promise to retag later, and
don't add it to `PILOT_PILLAR_GAPS` (that list is closed to the three
pilot ports, not a template for future ones — see its own comment).
This also means: don't invent a throwaway question just to check a
pillar off the list — design the project so each of the six STREAM
areas has a genuine activity, and if one area truly doesn't fit the
project's real content, redesign the project's scope rather than
padding it.

### Setting up a new paired activity (teacher/manual steps — Claude
cannot edit the live Sheet or redeploy Apps Script itself; see §1)
1. Add the activity's row to `ActivityCatalog` as normal (§3) — set
   `Day2Code` only if that activity uses the typed-passcode Day-2-style
   unlock; leave it blank otherwise.
2. For each **pair**, add **two** rows to `Pairs`: each student's own
   `Email`, the other's `PartnerEmail`, the shared `ActivityId`, and
   that student's own `Role` (`Driver` or `Navigator`); leave `TeamId`
   blank. For a **team of 3+** instead, add `TeamId` as a 5th header to
   the `Pairs` tab if it isn't there yet (existing pair-only rows are
   unaffected by adding the column — their own `TeamId` cell just stays
   blank), then add one row **per student** on the team, all sharing the
   exact same `TeamId` value (any short unique string, e.g. `T1`) for
   that `ActivityId` — one `Driver`, the rest `Navigator`; `PartnerEmail`
   is ignored for these rows, leave it blank.
3. Create the `ProjectState` tab (headers: `Email, ActivityId, StateJSON,
   UpdatedAt`) if this activity saves free-form state — skip it for a
   paired activity that only ever uses normal `LessonCheck`-graded
   items.
4. Paste the current `automation/apps-script/Code.gs` into the Apps
   Script editor and redeploy (New version, same `/exec` URL) — this
   whole section's backend mechanics require that redeploy to be live.
