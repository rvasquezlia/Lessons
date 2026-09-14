# Lessons — repo notes for Claude

## Progress-tracking architecture (read this before touching anything auth/progress related)

There is **exactly one** backend for student progress tracking across this whole
repo: one Google Sheet + one Apps Script Web App deployment. Every lesson
activity, in every grade, talks to that same backend. **Do not create a new
Sheet or a new Apps Script deployment per activity or per project** — that was
the old pattern (see `Lessons/Projects/*/index.html`, each with its own
`SHEET_API_URL`) and it's exactly what this design replaces. Adding a new
activity means adding one row to `ActivityCatalog` in the shared Sheet, never
shipping new backend code.

### Identity

- Students sign in with **Sign in with Google** (Google Identity Services),
  restricted to `lincoln.edu.ni` accounts via the token's `hd` claim.
- OAuth Client ID (safe to reference in front-end code):
  `478111261772-7l1qamohr0fjsa7ekosuhpj9jum1q4vc.apps.googleusercontent.com`
  — Google Cloud project `lessons-progress-tracker`, OAuth consent screen type
  **External**, currently in **Testing** status (only accounts added as Test
  Users can sign in until it's published to Production).
- The `client_secret` for that OAuth client is **never** needed by this
  design (the sign-in flow only needs the Client ID) and must never be
  committed to this repo, added to any page, or stored anywhere public.
- Every request to the backend is verified server-side (Apps Script calls
  Google's `tokeninfo` endpoint) — the front-end's claimed identity is never
  trusted directly.
- **Persisted sign-in**: `Lessons/token-cache.js` (shared by `lesson-auth.js`
  and `index.html`, no other dependencies) caches the raw ID token in
  `localStorage` after a successful check, and every page tries that cache
  before ever showing the sign-in button. A token is only reused while its
  own `exp` claim says it's still valid (~1 hour from issue, Google's own
  lifetime for these tokens — this never extends access beyond what Google
  itself already granted). Any backend response rejecting the token clears
  the cache immediately, so a revoked/expired token doesn't get retried
  forever. Any new gated page must include `token-cache.js` **before**
  `lesson-auth.js` in its `<head>` — leaving it out doesn't break the page,
  it just silently disables persistence and the student is asked to sign
  in on every visit.
- **GIS is initialized imperatively, not via the declarative
  `g_id_onload`/`data-*` div.** That's deliberate: the declarative form
  auto-fires Google's own sign-in UI (including a One Tap popup) on every
  page load regardless of whether a cached token is about to resume
  silently, which raced against the cache check and could flash a scary
  "couldn't reach the roster" error moments before a One Tap login quietly
  succeeded anyway. Instead: the `<script src=".../gsi/client">` tag on
  every gated page carries `onload="onGoogleLibraryLoad()"`, and
  `lesson-auth.js`/`index.html` only call `google.accounts.id.initialize()`
  + `renderButton()` + `prompt()` themselves, inside `showGateAndPromptSignIn()`
  — and only once a cached-token resume has actually failed or there was
  none to try. `#lesson-gate` starts with the `hidden` attribute in the
  HTML for exactly this reason: a successful silent resume never reveals
  it or touches Google's sign-in UI at all. Don't reintroduce a
  `data-client_id`/`data-auto_select` div on a gated page — it would
  re-create the exact race this was built to avoid.
- **Stale in-flight requests are explicitly discarded, not just raced.**
  Apps Script's response time is genuinely variable (a cold start can take
  several seconds), so a slow first attempt and a faster second one (e.g.
  a manual click after the first attempt already looked stuck) can both
  be in flight at once. Every `proceedWithToken()` call (in
  `lesson-auth.js` and `index.html`) captures a `requestGeneration` number
  at its start and checks it's still current before touching the DOM;
  `resolved` permanently retires every attempt once one actually succeeds.
  Without this, an earlier attempt timing out *after* a later one already
  unlocked the page would still run its failure handler and re-reveal the
  sign-in gate on top of already-unlocked content — this exact bug
  happened once (visible in git history) before the guard was added.
  A failed attempt that isn't a retry yet gets exactly one retry with a
  longer timeout (25s vs 15s) before actually giving up, since a lot of
  "failures" are really just a cold Apps Script container. A plain
  `#lesson-loading` element (a small CSS spinner, visible by default,
  hidden once either the gate or the real content is shown) covers the
  silent-check window so the page never just looks blank/frozen while
  this plays out.
- **Cache-bust `token-cache.js`/`lesson-auth.js` on every change.** Every
  page references them with a `?v=` query string — bump that number on
  **every page that includes the file that changed** (they can be at
  different versions; only bump the one you actually edited). Without it,
  GitHub Pages' CDN and browsers can keep serving an old cached copy of
  the file for a while after a push, so the live behavior can lag the
  committed code by an unpredictable amount - confusing to debug, since
  it looks like a bug that "sometimes" happens when it's really just
  staleness. Current versions: `token-cache.js` → `2`, `lesson-auth.js` →
  `11`.
- **`hidden` doesn't always mean hidden — check for a competing CSS rule
  first.** `#lesson-loading` has its own `display: flex` (to center the
  spinner), and an ID selector beats the browser's default
  `[hidden] { display: none }` on specificity - setting `el.hidden = true`
  on it silently does nothing, so the spinner stayed visible forever even
  after content unlocked (real bug, fixed by setting `el.style.display =
  'none'` directly in `hideLoadingIndicator()` instead). Before adding
  `.hidden`/`[hidden]` toggling to any new element, check whether that
  element already has an explicit `display` rule on an equal-or-higher-
  specificity selector — if so, toggle `style.display` directly instead.
- **The backend lock is scoped to writes only.** `identify` and
  `teacher-data` never write to the Sheet, so they run before
  `LockService.getScriptLock()` is ever acquired in `doPost` — only
  `access-check`/`submission` (which can append/update `Progress` or
  `AccessLog`) hold it. Before this, every request type shared one lock,
  so a plain read (like `identify`, fired on every index.html page load)
  could sit blocked behind a slow, unrelated write and time out on the
  client for no real reason.

### The shared Sheet

One spreadsheet, five tabs. Canonical source of truth for the Apps Script
code that reads/writes it: `automation/apps-script/Code.gs` in this repo —
copy that file's contents into the Apps Script editor (Extensions → Apps
Script, from the Sheet) whenever it changes, then redeploy (Deploy →
Manage deployments → edit the existing deployment → New version, so the
`/exec` URL doesn't change).

| Tab | Who fills it in | Purpose |
|---|---|---|
| `Roster` | **Manual** — teacher maintains: `Email, StudentName, Grade, Teacher, Section, Status` | Source of truth for who's allowed in and what grade/teacher they belong to. Add/remove students here directly in the Sheet. |
| `ActivityCatalog` | **Manual** — teacher adds one row per activity: `ActivityId, Title, Grade, Unit, Active` | Drives the grade-gate check. Adding a new lesson page = adding one row here, nothing else. |
| `Teachers` | **Manual** — `Email, Scope` (`Scope` optional) | Gates the `teacher-data` dashboard endpoint. Only emails listed here can pull data at all; being on `Roster` as a `Teacher` name does not grant this by itself. `Scope` controls *how much* of it: blank, `All`, or the column missing entirely means unrestricted (sees every student — this is the whole sheet's original behavior, still the default); any other value must exactly match a name used in `Roster`'s own `Teacher` column and restricts that account to only students with that `Teacher` value. Typo the name (case, spelling) and that teacher silently sees nobody, not an error — double-check it against `Roster` when adding a row. |
| `Progress` | **Automatic** — written entirely by Apps Script | One row per (student, activity), upserted on every save. Columns: `Email, StudentName, Grade, Teacher, ActivityId, ActivityTitle, FirstStartedAt, LastSubmittedAt, ItemsTotal, ItemsAttempted, ItemsCorrect, ScorePct, Status, SubmissionsLog (JSON), FlagReason, ReviewedByTeacher, ReviewedAt`. The last two are the only cells a teacher should hand-edit (checking off a flagged row after review). |
| `AccessLog` | **Automatic** — written entirely by Apps Script | **Denied access attempts only** — a student opening an activity their grade doesn't match, or one no longer active. Routine allowed re-checks on every Check-button click were never logged here (an earlier bug, see git history, that flooded this tab); **allowed opens stopped being logged here at all** in a later pass (see below) since they were both redundant with `Progress` and a source of duplicate rows in their own right. Rows from before that change may still say `Allowed` and are kept for history, not backfilled away. |

### Saving student progress — `lesson-shared.js` and the `record` argument

`Lessons/lesson-shared.js` is the client-side library every lesson page
includes for the actual check/save mechanics (separate from
`lesson-auth.js`, which only handles sign-in/gating/teacher-view — see
"Identity" above). Three pieces matter for any new problem/page:

- `LessonSync.init(activityId)` — called once, near the end of `<body>`,
  after the gate's HTML already exists. Wires up the backend connection
  for this specific `ActivityCatalog` row and is the thing that makes
  `LessonProgress`/`LessonCheck` below actually reach the Sheet.
- `LessonProgress.record({label, answer, section})` /
  `LessonProgress.preRegister(...)` — the actual call that appends an
  entry to that student's `Progress.SubmissionsLog` for this activity.
  Nothing reaches the Sheet, the dashboard, or a teacher's view of a
  student's work unless this gets called.
- `LessonCheck.check(key, isCorrect, feedbackEl, messages, record)` /
  `.submit(...)` / `.incomplete(...)` — the usual per-problem entry
  point a check function calls. **The 5th argument, `record`, is what
  actually triggers `LessonProgress.record(...)` under the hood — it is
  optional in the function signature, and omitting it does not error or
  visibly break anything.** A problem checked without a `record` object
  still shows correct/incorrect feedback on-screen, still locks the
  field, still looks completely normal to the student — but nothing
  about that attempt is ever saved, so it never shows up in `Progress`,
  never appears on the teacher dashboard, and is functionally invisible
  to a teacher forever.

**This bug shipped silently, site-wide, for a while.** The
`checkListRegistry`/`renderCheckList(containerId, problems, keyPrefix,
retryMsg)` pattern used by every `Review.html`'s "Are You Ready?" tab
(see the wired-units table below) was missing the `record` argument in
its `checkListItem()` call in 8 of that pattern's 9 pages — every
student who ever completed that tab on those 8 pages had their attempts
show correct feedback and then vanish. Fixed by giving
`renderCheckList()` a `section` param stored per-registry-entry and
extending each `checkListItem()`'s `LessonCheck.check()` call with a
proper 5th argument (`{label: p.label || p.q.replace(/\\\(|\\\)/g,
''), answer: val, section: cfg.section}`), with each page's own
`renderCheckList()` call site given its own distinct `section` string.

**Any time a new problem type, check function, or page pattern is
added, confirm it actually reaches the backend — don't trust on-screen
feedback alone.** The fastest check: open the teacher dashboard after
completing the new problem as a test student and confirm the attempt
shows up in Full Submission Log / that activity's detail view. A
problem that "checks" but was never wired to `LessonCheck.check(...,
record)` (or, for a page with its own bespoke save logic, never calls
`LessonProgress.record(...)` at all) will look completely finished in
manual testing and still save nothing — this is exactly the kind of gap
that doesn't surface until a teacher asks "why don't I see this
student's answers."

### Teacher resets — giving attempts back

Before this existed, a locked item had no way back for anyone, teacher
included — not a missing feature so much as an accidental side effect of
`restoreSubmissions()` (see above): it locks a field the moment **any**
entry exists for that key, regardless of whether the student had used
one attempt or two. A student who submits one wrong answer and closes
the tab returns to a permanently disabled field, having never gotten
their second try. This is teacher-dashboard-only, by design — nothing
about it is reachable from a lesson page.

**Three scopes, one mechanism.** A teacher can reset a single **item**
(one key, e.g. one vocabulary-match term or one Practice-Set question),
a whole **section** (one tab, e.g. "3. Quick Vocabulary Check" — every
key most recently logged under that section name), or the whole
**activity** (every resettable key on that student's Progress row for
that page). "Resettable" excludes `tab-*`/`reached-end`/`paste-*`/
`focus-lost-*`/`focus-back-*`/`rightclick-*` keys (`isResettableKey_` in
`Code.gs`) — `restoreSubmissions()` never locks those in the first
place (there's no `<key>-input` element for any of them), so resetting
one would write an entry with nothing to actually unlock.

**A reset is an appended log entry, never a deletion or overwrite** —
consistent with `SubmissionsLog`'s existing append-only design. Resetting
a key writes one new entry: `{key, label, answer: '', verdict: 'reset',
section, resetScope, resetBy, timestamp}` — `label` is the item's own
real label (`latestByKey[key].label`), **not** a generic "Reset by
teacher (item)" string; an earlier version used that generic string and
it read as redundant/confusing next to the Verdict column's own `reset
(item)` pill, which already says what happened. The full prior history
(every wrong attempt, the reset itself) stays in the log — nothing is
ever lost, and the dashboard's Attempts table shows the reset inline,
styled distinctly (`<span class="pill ok">reset
(item)</span>`, light green row) rather than looking like just another
attempt.

**The reset IS the unlock mechanism, and it's almost entirely free.**
`restoreSubmissions()` (`lesson-auth.js`) already computes "latest entry
per key wins" — it now also does `if (s.verdict === 'reset') return;`
before locking anything, meaning a reset key simply has nothing restored
against it: the student sees a plain, fresh field with their standard 2
attempts, exactly as if they'd never touched it. No new client-side
"unlock" logic was needed beyond that one early return, because the
2-attempt limit (`LessonCheck`'s `attempts`/`locked`) was already
in-memory and page-load-scoped the whole time — `restoreSubmissions()`'s
unconditional lock was the only thing actually enforcing anything across
a reload.

**Attempt numbering restarts after a reset, so a resubmission earns full
credit again** rather than permanently reading as "attempt 3." Both
`Code.gs`'s `recordSubmission_` (via `attemptsSinceReset_`, which walks
a key's entries backward and stops at its most recent `'reset'`) and
`teacher-dashboard.html`'s `decorateRow()` scoring loop (which slices
each key's entry list to only what's after its last reset marker before
doing the existing 1st-try/2nd-try scoring) apply the identical rule —
if either drifts from the other, a resubmission's score on the dashboard
would stop matching what the student actually experienced. **A key
that's been reset but not yet re-attempted contributes nothing to
`gradedCount`/scoring at all** — it's excluded entirely rather than
counted as "0 points," so it doesn't drag a score down while a student
just hasn't gotten to it yet.

**`section` had to start being persisted server-side for this to work
at all.** Every `LessonProgress.record(key, label, answer, verdict,
section)` call already sent `section` to the backend (via
`lesson-auth.js`'s `onRecord`), but `Code.gs`'s `recordSubmission_`
silently dropped it before this — nothing before this reset feature
ever consumed it, so the gap went unnoticed. A section-scoped reset
needs it to find every key belonging to a tab, so it's now stored on
every new `SubmissionsLog` entry. Entries logged before this change
have no `section` field and can't be reset by section (only by item or
whole-activity) — an unavoidable migration gap, not a bug.

**That migration gap used to be invisible, and looked like a broken
reset rather than a known limitation — fixed by surfacing it instead of
leaving it silent.** Reported live: a teacher ran a section reset on an
activity whose items mostly predated the section-persistence fix above,
and only the *one* item that happened to already carry a `section`
field (because it had separately been item-reset and resubmitted after
that fix shipped) actually reset — every older, section-less item in
that same tab was silently skipped, since `applyTeacherReset_` could
never match a key with no `section` against any section target,
whatever section it actually belonged to on the page. Nothing was
telling the teacher this was happening, so it read as "the section
reset only did one item" with no explanation. Fixed on both sides
without being able to fix the underlying gap (there's no way to
retroactively know which section a pre-migration entry belonged to):
`applyTeacherReset_` now counts these separately as `skippedNoSection`
and returns it alongside `resetCount` in every response — including in
the `error` message itself when a section reset ends up with *nothing*
left to reset (`"...N item(s)...predate section tracking...Use 'Reset
entire activity' instead."`) rather than the old generic "nothing to
reset" text. `teacher-dashboard.html`'s `teacherReset()` shows a
post-reset `alert()` naming both counts for any multi-item scope
(section/activity — an item reset is always exactly 1, so nothing needs
confirming there), and `submissionDetailTable()` computes and shows the
same warning **before** a teacher even clicks anything: a small note
under the "Give attempts back" toolbar reading "N item(s) on this
activity were logged before section tracking and can't be included in
a section reset - use 'Reset entire activity,' or the per-item Reset
link below, instead" whenever `lastIdxByKey`'s latest-entry-per-key view
contains any resettable key with no `section`. `scope === 'activity'`
was never affected by any of this — it never filters by section in the
first place, so it's always the correct fallback for a legacy activity
where "Reset section" can't reach everything.

**A multi-item reset (section or activity scope) is one teacher action,
but used to render as N separate rows/lines — collapsed into one now.**
Reported live after using "Reset entire activity" as the fallback for
the migration gap above: a 9-item activity reset flooded both the
Attempts table and the Overview/per-student/per-activity "Recent
activity" feeds with 9 near-identical `reset (activity)` rows, all
carrying the exact same timestamp, reading as noise rather than "one
reset happened." Every key a single `applyTeacherReset_` call resets
gets pushed with the *exact same* timestamp (one `now` per call) and
stays adjacent in `submissions`/`allSubmissions` since both are already
sorted ascending by timestamp with a stable sort — `submissionDetailTable()`
and the `allEvents` builder (in `decorateRow()`) both now walk the
sorted list and group consecutive `'reset'`-verdict entries sharing an
identical `timestamp`+`resetScope`+`resetBy` into a single rendered
row/line instead of mapping one-to-one. A group of exactly 1 (the
common case — an item-scope reset, or a section reset that only ever
catches one item) still renders exactly as before, naming that one
item; a group of N > 1 collapses to `"N items reset"` in the Attempts
table (with a `title` tooltip listing every collapsed item's own label,
for a teacher who wants to check exactly which ones) and `"<teacher>
reset N items (<scope>)"` in Recent Activity. This only changes
rendering — the underlying `SubmissionsLog` still carries one full
entry per key exactly as before (nothing about the append-only audit
trail changed), so nothing here can hide or lose an individual reset;
it only stops re-displaying the same one teacher action N times.

**The dashboard UI**: a "Give attempts back" toolbar (a section
`<select>` + "Reset section" button, plus a "Reset entire activity"
button) sits above the Attempts table in `submissionDetailTable()` —
the one function already shared by Student Roster & Profiles' per-
activity rows, Unit & Lesson Deep Dive's By Activity per-student rows,
and the Integrity & Behavior Monitor's Full Submission Log, so it
appears in all three without duplication. A per-item "Reset" link
appears only on each key's most recent row (never on an older attempt,
and never on the reset entry itself) via `teacherReset(email,
activityId, scope, target, label, btn)`, which confirms, POSTs
`type: 'teacher-reset'`, patches the one affected row in `allRows` from
the response's freshly-decorated `progress`, then re-renders and
reopens that student's own detail view — `renderAll()` always resets
every tab back to its list view (see "Teacher dashboard" above), which
would otherwise bounce a teacher back to the student list after every
single reset click.

**A visible "Reset applied" tag sits next to the score itself**
(`resetTagHtml(r)`, applied in `studentDetailTable()`,
`activityDetailTable()`, `renderIntegrityMonitor()`, and
`renderAllSubmissions()` — every per-row table that shows a `scorePct`
cell) so a teacher scanning a list sees that a reset happened without
opening that row's Attempts table to find the inline reset entry. Reads
`row.resetEvents` (every `'reset'`-verdict entry decorateRow() already
collected) and shows the scope in parentheses when every reset on that
row shares one (`Reset applied (item)`), or without it when a row has
been reset at more than one scope.

**Authorization reuses the exact same scoping as every other write** -
`isTeacher_`/`getTeacherScope_`/`getScopedEmailSet_` in `Code.gs`, so a
scoped teacher can only reset their own students, identically to how
their dashboard reads are already filtered. This is the dashboard's
**first** write path ever — `teacher-data` was, and remains, read-only —
so `type: 'teacher-reset'` lives inside `doPost`'s existing
`LockService`-guarded block alongside `access-check`/`submission`, not
as a separate unlocked branch.

**Not live** — same as everything else in this system, a reset only
takes effect the next time the student (re)loads that page; there's no
push mechanism to unlock a field they're already looking at.

**Scoped to locked items for now** — `restoreSubmissions()`'s DOM
assumptions (`<key>-input`/`<key>-feedback` sharing a parent with the
Check button) only cover the common `renderPracticeList()`/
`checkListRegistry` single-input pattern. A reset still writes and
scores correctly for any item type (the backend/scoring logic doesn't
care about DOM shape), but on a page using select-dropdown items,
multi-field Test-Prep questions, or the Vocabulary Match-Up widget, the
item may not have been visibly locking on reload in the first place (or
uses its own hand-written reveal logic) — so a reset there writes the
audit entry correctly but may have nothing visible to "give back." Don't
assume a reset button does something a student can see without checking
that specific page's own restore/lock behavior first.

**`LessonCheck.submit()` also grew a `lockAfterSubmit` flag**
(`record.lockAfterSubmit`, default true/omitted — unchanged behavior
everywhere existing content already calls `submit()`), for the
separate, narrower case of a non-graded item that should never need a
teacher's involvement to redo at all: pass `lockAfterSubmit: false` on
an item deliberately meant to be freely resubmitted (open practice, not
a point-in-time snapshot like a "predict before revealing" reflection,
which should stay locked on purpose). This propagates end-to-end the
same way `section` does — `LessonProgress.record`'s 6th argument →
`lesson-auth.js`'s `onRecord`/patched `record` → `Code.gs` stores it
on the entry only when explicitly `false` → `restoreSubmissions()`
checks `s.lockAfterSubmit === false` and, instead of locking, pre-fills
the last answer, leaves the field and button enabled, and shows "Saved
from your last session - you can edit and resubmit anytime" instead of
the locked message. Every resubmission still appends its own
`SubmissionsLog` entry regardless (nothing about the audit trail
changes) — freely-editable only ever affects whether the *field* locks,
never whether the record is kept. **This flag exists as infrastructure
only** — no existing page's content has been switched to it. Deciding
which specific reflections/submit-only items across the site should
become freely-editable is a per-item content call for whoever owns that
page's content to make deliberately, not something to flip site-wide
just because the mechanism now exists.

### Grade tracks beyond 6/7/8

Not every student fits a plain numeric grade. **7th Grade Honors** and
**8th Grade Pre-AP** are additional tracks, identified by non-numeric
`Grade` codes: `7-Honors` and `8-PreAP` (exact spelling — `Roster.Grade`,
`ActivityCatalog.Grade`, and `index.html`'s `CURRICULUM` keys all have to
match this string character-for-character). Neither collides with a
plain `"7"`/`"8"` student, and both were validated live against a real
`7-Honors` test account before any content existed for it — see
`resolveAccess_`'s grade-mismatch denial and `index.html`'s
`GRADE_KEY_BY_NUMBER` fallback below.

**`GRADE_KEY_BY_NUMBER` only maps numeric grades (6/7/8) to a readable
`CURRICULUM` key ("Sixth"/"Seventh"/"Eighth")** — `Number("7-Honors")` is
`NaN`, so `index.html`'s `gradeKey = GRADE_KEY_BY_NUMBER[Number(grade)]
|| grade` falls through to the raw grade string itself. This is why
`CURRICULUM["7-Honors"]` and `CURRICULUM["8-PreAP"]` are spelled to match
the Grade code exactly — no further code change was needed to make a
non-numeric grade resolve to its own top-level panel. `GRADE_ORDER` (used
only for the unrestricted teacher view) lists both non-numeric codes
alongside the three grade names, or a teacher would never see either
track's topics on the index at all.

**`ActivityCatalog.Grade` can list more than one grade, comma-separated
(e.g. `7,7-Honors`), when two tracks share one activity verbatim** —
`resolveAccess_` in `Code.gs` splits on `,`, trims each value, and checks
whether the student's own grade is in that list, rather than requiring
an exact single-value match. This is what lets **7th Grade Honors reuse
the existing `Seventh/Rational-Numbers` pages outright** — Honors covers
the identical skill (converting rational numbers to decimals, then
adding/subtracting/multiplying/dividing them) at a faster pace, so
rather than duplicating five pages verbatim, `Seventh/Rational-Numbers`'s
five `ActivityCatalog` rows are shared by both grade codes and
`CURRICULUM["7-Honors"]`'s own "Rational Numbers" topic entry points at
the exact same `base`/`activityIds` as `CURRICULUM["Seventh"]`'s. A
`7-Honors` student and a `7` student opening the same URL get the exact
same page, the exact same `Progress` row shape, and the exact same
teacher-view answer key — there is no Honors-specific fork of this
content anywhere. Never split a shared value like `"7"` into two rows
with different `ActivityId`s just to give Honors its own copy — extend
the existing row's `Grade` cell instead, unless the content genuinely
needs to differ.

**`teacher-dashboard.html` uses the same comma-list membership check as
`resolveAccess_`, via its own `gradeListIncludes(gradeField, singleGrade)`
helper** — every place on that page that used to compare a catalog/
activity grade against one student's or filter's grade with a plain
`===` has been switched to it: `filteredCatalog()` (a single-grade
filter pill used to make a shared activity vanish from By
Activity/By Unit entirely), `computeActivitySummaries()`'s `eligible`
roster count (previously sourced its group's `grade` from whichever
`Progress` row happened to be pushed first, which for a shared activity
could be either track's single grade depending on data order — now
always sourced from `ActivityCatalog` itself, the one authoritative
multi-value source), `computeStudentUnitCompletion()`'s
`catalogForGrade` filter, and `computeActivityStatusBreakdown()`'s
`eligible` filter (`computeUnitSummaries()` needed no separate fix since
it groups by `computeActivitySummaries()`'s own now-corrected `grade`
field). `populateFilters()`'s grade-pill list also splits
`ActivityCatalog.Grade` on comma before building its unique set — a
shared row used to add its own bogus, unclickable `"7,7-Honors"` pill
alongside the real `"7"`/`"7-Honors"` ones. Purely for display, a
separate `formatGradeLabel()` helper (comma-then-space instead of a bare
comma) is used everywhere a unit/activity's own `Grade` cell is
rendered as text (`By Unit`'s table and detail heading, `By Activity`'s
and the Engagement Funnel's detail headings) so `"7,7-Honors"` reads as
`"7, 7-Honors"` instead of looking like a typo — a roster student's own
`grade` (always a single value) is displayed as-is everywhere else, no
formatting needed.

**7th Grade Honors** (`Seventh/Squares-Cubes-and-Roots/`, `Grade:
7-Honors` only, not shared) — a genuinely new topic with no regular-7th
equivalent: perfect squares/cubes (1–20 / 1–15), and working backward
with square and cube roots, the bridge to irrational numbers later in
the sequence. Full five-page pattern, matching every other unit —
Vocabulary-Literacy (radical/root vocabulary, translating between
plain-English phrasing and radical notation) and Word-Problems
(area-from-square-root and volume-from-cube-root real-world scenarios)
were both written from scratch, since the source Honors material was
pure computation with neither; see "Squares-Cubes-and-Roots was
initially built as a 3-page set" further down for why this wasn't the
original shape. Every page uses plain `<input>` fields throughout, no
`<math-field>` — every answer in this topic (a base, a square, a cube,
or a real-world length/volume) is a plain integer.

**8th Grade Pre-AP** (`Eighth/Linear-Functions/`, `Grade: 8-PreAP` only,
not shared) — a new unit distinct from the existing `Linear-Equations`
(solving for a single unknown) and `Literal-Equations` (solving a
formula for a specified variable): domain/range and the definition of a
function, the slope formula, slope-intercept form, function notation
(evaluating \(f(x)\) and writing a rule from a table), and real-world
linear modeling. Full five-page pattern. `Practice-Set.html` and
`Word-Problems.html` mix plain-number answers (evaluating a function at
a given input, a slope between two points) with algebraic-rule answers
(writing \(y=mx+b\) or \(f(x)=mx+b\) from data) — the algebraic items use
`<math-field>` + the same `normalizeExpr()`/`answerMatches()` pattern
documented under "Visual math input" below, and sit outside
`window.listRegistry` with their own hand-written `revealAnswerKey`
fill-in, exactly like Literal-Equations' Tab 4/Tab 5 items.

**Why `AccessLog` shrank to denials-only.** Even after the Check-button
flood was fixed, `AccessLog` could still show a burst of rows for a
single real visit: an `access-check`/`submission` call that Apps
Script's cold start makes slow enough to hit the client's timeout
triggers exactly one automatic retry (`lesson-auth.js`'s
`proceedWithToken`) — but the client's `AbortController` only stops the
*client* from waiting, it doesn't stop the Apps Script execution that's
already running server-side. A slow-but-eventually-successful first
attempt plus its retry could both reach `logAccess_`, so one student
opening one page could log two "Allowed" rows, and a whole class hitting
cold starts at the start of a period could look like a flood in the
Sheet within a couple of minutes. Fixing the duplicate cleanly would
need the client to send a stable idempotency key across a retry and the
backend to dedupe on it — more machinery than an "Allowed" row is worth,
since it was never telling a teacher anything `Progress` doesn't
already: `FirstStartedAt` (set once, at the same moment an "Allowed" row
would have been logged) plus `SubmissionsLog`'s own per-item timestamps
(including the `tab-<panelId>` entries logged on every real page visit —
see "Engagement tracking" below) are a genuine, deduped interaction
timeline for that student+activity already. `checkAccess_` (formerly two
near-identical functions, `checkAccessAndLog_` and `verifyStillAllowed_`,
now merged into one) logs a `Denied` row exactly as before — denials are
rare, and worth flagging even with an occasional duplicate — but never
logs `Allowed` anymore, for a student or for the teacher answer-key-view
path. The teacher dashboard's Overview tab has a "Recent activity" card
that reads this same `Progress.SubmissionsLog` timeline directly
(flattened across every visible row, newest first) as the replacement
for what an allowed-opens `AccessLog` used to show.

### Teacher dashboard

`Lessons/teacher-dashboard.html` — a standalone, teacher-only page (not
linked from any lesson). Signs in **exactly like a lesson page** now
(same `token-cache.js`-backed persistent sign-in, imperative GIS init
gated by `onGoogleLibraryLoad()`, `requestGeneration`/`resolved`
stale-request guards, one retry with a longer timeout, `#lesson-loading`
spinner hidden via `style.display` — see "Persisted sign-in" above; this
used to be a plain declarative `data-client_id` gate with no caching,
which is why it looked and behaved differently from every other gated
page until this was fixed). It calls the backend with
`type: 'teacher-data'` instead of `access-check`/`submission`; the
backend checks the signed-in email against the `Teachers` tab and, if
authorized, returns four things in one response: `rows` (every
`Progress` row, including the raw `SubmissionsLog` JSON — same as
before), plus now also `roster` (every `Roster` row), `activityCatalog`
(every `ActivityCatalog` row), and `accessLog` (every `AccessLog` row) —
see `getRosterForDashboard_`/`getActivityCatalogForDashboard_`/
`getAccessLogForDashboard_` in `Code.gs`. `roster`/`activityCatalog`
exist so the dashboard can show students/activities with **zero**
submissions (a `Progress`-only view can only ever show rows that already
exist). `accessLog` is still returned - unused by the dashboard's own UI
since its one consumer (a "Denied Access" tab) was removed, but kept in
the response since it costs nothing to include and something might want
it again later; see "Teacher dashboard" below.

**Per-teacher scoping happens entirely server-side, before any of that
data leaves `Code.gs`.** `getTeacherScope_(email)` reads the signed-in
teacher's `Scope` value from the `Teachers` tab; `getScopedEmailSet_`
turns that into the set of student emails whose `Roster.Teacher` matches
it (or `null` for an unrestricted account). `getAllProgressForDashboard_`/
`getRosterForDashboard_`/`getAccessLogForDashboard_` all take that set
and filter by it before returning anything — a restricted teacher's
browser never receives another teacher's student rows to filter out
client-side, it simply never gets them. `activityCatalog` is never
filtered (an activity isn't "owned" by a teacher). The response also
carries `scope` itself (`null` for unrestricted, else the matched
teacher name) so the dashboard can say whose students it's showing and
hide the now-pointless "Teacher" filter pills for a scoped account (see
"Grade/Teacher quick filters" below).

**Grade/Teacher quick filters are one-click pill buttons, not
`<select>` dropdowns, and Grade defaults away from "All."** Both used to
be plain `<select>`s; the teacher reported the "All Grades" default as
mixing every grade's data together in every table with no visual
separation, and asked for a faster way to switch than opening a
dropdown. `renderFilterPills(containerId, values, current, allLabel,
onSelect)` renders one button per value plus a leading "All ..." button
into `#grade-pills`/`#teacher-pills`, called from `populateFilters()`
(itself only called once per data load/Refresh, from `onDataLoaded()`).
`currentGradeFilter`/`currentTeacherFilter` (plain JS variables, `''`
meaning "All" - same convention the old `<select>.value` used, so
`activeFilters()`/`filteredRows()`/`filteredRoster()`/`filteredCatalog()`
needed no changes beyond reading these instead of a DOM element's
`.value`) are set by `selectGrade(value)`/`selectTeacher(value)`, called
from each pill's own click listener - both then re-run
`populateFilters()` (to refresh which pill shows `.active`) and
`renderAll()`. `gradeFilterInitialized` makes the "default to the first
grade" behavior fire only once per page load: the very first
`populateFilters()` call sets `currentGradeFilter` to the first grade in
sorted order (numeric-looking grades like `"6"`/`"7"`/`"8"` happen to
sort correctly as strings too) rather than leaving it at `''`/"All" - a
teacher can still click "All Grades" explicitly at any time, this only
changes what's shown before that first click. A later Refresh leaves
whatever grade/teacher the teacher has since selected alone, resetting
only if that value no longer exists in the freshly-loaded data (e.g. a
student's grade changed in the Sheet). The Teacher pill group
(`#teacher-filter-group`) is hidden entirely for a scoped account
exactly as the old dropdown was, since such an account only ever has
one teacher value worth picking anyway.

**Grade/Activity pill values are coerced through `String()` before
being deduped or compared, because Google Sheets doesn't format a
numeric-looking cell consistently.** `Roster.Grade`/`ActivityCatalog.Grade`
cells like `"6"`/`"7"`/`"8"` can come back from the API as either a JS
number or a string depending on how that specific cell happens to be
formatted in the Sheet — mixing both for the same grade produced two
visually-identical but separately-tracked pills (`6` and `"6"` are
different `Set` members). `populateFilters()`'s `gradesFromRoster`/
`gradesFromCatalog` both map every value through `String(...)` before
building their dedup `Set`, and every filter comparison
(`filteredRows()`/`filteredRoster()`/`filteredCatalog()`/
`gradeListIncludes()`) does the same on both sides before comparing —
don't reintroduce a bare `===`/`.includes()` against a Sheet-sourced
grade value without it.

**The Activity filter is a multi-select toggle panel, not a `<select>`
or a single pill row** (`currentActivityFilter` is an array, not a
single string) — too many activities for a button row, and a teacher
sometimes wants to compare 2-3 specific activities at once rather than
one at a time. `renderActivityOptions()` builds a searchable checkbox
list into a popover, `toggleActivityPanel()` shows/hides it,
`updateActivityToggleLabel()` keeps the toggle button's own text in
sync ("All Activities" / the one selected title / "N activities
selected"). `availableActivityTitles` (the full unique set, independent
of the current selection) is what the search box filters against, kept
deliberately separate from `currentActivityFilter` so typing in the
search box never discards an existing selection.

**By Unit/By Activity/Engagement Funnel group their rows by an implicit
key even when sorted by another column, via `GROUP_KEYS`/`sortItems()`/
`compareValues()`** (`GROUP_KEYS`: By Unit and By Student group by
`grade`, By Activity and Engagement Funnel group by `unit`) —
`sortItems()` always sorts by the group field first, then by whatever
column the teacher actually clicked, so a table that's nominally sorted
by score/name still reads as clusters of one grade/unit at a time
instead of interleaved. `withUnitGroupHeaders()` renders that grouping
as an actual divider row between groups (By Activity, Engagement
Funnel) rather than leaving it implicit in the sort order alone.

Deliberately, **all analysis happens in the dashboard's own JS, not in
Apps Script**: average time between answers, the "3 answers within 60
seconds" rapid-burst flag, sorting, filtering, every aggregate below.
Tune or add rules by editing `teacher-dashboard.html` directly — that
never requires touching `Code.gs` or redeploying the backend. Only touch
the backend if the data being *returned* needs to change (a new column,
a new tab to join against), not when the flagging/aggregation rules
change.

The page visually matches the rest of the site (reuses
`lesson-shared.css`'s `.app-container`/`.brand-row`/`.nav-tabs`/
`.tab-btn`/`.panel`/`.section-title` rather than its own one-off styles
— including the filter bar, which used to be a dark navy strip that
didn't match anything else on the page and is now a plain light
`--bg`/`--border` bar like the rest of the site's cards) and has **four**
top-level tabs, all driven by the same `allRows`/`roster`/
`activityCatalog` globals and a shared `Grade`/`Teacher`/`Activity`/
"flagged only" filter bar. None of the tab panels carry an explanatory
`<p>` under their `.section-title` anymore — the tab name plus the
table's own column headers are the interface; a per-tab paragraph
restating "one row per X, click a row to see Y" was decided to be
redundant with that.

**This was cut down from eight top-level tabs to four, after the
teacher reported the eight-tab layout as "stacked on" and "not user
friendly."** The eight-tab layout (Overview, By Unit, By Activity, By
Student, Activity Status, Roster, Integrity Monitor, All Submissions)
was the result of adding each new capability as its own top-level tab
one phase at a time - functionally complete, but nothing about it read
as one coherent dashboard. The fix was reorganization, not
re-implementation: every table, chart, and detail view built in those
phases is still here, none of the underlying `compute*`/`render*`
functions changed, and no data was dropped - rows just got grouped
under fewer, better-named top-level tabs (deliberately matching the
"Executive Overview / Unit-Lesson Deep Dive / Student Roster & Profiles
/ Academic Integrity & Behavior Monitor" naming from the platform spec
the teacher originally shared, minus the pieces of that spec already
deferred - see "Deliberately deferred" further down). **Never
re-introduce a fifth+ top-level tab as the default way to add a new
view** - if a new capability doesn't obviously belong under one of the
four tabs below, it likely belongs as a new sub-tab inside one of them
instead (see `switchSubTab()` below), or is a sign the new capability
needs its own product decision about where it fits, not just "add a
tab."

Tab order is **Overview, Unit & Lesson Deep Dive, Student Roster &
Profiles, Integrity & Behavior Monitor**. Two of these are themselves
split into secondary tabs via a small `switchSubTab(panelId, subId)`
helper (mirrors `switchDashTab()`, but scoped to one top-level panel's
own direct-child `.sub-nav`/`.sub-panel` elements via `:scope`, so
switching a sub-tab in one top-level tab never touches another's
sub-tab state) - visually one level down from the primary
`.nav-tabs`/`.tab-btn` styling (`.sub-nav`/`.sub-tab-btn`/`.sub-panel`
in the page's own `<style>` block) so a teacher can tell at a glance
which level of navigation they're looking at:

- **Overview** — summary only, deliberately: stat tiles (active
  students, activities, average score, average Effort Score Index,
  not-started count, stalled-student count, flagged submissions), a
  "Progress by unit" bar chart, lowest-scoring-activity and
  lowest-scoring-student bar charts, and a "Flags" card (count plus a
  breakdown by flag *category* - see `flagCategory()` below - not the
  raw flag string, most of which carry their own per-row count and so
  are never identical across rows) with links to jump into either the
  flagged-only submission log (`jumpToFlagged()`) or straight to the
  Integrity & Behavior Monitor tab's Flags sub-tab
  (`jumpToIntegrityFlags()`), and a **"When students work"** card - a
  plain CSS 24-hour bar chart (`computeHourHistogram()`/
  `renderHourHistogram()`, no charting library) of every logged event's
  hour-of-day in the viewing browser's own local time, across the
  current filter. Purely descriptive, not a flag - it's there to surface
  a pattern (e.g. a burst right before a deadline, or work happening
  well outside class hours) that's sitting in timestamps already being
  recorded, nothing new to log for it. It never lists individual
  students or a raw event feed — that used to live here (a "Students who
  haven't started" list and a global "Recent activity" feed) but got
  moved into the per-student/per-activity detail views, where it's
  actually about something instead of everyone's events interleaved.
- **Unit & Lesson Deep Dive** — merges the former standalone By Unit and
  By Activity tabs into one tab with two sub-tabs, **By Unit** and **By
  Activity** (`switchSubTab('unit-lesson', 'units'|'activities')`) -
  same two tables/detail panes as before, under one nav item instead of
  two, since they're two granularities of the exact same drill-down
  rather than genuinely separate questions.
  - *By Unit*: one row per `ActivityCatalog.Unit` (+ grade, since two
    grades could reuse a unit name), aggregated from the same
    per-activity numbers `computeActivitySummaries()` produces
    (`computeUnitSummaries()` just groups those instead of re-deriving
    anything, so it can't disagree with By Activity). Click a unit to
    see every activity in it; click an activity there and it jumps
    straight to that activity's own detail view on the By Activity
    sub-tab (`jumpToActivity()`, which now also calls
    `switchSubTab('unit-lesson', 'activities')`) — a unit number is
    never a dead end.
  - *By Activity*: one row per catalog activity (including activities
    nobody has started), with a completion percentage computed against
    how many *eligible* roster students exist for that grade (and
    teacher, if filtered). Click an activity for its own mini dashboard:
    stat tiles, a score-by-student bar chart, the full per-student
    table, a **"Most common wrong answers"** card (see "Item Diagnostics,
    lite" below), and that activity's own "Recent activity" timeline
    (built from `Progress.SubmissionsLog` timestamps, scoped to just
    this activity).

**"Item Diagnostics, lite"** (`computeDistractorAnalysis()`/
`distractorAnalysisHtml()`) answers the "which wrong answer do students
pick most" question from the original platform spec, as far as it can
be answered from data already logged: for the activity currently open,
groups every wrong/incomplete answer by item key, then by exact answer
text, and shows the single most common wrong answer per item (only for
items with 2+ total wrong attempts logged - one wrong answer isn't a
pattern yet). This is deliberately **not** the fuller per-distractor
analysis the original spec described, which would need multiple-choice
options to be structured data rather than free-text answers to bucket
correctly - that fuller version stays on the deferred list further
down; this lite version works for any answer type already being
recorded as plain text, no new instrumentation or data shape needed.
- **Student Roster & Profiles** — merges the former standalone By
  Student and Roster tabs, which had drifted into showing nearly the
  same student list twice (By Student's own columns, plus a handful of
  extra ones only on Roster) with no separate detail view of Roster's
  own - now exactly **one** list (`renderByStudent()`), one row per
  roster student (including students with zero `Progress` rows, so
  "hasn't started anything" is visible instead of just absent), with
  every column either list used to show on its own: Student, Grade,
  Teacher, Activities started, Avg score, Effort Score Index, Lesson
  Completion % (averaged across the student's own wired units,
  formerly Roster-only), Attempt-2 Recovery Index (formerly
  Roster-only), Flags, and a "Last activity" column that reads
  "Stalled - Nd" once `STALLED_DAYS` (7) is crossed (formerly
  Roster-only). Click a student for their full profile: stat tiles
  (activities started, avg score, flags, last active, plus a second row
  for Effort Score Index, average Lesson Completion %, Attempt-2
  Recovery Index, and days-since-last-activity/Stalled), a
  score-by-activity bar chart, a **"Lesson completion by unit"** card,
  the full per-activity table, and their own "Recent activity" timeline
  across everything they've touched. `jumpToStudentDetail(email)` (used
  by the Integrity Monitor's ledger) still works exactly as before,
  just targeting `switchDashTab('students')` instead of a `'by-student'`
  tab id - the underlying `by-student-list`/`by-student-detail` element
  ids, and every `compute`/`render`/`open` function name, are unchanged.

**"Lesson Completion %" (`computeStudentUnitCompletion()`) is a
per-student, per-unit metric - not to be confused with
`computeActivitySummaries()`'s own `completionPct`.** The existing
`completionPct` (used in By Activity/By Unit) measures *participation*:
what fraction of the *eligible roster* has even started a given
activity. `computeStudentUnitCompletion()` answers a different
question for one specific student: of a unit's wired activities (for
that student's own grade), what fraction has *this student* actually
finished - status `completed-passed` or `completed-locked-out` from the
five-state funnel below, either way counts as "done" toward completion
even though only Passed counts toward mastery. Grouped by
`ActivityCatalog.Unit` using the same `unit`/`'Unassigned'` fallback
convention as `computeUnitSummaries()`, so a unit name always matches
between the two views. Rendered as its own table in the Student Roster
& Profiles detail drawer (`lessonCompletionHtml()`), listing every
wired unit for that student's grade with its Completion %, Passed
count, Locked Out count, and total activity count.

- **Integrity & Behavior Monitor** — merges the former standalone
  Activity Status, Integrity Monitor, and All Submissions tabs into one
  tab with three sub-tabs (`switchSubTab('integrity', 'engagement'|
  'flags'|'submissions')`), grouped together because all three are
  ultimately the same question ("what actually happened, and is any of
  it concerning") at three different levels of aggregation - the funnel,
  the flagged incidents, and the raw log everything else summarizes
  from.
  - *Engagement Funnel* (formerly the standalone Activity Status tab) —
    "are students actually opening this, and are they passing it?",
    answered with a five-state funnel per activity (Not started / Opened
    only / In progress / Completed - Passed / Completed - Locked Out),
    computed by `computeActivityStatusBreakdown()` from `Progress` alone
    via `progressStatus(row)`: no row at all is Not started; a row with
    neither graded items nor `reachedEnd` (only tab views logged) is
    Opened only; a row with graded items but no `reachedEnd` is In
    progress. Once `reachedEnd` is true, the split is Completed - Locked
    Out (`itemsCorrect < itemsAttempted` - at least one graded item was
    never answered correctly) vs Completed - Passed (everything they
    touched was eventually correct, or there were no graded items at all
    - an engagement-only page). This treats any never-fixed wrong item
    as "locked out" once the student has clicked through every tab,
    whether or not the UI pattern behind that specific item technically
    still allowed a retry - `SubmissionsLog` doesn't record which
    pattern (2-try check vs 1-shot submit) produced a given `incomplete`
    verdict, and a student who's already reached the end isn't going to
    circle back anyway. Above the per-activity table,
    `renderActivityStatusChart()` draws one aggregate stacked bar (plus
    a count legend) summing every filtered activity's own breakdown into
    a single "how's the whole filtered set doing" graph — the table
    alone only shows this per activity, one row at a time. Click an
    activity row to see which student is in which state, with stat
    tiles for the same five counts scoped to just that activity. The
    tab that used to read `AccessLog` for this same "is this being
    opened" question (see below) is gone entirely, replaced by this.
  - *Flags & Behavior* (formerly the standalone Integrity Monitor tab) —
    every row carrying at least one flag (stat tiles for the total plus
    a per-category breakdown via `flagCategory()`), a
    time-on-task-vs-score scatter plot (`renderIntegrityScatter()`, one
    dot per scored row, red if flagged - built as a small inline SVG, no
    charting library), and a flagged-only ledger table
    (`renderIntegrityMonitor()`) using the same inline-expand
    `submissionDetailTable()` pattern as the Submission Log sub-tab.
    This is a **retrospective read of already-recorded activity, never
    live monitoring** - see "Recorded-data integrity/effort signals"
    further down for exactly what is and isn't computed here, and why.
  - *Full Submission Log* (formerly the standalone All Submissions tab)
    — the original flat one-row-per-(student,activity) table, kept as
    the detail view everything else summarizes from. This is the one
    view that keeps the older inline-expand-a-row pattern
    (`toggleDetail()`) instead of a separate detail view — it's already
    the raw per-item layer, not a summary that would otherwise dead-end.

**Every list defaults to alphabetical order**, not a score/date
ranking — `sortState` in `teacher-dashboard.html` sets By Unit/By
Activity/Activity Status/Student Roster & Profiles to
`activityTitle`/`unit`/`studentName` ascending (the Submission Log sub-
tab also defaults to `studentName` ascending), except the Flags &
Behavior sub-tab, which defaults to `lastSubmittedAt` descending -
most-recent-incident-first reads better for a ledger than alphabetical.
A teacher scanning for one specific student or activity shouldn't have
to hunt through a ranked list first; clicking any column header still
re-sorts by that column exactly as before, this only changes what a
list shows before any click.

**There is no Access Log / Denied Access tab anymore** — it was removed
outright, not just renamed a second time. It read the backend's
`AccessLog` data (still returned by `teacher-data`, still perfectly
valid — this is a front-end-only removal, no `Code.gs` change) to show
denied sign-in attempts, but the Engagement Funnel sub-tab above already
answers the actually-useful version of that question ("is this being
opened"), and a separate denial log added a tab for a case nobody was
asking to see routinely. If denial data is ever needed again, it's still
in `result.accessLog` from the backend - only the dashboard's own
`renderAccessLog()`/`joinRosterName()`/`joinActivityTitle()` and the
`access-log` panel were deleted.

**Loading is hardened against the exact failure that once left the
spinner spinning forever with no way to recover short of a hard
reload.** Two independent gaps used to exist: (1) `onGoogleLibraryLoad()`
ran as a bare `<script onload>` handler with nothing catching a throw -
if `token-cache.js` failed to load (a bad path, a CDN hiccup) so
`TokenCache` was undefined, or anything else inside threw, the handler
died mid-execution and nothing ever called `hideLoadingIndicator()`.
(2) There was no fallback at all for Google's own script failing to
load in the first place (network filter, ad blocker, dead connection) -
`onload` simply never fires in that case, so `onGoogleLibraryLoad()`
never runs. Fixed on both sides: `onGoogleLibraryLoad()`'s body is now
wrapped in try/catch (`showGateWithError()` on failure - deliberately
touches only the DOM, never `google.accounts.id.*`, since that object
may not exist yet either), and a 10-second `setTimeout` fallback shows
the same error state if `googleLibraryLoaded` never got set. `onDataLoaded()`'s
`populateFilters()`/`renderAll()` call is also wrapped in try/catch now,
so a future bug in any render function surfaces as a visible message on
an otherwise-usable page instead of a silent partial render.

Both By Student's and By Activity's per-row tables (`studentDetailTable()`/
`activityDetailTable()`) have their own "Attempts" column using that
same inline-expand pattern, reusing `submissionDetailTable()` — the
item/answer/verdict/attempt-number/timestamp breakdown already built for
All Submissions — so drilling from a student into one of their
activities (or an activity into one of its students) reaches the exact
same attempt-level detail without a third full-panel view. Generated ids
run through `safeId()` first since an email or activityId can contain
characters (`@`, `.`) that aren't safe unescaped inside an HTML `id`.

**By Unit/By Activity/By Student share one list-then-detail pattern**
(`showListView(tabKey)`/`showDetailView(tabKey, html)`, keyed off each
tab's `#<tabKey>-list`/`#<tabKey>-detail` elements): the table is the
list view, clicking a row swaps to a full-panel detail view instead of
expanding a squeezed inline row, and a "← Back" button swaps back.
`lastUnitSummaries`/`lastActivitySummaries`/`lastStudentSummaries` cache
each tab's most recently rendered rows so a click can open a detail view
by array index without recomputing; `renderAll()` re-renders every tab
(and resets each back to its list view) on every filter change or
refresh, so a stale index can't be clicked from an outdated list.
Score bars (`scoreBarsHtml()`) and the recent-activity timeline
(`recentActivityHtml()`) are both extracted as plain string-builders
specifically so Overview's compact cards and each detail view's larger
ones can share the same rendering without duplicating it.

**`recentActivityHtml()` decodes each raw `SubmissionsLog` entry into a
readable line instead of dumping its raw `label`/`verdict`.** A tab-view
event's own `s.label` already comes prefixed as `"Viewed tab: ..."` by
`lesson-auth.js` — the timeline used to prepend that same prefix a
second time (`"Viewed tab: Viewed tab: ..."`) before rendering it; fixed
by using `s.label` as-is for tab-type events instead of re-wrapping it.
A graded event is decoded via `VERDICT_TEXT` (`{correct: 'Correct',
incomplete: 'Incorrect', reflection: 'Reflection submitted'}`) plus
`ordinal(s.attemptNumber || 1)`, rendered as e.g. `"<label> - 2nd
attempt - Correct"` rather than a bare verdict string, and colored via
`GRADED_PILL` (`{correct: 'ok', incomplete: 'flag', reflection:
'neutral'}`) so right/wrong/reflection are visually distinct at a
glance the same way every other pill on the dashboard is. Any future
event type added to `SubmissionsLog` (a new integrity signal, say)
needs its own entry in whichever of `VERDICT_TEXT`/`GRADED_PILL`/
`EVENT_PILL` applies, or it'll render with a generic/neutral fallback
instead of a readable label.

**`recentActivityHtml()` renders as a real `<table>` now, paginated 10
rows at a time - it used to be a `max-width:640px`-capped `<ul>`/`<li>`
flex list.** Reported live as "weird and stacked to the left, not
taking the whole part, not rendering as a table" - the width cap was a
deliberate choice (see the function's own comment history) to keep a
short single-line entry's timestamp close to its text rather than
floating off across a wide card, but next to the card's actual full
width it just read as a narrow column with dead space on the right,
worse once the reset-grouping fix above started producing longer
combined lines ("X reset N items (scope)"). Fixed by matching every
other table on this page (`Type`/`Description`/`Time` columns, wrapped
in `.table-wrap` for the same horizontal-scroll-on-overflow the rest of
the page's tables get) instead of a bespoke flex layout, and by only
rendering the most recent `RECENT_ACTIVITY_PAGE_SIZE` (10) rows visible
at first - the caller was previously dumping up to `limit` (default 20,
now 200 since pagination handles display volume instead) rows into the
DOM and onto the screen at once, `loadMoreRecentActivity(id, btn)`
un-hides the next 10 `<tr class="<id>-row" hidden>` rows on each click,
relabeling the button with however many remain or removing it entirely
once none are left. `id` is a per-call instance counter
(`recentActivityInstanceCounter`), not a fixed string, since a different
tab's detail view isn't necessarily torn out of the DOM when another
tab's is opened - two `recentActivityHtml()` instances can coexist, and
a fixed id would let one instance's "Load more" button reveal another
instance's rows.

**`scoreBarsHtml(items, labelKey, scoreKey)` takes an explicit
`scoreKey`** (defaults to `'avgScore'`) precisely because it's called
with two different shapes of object: Overview passes the aggregate
summaries (`computeUnitSummaries()`/`computeActivitySummaries()`/
`computeStudentSummaries()`), which really do have `.avgScore`, but
`openActivityDetail()`/`openStudentDetail()` pass raw per-row
`decorateRow()` output for their "Score by student"/"Score by activity"
cards, which only has `.scorePct` - passing `'scorePct'` there is
required, and a real bug once existed where both call sites read
`.avgScore` off rows that never had it: `undefined !== null` is `true`,
so nothing got filtered out, and the bar rendered a literal "undefined%"
label with `style="width:undefined%;"` - invalid CSS, which browsers
simply ignore, so the `bar-fill` div fell back to its default block-level
width (100% of its container) instead of an actual percentage. That's
why the bug looked like "a full bar next to the word undefined%" rather
than an empty one. A null score is never hidden
either way - it renders with whatever progress signal exists instead
(`itemsAttempted`/`tabsViewed` if the item has them) rather than being
silently dropped, since an unscored-but-touched activity is exactly the
kind of thing worth seeing here.

**Students are color-coded by grade+teacher wherever a list can mix
groups.** By Activity's detail table, All Submissions, and Activity
Status's detail table can all show students from more than one
teacher (an unrestricted "All"-scope teacher sees every section; one
activity can be opened by several sections in the same grade) with no
other visual grouping otherwise. `groupColor(grade, teacher)` hashes
the combo into a small fixed palette (`GROUP_COLORS`) so the same
combo always gets the same color everywhere it appears; `groupDot()`
renders that as a small circle before the student's name
(`activityDetailTable()`, `renderAllSubmissions()`,
`openActivityStatusDetail()`), and `groupLegendHtml()` renders a
compact "Grade G · Teacher" legend above each of those tables -
skipped entirely when the rows passed in are all the same group, since
there's nothing to disambiguate. Tables that already show an explicit
Teacher/Grade column for a single fixed group (By Student's own list,
any single-student detail view) don't get the dot - it only earns its
place where groups are actually mixed in the same table.

**Data-quality note**: the raw `Progress` columns
(`ItemsAttempted`/`ItemsCorrect`/`ScorePct`) count *every* logged
`SubmissionsLog` item, including the `tab-*`/`reached-end` engagement
items (see "Engagement tracking" below) — since every wired page now
logs those, trusting those raw columns directly would inflate "attempted"
and produce a misleading score on every activity. The dashboard's
`decorateRow()` recomputes all three client-side from the submissions
log itself, filtering out `tab-*`/`reached-end` keys first, and uses
`null` (not `0`) when nothing graded exists yet so an engagement-only
page doesn't drag an average down as if it scored zero.

**Scoring formula: 1st-try correct = 1 point, 2nd-try correct = 0.5,
never correct = 0 - except Test-Prep pages, which are attempt-1-only.**
`Code.gs`'s `recordSubmission_` appends every attempt as its own
`SubmissionsLog` entry (never overwrites), each tagged with its own
`attemptNumber` - the full attempt history for every item is already
sitting in the log, so this needed no backend or lesson-page changes at
all, only a rewrite of `decorateRow()`'s scoring math (consistent with
"all analysis happens in the dashboard's own JS" above). For each item
key: group its entries (already sorted ascending by timestamp), find
the entry (if any) with verdict `'correct'`, and award 1 point if its
`attemptNumber` is 1, else 0.5; a key with no correct entry earns 0. A
key whose *final* verdict is `'reflection'` (open-ended, no right
answer) is excluded entirely from both the score's numerator and
denominator - completion-tracked instead (`reflectionSubmitted`), not
graded, so an activity that's mostly reflections doesn't read as
low-scoring. **Test-Prep pages are graded attempt-1-only, with no
partial credit for a correct 2nd try** - `isTestPrep` checks
`row.activityId` for the `-test-prep` suffix every wired unit's
Test-Prep page uses; for those, only a correct *first* attempt scores
(1 point), a correct 2nd attempt scores 0, same as never getting it
right. This intentionally diverges from what the on-screen check flow
shows a student (several Test-Prep tabs still visually allow 2 tries
with a reveal) - the gradebook simply doesn't credit a 2nd-try recovery
on those pages, by design. `itemsAttempted` changed meaning as a side
effect (now counts only graded items, excluding reflections) - this
actually *fixes* a pre-existing mismatch with `progressStatus()`'s own
doc comment, which already claimed "a row with graded items but no
reachedEnd means they're partway through" while the old code counted
reflections toward that same number.

**Recorded-data integrity/effort signals - retrospective only, never
live monitoring.** After the scoring/session/completion work above, the
dashboard grew a further set of signals modeled on a longer platform
spec the teacher provided, but scoped down hard to one explicit rule the
teacher stated twice, in these exact terms: *"no live monitoring, only
recorded activity on their usage of the tool so that we can gather info
on their attempts."* Every signal below is therefore computed entirely
from timestamps, attempt numbers, and answer text already sitting in
`Progress.SubmissionsLog` - nothing here adds any new client-side
instrumentation to a lesson page, and nothing runs while a student is
actually working. A teacher only ever sees this once they open the
dashboard and it re-reads the whole `Progress` sheet - exactly like
every other tab.

- **`_thinkSeconds`** - `decorateRow()` sorts a row's full
  `SubmissionsLog` (`allSubmissions`, every event type) and attaches
  seconds-since-the-previous-event directly onto each entry *before*
  filtering it into `submissions`/`tabViews` - a filtered array holds
  references to the same objects, so both copies see the field for
  free. Every pacing signal below reads this one field; nothing
  separately re-walks the timestamps.
- **Fast-guessing** (`fastGuessCount`) - a graded item's first attempt
  submitted under `FAST_GUESS_SECONDS` (3s) after the previous event.
- **Attempt-1 sacrifice** (`sacrificeCount`) - a fast (guessed) first
  attempt followed by a correct second attempt that took at least
  `SACRIFICE_MIN_SECONDS` (15s) - the pattern of "throw away a guess,
  then actually work it out with the reveal/retry as a hint."
- **Reflection padding** (`paddedReflectionCount`) - a submitted
  reflection (verdict `'reflection'`) of at least 12 words (shorter
  answers are never judged, to avoid flagging legitimately brief ones)
  whose distinct-word ratio (`isPaddedReflection()`/`tokenize()`) is
  under 40% - the signature of repeated/copy-pasted filler typed to
  satisfy a completion requirement rather than actually reflect.
- **Idle gaps** (`idleGapCount`) - a pause of at least
  `IDLE_GAP_MIN_MINUTES` (3) between two consecutive logged events that's
  still short enough (under `SESSION_GAP_MINUTES`, 15) to count as the
  same work session rather than starting a new one - a multi-minute
  pause mid-session, not a departure.
- **Tab-skipping** (`tabSkipCount`) - two consecutive tab-view timestamps
  less than `TAB_SKIP_SECONDS` (2) apart, checked against `tabViews`'
  own timestamps specifically (not the row-wide `_thinkSeconds`, which
  could span a graded answer in between) - reads as clicking through the
  nav without reading a tab's content.
- **Paste detection** (`pasteCount`) and **tab-focus tracking**
  (`focusLossCount`/`awayMinutes`) - see "Paste detection and tab-focus
  tracking" under "Engagement tracking" further down for the full design
  (what's logged, what's deliberately never logged, and the student-
  facing disclosure that goes with it). Both are logged by
  `lesson-auth.js` as their own `SubmissionsLog` item types
  (`paste-*`/`focus-lost-*`/`focus-back-*`), excluded from graded-item
  scoring in `decorateRow()` the same way `tab-*`/`reached-end` already
  are (`isIntegrityKey()`), and reach `teacher-dashboard.html` through
  the exact same channel every other signal on this page uses - no
  special-casing anywhere else in the pipeline.
- **Low-effort reflection** (`shortReflectionCount`) - a submitted
  reflection under `MIN_REFLECTION_WORDS` (4) words (e.g. "idk", "good",
  "done") - the opposite failure mode from padding above: too short to
  judge for word-repetition (`isPaddedReflection()`'s own 12-word floor
  doesn't apply), but still not a genuine answer.
  `isTooShortReflection()` only ever runs on a reflection that already
  failed the padding check, so a single reflection is never flagged for
  both reasons at once.
- **Right-click detection** (`rightClickCount`) - see "Paste detection
  and tab-focus tracking" under "Engagement tracking" further down for
  the full mechanism (it's built to the exact same scope as paste
  detection: only a right-click landing on an actual answer field is
  ever logged, the browser's context menu is never blocked). Flagged on
  any occurrence (`"Right-clicked in an answer field (N)"`).
- **Possible shared answers** (`applyDuplicateAnswerFlags()`) - the
  first of two signals here that aren't per-row: two different students
  submitting the *exact same wrong* answer on the same activity+item
  within `DUPLICATE_ANSWER_WINDOW_MINUTES` (15) of each other. Run once,
  from `onDataLoaded()` right after every row is decorated (`allRows =
  (...).map(decorateRow); applyDuplicateAnswerFlags(allRows);`), since it
  needs to compare rows against *each other*, not just look at one row's
  own history - the one exception to "all analysis happens per-row" in
  this file. Deliberately conservative to keep false positives down:
  only wrong/incomplete answers count (two students both answering
  correctly isn't suspicious - they're supposed to converge on the same
  right answer), and only answers at least `DUPLICATE_ANSWER_MIN_LENGTH`
  (4) characters after whitespace is stripped (so `"x^2 + 3x - 4"` and
  `"x^2+3x-4"` still match as the same wrong answer) - a shared `"5"` or
  `"-3"` on a numeric item is far too common on its own to mean
  anything. This is a genuinely strong integrity signal (a classic
  "identical wrong answer" copying tell) built entirely from answers
  already being recorded - no new instrumentation, still fully
  retrospective.
- **Possible answer lookup** (`applyLookedUpFlags()`) - the second
  cross-row signal: a composite of three things that only mean something
  *together* - a paste event, a high score (`scorePct >=
  LOOKED_UP_SCORE_THRESHOLD`, 90), and a completion time unusually fast
  *relative to this same activity's other students*
  (`totalMinutes <= LOOKED_UP_TIME_RATIO × that activity's own average
  time among scored rows`, ratio 0.5) - not a fixed cutoff, since a fast
  time on one activity is a normal pace on another. None of the three
  alone is suspicious (pasting a worked-out answer into a math-field is
  often completely legitimate, finishing fast can mean real mastery, a
  high score is the goal), but a fast, high-scoring finish that also
  involved a paste is worth a second look. Needs at least
  `LOOKED_UP_MIN_PEERS` (3) other scored students on the same activity
  before "unusually fast" means anything - runs once from
  `onDataLoaded()` right after `applyDuplicateAnswerFlags()`
  (`applyLookedUpFlags(allRows)`), grouping rows by `activityId` to
  compute each activity's own average time before checking any
  individual row against it.
- Each of the ten signals above appends its own descriptive string
  (with its own per-row count baked in, e.g. `"Fast-guessing on 2 items
  (<3s)"`) to the same `flags` array the pre-existing `flagReason`/
  rapid-burst flags already used - every place that already rendered
  `flags` (row styling, the Flags columns, per-activity/per-student
  detail tables) picked these up with no further changes.
  `flagCategory(flagText)` buckets a flag string back into one of twelve
  human-scale categories (matched by substring, since the strings
  themselves are never identical row-to-row) for the Overview/Integrity
  Monitor summary counts.
- **Effort Score Index** (`computeEffortScore(rows)`, per-student
  aggregate) - a 0-100 composite: 40% how far they get into each
  activity on average (`reachedEnd` = 100, any engagement at all = 50,
  otherwise 0), 40% what fraction of their reflections weren't padded
  (defaults to 100% when they have no reflections yet, so a student
  isn't penalized for nothing to judge), 20% what fraction of their rows
  carry zero flags. Weights are a starting point, not a validated
  formula - tune freely, this is pure front-end analysis.
- **Attempt-2 Recovery Index** (`computeRecoveryIndex(rows)`, per-student
  aggregate) - of every graded item missed on the first try
  (`failedFirstTry`, tracked per row in `decorateRow()`), what percentage
  were eventually answered correctly (`correctSecondTry`)? `null` (not
  0%) when a student has never missed a first try at all.
- **Days Since Last Attempt / Stalled** (`daysSinceLastActive`/`stalled`
  on `computeStudentSummaries()`'s output) - approximated from the most
  recent logged event across every activity a student has touched, since
  `ActivityCatalog` has no assigned-start-date concept to measure a true
  "days overdue" against. A student is only ever `stalled` when they
  also still have at least one un-`reachedEnd` activity outstanding -
  there's nothing to be stalled on otherwise, however long ago they were
  last active. `STALLED_DAYS` (7) is the cutoff.

**Deliberately deferred, not silently dropped**, because each would need
either genuinely new client-side instrumentation beyond what's already
logged, or is inherently a live feature the "no live monitoring" rule
rules out outright: a Printable PDF/Report Generator, the *full*
per-distractor Item Diagnostics (structured multiple-choice-option
analysis - a "lite," free-text-answer version now exists, see "Item
Diagnostics, lite" above), true DevTools/concurrent-session detection,
Vocabulary flashcard rapid-flip tracking, and any Live Classroom View.
Revisit these only on explicit request, and only after confirming what
new instrumentation (if any) each would actually require. **Paste
detection, right-click detection, and two cross-student integrity
checks (possible shared answers, possible answer lookup) have since
been added** (see above) - all narrower and more ethically bounded than
the original spec's broader "clipboard/behavior monitoring": each logs
or compares only the fact of an event (or answer text already being
recorded), never new content, so none of them are in this deferred list
on their own anymore - but genuine DevTools/concurrent-session detection
remain deferred for the reasons above.

- **Spreadsheet ID**: `1-HLtX5AwskPx8hy_Ip2kjGMz5OUIS91M2x0FgEt75zA`
- **Apps Script Web App URL**: `https://script.google.com/macros/s/AKfycbyC7mb1TKfg3JvhiZftXMf7oXkzrBMWJczZSURC7sIfoIxYnZrrumYfx-j7JYTY0A9i/exec`

### Role differentiation on lesson pages

`access-check` checks `Teachers` before it ever looks at `Roster`. An
email on `Teachers` gets `role: "teacher"` back — grade-gate skipped
entirely, no `Progress` row created — and the front-end
(`lesson-auth.js`'s `unlockTeacherView`) fills in every problem with its
correct answer instead of the interactive check flow, reading
`window.listRegistry` that the page itself exposes. Anyone else gets
`role: "student"` through the normal `Roster`/`ActivityCatalog` grade
check as before.

Pages using the `renderPracticeList()`/`checkPractice()` single-text-input
pattern get this for free by exposing their registry as
`window.listRegistry` (see Practice-Set.html, Word-Problems.html,
Review.html — each just adds one line after declaring their local
registry object, whatever it's called locally). A page with a different
problem shape (select dropdowns, multi-field answers, several unrelated
check functions with no shared registry — see Vocabulary-Literacy.html,
Test-Prep.html) instead defines its own `window.revealAnswerKey`
function that fills in and locks every one of its own problems by hand;
`unlockTeacherView` calls it if present. **Don't assume teacher view
works on a new page** until it has either `window.listRegistry` exposed
or its own `window.revealAnswerKey` — check the page's own script for
one of those two before trusting the answer key to show anything.

**The reveal's feedback text needs `\( \)` delimiters and a `triggerMathJax()`
call - the field's own `.value` doesn't.** `unlockTeacherView`'s generic
loop (and every page's hand-written `revealAnswerKey`) sets two things
per problem: the input/math-field's `.value` (raw LaTeX like
`\dfrac{V}{\pi r^2}` - a `<math-field>` renders that directly with no
MathJax involved) and a `feedback.innerHTML` string announcing the
answer. That second one *is* plain HTML text with no renderer of its
own, so the same raw LaTeX has to be wrapped in `\(...\)` before MathJax
will touch it, and something has to call `triggerMathJax()` afterward
since this is new DOM content MathJax has never scanned - `unlockTeacherView`
never did either, a real bug that shipped silently for a while: on a
plain `<input>` the field's own value showed that same raw LaTeX too, so
nothing looked inconsistent, but once a page's answers moved to
`<math-field>` (see "Visual math input" below) the input rendered a real
fraction while the text right below it kept showing literal
`\dfrac{...}` source - much more obviously broken side by side. Fixed in
`unlockTeacherView` (wraps `answer` in `\(...\)`, calls `triggerMathJax()`
once after the loop) and in every hand-written `revealAnswerKey` that
sets its own feedback text from a LaTeX `displayAnswer`. Any new
hand-written reveal that shows a LaTeX answer as feedback text needs
the same two things: delimiters around it, and a `triggerMathJax()`
call somewhere before the function returns.

**`displayAnswer` isn't stored the same way on every page - some already
carry their own `\( \)` wrapper.** Most units store bare LaTeX
(`"\dfrac{V}{\pi r^2}"`), but every `Review.html` plus one
`Vocabulary-Literacy.html` (`Eighth/Linear-Equations`) bakes the
delimiters in already (`"\(\frac{6}{9}\)"`), since that same string
also gets interpolated directly into a `"Correct! ..."` message
elsewhere on those pages - it has to be pre-delimited there since
nothing else would wrap it. `unlockTeacherView` strips a leading `\(`/
trailing `\)` (`rawAnswer.replace(/^\\\(|\\\)$/g, '')`) before doing
anything else with it, so both conventions end up at the same bare
form: safe to assign directly to a `<math-field>`'s `.value`, and safe
to wrap exactly once for the feedback text. Skipping this strip step
double-wraps the second convention into invalid LaTeX (a literal stray
`\(` inside the math content itself, since MathJax's delimiter scanner
doesn't nest) - unrenderable, not just cosmetically wrong. Any new
hand-written reveal reading a page's own `displayAnswer` needs the same
strip before using it as a `<math-field>`'s `.value`, and before
wrapping it for feedback text - check which convention that specific
page already uses (grep the file for `displayAnswer: "\(` ) rather than
assuming.

**A plain `<input>`/`<select>` can never render LaTeX at all - only a
`<math-field>` parses it as real math.** A numeric-answer item (`p.a`
defined) can still carry a richer `displayAnswer` meant for the
feedback text (e.g. `"-\frac{5}{6} \approx -0.83"`, the fraction
equivalent shown alongside a decimal answer, from Seventh/Operations-
with-Rationals' Practice-Set). `unlockTeacherView`'s generic reveal
used to fill the answer INPUT with that same rich string unconditionally
- harmless on a `<math-field>` (renders it as real math), but on a
plain `<input>` (this page's answer boxes were never converted - every
item there is graded as a decimal, see "Visual math input" above) it
just showed the literal, unrendered LaTeX source, cut off by the box's
width (real bug, reported via screenshot, fixed in `lesson-auth.js`
`v7`). Fixed generically: when the target element isn't a `<math-field>`
and `p.a` is defined, its `.value` is now the bare `String(p.a)` instead
- the feedback text below still shows the richer `displayAnswer` either
way, since MathJax renders that fine regardless of what's in the input
above it. Any new hand-written `revealAnswerKey` that fills a plain
`<input>`/`<select>` needs the same care: never assign a `displayAnswer`
(or any other field) straight to `.value` without first checking it's
free of LaTeX commands (`\frac`, `\sqrt`, `\approx`, `\pi`, `\times`,
etc.) - prefer a plain numeric/text fallback for the input itself when
one exists, same as the generic fix does.

**The `TEACHER VIEW` banner is styled via `.teacher-view-banner` in
`lesson-shared.css`, not inline.** `unlockTeacherView` just sets
`banner.className = 'teacher-view-banner'` and prepends it as
`.app-container`'s first child. It used to carry its own inline
`margin`/`border-radius`, which left a gap around it revealing the
white background behind it and made the blue `<header>` below look
disconnected from the rest of the rounded card - fixed by making it
full-width and flush with no margin, so `.app-container`'s own
`overflow:hidden` + `border-radius:16px` clips it into the same rounded
top corners as everything else. The "Open Teacher Dashboard" link is a
real pill-button (`.teacher-view-banner a`) now instead of a plain
underlined link.

**Teacher view now disables every remaining live control at the end of
`unlockTeacherView`, not just the ones its own reveal logic already
knew about.** Reported live: a teacher signed in and could still click
Strategy Challenge's "pick your group" buttons, or any Check/Submit
button a page's `window.listRegistry`/`window.revealAnswerKey` reveal
code didn't happen to reach - pointless for a teacher who's only there
to see the answer key, not attempt anything. Fixed with a final sweep
in `unlockTeacherView` (`lesson-auth.js`, after `revealAnswerKey()`
runs): every still-enabled `<button>`/`.card-select-option` inside
`.app-container` gets `disabled = true`, **except** ones whose
`onclick` matches a `SAFE_ONCLICK` regex (`next`/`prev`/`reveal`/
`reset`/`toggle`/`switchtab`/`switchsubtab`/`print`/`scroll`/`jump`/
`open`/`show`/`close`, case-insensitive) or that carry the `.tab-btn`/
`.sub-tab-btn` class - a teacher still needs carousel next/prev,
"Reveal Next Round/Step," Reset, and tab navigation to actually read
everything, so those stay live. This is a blanket, page-agnostic sweep
- it needed zero changes to any individual lesson page, including ones
with a bespoke picker like Strategy Challenge that predates this fix
entirely. If a future interactive control's `onclick` name doesn't
naturally contain one of the safe words above (e.g. a hypothetical
`showHint()` does, but something named unusually might not), add its
keyword to `SAFE_ONCLICK` rather than leaving it live by accident, or
rather than leaving it disabled by accident if it's meant to stay
usable in teacher view.

**`assets/lia-logo.png` needs a light backdrop of its own wherever it's
used.** The file is a transparent PNG whose ink (the wordmark, the
"35th" numeral) is navy blue (`rgb(27,28,106)`) - almost the same color
as `--primary` (`#1e3a8a`), the header background every page places it
on. Without something light behind it, the logo nearly disappears into
the header rather than just looking slightly off. `.brand-logo` (in
`lesson-shared.css`, and separately in `index.html`'s own inline
styles - it doesn't link `lesson-shared.css`) now gives the `<img>`
itself a white background, padding, and rounded corners, so it reads
as a small white badge regardless of what's behind it. If this logo
(or any other transparent asset in a similar dark navy) shows up
somewhere new, check contrast against its actual background before
trusting it'll be visible - "the file has transparency" doesn't mean
"the file has contrast."

### Engagement tracking (tab views, not just graded answers)

`lesson-auth.js` also patches `window.switchTab` (a real `function`
declaration on every lesson page, not a `const`, so it's a genuine
`window` property this can wrap) to sync two more item types into the
same `SubmissionsLog`, independent of `LessonCheck`/`LessonProgress`:
`tab-<panelId>` (verdict `viewed`, logged once per tab actually opened,
including the first one visible at sign-in) and `reached-end` (verdict
`reached-end`, logged once the last `.tab-btn` in the page's nav is
opened). This is what lets a page with no graded content at all (or one
where grading isn't the point) still show meaningful data: whether a
student opened it, how many tabs they saw, whether they got to the end.

`teacher-dashboard.html`'s `decorateRow()` splits these out from graded
answers before computing "avg seconds per answer" or the rapid-burst
flag — a tab view isn't an answer, and would otherwise skew both. They
surface instead as their own `Tabs viewed` / `Reached end` columns.

**Work sessions ("when did they actually work on this") are computed
retrospectively from these same timestamps - there is no live/real-time
monitoring anywhere in this system, by design.** `computeSessions(events,
gapMinutes)` in `teacher-dashboard.html` groups a row's full event list
(`allSubmissions` - every tab view, check attempt, and submission, not
just graded answers) into sessions: consecutive events stay in the same
session while the gap between them is under `SESSION_GAP_MINUTES` (15);
a longer gap means the student left and came back later, starting a new
session. `decorateRow()` attaches `sessions` (each `{start, end, count,
minutes}`) and `totalMinutes` (their sum) to every row - a single-event
session has `minutes: 0` (a brief visit, not padded to look like time
was spent) rather than being dropped. Surfaced as a `Time on task`
column on By Activity's/By Student's per-row detail tables and on All
Submissions, and as a "Work sessions" table (session #, start, end,
duration, event count) prepended to `submissionDetailTable()`'s
existing per-item breakdown - reused by all three of those tables, so
this needed exactly one change to show up everywhere. Deliberately not
a live/real-time feature: this is a read of already-logged history when
a teacher opens the dashboard, not anything watching a student as they
work. If a genuinely live view is ever wanted, that's a separate,
much bigger architectural decision (Apps Script/Sheets has no
push/websocket mechanism) - don't casually extend this retrospective
computation into one.

**Student-facing disclosure**: every gated page's sign-in gate shows one
sentence - *"Activity performed on this page is recorded so your
teacher can review your work."* - covering every listener on this page
(graded answers, tab views, paste detection, tab-focus tracking) without
having to enumerate each one or edit this text every time a new signal
is added. `lesson-auth.js`'s `injectDisclosure()` inserts it as a
`<p class="lesson-gate-disclosure">` into `#lesson-gate .lesson-gate-body`
once per page load (idempotent - checks for its own class first), called
from `init()` - which only runs after the gate's HTML already exists in
the DOM, since `LessonSync.init(...)` is always called from a page's own
inline script near the end of `<body>`, well after `<head>`'s
`lesson-auth.js` include has already run. `index.html` has its own
separate, non-shared gate implementation (see "index.html is also gated
now" below) and so hand-carries the identical sentence and
`.lesson-gate-disclosure` CSS rule directly in its own markup instead -
if this sentence ever changes, update both places. **Any new gated page
gets this for free automatically** as long as it calls `LessonSync.init()`
- no per-page HTML edit needed, same as every other shared-file
mechanism in this doc.

**Paste detection and tab-focus tracking** (added alongside the
integrity signals above, per an explicit teacher request for
"ethical means" comparable to what tools like EdPuzzle already do - flag
*that* a paste happened or a tab was left, never capture *what* was
typed/copied or *where* a student went): both are single shared
listeners in `lesson-auth.js`, wired once and covering every page that
loads it, with zero per-page changes needed for a new answer field or a
new page to be covered.
- `onPaste(e)` listens for `paste` on `document` (paste events bubble,
  including out of a `<math-field>`'s Shadow DOM, since clipboard events
  are `composed`) and, only when the target is an `INPUT`/`TEXTAREA`/
  `MATH-FIELD`, logs `{key: 'paste-<timestamp>', verdict:
  'paste-detected', label: 'Pasted into an answer field'}` with an empty
  `answer` field - **the clipboard content itself is never read or
  logged, by design**; this is a "did they paste" flag for the teacher,
  not a way to see what was pasted or where it came from. Debounced to
  at most one logged event per 2 seconds so a single paste action that
  fires more than one browser paste event doesn't log a duplicate burst.
- `onVisibilityChange()` listens for `visibilitychange` on `document`
  (the Page Visibility API - this only ever knows "is this browser tab
  the visible one right now," nothing about what's on another tab or
  app) and logs a matched pair of events: `focus-lost-<timestamp>`
  (verdict `focus-lost`) when the tab becomes hidden, and
  `focus-back-<timestamp>` (verdict `focus-regained`) when it becomes
  visible again. The very first "visible" state on page load isn't a
  "return" from anywhere, so it's deliberately never logged.
- Both use a **unique key per occurrence** (`paste-<timestamp>`, not a
  fixed key like a graded item would use) since each paste/focus-change
  is its own event, not a repeated attempt on one item -
  `teacher-dashboard.html`'s `decorateRow()` has an `isIntegrityKey(key)`
  helper (`key.startsWith('paste-'|'focus-lost-'|'focus-back-')`) that
  excludes all of them from `submissions`/graded-item scoring the exact
  same way `tab-*`/`reached-end` already are excluded - without this,
  every paste/focus event would wrongly count as "a graded item that was
  never answered correctly" and drag down `scorePct` and inflate
  `failedFirstTry` on any activity that logged one.
- `decorateRow()` computes `pasteCount` (raw count), `focusLossCount`
  (raw count), and `awayMinutes` - the latter by pairing each
  `focus-lost` event with the next `focus-regained` event *after* it
  (a student who never returns, or is still away as of the last sync,
  simply leaves that one pair unclosed) for real elapsed away-time,
  rather than inferring it from answer-gap heuristics the way
  `idleGapCount` has to for pages/moments this signal doesn't cover
  (visibilitychange only fires on an actual tab-hide/switch/minimize,
  never on "sitting on the page but not doing anything" - the two
  signals are complementary, not redundant). A paste of any count is
  flagged (`"Pasted into an answer field (N)"`); tab-focus loss is only
  flagged once it happens repeatedly in one activity
  (`FOCUS_LOSS_FLAG_THRESHOLD`, 3) since briefly switching away once or
  twice during a class period is normal, not itself suspicious - the
  raw `focusLossCount`/`awayMinutes` numbers are still available even
  when nothing gets flagged.
- **Right-click detection** (`rightClickCount`), added in the same
  reviewed pass as the two cross-student checks below, per the explicit
  instruction that it "falls under the same activity recorded as they
  would do it in the page" - i.e. built to the exact same scope and
  shape as paste detection above, not a broader or separately-invasive
  mechanism. `onContextMenu(e)` listens for `contextmenu` on `document`
  but - like `onPaste()` - only logs anything when `e.target` is an
  `INPUT`/`TEXTAREA`/`MATH-FIELD`: a right-click on the branding, nav,
  or question text is never logged, and a right-click "outside the
  page" isn't something page JS can even observe in the first place (a
  browser only ever fires `contextmenu` for its own document). The
  browser's context menu is never blocked (`e.preventDefault()` is
  deliberately never called) - this only records that a right-click
  happened in an answer field, the same non-invasive "flag the fact,
  not the content" design as paste detection, since a student may have
  an entirely ordinary reason to right-click (spellcheck, "look up").
  Logged as `rightclick-<timestamp>` (verdict `rightclick-detected`),
  excluded from graded scoring by the same `isIntegrityKey()` check as
  the other three integrity event types, and flagged on any occurrence
  (`"Right-clicked in an answer field (N)"`) - unlike tab-focus loss,
  there's no "everyone does this occasionally" baseline to wait out,
  since right-clicking inside a math/text answer field specifically is
  rare during normal use.
- **Cache-bust note**: this shipped as `lesson-auth.js` → `v9` (paste/
  focus tracking shipped as `v8`; right-click detection bumped it again
  to `v9`) - bumped across all 37 referencing pages each time (same
  mechanical `?v=` bump described in "Persisted sign-in" above;
  `token-cache.js` is unaffected and stays at `v2`).

### Wired units — current activity IDs

Same pattern (Review/Vocabulary-Literacy/Explanation/Practice-Set/
Word-Problems/Test-Prep all wired, Teacher-Guide left alone) now applied
to six units across Sixth, Seventh, and Eighth grade, in addition to
Rational Numbers — **every grade is wired now**. Two units also have a
Guided-Solving-Ladder page (Seventh/Operations-with-Rationals,
Eighth/Literal-Equations); those are wired too (see the table below) -
`Teacher-Guide.html` is the only page still deliberately left alone
(see "Explanation is gated too" further down for why `Explanation.html`
isn't on that list anymore). Don't assume a page has any of this without
checking for `gsi/client` in its `<head>` first, in case a new unit gets
added later without being wired yet.

**Explanation is gated too — this was a real correction, not always the
design.** Every `Explanation.html` originally shipped ungated (no
sign-in, no `ActivityId`, no `Progress` row) on the reasoning that it's
read-only worked examples with nothing to check an answer against - the
same reasoning that still holds for `Teacher-Guide.html`. That reasoning
missed the actual requirement: **the per-grade access gate itself** is
the point, not just "is there something to grade" - a 6th-grader opening
an 8th-grade Explanation page (or a regular-track student opening an
Honors/Pre-AP one) should be denied exactly like any other activity, and
a teacher should be able to see on the dashboard whether a student even
opened it. `Teacher-Guide.html` stays ungated because it's genuinely
role-restricted a different way: it's never linked from the student
index at all (no `activityIds.teacher` ever exists, matching every
other page in that role), so a student has no path to it regardless.
`Explanation.html`, by contrast, sits right alongside the other
student-facing pages in `CURRICULUM` - gating it is just consistency
with those.

Every `Explanation.html` was retrofitted with the exact same gate
markup/scripts as every other lesson page (`token-cache.js`/
`lesson-auth.js`/GIS `<script>`, `#lesson-loading`, `#lesson-gate`,
`<div class="app-container" hidden>`) and a `LessonSync.init('<unit>-
explanation')` call. None of them define `window.listRegistry` or
`window.revealAnswerKey` - a worked-example carousel already shows the
same fully-solved content to a teacher and a student alike, so
`unlockTeacherView`'s generic reveal loop simply has nothing to fill in
(harmless - it still shows the `TEACHER VIEW` banner, same as any other
page). Engagement tracking (`tab-<panelId>`/`reached-end`) needs no
special handling either - it's already generic in `lesson-auth.js`'s
`patchSwitchTab()`, keyed off any page's own `switchTab()`/`.tab-btn`/
`.panel` markup, which every Explanation page already has.

| Unit | ActivityId prefix | listRegistry / revealAnswerKey |
|---|---|---|
| Seventh/Rational-Numbers | `7-rational-numbers-*` | Practice-Set, Word-Problems, Review use `window.listRegistry`; Test-Prep and Vocabulary-Literacy use hand-written `window.revealAnswerKey`. |
| Sixth/Decimal-Operations | `6-decimal-operations-*` | Practice-Set, Word-Problems, Review use `window.listRegistry` (local var `checkListRegistry`). Vocabulary-Literacy and Test-Prep are hand-written — Test-Prep has *two* separate registries (`estExactRegistry` for two-field estimate+exact items, `submitListRegistry` for single-field submit-only items) plus several one-off items (concept check, two critical-thinking textareas, extra credit, readiness check), none of it merged into `window.listRegistry`. |
| Sixth/Operations-with-Fractions | `6-operations-with-fractions-*` | Same shape as Decimal-Operations, except Test-Prep's `checkListRegistry`/`submitListRegistry` **are** merged into `window.listRegistry` (`Object.assign`) since both already use the single-input convention — only the remaining one-offs (concept check, critical thinking, extra credit, readiness) are hand-written. |
| Seventh/Integers | `7-integers-*` | Practice-Set/Word-Problems use `window.listRegistry` (local var `listRegistry`), Review uses `checkListRegistry`. Vocabulary-Literacy and Test-Prep are hand-written; Test-Prep also has a checkbox multi-select pattern (`checkQCMulti`) and a 4-select sign-group pattern (`checkQCSigns`) with their own reveal logic. |
| Seventh/Operations-with-Rationals | `7-operations-with-rationals-*` | Same shape as Integers (including a `checkQCMulti` checkbox group in Test-Prep), but no sign-group pattern. Its Guided-Solving-Ladder page has one flat `ladderExercises` array (not grouped by key prefix like every other registry here) - exposed as `window.listRegistry = { lex: { problems: ... } }` to fit the same generic reveal mechanism, with `mc`-type items given a synthesized `displayAnswer` (the generic reveal only knows `displayAnswer`/`a`/`accepted`, not this page's own `p.answer`) so a `<select>` gets set to the right option like any other item. |
| Eighth/Linear-Equations | `8-linear-equations-*` | Review uses `window.listRegistry` (local var `checkListRegistry`). Vocabulary-Literacy, Practice-Set, and Word-Problems are entirely hand-written `window.revealAnswerKey` (no page has a shared registry covering everything). Test-Prep's `listRegistry` (local var, matching the shared-name convention) covers only its submit-only Mixed Practice tab; the rest (Check Your Understanding, Error Analysis, Readiness Check) is hand-written. Practice-Set's Strategy Challenge tab is student-choice-driven (pick a group first) and has nothing to reveal until a group is picked — `revealAnswerKey` skips it harmlessly if none was. |
| Eighth/Literal-Equations | `8-literal-equations-*` | Review uses `window.listRegistry` (local var `checkListRegistry`). Practice-Set's `symRegistry` and Word-Problems' `wpRegistry` are both exposed as `window.listRegistry`, covering most of each page; Practice-Set still hand-writes its Tab 4 Live Number Check (targets depend on live slider values, recomputed with the same formula the check functions use) and Tab 5 Error Analysis, and Word-Problems hand-writes its one Tab 3 investment-comparison item. Test-Prep's `submitSymRegistry` (as `window.listRegistry`) covers Mixed Practice parts 1-2 only; part 3 (numeric, separate render/check functions) plus Full Review/Error Analysis/Readiness Check are hand-written. Vocabulary-Literacy is entirely hand-written (two standalone check functions, no registry). Its Guided-Solving-Ladder page already used the standard keyed-registry shape (`exRegistry`, covering both its tabs) so it only needed `window.listRegistry = exRegistry` - no hand-written reveal at all. |
| Eighth/Linear-Inequalities | `8-linear-inequalities-*` | Review uses `window.listRegistry` (local var `checkListRegistry`, adapted to accept either a solved inequality via `p.ineq`/`checkInequality` or an unsolved translated one via `p.accepted`/`ineqAnswerMatches`). Test-Prep's `listRegistry` covers Tab 1's guided list and Tab 3's Mixed Practice; the rest (both Check Your Understanding items, the critical-thinking reflection, Tab 2's Error Analysis Review, Tab 4's exit ticket) is hand-written. Vocabulary-Literacy, Explanation, Practice-Set, and Word-Problems are entirely hand-written `window.revealAnswerKey` (no shared registry, since almost every tab has its own answer shape - text, a select pair for graphing, or a combined inequality+numeric field). **This is the first unit with no `<math-field>` anywhere on any page** - see "Inequality answers are plain text, not `<math-field>`" below for why. |
| Seventh/Squares-Cubes-and-Roots (**7-Honors only**, 5 pages) | `7-squares-cubes-and-roots-*` | Practice-Set uses `window.listRegistry` for all three tabs' plain-number items (`checkPractice`), plus three critical-thinking textareas (`checkCT1`/`checkCT2`/`checkCT3`, submit-only, outside the registry). Word-Problems also uses `window.listRegistry` (plain-number real-world answers across all three tabs). Review's "Are You Ready?" tab and Vocabulary-Literacy's "Quick Vocabulary Check"/translation tabs both use the `checkListRegistry`-style pattern (two separate hand-written render/check functions on Vocabulary-Literacy, so its own `window.revealAnswerKey` covers both). Test-Prep is entirely hand-written `window.revealAnswerKey` (four problem shapes, none sharing a registry). |
| Eighth/Linear-Functions (**8-PreAP only**, 5 pages) | `8-linear-functions-*` | Practice-Set's Tabs 1 & 3 (plain-number: slope, function evaluation) use `window.listRegistry`; Tabs 2 & 4 (algebraic-rule answers via `<math-field>`: slope-intercept form, writing a function rule from a table) sit outside the registry with their own hand-written reveal, same pattern as Literal-Equations. Word-Problems' two numeric tabs use `window.listRegistry`; its one algebraic item (writing the fuel-tank equation) is hand-written. Vocabulary-Literacy and Test-Prep are entirely hand-written (no page-wide registry). |

**Strategy Challenge's "more practice" keys are scoped by chosen group
(`stm-<group>-<i>`), not bare (`stm-<i>`) - a real scoring-integrity bug,
fixed after the teacher asked directly how group-activity progress is
saved/reviewed and whether switching groups was safe.** Both pages with
this student-choice-driven pattern (`Eighth/Linear-Equations/Practice-
Set.html`, `Eighth/Linear-Inequalities/Practice-Set.html`) let a student
pick strategy Group A/B/C(/D) via `chooseStrategyGroup(key)`, and their
own visible on-page text says a student "may reload the page to try
another group later" - switching groups across sessions is explicitly
allowed, by design. The flagship item's `LessonCheck` key was already
scoped correctly (`strategy-${chosenStrategyGroup}`), but the "more
practice" items' keys were bare `stm-${i}` - identical across every
group, since each group's own `more` array is index-parallel. Since
`attemptsSinceReset_` in `Code.gs` counts prior attempts purely by
`item.key` string match with no concept of "which logical problem" a key
represents, a student who tried Group A, reloaded, then picked Group B
would have their fresh first attempt at Group B's problem 1 silently
miscounted as a second attempt at whatever Group A's problem 1 was -
capping their score at 0.5 instead of 1, invisibly. Fixed by scoping
every occurrence (the `<input>`/`<math-field>` id, its feedback div id,
the `LessonProgress.preRegister` call, `checkStrategyMore`'s own
element lookups and `LessonCheck.check` key, and the teacher-reveal
`fillInput` call) to `stm-${chosenStrategyGroup}-${i}` in both files -
verified via Playwright that Group A and Group B now render entirely
distinct element ids, and that both the check flow and the teacher
reveal still work correctly against the new scoped ids. **Two
limitations remain, not yet fixed:** the picker itself has no visual
memory across a reload - `restoreSubmissions()` can't touch this
section since its elements don't exist in the DOM until a group is
chosen (it runs once at page load) and the flagship input's id
(`strategy-x`, not `strategy-x-input`) doesn't match the `${key}-input`
convention `restoreSubmissions()` looks for anyway - so a returning
student always sees the bare picker again with no indication they'd
already started a group, even though every attempt they made is safely
saved server-side. And the teacher-view answer key only ever reveals
whichever group is *currently selected* in that browser session -
there's no way for a teacher to see all groups' answers at once without
picking each one via `chooseStrategyGroup()` themselves (a page's own
teacher view has no group picker; the check-fill happens automatically
once `chosenStrategyGroup` already has a truthy value). Progress
itself, and its teacher-side review, are not affected by any of this -
every attempt reaches `Progress.SubmissionsLog` exactly like any other
graded item, visible in the dashboard's Full Submission Log / that
student's own profile, section `'6. Strategy Challenge'` (Linear-
Equations) / `'5. Strategy Challenge'` (Linear-Inequalities) - it was
only the *scoring* (attempt-numbering) and the *on-screen* picker state
that had gaps.

**Squares-Cubes-and-Roots was initially built as a 3-page set** (Review,
Practice-Set, Test-Prep only, skipping Vocabulary-Literacy/Word-Problems)
since the source Honors materials were pure computation with no
real-world word problems or dedicated vocabulary exercise - reasonable
on its own, but it was an unrequested, unconfirmed deviation from every
other unit's 5-page pattern, and was corrected once questioned rather
than left as a standing exception. Vocabulary-Literacy's radical
notation (translating "the square root of 81" to \(\sqrt{81}\) and
back) and Word-Problems' area/volume-from-perfect-square/cube scenarios
were both written from scratch — original problems, not sourced from
the provided materials, verified by hand against the same 1–20/1–15
reference chart the rest of the unit uses. **Don't default to a reduced
page set for a future unit just because the source material doesn't
include every page's content yet** - write the missing content
yourself (as here) or ask first, rather than quietly shipping fewer
pages than the established pattern.

**Both new units also got their `Explanation.html`/`Teacher-Guide.html`
pair** — the two pages every other unit has beyond the wired
Review/Vocabulary-Literacy/Practice-Set/Word-Problems/Test-Prep set.
This was a real gap the first time these two units shipped: "5-page
pattern wired" was read as "the whole unit," but every unit actually
ships 7 files (see "Explanation is gated too" above — `Explanation.html`
was ungated when these two units first shipped it, then retrofitted with
the same gate as every other page once that was corrected too; only
`Teacher-Guide.html` stays ungated). Both new `Explanation.html` pages
follow the existing carousel pattern (`makeCarousel()`, `flow-row`/
`qa-list`/`resolve-box`, `TeacherPrint.registerCarousel()`); both new
`Teacher-Guide.html` pages follow the existing pacing-plus-full-answer-
key pattern, condensed to 3 tabs (Overview, then two Answer-Keys tabs)
instead of the 5-6 seen on older units. **Deliberately deferred, not
overlooked:** a dedicated `printables/` folder (standalone print-only
Test Prep/Challenge Bank pages) and an IXL Practice tab with real,
verified skill codes — every existing unit's IXL tab links to codes
hand-verified against IXL's own published alignment guide for that
exact grade/lesson, which takes real research per unit; don't fabricate
codes or URLs to fill this in later without doing that same
verification first.

Every wired page needs its own row in `ActivityCatalog` (matching
`Grade`, `Active: TRUE`) before its gate will let anyone in — that's 62
rows now (42 from the 6-page pattern — Review/Vocabulary-Literacy/
Explanation/Practice-Set/Word-Problems/Test-Prep — across 7 grade-6/7/8
units, the 2 Guided-Solving-Ladder pages, 6 for Seventh/Squares-Cubes-
and-Roots, 6 for Eighth/Linear-Functions, and 6 for Eighth/Linear-
Inequalities). The six `7-rational-
numbers-*` rows (including `-explanation`) also need their `Grade` cell
widened to `7,7-Honors` (see "Grade tracks beyond 6/7/8" above) so
Honors can open the same rows — that's an edit to six existing rows, not
six new ones. `index.html`'s `CURRICULUM` also needs an `activityIds`
block per topic (see the existing entries) or a signed-in student won't
see that topic on the index even once the pages themselves work — this
has been added for every wired topic already, across all five top-level
grade keys (`Sixth`, `Seventh`, `Eighth`, `7-Honors`, `8-PreAP`).

**Before trusting `window.revealAnswerKey` or `window.listRegistry` works
on a specific page you haven't checked**, open that page's own `<script>`
and confirm which one it actually defines — the table above summarizes,
but the two Decimal-Operations vs. Operations-with-Fractions Test-Prep
pages look nearly identical at a glance and are wired differently
underneath (unmerged vs. merged registries).

**Guided-Solving-Ladder is deliberately not indexed on `index.html`.**
It briefly existed as a seventh curriculum-index section (a `ladder`
entry in `SECTIONS`, plus a `ladder` href/`activityIds.ladder` on the
two topics that have the page) but was removed by explicit request —
neither the link nor its "Coming soon" placeholder should show up on
the index for any topic, wired or not. The two `Guided-Solving-Ladder.html`
pages themselves (Seventh/Operations-with-Rationals,
Eighth/Literal-Equations) still exist, are still gated/wired exactly as
described in the table below, and are still linked from their unit's
own `Teacher-Guide.html` — only the `index.html` navigation entry was
removed. Don't reintroduce the `ladder` `SECTIONS` entry without
checking with the teacher first.

**The Question Ladder's second question is "What is preventing me..."
site-wide now, not "obstructing."** Every occurrence of "obstructing"/
"obstruction" across every ladder-pattern page (`Guided-Solving-Ladder.html`
×2, both `Literal-Equations`/`Linear-Equations` Explanation/Test-Prep/
Practice-Set/Word-Problems pages that reference the Question Ladder, and
`Linear-Inequalities`'s own Explanation/Test-Prep/Review) was replaced
with "preventing"/"block" - a plain word-swap, sentence structure
otherwise unchanged (`"What is obstructing me from doing so?"` →
`"What is preventing me from doing so?"`, `"a single obstruction"` → `"a
single block"`). This is deliberate site-wide consistency, not a
per-page rewrite - every unit's ladder should use the identical phrase,
so a student moving between units (e.g. Literal-Equations to
Linear-Inequalities) sees the same question worded the same way. If this
wording is ever revisited again, change it everywhere in one pass the
same way, not on just the page someone happens to be looking at.

**Linear-Inequalities' `Explanation.html` reuses the Guided-Solving-
Ladder's exact Round-by-Round Q&A markup/CSS for its own worked
examples, not just a summary paragraph per problem.** The page originally
shipped with terse, single-line "Write it / Solve / Interpret" summaries
per worked example (Tabs 2-5) - reported live as "not explanatory at
all," with the teacher pointing at `Guided-Solving-Ladder.html` as the
bar for what a real explanation should look like. Fixed by copying that
page's `.ladder`/`.ladder-formula`/`.ladder-round`/`.ladder-round-label`/
`.qa`/`.ladder-eq`/`.ladder-result`/`.ladder-check` CSS and structure
verbatim into `Explanation.html`'s own `<style>` block and rewriting
every worked example (including the two Tab 5 word-problem examples,
which get the identical Define/Write/`.ladder`-Solve/Interpret
treatment rather than staying as dense prose) as a full Round-by-Round
breakdown - one added inequality-specific question ("Am I multiplying
or dividing by a negative?", styled via new `.qa .a.flip-yes`/
`.qa .a.flip-no`/`.type-tag.flip` classes) beyond the four questions
Literal-Equations' ladder already asks. **Every round also gets a new
`.ladder-arithmetic` line** (small italic text between `.ladder-eq` and
`.ladder-result`) spelling out what actually happens to the numbers on
that step (e.g. `"-4 + 4 cancels to 0 on the left; 11 + 4 = 15 on the
right"`) - added after the teacher's separate note that "the solve step
can be more explanatory on what happens with the numbers, the students
can get a little bit lost" jumping straight from an equation-with-the-
operation-applied to its simplified result with no visible arithmetic
in between. Any other unit's Explanation page that gets this same
"make it more explanatory" treatment in the future should follow this
same pattern (full ladder rounds + a `.ladder-arithmetic` line per
round), not revert to one-line summaries.

**The "Reveal Next Round/Step" progressive-reveal button was hard to
reach and never told a student when they were done - fixed on every
page using the pattern, one still deferred.** Every occurrence (a
`.challenge-box` with a `stepCount`/`renderXSteps()`/single-container
pattern - `Linear-Inequalities/Explanation.html`'s `msSteps`,
`Literal-Equations/Review.html` and `Linear-Equations/Review.html`'s
own near-identical clones, `Sixth/Decimal-Operations/Review.html`'s)
used to place the reveal button **above** the container new rounds get
appended into - harmless on paper, but once a student scrolled down to
actually read a newly-revealed round, the button was back up above
everything they'd just read, requiring a scroll back up for every single
click. Fixed by moving the button (and its Reset sibling) to sit
**after** the steps container instead, so it's always right where the
student's attention already is. Each page's `render*Steps()` also now
toggles the button's own state once every round is revealed - relabels
it (e.g. `"All rounds revealed"`) and sets `disabled = true` - instead
of leaving it sitting there with nothing telling a student they'd
already seen everything. **`Sixth/Decimal-Operations/Explanation.html`
has several more of these same reveal widgets** (`revealAddStep`/
`revealMultStep`, plus a differently-shaped `nextAddExStep`/
`nextMultExStep`/`nextDivExStep`/`nextWordProblemStep` example-switcher
pattern) that were **not** touched in this pass - that page has enough
distinct widgets, each shaped slightly differently, to warrant its own
dedicated pass rather than a rushed one bundled into an unrelated unit's
fix. Apply the identical two-part fix (button after the container,
disable+relabel at the end) there before assuming it's already covered.

### Visual math input (site-wide now, except Lessons/Projects)

Piloted first on just Eighth/Literal-Equations' Practice-Set Tabs 1-3,
then rolled out to every math/expression answer across that one unit
once the pilot proved out live, and from there to every other wired
unit site-wide (see further down for that later rollout - this next
paragraph documents the original single-unit pilot, whose mechanics and
gotchas still apply everywhere). **Every math-related answer input in
this unit** - fractions,
algebraic expressions, and plain numbers alike - now uses
[MathLive](https://cortexjs.io/mathlive/)'s `<math-field>` custom
element instead of `<input type="text">`, loaded via
`<script src="https://cdn.jsdelivr.net/npm/mathlive@0.110.0/mathlive.min.js">`
in each page's `<head>` (pin the version on any future upgrade — same
convention as each page's existing pinned `mathjax@3` include just
above it): **Practice-Set** (Tabs 1-3's `symRegistry`, Tab 4's Live
Number Check `lc1`-`lc4`, Tab 5's `errorItems`), **Test-Prep** (Tab 1's
`fund-q2`, Tab 2's `erroranalysisProblems`, Tab 3's `mixedPart1`/
`mixedPart2`/`mixedPart3`, Tab 4's exit-ticket `exit-1`/`exit-2`),
**Review** (`onetwoPractice`/`multistepPractice` via the shared
`checkListRegistry`/`renderCheckList`/`checkListItem`), and
**Word-Problems** (`geometryProblems`/`scienceProblems`/
`financeProblems`/`moreProblems`/`challengeProblems` via `wpRegistry`,
plus the standalone `fin-a`/`fin-b` investment-comparison fields).
**Vocabulary-Literacy is the deliberate exception** - none of its
answers are math notation (single variable letters like `"t"`/`"r"`, or
vocabulary terms like `"literalequation"`/`"distribute"`), so it stays
plain `<input type="text">`; a math editor would be worse UX there, not
better, so "every math-related answer" was read to exclude it on
purpose. If this unit's other pages ever gain a genuinely mathematical
answer, wire it in with the same pattern below - don't leave it as a
plain input just because Vocabulary-Literacy is the precedent for
*not* converting something.

**Why most of this needed so little rework.** `<math-field>` happens to
mirror the exact two things a check function and `unlockTeacherView()`
(in `lesson-auth.js`) already relied on from a plain `<input>`: a
settable `.value` property (MathLive's default LaTeX form, so
`displayAnswer` strings like `\dfrac{d}{t}` work for the teacher-view
reveal) and a reflected `.disabled` boolean (so `unlockTeacherView`'s
generic `window.listRegistry` reveal loop needed **zero** changes on
any page using it). Every converted page defines its own copy of two
small helpers (no shared JS module across these static pages, so each
page's `<script>` carries its own): `readMathField(field)` returns
`field.getValue('ascii-math')`, guarded with
`typeof field.getValue === 'function'` first - if the MathLive script
never loaded (blocked network, ad blocker, a cold CDN failure),
`<math-field>` stays an undefined custom element with no such method,
and this treats that the same as an empty answer instead of throwing;
and (on pages with fraction/expression answers) `answerMatches(val, accepted)`
(see below).

**ASCIIMath always double-parenthesizes every fraction, and `accepted[]`'s
own spelling can't be trusted to already anticipate that - normalize
BOTH sides, not just the student's answer.** Checked directly against
MathLive's own source (`atomToAsciiMath`'s `genfrac` case): `\frac{d}{t}`
is *always* serialized as `"(d)/(t)"`, both sides wrapped regardless of
how simple they are. `normalizeExpr()`'s `stripRedundantParens()` step
strips a `(...)` pair only when its content has no top-level `+`/`-`,
matching the convention most `accepted[]` entries follow by hand (e.g.
`"(p-2w)/2"` keeps parens around the multi-term numerator, not the
single-term denominator) - but not every entry follows it: Test-Prep's
`"v/(pir^2)"` keeps parens around a single-term denominator anyway
(for a human reader's clarity), which `stripRedundantParens()` would
still strip from a *typed* answer, producing `"v/pir^2"` - a mismatch
against the unstripped accepted string. Rather than hand-auditing every
`accepted[]` entry's exact parenthesization on every page (fragile, and
the next new problem could reintroduce the same gap), every check
function compares via `answerMatches(val, p.accepted)` -
`accepted.some((a) => normalizeExpr(a) === normalizeExpr(val))` -
normalizing the accepted spelling too, so however it happens to be
written, it collapses to the same canonical form as a correctly-typed
answer. `p.accepted.includes(normalizeExpr(val))` (the pilot's first
version) is the wrong pattern now; don't reintroduce it on a new page.
Verified by simulating every fraction/expression problem across all
four pages (Practice-Set's `errorItems` and Tabs 1-3, Test-Prep's
`erroranalysisProblems`/`mixedPart1`/`mixedPart2`/exit-ticket) through
the real `normalizeExpr()`/`answerMatches()` - all match. If a future
problem's `accepted[]` deliberately keeps parens around a single-term
side for a reason `stripRedundantParens()` can't infer (or nests one
fraction inside another), `answerMatches()` already covers the normal
case above; re-verify by hand the same way for anything unusual rather
than assuming the regex generalizes further than these problems needed.

**A hand-written `revealAnswerKey` has to fill `.value` with LaTeX
(`p.displayAnswer`), not the plain-text `accepted[0]`.** Any page whose
fraction answers aren't part of the generic `window.listRegistry` loop
(Practice-Set's Tab 5 `errorItems`, Test-Prep's Tab 2
`erroranalysisProblems`, Test-Prep's Tab 4 exit ticket) has its own
hand-written reveal code. Before this rollout those set
`answer.value = p.accepted[0]` (or a hardcoded plain string like
`'d/r'`) - harmless on a plain `<input>`, but on a `<math-field>` a
plain-text string like `"v/(pir^2)"` just displays as flat unstyled
characters instead of a real fraction, since MathLive's `.value`
setter expects LaTeX. Fixed by pointing each of these at
`p.displayAnswer` (or, for the exit ticket's two hardcoded checks,
literal LaTeX like `'\dfrac{d}{r}'`) instead. Test-Prep's `mixedPart2`
had no `displayAnswer` field at all (its check never needed one, being
submit-only with no immediate reveal) - added one to each of its two
items so the generic `window.listRegistry` reveal loop has something
correct to show a teacher. Rolling this pattern out further: search a
new page's own `revealAnswerKey` for `.accepted[0]` before assuming its
reveal already works — an unfixed one won't crash, it'll just look
wrong.

**Numeric-only answers went along for the ride, not just fractions.**
Review, Word-Problems, and the numeric portions of Practice-Set (Tab 4)
and Test-Prep (`fund-q2`, `mixedPart3`) never had `accepted[]`/
`normalizeExpr()` at all - they check with `LessonCheck.numericMatch()`,
which already strips anything but digits/`.`/`-` before parsing. These
only needed the input swap and a `readMathField()` read, no
`answerMatches()`/`stripRedundantParens()` - a `<math-field>` is just as
good a place to type a plain number as a text box, and using it
everywhere on a page (not just where fractions appear) keeps one
consistent input experience per page instead of mixing two.

**Rolled out site-wide, except `Lessons/Projects/*` (left untouched on
purpose - a separate, older pattern entirely, see the top of this file).**
What started as an Eighth/Literal-Equations-only pilot was extended to
every other wired unit: Sixth/Decimal-Operations, Sixth/Operations-with-
Fractions, Seventh/Rational-Numbers, Seventh/Integers, Seventh/
Operations-with-Rationals, and Eighth/Linear-Equations. Don't assume
`<math-field>` is available on a page just because its unit is listed
here, though - check for the MathLive `<script>` tag in that specific
page's own `<head>` first, since several pages in these units needed
**zero** changes (see below).

**The dividing line is "is this answer a plain number," not "does the
question involve fractions."** Per the explicit rule this rollout
followed: an answer like `-1`, `5`, `66`, `-56`, `0.25`, or `-9.56`
(however the question got there) stays a plain `<input type="text">`;
an answer that's a fraction, an algebraic expression, an equation, or
anything else with real math notation gets the `<math-field>` editor.
This is a property of the **answer format**, not the question - several
pages ask a fraction-heavy question (e.g. "\(-\frac{1}{2} + (-\frac{1}{3})\)")
but grade the student's answer as a rounded decimal
(`LessonCheck.numericMatch`), and those inputs correctly stayed plain
text (e.g. all of Seventh/Operations-with-Rationals' Practice-Set,
Test-Prep, and Word-Problems - every answer field on those three pages
is decimal-only by the page's own design, confirmed by grepping for
`accepted:`/fraction notation in an actual answer field before touching
anything). Similarly, Seventh/Integers needed no changes anywhere -
every answer across all 5 pages is a plain integer, a comparison
symbol, a word, or a comma-separated list of plain integers, even
though some questions display exponents or fraction-form work.

**A shared render/check template mixing a plain-number/word/symbol
answer with math-notation answers gets one new per-item flag,
`text: true`, rather than being split into two templates or converted
wholesale.** This matters when one shared template (a `listRegistry`/
`checkListRegistry`-style loop) serves a mix of item shapes - e.g.
Seventh/Rational-Numbers' Practice-Set mixes yes/no classification
items with fraction-simplification items under one `renderPracticeList`/
`checkPractice`; Seventh/Rational-Numbers' Word-Problems has one
word-answer item ("yesterday"/"today") and one comma-separated
ordered-list item alongside plain fraction/number word problems;
Eighth/Linear-Equations' Review mixes yes/no like-terms judgment calls
with algebraic-expression combine/distribute answers. Marking the
non-math items `p.text = true` in their data and branching the render
function (`p.text ? <input> : <math-field>`) and the check function
(`p.text ? field.value : readMathField(field)`) keeps the rest of the
shared template's logic and structure completely unchanged. Don't
convert a yes/no or open-ended free-text item to `<math-field>` just
because it lives in the same array as fraction items - the exclusion
rule is per-answer, not per-template.

**Algebraic expressions need two more normalizeExpr steps beyond
fraction paren-stripping: stripping an explicit multiplication mark,
and (rarely) leaving a meaningfully-signed parenthesized group alone.**
MathLive's ASCIIMath export can render a coefficient-times-variable
product with an explicit `*` (e.g. `8x` back as `8*x`), which a plain
`accepted: ["8x"]` won't match without also stripping `*`/`·` in
`normalizeExpr()` (Eighth/Literal-Equations' Practice-Set already did
this for `symRegistry`; Eighth/Linear-Equations' Review and Vocabulary-
Literacy needed the same treatment added). Separately,
`stripRedundantParens()`'s `[^()+-]+` pattern already refuses to strip
a parenthesized group that itself contains a `+`/`-` (e.g. the `(-2.9)`
in a Keep-Change-Change rewrite like `-6.4+(-2.9)`, from Seventh/
Operations-with-Rationals' Guided-Solving-Ladder) - that's intentional,
not a gap, since collapsing that paren would change the expression's
meaning, not just its redundant grouping.

**A hand-written `revealAnswerKey` needs checking even when it isn't
the one being converted, if it fills a field that *is* being converted.**
Eighth/Linear-Equations' Vocabulary-Literacy's `displayAnswer` uses the
pre-delimited `"\(n + 12\)"` convention (see the note above on the
three `displayAnswer` conventions) - its hand-written `fillInput` set
`input.value = answer` directly, harmless on the old plain `<input>`
(showed literal `\(n + 12\)` as flat text) but would make a
`<math-field>` try to parse that string as LaTeX. Fixed the same way as
`unlockTeacherView`: strip the `\( \)` wrapper before assigning `.value`,
while leaving the feedback `innerHTML` (which still wants the delimiters
for MathJax) untouched.

**Seventh/Operations-with-Rationals' Practice-Set/Test-Prep/Word-Problems
originally forced every answer to a decimal - including on problems that
are pure fraction computation - and that was a design mistake, not a
deliberate "numeric-only" exclusion.** The first rollout pass (see
"Rolled out site-wide" above) noticed these three pages checked every
answer with `LessonCheck.numericMatch()` and concluded they needed no
math-field conversion at all, under the "is this answer a plain number"
rule. That was too literal a reading: several of those "decimal" answers
were actually decimal-forced conversions of a pure-fraction problem
(e.g. `-\frac{1}{2} + (-\frac{1}{3})`, answer `-\frac{5}{6}`, forced to
`-0.83`) with no way to type the fraction at all - reported live via a
screenshot of a student stuck on exactly this. Fixed by giving every
problem across all three pages an explicit `format`: `'fraction'`
(the problem uses only fractions - `<math-field>`, and **only** the
exact fraction/whole-number in `accepted[]` counts, no decimal credit),
`'decimal'` (the problem uses only decimals/dollar amounts - unchanged
plain `<input>`), or `'mixed'` (the problem itself combines a fraction
and a decimal quantity - `<math-field>`, and *either* form is accepted,
via `formatMatches(format, raw, p)`: `numericMatch(raw, p.a)` for
decimal, `answerMatches(raw, p.accepted)` for fraction, both OR'd for
mixed). `format` defaults to `'decimal'` where a problem array doesn't
set one (Word-Problems' shared `renderList`/`checkItem`), so most items
on a page needed zero changes - only the pure-fraction and genuinely-
mixed items got a `format` key added. Every fraction value across all
three pages was independently recomputed with exact rational arithmetic
(gcd-reduced numerator/denominator, not eyeballed from an existing
decimal) before being wired into an `accepted[]` list - this is real
grading data, worth the extra step. One answer (Word-Problems' "noon
temperature", `-\frac{3}{4} + 2\frac{1}{4} = \frac{3}{2}`) exceeds
magnitude 1, so its `accepted[]` carries both the improper-fraction
spelling (`"3/2"`, for a student who types it as one fraction) and the
mixed-number spelling (`"1 1/2"`, which normalizes the same way a
math-field's own mixed-number ASCIIMath output does - see the
Sixth/Operations-with-Fractions mixed-number note further up) - don't
assume a single spelling covers both ways a student might type a
magnitude-over-1 fraction answer. **If another unit's page was written
with the same "just force everything to a decimal" pattern, don't
assume it's intentional** - check whether any of its problems are pure
fraction computation with no decimal in sight, the same way these three
were.

**Inequality answers (Eighth/Linear-Inequalities) use `<math-field>`
after all - the earlier "plain text" decision was reversed on explicit
teacher request.** This unit originally kept every inequality answer as
a plain `<input type="text">`, on the reasoning that a solved inequality
is a short, fixed-shape symbolic token rather than a built-up expression,
and that MathLive's ASCIIMath export had never been verified against
`\ge`/`\le` in this sandboxed environment (no CDN access to test it
live). The teacher reviewed the shipped page and asked for the math
editor regardless - "no matter if they just need to add x>5, better to
have them use the math editor" - so every inequality-answer field across
all five graded pages (Practice-Set, Test-Prep, Review, Word-Problems,
Vocabulary-Literacy) was converted to `<math-field>`, and each of those
files' `<head>` now includes the same pinned MathLive `<script>` tag
every other math-field unit uses. **The dividing line stays the same
one used site-wide** ("is this answer a plain number" - see "Visual
math input" above): a field that holds an inequality (solved, like
`x > 5`, or an unsolved setup, like `45n + 150 \leq 600`) became a
`<math-field>`; a field that holds a plain final number (a word
problem's "how many students/months/cupcakes" answer, or a step number
in an Error Analysis item) stayed a plain `<input>` - converting those
too would have been converting numbers that were never inequality
notation in the first place, not what was asked. Every check function
now reads via the same `readMathField(field)` helper as every other
math-field page (`typeof field.getValue === 'function' ? field.getValue
('ascii-math') : ''`, so a MathLive load failure degrades to an empty
answer instead of throwing) instead of a plain `.value` read - the
underlying `normalizeInequality`/`checkInequality`/`normalizeIneqExpr`/
`ineqAnswerMatches` parsing logic needed no changes at all, since it
already tolerated `>=`/`<=` (the exact tokens MathLive's `ascii-math`
export produces for `\geq`/`\leq`, per the ASCIIMath spec both use)
alongside the unicode/sloppy spellings a plain typed answer could also
produce. **The teacher-view reveal had to switch conventions too** -
`fillInput` on every page now writes real LaTeX into a `<math-field>`'s
`.value` (unicode `≥`/`≤` swapped for `\geq`/`\leq` where a page's answer
data stores the readable unicode form) instead of the old plain-ASCII
string, mirroring the same math-field-vs-plain-input branch every other
unit's reveal already makes. Every page in this unit that grades a
solved inequality still defines the identical pair of helpers
(duplicated per-page, same convention as `readMathField()`/
`normalizeExpr()` elsewhere):
- `normalizeInequality(raw, variable)` - strips whitespace, folds
  unicode `≥`/`≤` and the sloppy `=>`/`=<` spellings to ASCII `>=`/`<=`,
  parses either `variable OP number` or `number OP variable` (flipping
  the operator in the second case so `5 < x` and `x > 5` compare equal),
  and returns a canonical `"<variable><op><number>"` string or `null` if
  unparseable.
- `checkInequality(raw, variable, operator, boundary)` - `true` iff
  `normalizeInequality(raw, variable)` equals the canonical form of the
  expected answer.
Verified with a battery of edge cases (spacing, case, both operand
orders, unicode vs. ASCII operators, decimal boundaries, garbage input)
before use in any page. A **separate** pair - `normalizeIneqExpr(s)`/
`ineqAnswerMatches(val, accepted)` - handles the *other* answer shape
this unit needs: an **unsolved**, translated inequality (e.g. "at least
12" → `n>=12`) where the accepted spelling is one specific fixed string
rather than a canonical solved form; this is the same
`normalizeExpr`/`answerMatches` pattern used elsewhere on the site, with
the same unicode/`=>`/`=<` folding added. Don't use the solved-form
checker for a translation item or vice versa - they're deliberately
different because their correctness conditions are different (a
translation has exactly one right spelling; a solved inequality has
several equivalent typings).

**Graphing uses a static, self-contained SVG number line, not an
interactive widget.** `numberLineSvg(boundary, type, direction)`
(duplicated per-page, same as the two helper pairs above) draws a fixed
\(-10\) to \(10\) number line with tick marks, an open or filled circle
at `boundary`, and an arrow/ray toward `'left'` or `'right'` - every
boundary value graphed by this function across the whole unit is a
whole number in that range, so the fixed range needed no generalization.
Used two ways: as a worked-example illustration on Explanation.html
(hard-coded calls, nothing graded), and as the actual graded prompt on
Practice-Set's "Read the Graph" items (student types the inequality the
rendered graph shows, checked via `checkInequality`). The reverse skill
- given an inequality, describe its graph - is graded differently, via
two independent sub-answers (circle type, direction) checked in
`checkDescribe()`, rather than asking a student to somehow "draw" a
graph; open/closed and left/right are graded separately because they're
two independent mistakes, not one. Originally two `<select>` dropdowns -
see "Card-select" below for why and how that changed. A genuinely
interactive, draggable number line was considered and rejected for this
build - the static-SVG-plus-typed-answer / two-choice-description
approach fully covers the graphing standard (HSA.REI.B.3) without
needing new drag-and-drop infrastructure.

### Card-select (touch-friendly replacement for a plain `<select>`)

The teacher reviewed Linear-Inequalities' shipped "Describe the Graph"
item (two `<select>` dropdowns: circle type, direction) and asked for a
site-wide change: "let's change from dropdown to cards to select, if
multiple, two rows of cards so that it's more visually [clear]." A
`<select>`'s native dropdown is small, easy to mis-tap on a touchscreen,
and hides every option until opened - a poor fit for a short, fixed
choice set a student picks between constantly.

**`createCardSelect(containerId, options, config)` in `lesson-shared.js`**
is the shared factory (same "build it once, reuse everywhere" precedent
as `createVocabMatch()` above) - renders `options` (`{value, label}`) as
a row of clickable `.card-select-option` buttons inside the element with
id `containerId`, tracks which one is selected, and re-renders on every
click so the `.selected` styling always matches state. Returns
`{getValue, setValue, reset, disable}` - a page's check/reveal functions
read or force a value the exact same way they would a `<select>`'s
`.value`, except `getValue()` returns `null` (not `''`) when nothing is
picked yet. CSS lives in `lesson-shared.css`: `.card-select-row` (one
labeled row per choice group - "if multiple, two rows of cards" from the
request above is satisfied by giving each group, e.g. Circle Type and
Direction, its own `.card-select-row` stacked vertically, rather than
cramming both into one row of dropdowns side by side), `.card-select`
(the flex row of option buttons within one group), `.card-select-option`
(+`.selected`/`:disabled`).

**Piloted on Linear-Inequalities' "Describe the Graph" item first, then
rolled out to every remaining `<select>` site-wide** (`Lessons/Projects/*`
and `teacher-dashboard.html`'s own admin reset-scope picker excluded -
the former is the separate older pattern documented at the top of this
file, the latter is a teacher-only admin control, not student-facing
graded content) - `describeCardSelects[i]` holds `{circle, direction}`
instances per item on the pilot page, and every other page's own
check/reveal functions read/write through `.getValue()`/`.setValue()`/
`.disable()` the exact same way, instead of touching a `<select>`
element's `.value`/`.disabled` directly. Covered ~20 files across every
grade (Sixth/Decimal-Operations, Sixth/Operations-with-Fractions,
Seventh/Integers, Seventh/Operations-with-Rationals (including its
Guided-Solving-Ladder), Seventh/Rational-Numbers,
Seventh/Squares-Cubes-and-Roots, Eighth/Linear-Equations,
Eighth/Linear-Functions) - both static (non-templated) selects, kept in
a per-page `cardSelects`/similarly-named registry object keyed by
element id so a shared check/reveal function can tell a card-select
apart from a plain `<input>`/`<math-field>`, and templated selects
(rendered per-array-item in a loop), tracked in a parallel array indexed
the same way the array itself is.

**`unlockTeacherView`'s generic `window.listRegistry` reveal loop (in
`lesson-auth.js`) gained a third branch for this**, alongside its
existing plain-`<input>` and `<math-field>` cases: when the looked-up
element has the `card-select` class, it marks the `.card-select-option`
button whose `data-value` matches the answer as `.selected` and disables
every option in the group - directly via the DOM, with no dependency on
that page's own `createCardSelect()` instance (`unlockTeacherView` only
ever has the element id, never a reference to the instance itself). This
is what let `Seventh/Operations-with-Rationals/Guided-Solving-Ladder.html`'s
multiple-choice items convert with no hand-written reveal code at all -
they were already in `window.listRegistry`. **Bump `lesson-auth.js`'s
`?v=` cache-bust number across every referencing page whenever this
generic function changes again** - same rule as any other `lesson-auth.js`
edit (see "Persisted sign-in" above); this rollout bumped it to `v10`.

**Converting a `<select>` to card-select surfaced several already-present
`LessonCheck.check(...)` calls silently missing their `record` argument**
- the exact historical bug class documented above under "Saving student
progress," just never caught on these specific items because nobody had
touched that code since. Found and fixed on `Sixth/Decimal-Operations`
and `Sixth/Operations-with-Fractions`'s Vocabulary-Literacy word-sort/
translate checks (both used the lower-level `LessonCheck.show()`, which
only renders feedback and never records at all - `LessonProgress.record()`
calls were added directly after each), and on `Seventh/Integers` and
`Seventh/Rational-Numbers`'s Vocabulary-Literacy operation-vocabulary/
clue-word/compare-words checks (`LessonCheck.check(...)` calls that
omitted the 5th `record` argument entirely). **Any time this card-select
conversion touches an existing check function, read its full call before
assuming it already saves correctly** - converting the input without
verifying this would have preserved a pre-existing, unrelated data-loss
bug instead of fixing it.

**A full site-wide audit (AST-based, not regex) found 10 more instances
of this exact bug class, none related to card-select - fixed in one
pass.** Requested directly: "review everything again against the
grading system... review the mechanism for answer key is consistent as
well." A naive regex scan for `LessonCheck.check(...)` call sites with
fewer than 5 arguments produces heavy false positives (a regex literal
or template-string expression containing a literal `(`/`)` - e.g.
Strategy Challenge's `g.eq.replace(/\\\(|\\\)/g, '')` - confuses a
paren-counting regex into miscounting real, correctly-5-argument calls);
the reliable way to check this is a real JS parser (TypeScript's
`ts.createSourceFile` + walking `CallExpression` nodes, since neither
`acorn` nor `espree` are installed in this environment but `typescript`
is) counting each call's actual `arguments.length`. That pass found 10
genuinely broken calls (all missing the whole 5th argument, not just
malformed) across 8 files: `Eighth/Linear-Equations/Vocabulary-Literacy.html`
(Tab 2 Translation Practice, `tr-*`), `Eighth/Linear-Functions/Vocabulary-Literacy.html`
(Tab 2 Domain & Range, `dr-*`), `Eighth/Literal-Equations/Vocabulary-Literacy.html`
(Tab 2 Reading a Formula, `rd-*`), `Seventh/Integers/Vocabulary-Literacy.html`
(Tab 1 Number Vocabulary `nv-*`, and Tab 3 Word-Problem Clue Words'
`checkTranslate(keyPrefix, idx)`), `Seventh/Operations-with-Rationals/Vocabulary-Literacy.html`
(Tab 1 Quick Refresher `qr-*`, and the same Tab 3 `checkTranslate`
pattern), `Seventh/Rational-Numbers/Vocabulary-Literacy.html` (Tab 1
Number System Vocabulary, `nv-*`), `Seventh/Squares-Cubes-and-Roots/Vocabulary-Literacy.html`
(Tab 2 Reading & Writing Radical Notation, `tr-*`), and
`Sixth/Operations-with-Fractions/Explanation.html`'s Tab 7 "Whiteboard
Modeling" - the one non-Vocabulary-Literacy hit, and a reminder that
this bug isn't confined to one page type: any check function anywhere
can have it. Every one of these had been silently losing every student
attempt since the page shipped - correct/incorrect feedback rendered
normally on screen, nothing ever reached `Progress.SubmissionsLog`.
Fixed with the same `{label, answer, section}` shape used everywhere
else (section taken from that item's own tab name, label from the
item's own question text/`p.q`), re-verified with the same AST script
(0 remaining short calls site-wide) and live Playwright tests against
the real pages (each fixed item now appends a correctly-shaped
`LessonProgress` entry) plus a live `unlockTeacherView()` run across 13
pages spanning every registry pattern (hand-written `revealAnswerKey`,
`window.listRegistry`, card-select, Guided-Solving-Ladder, an
Explanation-only banner) with zero JS errors and every answer key
field populated, including all 10 just-fixed items. Also audited every
`LessonCheck.submit(...)` call site-wide the same way (required 2nd
`record` argument missing or a literal `null`/`undefined`) - all 83
calls were clean, nothing to fix there. **If a future audit needs to
repeat this check, don't reach for a regex-based paren counter** - it
will both under- and over-report; parse each `<script>` block with a
real parser (`ts.createSourceFile(..., ts.ScriptKind.JS)` works fine on
plain JS despite the "TypeScript" name) and inspect `CallExpression`
argument counts directly.

### Vocabulary Match-Up (drag-and-drop term/definition/example widget)

The old "Quick Vocabulary Check"/"Check Your Understanding" self-check
pattern on `Vocabulary-Literacy.html` — a stack of fill-in-the-blank
boxes ("Type the vocabulary word that matches...") or, on two Sixth
pages, a stack of `<select>` multiple-choice boxes — was reported as
looking cramped and awkward on screen (a teacher screenshot showed
several nearly-identical "Locked - Answer key" boxes stacked one after
another). Replaced with a 3-column drag-and-drop match-up, modeled on
an existing activity in `Lessons/Projects/Ethical-Auditor-Community-
Engineer/index.html` (that file's `VOCAB_TERMS`/`renderVocabMatch()`/
`onVocabDrop()` pattern) but reimplemented as a shared, reusable factory
rather than copied per-page.

**`createVocabMatch(config)` in `lesson-shared.js`** is the shared
factory — one call per page, returns one instance a page keeps as a
page-level `const vocabMatch` (the identifier name is fixed: the
instance's own rendered `onclick`/`ondrop` handlers call back through
the literal string `vocabMatch`, not a name read from `config`, so
renaming the variable breaks the handlers). Config: `{termsId, defsId,
exsId, feedbackId, terms: [{key, term, def, example}], progressKey,
progressLabel, section}`. `def`/`example` render as raw `innerHTML`
(same convention as every glossary card) so they can carry LaTeX
(`\\(...\\)`) or `<strong>` — author them, never populate them from
student input. Drag a term onto its matching definition and onto its
matching example (both required for that term to earn credit); tap-to-
select (tap a term, then tap a definition/example) is the touch
fallback for devices where drag doesn't work reliably. On full
completion, calls `LessonProgress.record(progressKey, progressLabel,
"All N terms matched...", 'correct', section)` directly (not through
`LessonCheck.check()`, since this isn't a single right/wrong answer) —
see "Saving student progress" above for why this call is what actually
makes an attempt reach the backend. `vocabMatch.reveal()` is the
teacher-view hook: call it from the page's own `window.revealAnswerKey`
alongside whatever else that function already reveals (a page can mix
a match-up tab with hand-written reveal logic for its other tabs, as
several already do).

**CSS lives in `lesson-shared.css`**: `.match-wrap`/`.match-col`/
`.match-col-heading`/`.match-card` (+`.selected`/`.matched`)/
`.match-badges`/`.match-badge` (+`.done`)/`.match-slot` (+`.matched`/
`.wrong-flash`). **`.match-slot`'s definition/example content is
wrapped in a `<span>`, not dropped straight into the flex container** -
a real bug this surfaced once: `.match-slot` is `display:flex;
align-items:center` for vertical centering, and CSS flexbox turns each
direct child into its own flex item - a definition string containing
plain text plus an inline element (e.g. `"...the graph is
<strong>not</strong> a function."`) split into three separate flex
items (text, `<strong>`, text) that laid out as a broken multi-column
row instead of one wrapped paragraph. Wrapping the whole thing in one
`<span>` makes it a single flex item again, so its own inline content
wraps normally. Don't strip that wrapper without re-verifying against a
definition that actually contains inline markup (most don't, which is
why this went unnoticed in the original Projects-folder version this
was modeled on).

**Rolled out to 6 of the 9 `Vocabulary-Literacy.html` pages** — every
one whose old self-check tab was a single, standalone "match the term"
tab: `Eighth/Linear-Functions`, `Eighth/Linear-Equations`,
`Eighth/Literal-Equations`, `Seventh/Squares-Cubes-and-Roots`,
`Sixth/Decimal-Operations`, `Sixth/Operations-with-Fractions`. Term/def/
example content was sourced directly from each page's own Tab 1
glossary (never invented fresh), so the match-up stays word-for-word
consistent with the reference material a student already read. Two
pages' term sets got a small edit rather than a straight port: Eighth/
Literal-Equations dropped a letter-identification item ("in \(I=Prt\),
which letter is principal?" - no def/example to match against) in favor
of the glossary's own "Formula" term; Sixth/Decimal-Operations and
Sixth/Operations-with-Fractions (both originally multiple-choice
`<select>` quizzes, not fill-in-the-blank) reused their existing
"correct choice" text as the definition and pulled a matching example
from Tab 1's Word Bank cards.

**NOT rolled out to `Seventh/Integers`, `Seventh/Operations-with-
Rationals`, `Seventh/Rational-Numbers`** — these three never had a
standalone "match the term" self-check tab to begin with; their
vocabulary practice (select-dropdown classification, clue-word
matching, operation-vocabulary matching) is spread across all of that
page's tabs as a different, already-varied interaction shape, not the
repetitive stacked-box pattern that prompted this change. Converting
those would mean redesigning that page's whole tab structure, not
swapping one tab's widget - a bigger, separate decision nobody has
asked for yet. Don't assume these three need the same treatment without
checking with the teacher first.

### index.html is also gated now

Unlike a lesson page, the index links to many activities rather than
being one itself, so it calls a third request type, `identify` (email +
role + grade only, no `ActivityCatalog`/grade check against a specific
activity — see `Code.gs`'s `identify` branch).

- **Teacher** (`Teachers` tab): unrestricted — every grade, every topic,
  every section including the Teacher's Guide, exactly like the index
  behaved before any of this existed.
- **Student** (`Roster`): only their own grade's panel (no grade picker),
  and within it, only sections a topic explicitly lists an `activityId`
  for in `CURRICULUM` (see the `Rational Numbers` topic under `Seventh`
  for the pattern). The Teacher's Guide section never shows for a
  student, full stop, regardless of whether it's "wired." A topic with
  no wired sections at all doesn't show as an empty card — it's just
  omitted.

**Every topic in `CURRICULUM` now has an `activityIds` block** — all
eight grade-6/7/8 units (Sixth's two, Seventh's three, Eighth's three)
are visible to a signed-in student on the index, plus the two Honors/Pre-AP
topics under the `7-Honors`/`8-PreAP` grade keys (see "Grade tracks
beyond 6/7/8" further up). As new units get added and wired the same
way, add their `activityId`s to `CURRICULUM` the same way, or a
signed-in student won't see them on the index even once the pages
themselves work.

**`GRADE_ORDER` and each grade's `topics` array are ordered by actual
teaching sequence, not alphabetically or by when a unit was added to
this file.** Reported live: the grade picker and topic cards read as
out of order to a teacher scanning the index top-to-bottom.
`GRADE_ORDER` is `["Sixth", "Seventh", "7-Honors", "Eighth", "8-PreAP"]`
- the Honors/Pre-AP track for a grade sits immediately after that
grade's regular track, not clustered at the end. Within `Eighth.topics`,
the order is Linear Equations → Literal Equations → Linear Inequalities
- matching the order these are actually taught, not the order they were
added to this file (Linear Inequalities was built after Linear
Equations but before Literal Equations got its own unit here, so the
array's insertion order and the teaching order had drifted apart).
**When adding a new topic to an existing grade, insert it at its correct
teaching-sequence position in that grade's array - appending to the end
is only correct if the new unit is genuinely taught last.**

**`equalizeTopicCardHeads(panelEl)` pins every visible `.topic-card-head`
in a grade panel to the same height.** Reported live as looking
misaligned/OCD-triggering: a topic with a longer `summary` string wraps
to more lines than one with a shorter summary, and since each card's own
head/body split is independent, the section-link buttons below the head
started at a different vertical position card to card within the same
row - even though the grid already stretches every *card* in a row to
the same overall height, the *split* between head and body inside each
card wasn't equalized. Fixed by measuring every `.topic-card-head` in
the panel actually being shown and setting `min-height` on all of them
to the tallest one, rather than hardcoding a fixed pixel value that
would go stale the next time a topic's summary text changes length.
Called after every render that can change which panel is visible
(`renderForTeacher()`, `renderForStudent()`, `showGrade()`) and again on
a debounced `resize` listener, since how many lines a summary wraps to
depends on viewport width. Never call it against a `display:none` panel
- `offsetHeight` reads `0` there, which would zero out every head's
`min-height` instead of matching them.

### Teacher-Guide pages: no dedicated answer-key tabs, real differentiation content instead

**Every `Teacher-Guide.html`'s standalone "Answer Key" tab(s) are redundant
now, and Linear-Inequalities' has been rebuilt as the pilot for removing
them.** The teacher pointed out directly that answer keys already live on
each student page itself — sign in as a teacher and `unlockTeacherView`
fills in every problem inline (see "Role differentiation on lesson
pages" above) — so a separate answer-key tab duplicating the exact same
content on the Teacher-Guide page serves no purpose. `Eighth/Linear-
Inequalities/Teacher-Guide.html` was rebuilt from 4 tabs (Topic Overview
&amp; Pacing, two Answer-Key tabs, IXL Practice) to 5: **Topic Overview
&amp; Pacing** (kept), **Lesson-by-Lesson Guide** (NEW — replaces both
answer-key tabs' screen real estate with a per-page, per-tab explanation
of what each of the unit's six pages and every tab inside them actually
covers — the teacher separately asked for exactly this: "the teacher's
guide can have a little explanation on each activity per each Unit...
Lesson/Activity... Tab"), **Metacognition &amp; Discussion** (NEW —
reflection-prompt stems plus three leveled small-group discussion
prompts, Building Understanding/Applying/Extending), **Differentiation**
(NEW — real scaffolded support problems with the hint text meant to be
read aloud, and extension/challenge problems that stay within the
unit's own standard scope rather than reaching into a later lesson's
content, both with real worked answers, not just a list of IXL links),
and **Challenge Bank** (see below). **Piloted on Linear-Inequalities,
then rolled out to all 9 units site-wide** across two passes: first the
7 regular-track units (`Sixth/Decimal-Operations`, `Sixth/Operations-
with-Fractions`, `Seventh/Integers`, `Seventh/Rational-Numbers`,
`Seventh/Operations-with-Rationals`, `Eighth/Linear-Equations`,
`Eighth/Literal-Equations`), then the two Honors/Pre-AP-only units
(`Seventh/Squares-Cubes-and-Roots`, `Eighth/Linear-Functions`) once the
teacher confirmed the same pattern should apply there too. **Every
Teacher-Guide.html on the site now has this shape** — Overview &amp;
Pacing, Lesson-by-Lesson Guide, Metacognition &amp; Discussion,
Differentiation, Challenge Bank, IXL Practice — no unit still has the
old dedicated answer-key tab(s).

**The two Sixth-grade units already had their own "Misconceptions &amp;
Differentiation" tab from an earlier pass, so those two got a slightly
different treatment than the rest: the four "Key: X" tabs were
still replaced by one Lesson-by-Lesson Guide, and a new Metacognition
&amp; Discussion tab was still added, but no separate new
"Differentiation" tab was created — instead, the existing Misconceptions
&amp; Differentiation tab was extended in place with new "Scaffolded
Support Problems" and "Extension / Challenge Problems" subsections,
keeping its own id (`misconceptions`) and every misconception already
documented there untouched.** Every other unit (three Seventh, four
Eighth) had no pre-existing differentiation content, so they got a
genuinely new `differentiation` tab, matching Linear-Inequalities'
own shape exactly.

**"No printed elements needed, all digital" — a second, later teacher
instruction that superseded the earlier "leave existing printables
alone" scoping.** The first Teacher-Guide pass (pilot plus the 7-unit
rollout above) deliberately left every unit's own "Printables &amp;
Challenge Bank"/"Printables &amp; Key"/"Challenge Bank" tab untouched,
reasoning that printable worksheets with their own answer key (for
grading *paper* work) were a genuinely different feature from the
redundant on-screen answer-key tabs being removed. The teacher later
asked directly for that print-based workflow to go away too, site-wide,
consolidated into one consistently-named digital tab per unit. Every
unit's Teacher-Guide now has exactly one **Challenge Bank** tab
(panel id `challenge` on most units; `resources`/`paper` on a couple
where the id predates this pass and renaming the id wasn't necessary):
- **Every download link to a `printables/*.html` file was removed** from
  every Teacher-Guide (`Seventh/Integers`, `Seventh/Rational-Numbers`,
  `Seventh/Operations-with-Rationals`, `Eighth/Linear-Equations`,
  `Eighth/Literal-Equations`, `Sixth/Decimal-Operations`).
  `Eighth/Linear-Equations` and `Eighth/Literal-Equations` each had
  *two* separate tabs ("Printables &amp; Key" + "Challenge Bank") merged
  into one. **No file under any unit's own `printables/` folder was
  deleted** — only the links to them from the Teacher-Guide were
  removed; the folders themselves are untouched and still exist.
- **Content that functioned as the actual graded/paper assessment**
  (a Mixed Practice or Timed Review Quiz printable meant as a
  confidential paper test) was never transcribed into the Challenge
  Bank tab — every unit's on-screen Test-Prep page already has a
  submit-only, no-retry Mixed Practice tab that reveals nothing to the
  student, so that digital tab now *is* the assessment, graded from the
  teacher dashboard's submission log. Every Challenge Bank tab says
  this explicitly in a short note near the top.
- **Genuinely useful content that only existed as a printable** (a
  formula reference sheet, small-group activity cards, official Savvas
  worksheet problems with their own answer key) was inlined as normal
  digital tables/cards under the Challenge Bank tab rather than simply
  dropped — the answers/content survive, only the "print this" call to
  action is gone. Small-group activities that used to need physical
  cards (Error Analysis cards, Formula Rearrangement cards, Strategy
  Challenge cards) now point teachers at running the same activity
  directly from the on-screen student page instead.
- **Sixth-grade units' "Teacher Resources" tab was renamed to "Challenge
  Bank"** (not merged with the separate Misconceptions &amp;
  Differentiation tab — those stay two different tabs) — its Printables
  Index box and confidential paper-assessment point breakdown were
  removed the same way, while its already-digital content (Additional
  Practice/Quick Check/Enrichment tables, IXL Skill Codes) stayed
  exactly as-is under the new name.
- **Units with no pre-existing printable/challenge content at all**
  (`Sixth/Operations-with-Fractions`, and both Honors/Pre-AP units when
  they were first redesigned) still got a Challenge Bank tab for
  consistency — `Operations-with-Fractions`' says plainly there's
  nothing there yet rather than fabricating filler, while
  `Squares-Cubes-and-Roots` and `Linear-Functions` (built fresh in the
  second pass) each got 5 genuinely new, original challenge problems
  with click-to-reveal solutions (`.challenge-box`/`.solution-toggle` —
  copy this exact markup/CSS from an existing unit's Teacher-Guide
  rather than inventing new styling) since they had no separate
  printables tab to migrate from in the first place.
- Every stray cross-reference elsewhere in a file (Materials Needed,
  the pacing table, a "see Printables tab" note inside the Lesson-by-
  Lesson Guide) that assumed a printable/paper workflow still existed
  was rewritted to describe the digital equivalent instead — a Teacher-
  Guide redesign that leaves a dangling "see the printed X" sentence
  pointing at nothing is worse than one that never mentioned printing
  at all, so these were fixed as part of the same pass, not deferred.

**Two known content gaps, both since fixed — a pattern worth checking
on any Teacher-Guide you haven't touched yet:** `Eighth/Literal-
Equations`, `Seventh/Squares-Cubes-and-Roots`, and `Eighth/Linear-
Functions` all had an Overview &amp; Pacing "Section/Purpose/Suggested
Time" table listing only 5 of that unit's actual 6-7 pages — every one
of them was missing a row for `Review.html` (Literal-Equations was also
missing `Guided-Solving-Ladder.html`, added as an explicit "Additional
resource" row with a link, not folded into the regular sequence). All
three were corrected as they were found. If a future edit touches
another unit's Overview table, cross-check its row count against that
unit's actual page list (`ls` the unit's folder) before trusting the
table is complete.

**IXL link lists were "chunky" — several files crammed 2-4 links into
one dense inline paragraph, comma-separated, instead of one per line —
reformatted site-wide (not just the pilot unit) since it was a
mechanical, low-risk fix.** Two shapes existed: an `<strong>Also
consider:</strong>` paragraph following a page's main `<ul>` (a
secondary/optional skill suggestion), and a denser `<strong>Label</strong>
(context): <a>...</a>, <a>...</a>, ...` paragraph under "Building on
Previous Topics"/"Differentiation &amp; Additional IXL Practice"
headings citing several grade-levels-back foundational skills at once.
Both were converted to the same `<ul><li>` shape every other IXL list on
the page already uses — one link (plus its `<span class="ixl-code">`)
per line — while preserving any trailing prose sentence (e.g. "Send any
student who is still shaky on sign rules or conversions back to those
topics before this one.") as its own paragraph after the list rather
than losing it. Touched 8 files: `Eighth/Literal-Equations`,
`Eighth/Linear-Equations`, `Eighth/Linear-Functions`,
`Eighth/Linear-Inequalities`, `Seventh/Integers`,
`Seventh/Operations-with-Rationals`, `Seventh/Rational-Numbers`,
`Seventh/Squares-Cubes-and-Roots` — every `Teacher-Guide.html` that had
at least one multi-link inline paragraph. `Sixth/Decimal-Operations`
and `Sixth/Operations-with-Fractions` were checked and had none to fix.
If a future IXL addition ever crams more than one link into a single
`<p>` again, split it into a `<ul>` the same way rather than
reintroducing the dense inline style.

### Reference materials for content authoring — check these before building/citing anything

Two local reference sources exist in this repo specifically so content
work (new units, IXL tabs, standards citations) never has to guess or
fabricate. **Check both before writing a new unit or adding IXL/standards
references to an existing one** — this was missed once already (an
entire session spent researching IXL codes via blocked web access before
realizing `IXL/` already existed locally with real, pre-verified data).

- **`IXL/` (repo root)** — `IXL/README.md` indexes four grade-level
  files (`5th/`, `6th/`, `7th-Accelerated/`, `Algebra-1/`), each a
  snapshot (dated 2026-09-09) of IXL's own published skill-alignment
  guide for the exact Savvas enVision book/edition this school teaches
  from, organized Topic → Lesson → IXL skill (name + direct link + the
  3-character code). This is the *only* source that should ever feed a
  Teacher-Guide's "IXL Practice" tab — never fabricate a code or guess
  at IXL's URL slug pattern, and never rely on a web search result's
  claimed code (tested live: search-engine summaries gave three
  different codes for the same skill in one query). `ixl.com` itself is
  blocked by this environment's network egress policy, so `IXL/` is not
  just a convenience, it's the only way to get real codes at all here.
  Match a unit's actual lessons to the file's Topic/Lesson headings by
  content, not by number alone — book Topic/Lesson numbers don't always
  line up with this site's own unit names (e.g. the "Linear Equations"
  *site* unit is Topic 1 in the Algebra 1 book, not the book's own
  Topic 2, which is confusingly also literally titled "Linear
  Equations" but covers slope-intercept/graphing instead). If a skill a
  unit teaches has no real match in the relevant file, say so and leave
  it uncited — don't force the nearest-sounding code onto it (see
  Squares-Cubes-and-Roots' and Linear-Functions' own IXL panels for two
  worked examples of exactly this: each names the specific skill it
  couldn't verify a code for, rather than omitting the gap silently).
- **`Math Department Curriculum Map & Year Plan.xlsx` (repo root)** —
  one sheet per course (`Math 6`, `Pre Algebra`, `Pre Algebra Honors`,
  `Algebra I`, `Algebra I Honors`), one row per teaching week, columns
  including `Theme / Unit Title` and `Standards` (the exact CCSS/HSA/
  HSF/etc. codes, often several per week, each with its full official
  text — not just the bare code). This is the source of truth for which
  standard(s) a given lesson/unit addresses — cross-reference by
  matching a site unit's actual lesson **name**/content against a row's
  `Theme / Unit Title` text, **never by the embedded lesson number**
  (e.g. "2-4") — the book's own numbering was updated this year, so a
  number in the map row can't be trusted to line up with a number
  anywhere else (not the site's own unit, not last year's map, not a
  teacher's memory of "that used to be lesson 3"). Two map rows can
  legitimately share a name almost verbatim while meaning different
  content (see the Linear Equations/Topic-2 example above) — resolve
  that by reading the row's full lesson title and description, not by
  trusting whichever number sits in front of it. Read the **full,
  untruncated** cell text before concluding a match — a first pass at
  this that truncated cells to 200 characters for display silently
  dropped extra standard sub-parts sitting later in the same cell
  (`7.NS.A.1c`/`1d` on an add/subtract row, `7.NS.A.2c` on a multiply/
  divide row, `HSF-IF.B.5`/`HSF-LE.A.2` on a functions row) — always
  read the raw cell value (e.g. via `openpyxl` — not preinstalled, `pip
  install openpyxl` first) rather than any pre-summarized or truncated
  dump of it. One site unit can span several of the map's weekly rows,
  and one row can straddle two lessons — collect every standard from
  every row whose name/content genuinely matches the unit before
  finalizing its list, don't stop at the first hit.

### Standards line (the citation under every lesson page's title)

Every lesson page (`Review.html`, `Vocabulary-Literacy.html`,
`Explanation.html`, `Practice-Set.html`, `Word-Problems.html`,
`Test-Prep.html`, `Teacher-Guide.html`, and both `Guided-Solving-
Ladder.html` pages — every page type, not just the student-facing five)
has a one-line standards citation immediately under its `<h1>`:
`<p class="standards-line">Standards: <code(s)>, <code(s)>...</p>`,
styled via `.standards-line` in `lesson-shared.css` (`margin: 6px 0 0
0; font-size: 0.85rem; font-weight: 700; opacity: 0.82; letter-spacing:
0.02em;` — deliberately a plain styled line, not another `.badge`
pill). It's inserted once per file, right after that file's single
`</h1>`, identical text across every page in one unit (a whole unit
teaches the same standard(s), not a different subset per page type).

**The codes must come from `Math Department Curriculum Map & Year Plan.xlsx`
(see "Reference materials" above), matched by lesson name/content —
never by lesson number, and never fabricated or guessed from the
standard's own title/number alone.** If a unit's content doesn't
cleanly match anything in the map, say so and leave a gap noted rather
than forcing the nearest-sounding standard onto it — same rule as the
IXL codes above.

**Current per-unit citations** (as of the most recent correction pass —
verify against the map again before trusting these blindly on a future
edit, don't just copy this table forward indefinitely):

| Unit | Standards line |
|---|---|
| Sixth/Decimal-Operations | `6.NS.B.2, 6.NS.B.3` |
| Sixth/Operations-with-Fractions | `5.NF.A.1, 6.NS.A.1` |
| Seventh/Integers | `7.NS.A.1a, 7.NS.A.1b, 7.NS.A.1c, 7.NS.A.1d` |
| Seventh/Rational-Numbers | `7.NS.A.1b, 7.NS.A.1c, 7.NS.A.1d, 7.NS.A.2a, 7.NS.A.2b, 7.NS.A.2c, 7.NS.A.2d` |
| Seventh/Operations-with-Rationals | `7.NS.A.1b, 7.NS.A.1c, 7.NS.A.1d, 7.NS.A.2a, 7.NS.A.2b, 7.NS.A.2c` |
| Seventh/Squares-Cubes-and-Roots (7-Honors) | `8.EE.A.2` |
| Eighth/Linear-Equations | `HSA.CED.A.1, HSA.REI.A.1, HSA.REI.B.3` |
| Eighth/Linear-Inequalities | `HSA.CED.A.1, HSA.REI.A.1, HSA.REI.B.3` |
| Eighth/Literal-Equations | `HSA.CED.A.4` |
| Eighth/Linear-Functions (8-PreAP) | `HSA.CED.A.2, HSS.ID.C.7, HSF-IF.A.1, HSF-IF.B.5, HSF-LE.A.2` |

Notes worth knowing before touching any of these again:
- Rational-Numbers and Operations-with-Rationals deliberately do **not**
  carry `7.NS.A.1a` ("opposite quantities combine to make 0") — the
  map ties that specific sub-standard to the Integers-flavored
  add/subtract lessons, not the Rational-Numbers-flavored ones, even
  though both units add/subtract signed numbers.
  `Seventh/Integers` is the only unit that carries it.
- Eighth/Linear-Functions' citation is deliberately broader than the
  older, pre-existing "Standards & Objectives" text on its own
  Teacher-Guide Overview tab (which cites `HSF.IF.A.2`, function
  notation) — that older text was written before this session had
  access to the map and was never itself verified against it;
  `HSF.IF.A.2` does not appear anywhere in the map's Algebra I or
  Algebra I Honors sheets, so it was deliberately **not** carried into
  this standards-line badge. That older Overview-tab text itself was
  left alone (out of scope for this feature) — don't assume the two
  are supposed to match, and don't "fix" one to match the other without
  re-verifying both against the map first.
- Eighth/Linear-Inequalities carries the **identical** standards line to
  Eighth/Linear-Equations, not a coincidence or a copy-paste error: both
  units come from the same Algebra I Topic 1 map rows (Q01W02-W05), and
  the map cites the same `HSA.CED.A.1, HSA.REI.A.1, HSA.REI.B.3` trio on
  Lesson 1-5's own row (the inequalities lesson) as it does on
  Lessons 1-2/1-3's rows (the equations lessons) - the standards
  genuinely don't distinguish equations from inequalities at this grain.
  `HSA.CED.A.4` (Literal-Equations' own citation, "rearrange formulas")
  correctly stays off this unit's line, same reasoning as every other
  exclusion in this list - it belongs to a different lesson (1-4) that
  this unit doesn't teach.
- A brand-new unit gets this the same way any of the above did: find
  its lessons' name-matching row(s) in the map, pull every standard
  those rows cite (full untruncated text), union them, and add the
  `<p class="standards-line">` line to every one of that unit's page
  types — this table needs a new row too, or the next session won't
  know the citation exists without re-deriving it from scratch.

### Flow

1. Teacher shares an activity link.
2. Page shows a sign-in gate before any lesson content renders.
3. Student signs in with Google → front-end sends the ID token + `activityId`
   to the Apps Script backend as an `access-check` request.
4. Backend verifies the token, looks up `Roster`, compares `Roster.Grade`
   to `ActivityCatalog.Grade` for that activity, logs the result to
   `AccessLog`, and either denies or unlocks the page (returning any
   existing `Progress` row so the student resumes where they left off).
5. Every check/submission on the page also posts to the backend
   (`submission` request type) — appended into that same `Progress` row's
   `SubmissionsLog`, never a new row.

### Status

Done: OAuth client + consent screen created, `hd`-domain check validated
live against a real `lincoln.edu.ni` account. Sheet created with all 4
tabs. Apps Script deployed as a Web App (URL above).

Not yet done: the deployed script hasn't been tested end-to-end with a
real ID token, `Roster`/`ActivityCatalog` may only have test rows in
them rather than the real class lists, and no lesson page has been
wired to any of this yet. Don't assume student-facing pages work until
that's true.
