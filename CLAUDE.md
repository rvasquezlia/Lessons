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
  `7`.
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
hide the now-pointless "Teacher" filter dropdown for a scoped account.

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
`--bg`/`--border` bar like the rest of the site's cards) and has six
tabs, all driven by the same `allRows`/`roster`/`activityCatalog`
globals and a shared `Grade`/`Teacher`/`Activity`/"flagged only" filter
bar. None of the tab panels carry an explanatory `<p>` under their
`.section-title` anymore — the tab name plus the table's own column
headers are the interface; a per-tab paragraph restating "one row per
X, click a row to see Y" was decided to be redundant with that.

Tab order is **Overview, By Unit, By Activity, By Student, Activity
Status, All Submissions** — the three "By X" drill-downs sit together,
Activity Status (engagement funnel) comes right after them, and All
Submissions (the flat raw log) stays last since it's the destination
everything else summarizes from, not a place to land first. Activity
Status used to sit between By Unit and By Activity, which read as an
arbitrary interruption of the "By X" group; moving it after them was a
front-end-only reorder (nav buttons + matching `.panel` divs), nothing
in `Code.gs` or the data shapes changed.

**Every list tab defaults to alphabetical order**, not a score/date
ranking — `sortState` in `teacher-dashboard.html` sets By Unit/By
Activity/Activity Status to `activityTitle`/`unit` ascending and By
Student/All Submissions to `studentName` ascending. A teacher scanning
for one specific student or activity shouldn't have to hunt through a
ranked list first; clicking any column header still re-sorts by that
column exactly as before, this only changes what a tab shows before any
click.

- **Overview** — summary only, deliberately: stat tiles (active
  students, activities, average score, not-started count, flagged
  submissions), a "Progress by unit" bar chart, lowest-scoring-activity
  and lowest-scoring-student bar charts, and a "Flags" card (count plus
  a breakdown by flag reason) with a "View all flagged submissions" link
  that checks the flagged-only filter and jumps to All Submissions
  (`jumpToFlagged()`). It never lists individual students or a raw event
  feed — that used to live here (a "Students who haven't started" list
  and a global "Recent activity" feed) but got moved into the
  per-student/per-activity detail views below, where it's actually about
  something instead of everyone's events interleaved.
- **By Unit** — one row per `ActivityCatalog.Unit` (+ grade, since two
  grades could reuse a unit name), aggregated from the same per-activity
  numbers `computeActivitySummaries()` produces
  (`computeUnitSummaries()` just groups those instead of re-deriving
  anything, so it can't disagree with By Activity). Click a unit to see
  every activity in it; click an activity there and it jumps straight to
  that activity's own detail view on the By Activity tab
  (`jumpToActivity()`) — a unit number is never a dead end.
- **By Activity** — one row per catalog activity (including activities
  nobody has started), with a completion percentage computed against
  how many *eligible* roster students exist for that grade (and teacher,
  if filtered). Click an activity for its own mini dashboard: stat
  tiles, a score-by-student bar chart, the full per-student table, and
  that activity's own "Recent activity" timeline (built from
  `Progress.SubmissionsLog` timestamps, scoped to just this activity).
- **By Student** — one row per roster student (including students with
  zero `Progress` rows, so "hasn't started anything" is visible instead
  of just absent), averaged across every activity they've touched. Click
  a student for their full profile: stat tiles, a score-by-activity bar
  chart, the full per-activity table, and their own "Recent activity"
  timeline across everything they've touched.
- **Activity Status** — "are students actually opening this?", answered
  with a four-state funnel per activity (Not started / Opened only / In
  progress / Completed), computed by `computeActivityStatusBreakdown()`
  from `Progress` alone: no row at all is Not started; a row with
  `reachedEnd` is Completed; a row with graded items but no `reachedEnd`
  is In progress; a row with neither (only tab views logged) is Opened
  only. Above the per-activity table, `renderActivityStatusChart()`
  draws one aggregate stacked bar (plus a count legend) summing every
  filtered activity's own breakdown into a single "how's the whole
  filtered set doing" graph — the table alone only shows this per
  activity, one row at a time. Click an activity row to see which
  student is in which state, with stat tiles for the same four counts
  scoped to just that activity. This is the dashboard's only engagement
  view now - the tab that used to read `AccessLog` (see below) is gone
  entirely.
- **All Submissions** — the original flat one-row-per-(student,activity)
  table, kept as the detail view everything else summarizes from. This
  is the one tab that keeps the older inline-expand-a-row pattern
  (`toggleDetail()`) instead of a separate detail view — it's already
  the raw per-item layer, not a summary that would otherwise dead-end.

**There is no Access Log / Denied Access tab anymore** — it was removed
outright, not just renamed a second time. It read the backend's
`AccessLog` data (still returned by `teacher-data`, still perfectly
valid — this is a front-end-only removal, no `Code.gs` change) to show
denied sign-in attempts, but the Activity Status tab above already
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

### Wired units — current activity IDs

Same 5-page pattern (Review/Vocabulary-Literacy/Practice-Set/Word-Problems/
Test-Prep wired, Explanation/Teacher-Guide left alone) now applied to six
units across Sixth, Seventh, and Eighth grade, in addition to Rational
Numbers — **every grade is wired now**. Two units also have a
Guided-Solving-Ladder page (Seventh/Operations-with-Rationals,
Eighth/Literal-Equations); those are wired too (see the table below) -
Explanation/Teacher-Guide are the only pages still deliberately left
alone. Don't assume a page has any of this without checking for
`gsi/client` in its `<head>` first, in case a new unit gets added later
without being wired yet.

| Unit | ActivityId prefix | listRegistry / revealAnswerKey |
|---|---|---|
| Seventh/Rational-Numbers | `7-rational-numbers-*` | Practice-Set, Word-Problems, Review use `window.listRegistry`; Test-Prep and Vocabulary-Literacy use hand-written `window.revealAnswerKey`. |
| Sixth/Decimal-Operations | `6-decimal-operations-*` | Practice-Set, Word-Problems, Review use `window.listRegistry` (local var `checkListRegistry`). Vocabulary-Literacy and Test-Prep are hand-written — Test-Prep has *two* separate registries (`estExactRegistry` for two-field estimate+exact items, `submitListRegistry` for single-field submit-only items) plus several one-off items (concept check, two critical-thinking textareas, extra credit, readiness check), none of it merged into `window.listRegistry`. |
| Sixth/Operations-with-Fractions | `6-operations-with-fractions-*` | Same shape as Decimal-Operations, except Test-Prep's `checkListRegistry`/`submitListRegistry` **are** merged into `window.listRegistry` (`Object.assign`) since both already use the single-input convention — only the remaining one-offs (concept check, critical thinking, extra credit, readiness) are hand-written. |
| Seventh/Integers | `7-integers-*` | Practice-Set/Word-Problems use `window.listRegistry` (local var `listRegistry`), Review uses `checkListRegistry`. Vocabulary-Literacy and Test-Prep are hand-written; Test-Prep also has a checkbox multi-select pattern (`checkQCMulti`) and a 4-select sign-group pattern (`checkQCSigns`) with their own reveal logic. |
| Seventh/Operations-with-Rationals | `7-operations-with-rationals-*` | Same shape as Integers (including a `checkQCMulti` checkbox group in Test-Prep), but no sign-group pattern. Its Guided-Solving-Ladder page has one flat `ladderExercises` array (not grouped by key prefix like every other registry here) - exposed as `window.listRegistry = { lex: { problems: ... } }` to fit the same generic reveal mechanism, with `mc`-type items given a synthesized `displayAnswer` (the generic reveal only knows `displayAnswer`/`a`/`accepted`, not this page's own `p.answer`) so a `<select>` gets set to the right option like any other item. |
| Eighth/Linear-Equations | `8-linear-equations-*` | Review uses `window.listRegistry` (local var `checkListRegistry`). Vocabulary-Literacy, Practice-Set, and Word-Problems are entirely hand-written `window.revealAnswerKey` (no page has a shared registry covering everything). Test-Prep's `listRegistry` (local var, matching the shared-name convention) covers only its submit-only Mixed Practice tab; the rest (Check Your Understanding, Error Analysis, Readiness Check) is hand-written. Practice-Set's Strategy Challenge tab is student-choice-driven (pick a group first) and has nothing to reveal until a group is picked — `revealAnswerKey` skips it harmlessly if none was. |
| Eighth/Literal-Equations | `8-literal-equations-*` | Review uses `window.listRegistry` (local var `checkListRegistry`). Practice-Set's `symRegistry` and Word-Problems' `wpRegistry` are both exposed as `window.listRegistry`, covering most of each page; Practice-Set still hand-writes its Tab 4 Live Number Check (targets depend on live slider values, recomputed with the same formula the check functions use) and Tab 5 Error Analysis, and Word-Problems hand-writes its one Tab 3 investment-comparison item. Test-Prep's `submitSymRegistry` (as `window.listRegistry`) covers Mixed Practice parts 1-2 only; part 3 (numeric, separate render/check functions) plus Full Review/Error Analysis/Readiness Check are hand-written. Vocabulary-Literacy is entirely hand-written (two standalone check functions, no registry). Its Guided-Solving-Ladder page already used the standard keyed-registry shape (`exRegistry`, covering both its tabs) so it only needed `window.listRegistry = exRegistry` - no hand-written reveal at all. |

Every wired page needs its own row in `ActivityCatalog` (matching
`Grade`, `Active: TRUE`) before its gate will let anyone in — that's 37
rows now (35 from the 5-page pattern across 7 units, plus the 2
Guided-Solving-Ladder pages). `index.html`'s `CURRICULUM` also
needs an `activityIds` block per topic (see the existing entries) or a
signed-in student won't see that topic on the index even once the pages
themselves work — this has been added for all 7 wired units already.

**Before trusting `window.revealAnswerKey` or `window.listRegistry` works
on a specific page you haven't checked**, open that page's own `<script>`
and confirm which one it actually defines — the table above summarizes,
but the two Decimal-Operations vs. Operations-with-Fractions Test-Prep
pages look nearly identical at a glance and are wired differently
underneath (unmerged vs. merged registries).

**Guided-Solving-Ladder is a seventh curriculum-index section**, not one
of the original six (`review`/`vocab`/`explain`/`practice`/`word`/
`test`/`teacher`) — `index.html`'s `SECTIONS` array has a `ladder` entry
(`--c-ladder`/`--c-ladder-bg` for its pill color) alongside the rest.
Only the two topics that actually have the page (Seventh/
Operations-with-Rationals, Eighth/Literal-Equations) set a `ladder` href
and `activityIds.ladder` — every other topic simply omits the key, which
means students never see it (same omission rule as any other section)
and teachers see a harmless "Guided Solving Ladder: Coming soon" tag on
the other five topics, same as any genuinely-unbuilt section would show.

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
seven wired units (Sixth's two, Seventh's three, Eighth's two) are
visible to a signed-in student on the index, in addition to Rational
Numbers. As new units get added and wired the same way, add their
`activityId`s to `CURRICULUM` the same way, or a signed-in student won't
see them on the index even once the pages themselves work.

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
