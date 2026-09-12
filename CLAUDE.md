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
| `Teachers` | **Manual** — one column: `Email` | Gates the `teacher-data` dashboard endpoint. Only emails listed here can pull all-student data; being on `Roster` as a `Teacher` name does not grant this by itself. |
| `Progress` | **Automatic** — written entirely by Apps Script | One row per (student, activity), upserted on every save. Columns: `Email, StudentName, Grade, Teacher, ActivityId, ActivityTitle, FirstStartedAt, LastSubmittedAt, ItemsTotal, ItemsAttempted, ItemsCorrect, ScorePct, Status, SubmissionsLog (JSON), FlagReason, ReviewedByTeacher, ReviewedAt`. The last two are the only cells a teacher should hand-edit (checking off a flagged row after review). |
| `AccessLog` | **Automatic** — written entirely by Apps Script | One row per real access event: a student opening an activity (allowed or denied), or a submission-time re-check that comes back denied. Routine allowed re-checks on every Check-button click are NOT logged here — that was an earlier bug (see git history) that flooded this tab. |

### Teacher dashboard

`Lessons/teacher-dashboard.html` — a standalone, teacher-only page (not
linked from any lesson). Signs in the same way as a lesson page, but
calls the backend with `type: 'teacher-data'` instead of
`access-check`/`submission`; the backend checks the signed-in email
against the `Teachers` tab and, if authorized, returns every `Progress`
row as-is (including the raw `SubmissionsLog` JSON).

Deliberately, **all analysis happens in the dashboard's own JS, not in
Apps Script**: average time between answers, the "3 answers within 60
seconds" rapid-burst flag, sorting, filtering. Tune or add rules by
editing `teacher-dashboard.html` directly — that never requires touching
`Code.gs` or redeploying the backend. Only touch the backend if the data
being *returned* needs to change (a new column, a new tab to join
against), not when the flagging rules change.

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

This currently only works on pages using the `renderPracticeList()` /
`checkPractice()` pattern (single text-input-per-problem, like the
Rational Numbers Practice Set pilot) because that's what
`window.listRegistry` and the `<key>-input`/`<key>-feedback` id
convention come from. A page with a different problem shape (radio-button
groups, multi-field answers) needs its own reveal logic added to
`unlockTeacherView` before this will show anything for it — don't assume
teacher view works on a page until it's been wired the same way this
pilot page was (`window.listRegistry = listRegistry;` after that
constant's declaration).

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
