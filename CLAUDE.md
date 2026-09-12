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
  `4`.
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
`--bg`/`--border` bar like the rest of the site's cards) and has five
tabs, all driven by the same `allRows`/`roster`/`activityCatalog`
globals and a shared `Grade`/`Teacher`/`Activity`/"flagged only" filter
bar. None of the tab panels carry an explanatory `<p>` under their
`.section-title` anymore — the tab name plus the table's own column
headers are the interface; a per-tab paragraph restating "one row per
X, click a row to see Y" was decided to be redundant with that.

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
- **Activity Status** — "are students actually opening this?", answered
  with a four-state funnel per activity (Not started / Opened only / In
  progress / Completed), computed by `computeActivityStatusBreakdown()`
  from `Progress` alone: no row at all is Not started; a row with
  `reachedEnd` is Completed; a row with graded items but no `reachedEnd`
  is In progress; a row with neither (only tab views logged) is Opened
  only. Click an activity to see which student is in which state, with
  stat tiles for the same four counts scoped to just that activity. This
  is the dashboard's only engagement view now - the tab that used to
  read `AccessLog` (see below) is gone entirely.
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
