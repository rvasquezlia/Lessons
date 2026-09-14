// Shared backend for ALL lesson progress tracking - see /CLAUDE.md before
// changing anything here. One Sheet, one deployment, every activity in
// every grade points at this same script via its ActivityId.
//
// After editing this file, copy its full contents into the Apps Script
// editor for the shared Sheet (Extensions -> Apps Script) and redeploy -
// this file is the source of truth, the Apps Script editor copy is not.

const SPREADSHEET_ID = '1-HLtX5AwskPx8hy_Ip2kjGMz5OUIS91M2x0FgEt75zA';
const GOOGLE_CLIENT_ID = '478111261772-7l1qamohr0fjsa7ekosuhpj9jum1q4vc.apps.googleusercontent.com';
const ALLOWED_DOMAIN = 'lincoln.edu.ni';

function ss_() { return SpreadsheetApp.openById(SPREADSHEET_ID); }

// Maps header name -> column index (0-based), so row order in the sheet
// can be rearranged later without breaking the script.
function colMap_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const map = {};
  headers.forEach((h, i) => { map[h] = i; });
  return map;
}

// Verifies a Google ID token via Google's tokeninfo endpoint - simplest
// reliable option inside Apps Script (no JWKS/RSA verification needed).
// Fine at classroom scale; a high-volume production app would verify the
// signature locally against Google's public keys instead.
function verifyIdToken_(idToken) {
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return { ok: false, error: 'Invalid or expired token' };
  const payload = JSON.parse(res.getContentText());
  if (payload.aud !== GOOGLE_CLIENT_ID) return { ok: false, error: 'Token not issued for this app' };
  if (payload.hd !== ALLOWED_DOMAIN) return { ok: false, error: 'Not a ' + ALLOWED_DOMAIN + ' account' };
  return { ok: true, email: payload.email, name: payload.name };
}

function findRow_(sheet, colIdx, value) {
  const data = sheet.getDataRange().getValues();
  for (let r = 1; r < data.length; r++) {
    if (data[r][colIdx] === value) return { rowNumber: r + 1, row: data[r] };
  }
  return null;
}

// Trim + lowercase so a stray leading/trailing space or a capitalized
// letter typed into Roster/Teachers (both hand-maintained by a teacher,
// not code) doesn't silently fail to match the token's email - "not on
// the roster" used to fire for that too, indistinguishable from actually
// missing. Google's own token email is already lowercase in practice,
// but this normalizes both sides the same way regardless.
function normalizeEmail_(email) {
  return String(email || '').trim().toLowerCase();
}

// Same idea as findRow_ but for an Email column specifically - compares
// normalizeEmail_() on both sides instead of a raw strict match.
function findRowByEmail_(sheet, colIdx, email) {
  const target = normalizeEmail_(email);
  const data = sheet.getDataRange().getValues();
  for (let r = 1; r < data.length; r++) {
    if (normalizeEmail_(data[r][colIdx]) === target) return { rowNumber: r + 1, row: data[r] };
  }
  return null;
}

// Same reasoning as normalizeEmail_ - Status is hand-typed too, and
// "active" / "Active " / "ACTIVE" all clearly mean the same thing a
// strict === 'Active' would silently reject.
function isActiveStatus_(status) {
  return String(status || '').trim().toLowerCase() === 'active';
}

function logAccess_(email, activityId, studentGrade, requiredGrade, result, reason) {
  const sheet = ss_().getSheetByName('AccessLog');
  sheet.appendRow([new Date(), email, activityId, studentGrade, requiredGrade, result, reason]);
}

// Pure access computation - no logging here. Verified email must be on
// the roster, and the roster's grade must match the activity's required
// grade. Called both when a student opens an activity and on every
// submission to re-verify nothing changed mid-session - see checkAccess_
// for the logging policy shared by both call sites.
function resolveAccess_(email, activityId) {
  const roster = ss_().getSheetByName('Roster');
  const rMap = colMap_(roster);
  const studentRow = findRowByEmail_(roster, rMap['Email'], email);
  if (!studentRow || !isActiveStatus_(studentRow.row[rMap['Status']])) {
    return { allowed: false, reason: 'Your account is not on the class roster yet - check with your teacher.', logReason: 'Not found on roster' };
  }
  const student = {
    name: studentRow.row[rMap['StudentName']],
    grade: studentRow.row[rMap['Grade']],
    teacher: studentRow.row[rMap['Teacher']]
  };

  const catalog = ss_().getSheetByName('ActivityCatalog');
  const cMap = colMap_(catalog);
  const activityRow = findRow_(catalog, cMap['ActivityId'], activityId);
  if (!activityRow || (activityRow.row[cMap['Active']] !== true && activityRow.row[cMap['Active']] !== 'TRUE')) {
    return { allowed: false, reason: 'This activity is not available.', logReason: 'Unknown or inactive activity', studentGrade: student.grade };
  }
  // ActivityCatalog.Grade can list more than one grade, comma-separated
  // (e.g. "7,7-Honors"), for an activity two tracks share verbatim - a
  // regular-track and an accelerated/honors-track student opening the
  // exact same page. Each listed value is compared as a whole string
  // (trimmed), never a substring match, so "7" never accidentally matches
  // a student whose grade is "7-Honors" or vice versa.
  const requiredGrade = activityRow.row[cMap['Grade']];
  const allowedGrades = String(requiredGrade).split(',').map((g) => g.trim());
  if (!allowedGrades.includes(String(student.grade))) {
    return { allowed: false, reason: 'This activity is not assigned to your grade.', logReason: 'Grade mismatch', studentGrade: student.grade, requiredGrade };
  }

  return { allowed: true, student, activityTitle: activityRow.row[cMap['Title']], studentGrade: student.grade, requiredGrade };
}

// AccessLog only records denials now, not every allowed open. An allowed
// access-check is already fully recoverable from Progress: FirstStartedAt
// (set once, at the same moment this would have logged "Allowed") and
// SubmissionsLog's own per-item timestamps (including the tab-<panelId>
// entries logged on every real page visit - see "Engagement tracking")
// are a genuine, deduped interaction timeline the dashboard can read
// directly, unlike AccessLog. Logging every allowed open was also
// double-counting itself: a client-side timeout doesn't stop this
// function from finishing server-side, so a slow cold-start attempt
// followed by the client's own automatic retry could log the exact same
// real-world visit twice - AccessLog would show a burst of rows for one
// student opening one page. A denial is rare and worth a teacher's
// attention regardless of an occasional duplicate, so it stays logged;
// used for both a student opening an activity and every submission's
// routine re-check that access hasn't changed mid-session.
function checkAccess_(email, activityId) {
  const result = resolveAccess_(email, activityId);
  if (!result.allowed) {
    logAccess_(email, activityId, result.studentGrade || '', result.requiredGrade || '', 'Denied', result.logReason);
  }
  return result;
}

// ================================================================
// PAIRED/TEAM ACTIVITIES (Pairs + ProjectState tabs) - see /CLAUDE.md's
// "Paired activities" section for the full design. Both tabs are
// optional additions a teacher creates only for an activity that needs
// them - getSheetByName() returns null (never throws) for a tab that
// doesn't exist yet, so every function below degrades to a no-op/null
// and every other page on the site is completely unaffected whether or
// not these tabs exist.
// ================================================================

function normalizeRole_(role) {
  return String(role || '').trim().toLowerCase();
}

// Looks up this student's own pairing row for one activity - null if the
// Pairs tab doesn't exist yet, or this student has no row on it for this
// activityId (the common case: an activity with no pairing at all).
function getPairing_(email, activityId) {
  const sheet = ss_().getSheetByName('Pairs');
  if (!sheet) return null;
  const map = colMap_(sheet);
  const data = sheet.getDataRange().getValues();
  for (let r = 1; r < data.length; r++) {
    if (normalizeEmail_(data[r][map['Email']]) === normalizeEmail_(email) && data[r][map['ActivityId']] === activityId) {
      return { rowNumber: r + 1, email: data[r][map['Email']], partnerEmail: data[r][map['PartnerEmail']], role: data[r][map['Role']] };
    }
  }
  return null;
}

// access-check-facing shape: role normalized to 'driver'/'navigator', plus
// the partner's real StudentName (looked up from Roster) instead of just
// their email, so the page can show "Paired with <name>" directly.
function getPairingWithPartnerName_(email, activityId) {
  const pairing = getPairing_(email, activityId);
  if (!pairing) return null;
  const roster = ss_().getSheetByName('Roster');
  const rMap = colMap_(roster);
  const partnerRow = findRowByEmail_(roster, rMap['Email'], pairing.partnerEmail);
  return {
    role: normalizeRole_(pairing.role),
    partnerEmail: pairing.partnerEmail,
    partnerName: partnerRow ? partnerRow.row[rMap['StudentName']] : pairing.partnerEmail
  };
}

// Mirrors one submitted item into the partner's own Progress row, so both
// partners' dashboard rows read identically without the dashboard (or
// Progress's own schema) needing to know pairing exists at all. Emails
// are normalized before being handed to recordSubmission_/
// getOrCreateProgressRow_ specifically because the partner's email here
// comes from a teacher's hand-typed Pairs.PartnerEmail cell, which won't
// necessarily match the exact casing Google's own token reports for that
// same account the next time the partner signs in themselves - see the
// normalizeEmail_ comparison now used in both of those functions' own
// row-lookups for the other half of this fix.
function mirrorSubmissionToPartner_(partnerEmail, activityId, item) {
  const roster = ss_().getSheetByName('Roster');
  const rMap = colMap_(roster);
  const partnerRow = findRowByEmail_(roster, rMap['Email'], partnerEmail);
  if (!partnerRow) return; // partner isn't on the roster - nothing to mirror to
  const partnerStudent = {
    name: partnerRow.row[rMap['StudentName']],
    grade: partnerRow.row[rMap['Grade']],
    teacher: partnerRow.row[rMap['Teacher']]
  };
  const catalog = ss_().getSheetByName('ActivityCatalog');
  const cMap = colMap_(catalog);
  const activityRow = findRow_(catalog, cMap['ActivityId'], activityId);
  const activityTitle = activityRow ? activityRow.row[cMap['Title']] : '';
  recordSubmission_(normalizeEmail_(partnerEmail), activityId, partnerStudent, activityTitle, item);
}

// Free-form app state (anything that isn't a discrete graded answer, e.g.
// a canvas layout or a shopping cart's contents) doesn't fit the
// SubmissionsLog append-only audit-log model - it's one snapshot that
// gets overwritten on every save, not a growing history. ProjectState is
// a separate, tiny, upsert-only tab for exactly that: one row per
// (student, activity), the whole blob in one JSON cell.
function getProjectState_(email, activityId) {
  const sheet = ss_().getSheetByName('ProjectState');
  if (!sheet) return '';
  const map = colMap_(sheet);
  const data = sheet.getDataRange().getValues();
  for (let r = 1; r < data.length; r++) {
    if (normalizeEmail_(data[r][map['Email']]) === normalizeEmail_(email) && data[r][map['ActivityId']] === activityId) {
      return data[r][map['StateJSON']] || '';
    }
  }
  return '';
}

function saveProjectState_(email, activityId, stateJson) {
  const sheet = ss_().getSheetByName('ProjectState');
  if (!sheet) return;
  const map = colMap_(sheet);
  const data = sheet.getDataRange().getValues();
  const now = new Date();
  for (let r = 1; r < data.length; r++) {
    if (normalizeEmail_(data[r][map['Email']]) === normalizeEmail_(email) && data[r][map['ActivityId']] === activityId) {
      sheet.getRange(r + 1, map['StateJSON'] + 1).setValue(stateJson);
      sheet.getRange(r + 1, map['UpdatedAt'] + 1).setValue(now);
      return;
    }
  }
  const newRow = [];
  newRow[map['Email']] = email;
  newRow[map['ActivityId']] = activityId;
  newRow[map['StateJSON']] = stateJson;
  newRow[map['UpdatedAt']] = now;
  sheet.appendRow(newRow);
}

// Teacher-initiated: removes a pairing in both directions (this student's
// row and their partner's row) so it stops mirroring/locking anything
// further - same "teacher is the only one who can undo it" rule as
// teacher-reset. Nothing about SubmissionsLog/ProjectState history is
// touched; this only removes the two Pairs rows, so a re-paired student
// keeps every prior attempt on record.
function unpair_(studentEmail, activityId) {
  const sheet = ss_().getSheetByName('Pairs');
  if (!sheet) return { ok: false, error: 'No Pairs tab found' };
  const map = colMap_(sheet);
  const data = sheet.getDataRange().getValues();
  const rowsToDelete = [];
  let partnerEmail = null;
  for (let r = 1; r < data.length; r++) {
    if (normalizeEmail_(data[r][map['Email']]) === normalizeEmail_(studentEmail) && data[r][map['ActivityId']] === activityId) {
      rowsToDelete.push(r + 1);
      partnerEmail = data[r][map['PartnerEmail']];
    }
  }
  if (partnerEmail) {
    for (let r = 1; r < data.length; r++) {
      if (normalizeEmail_(data[r][map['Email']]) === normalizeEmail_(partnerEmail) && data[r][map['ActivityId']] === activityId) {
        rowsToDelete.push(r + 1);
      }
    }
  }
  if (!rowsToDelete.length) return { ok: false, error: 'No pairing found for that student/activity' };
  // Delete from bottom to top so earlier row numbers in the list don't
  // shift out from under the later deletions.
  rowsToDelete.sort((a, b) => b - a).forEach((rowNum) => sheet.deleteRow(rowNum));
  return { ok: true, unpaired: rowsToDelete.length };
}

function getPairsForDashboard_(emailSet) {
  const sheet = ss_().getSheetByName('Pairs');
  if (!sheet) return [];
  const map = colMap_(sheet);
  const data = sheet.getDataRange().getValues();
  const rows = [];
  for (let r = 1; r < data.length; r++) {
    const email = data[r][map['Email']];
    if (emailSet && !emailSet[email]) continue;
    rows.push({ email: email, partnerEmail: data[r][map['PartnerEmail']], activityId: data[r][map['ActivityId']], role: data[r][map['Role']] });
  }
  return rows;
}

// Simple first-pass flags - tune thresholds once real pilot data exists.
function computeFlag_(row) {
  const submissions = JSON.parse(row.SubmissionsLog || '[]');
  if (submissions.length >= 3) {
    const first = new Date(submissions[0].timestamp);
    const last = new Date(submissions[submissions.length - 1].timestamp);
    const seconds = (last - first) / 1000;
    if (seconds > 0 && seconds < submissions.length * 5) return 'Completed unusually fast';
  }
  const allFirstTryCorrect = submissions.length > 3 && submissions.every((s) => s.verdict === 'correct' && (s.attemptNumber || 1) === 1);
  if (allFirstTryCorrect) return 'Every item correct on first attempt';
  const hour = new Date().getHours();
  if (hour < 6 || hour > 22) return 'Submitted outside typical class hours';
  return '';
}

// Token verification is a network call to Google - it doesn't touch the
// Sheet at all, so it happens before any lock is acquired. Same for
// identify/teacher-data below: neither ever writes, so they never wait on
// the lock that access-check/submission need for their writes. Every
// request used to share one lock regardless of type, which meant a
// simple read (e.g. index.html's identify, fired on every page load)
// could sit blocked behind a slow write from a completely unrelated
// request - a real source of the "sometimes fast, sometimes times out"
// inconsistency.
function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  const auth = verifyIdToken_(body.idToken);
  if (!auth.ok) return jsonOut_({ ok: false, error: auth.error });

  // Identity-only, no activity attached - used by index.html, which
  // links to many activities rather than gating one. Same
  // Teachers-before-Roster order as access-check, but never checks
  // ActivityCatalog/grade-match against anything, since there's no
  // single activity here to match against. Never writes - no lock needed.
  if (body.type === 'identify') {
    if (isTeacher_(auth.email)) {
      return jsonOut_({ ok: true, role: 'teacher', student: { name: auth.name } });
    }
    const roster = ss_().getSheetByName('Roster');
    const rMap = colMap_(roster);
    const studentRow = findRowByEmail_(roster, rMap['Email'], auth.email);
    if (!studentRow || !isActiveStatus_(studentRow.row[rMap['Status']])) {
      return jsonOut_({ ok: true, role: 'unknown', reason: 'Your account is not on the class roster yet - check with your teacher.' });
    }
    return jsonOut_({
      ok: true, role: 'student',
      student: { name: studentRow.row[rMap['StudentName']], grade: studentRow.row[rMap['Grade']], teacher: studentRow.row[rMap['Teacher']] }
    });
  }

  // Read-only, teacher-dashboard-facing. Deliberately hands back raw rows
  // (SubmissionsLog included as-is) rather than pre-computed stats -
  // decoding it and computing things like average time between answers
  // or flagging rapid bursts lives in the dashboard page's own JS, so
  // those rules can be tuned without redeploying this script. Never
  // writes - no lock needed.
  //
  // roster/activityCatalog are included alongside Progress rows so the
  // dashboard can compute real completion rates (attempted vs. everyone
  // enrolled) and show students/activities with zero submissions - not
  // just aggregate over whoever happened to submit something.
  // accessLog is included so denied/allowed access attempts are visible
  // too, not just graded work.
  //
  // A Teachers-tab Scope restricts rows/roster/accessLog to just that
  // teacher's own students (see getTeacherScope_) - activityCatalog is
  // never filtered, since an activity isn't "owned" by a teacher.
  if (body.type === 'teacher-data') {
    if (!isTeacher_(auth.email)) return jsonOut_({ ok: false, error: 'Not authorized' });
    const scope = getTeacherScope_(auth.email);
    const emailSet = getScopedEmailSet_(scope);
    return jsonOut_({
      ok: true,
      scope: scope || null,
      rows: getAllProgressForDashboard_(emailSet),
      roster: getRosterForDashboard_(emailSet),
      activityCatalog: getActivityCatalogForDashboard_(),
      accessLog: getAccessLogForDashboard_(emailSet),
      pairs: getPairsForDashboard_(emailSet)
    });
  }

  // Read-only day-2-style unlock code check for a paired/project
  // activity - compares against that activity's own ActivityCatalog.Day2Code
  // cell (blank/missing column means no code is configured, so this
  // always returns ok:false for every activity that doesn't use it).
  // Never writes - no lock needed.
  if (body.type === 'check-day2-code') {
    const catalog = ss_().getSheetByName('ActivityCatalog');
    const cMap = colMap_(catalog);
    const activityRow = findRow_(catalog, cMap['ActivityId'], body.activityId);
    const expected = activityRow && cMap['Day2Code'] !== undefined ? String(activityRow.row[cMap['Day2Code']] || '').trim() : '';
    const typed = String(body.code || '').trim();
    return jsonOut_({ ok: !!expected && expected.toLowerCase() === typed.toLowerCase() });
  }

  // Everything below this line can write (Progress/AccessLog/Pairs/
  // ProjectState) - only these request types hold the lock.
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (body.type === 'access-check') {
      // Teachers bypass the grade-gate entirely and never get a Progress
      // row - they're viewing the answer key, not doing the activity.
      // Checked before the roster lookup since a teacher's email has no
      // reason to be in Roster (which is grade/student-specific).
      if (isTeacher_(auth.email)) {
        return jsonOut_({ ok: true, allowed: true, role: 'teacher', student: { name: auth.name } });
      }
      const access = checkAccess_(auth.email, body.activityId);
      if (!access.allowed) return jsonOut_({ ok: true, allowed: false, reason: access.reason });
      const progress = getOrCreateProgressRow_(auth.email, body.activityId, access.student, access.activityTitle);
      // pairing/projectState are both undefined (dropped by JSON.stringify)
      // for the vast majority of activities, which have no Pairs/
      // ProjectState rows at all - every existing page's response shape is
      // unchanged.
      const pairing = getPairingWithPartnerName_(auth.email, body.activityId);
      const projectState = getProjectState_(auth.email, body.activityId);
      return jsonOut_({
        ok: true, allowed: true, role: 'student', student: access.student, progress,
        pairing: pairing || undefined,
        projectState: projectState || undefined
      });
    }

    if (body.type === 'submission') {
      const access = checkAccess_(auth.email, body.activityId);
      if (!access.allowed) return jsonOut_({ ok: false, error: access.reason });
      const pairing = getPairing_(auth.email, body.activityId);
      // Defense in depth: a Navigator's own inputs are disabled client-side
      // and never call LessonCheck.check()/.submit() in the first place,
      // but the backend never trusts the front-end's claimed role either -
      // same principle as every other access check in this file.
      if (pairing && normalizeRole_(pairing.role) === 'navigator') {
        return jsonOut_({ ok: false, error: "Your partner is driving this activity - you can only view their answers." });
      }
      const updated = recordSubmission_(auth.email, body.activityId, access.student, access.activityTitle, body.item);
      if (pairing && pairing.partnerEmail) {
        mirrorSubmissionToPartner_(pairing.partnerEmail, body.activityId, body.item);
      }
      return jsonOut_({ ok: true, progress: updated });
    }

    // Free-form app-state save (see the "Paired/team activities" block
    // above) - mirrored to the partner's own ProjectState row the same
    // way a submission mirrors, and rejected from a Navigator the same way.
    if (body.type === 'project-state-save') {
      const access = checkAccess_(auth.email, body.activityId);
      if (!access.allowed) return jsonOut_({ ok: false, error: access.reason });
      const pairing = getPairing_(auth.email, body.activityId);
      if (pairing && normalizeRole_(pairing.role) === 'navigator') {
        return jsonOut_({ ok: false, error: "Your partner is driving this activity - you can only view their progress." });
      }
      saveProjectState_(normalizeEmail_(auth.email), body.activityId, body.stateJson);
      if (pairing && pairing.partnerEmail) {
        saveProjectState_(normalizeEmail_(pairing.partnerEmail), body.activityId, body.stateJson);
      }
      return jsonOut_({ ok: true });
    }

    // Teacher-only, writes. Removes a pairing in both directions so a
    // teacher can re-pair a student (a partner absent for the rest of the
    // project, or two students paired by mistake) - see unpair_() for
    // exactly what gets removed. Reuses the identical scoping check as
    // teacher-reset below.
    if (body.type === 'teacher-unpair') {
      if (!isTeacher_(auth.email)) return jsonOut_({ ok: false, error: 'Not authorized' });
      const scope = getTeacherScope_(auth.email);
      const emailSet = getScopedEmailSet_(scope);
      if (emailSet && !emailSet[body.studentEmail]) {
        return jsonOut_({ ok: false, error: 'Not authorized for this student' });
      }
      const result = unpair_(body.studentEmail, body.activityId);
      if (!result.ok) return jsonOut_({ ok: false, error: result.error });
      return jsonOut_({ ok: true, unpaired: result.unpaired });
    }

    // Teacher-only, writes. Gives a student's locked item(s) their 2
    // attempts back - scope is 'item' (body.target = the item's key),
    // 'section' (body.target = the tab/section name), or 'activity' (every
    // resettable key on this Progress row, body.target unused). See
    // applyTeacherReset_ for what actually gets written, and /CLAUDE.md's
    // reset-mechanism notes for the full design.
    if (body.type === 'teacher-reset') {
      if (!isTeacher_(auth.email)) return jsonOut_({ ok: false, error: 'Not authorized' });
      const scope = getTeacherScope_(auth.email);
      const emailSet = getScopedEmailSet_(scope);
      // Same raw (non-normalized) comparison getAllProgressForDashboard_
      // already uses for this exact emailSet - body.studentEmail comes
      // straight from a Progress row's own Email cell round-tripped
      // through the dashboard, so it's already in the same spelling.
      if (emailSet && !emailSet[body.studentEmail]) {
        return jsonOut_({ ok: false, error: 'Not authorized for this student' });
      }
      const result = applyTeacherReset_(auth.email, body.studentEmail, body.activityId, body.scope, body.target);
      if (!result.ok) return jsonOut_({ ok: false, error: result.error });
      return jsonOut_({ ok: true, progress: result.progress, resetCount: result.resetCount, skippedNoSection: result.skippedNoSection });
    }

    return jsonOut_({ ok: false, error: 'Unknown request type' });
  } finally {
    lock.releaseLock();
  }
}

function getOrCreateProgressRow_(email, activityId, student, activityTitle) {
  const sheet = ss_().getSheetByName('Progress');
  const map = colMap_(sheet);
  const data = sheet.getDataRange().getValues();
  // Normalized (not strict ===) so a mirrored write for a paired
  // activity - whose email comes from a teacher's hand-typed
  // Pairs.PartnerEmail cell, not from that student's own Google token -
  // still finds the row that student's own sign-in already created. Safe
  // to broaden for every page: this only makes matching more permissive,
  // never less, so an existing exact-cased match still matches.
  for (let r = 1; r < data.length; r++) {
    if (normalizeEmail_(data[r][map['Email']]) === normalizeEmail_(email) && data[r][map['ActivityId']] === activityId) {
      return rowToProgress_(data[r], map);
    }
  }
  const now = new Date();
  const newRow = [];
  newRow[map['Email']] = email;
  newRow[map['StudentName']] = student.name;
  newRow[map['Grade']] = student.grade;
  newRow[map['Teacher']] = student.teacher;
  newRow[map['ActivityId']] = activityId;
  newRow[map['ActivityTitle']] = activityTitle;
  newRow[map['FirstStartedAt']] = now;
  newRow[map['LastSubmittedAt']] = '';
  newRow[map['ItemsTotal']] = 0;
  newRow[map['ItemsAttempted']] = 0;
  newRow[map['ItemsCorrect']] = 0;
  newRow[map['ScorePct']] = 0;
  newRow[map['Status']] = 'In Progress';
  newRow[map['SubmissionsLog']] = '[]';
  newRow[map['FlagReason']] = '';
  newRow[map['ReviewedByTeacher']] = false;
  newRow[map['ReviewedAt']] = '';
  sheet.appendRow(newRow);
  return rowToProgress_(newRow, map);
}

// How many times this key has already been attempted, counting only
// attempts since its most recent teacher-reset marker (see
// applyTeacherReset_) - a reset makes the next attempt "attempt 1" again
// instead of continuing to count attempt 3, 4, etc. against the item's
// original 2-attempt/scoring logic. Walking backward and stopping at the
// first 'reset' verdict for this exact key is cheaper than slicing the
// whole array and handles a key that was never reset the same way (walks
// to the start, counts everything).
function attemptsSinceReset_(submissions, key) {
  let count = 0;
  for (let i = submissions.length - 1; i >= 0; i--) {
    if (submissions[i].key !== key) continue;
    if (submissions[i].verdict === 'reset') break;
    count++;
  }
  return count;
}

function recordSubmission_(email, activityId, student, activityTitle, item) {
  const sheet = ss_().getSheetByName('Progress');
  const map = colMap_(sheet);
  const data = sheet.getDataRange().getValues();
  let rowNumber = -1;
  // Same normalized-email broadening as getOrCreateProgressRow_ above, for
  // the same reason (a mirrored write's email comes from a hand-typed
  // Pairs cell, not a live Google token).
  for (let r = 1; r < data.length; r++) {
    if (normalizeEmail_(data[r][map['Email']]) === normalizeEmail_(email) && data[r][map['ActivityId']] === activityId) { rowNumber = r + 1; break; }
  }
  if (rowNumber === -1) {
    getOrCreateProgressRow_(email, activityId, student, activityTitle);
    return recordSubmission_(email, activityId, student, activityTitle, item);
  }

  const row = sheet.getRange(rowNumber, 1, 1, sheet.getLastColumn()).getValues()[0];
  const submissions = JSON.parse(row[map['SubmissionsLog']] || '[]');
  const attemptNumber = attemptsSinceReset_(submissions, item.key) + 1;
  // item.section is sent by every LessonProgress.record() call (see
  // lesson-auth.js's onRecord) but was never actually persisted here until
  // now - needed so a teacher's "reset this section" action (see
  // applyTeacherReset_) can find every key that belongs to a given tab.
  // item.lockAfterSubmit is only ever explicitly false (LessonCheck.submit()
  // opted this item out of locking - see lesson-shared.js/CLAUDE.md's
  // reset-mechanism notes); anything else (undefined for every graded
  // item and the vast majority of submit-only ones) is left off the
  // stored entry entirely rather than writing a redundant `true` onto
  // every single row.
  const entry = { key: item.key, label: item.label, answer: item.answer, verdict: item.verdict, section: item.section || '', attemptNumber, timestamp: new Date().toISOString() };
  if (item.lockAfterSubmit === false) entry.lockAfterSubmit = false;
  submissions.push(entry);

  const uniqueKeys = {};
  submissions.forEach((s) => { uniqueKeys[s.key] = s.verdict; });
  const itemsAttempted = Object.keys(uniqueKeys).length;
  const itemsCorrect = Object.values(uniqueKeys).filter((v) => v === 'correct').length;

  row[map['LastSubmittedAt']] = new Date();
  row[map['ItemsAttempted']] = itemsAttempted;
  row[map['ItemsCorrect']] = itemsCorrect;
  row[map['ScorePct']] = itemsAttempted ? Math.round((itemsCorrect / itemsAttempted) * 100) : 0;
  row[map['SubmissionsLog']] = JSON.stringify(submissions);
  row[map['Status']] = 'In Progress';

  const asObj = rowToProgress_(row, map);
  row[map['FlagReason']] = computeFlag_(asObj);

  sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
  return rowToProgress_(row, map);
}

// A key logged by lesson-auth.js's own engagement/integrity tracking
// (tab views, reached-end, paste/focus/right-click detection) - see
// /CLAUDE.md's "Engagement tracking". restoreSubmissions() on the client
// never locks these (there's no <key>-input element for any of them), so
// resetting one would write an entry with nothing to actually unlock -
// excluded from every reset scope below.
function isResettableKey_(key) {
  return !(key.startsWith('tab-') || key === 'reached-end' || key.startsWith('paste-') ||
    key.startsWith('focus-lost-') || key.startsWith('focus-back-') || key.startsWith('rightclick-'));
}

// Teacher-initiated: gives a student's locked item(s) back their attempts.
// Never overwrites or deletes prior SubmissionsLog entries - appends one
// 'reset' verdict entry per affected key instead, so the full history
// (including who reset what and when) stays intact for the dashboard's
// audit trail, and attemptsSinceReset_ above naturally treats the next
// real attempt on that key as a fresh attempt 1.
//   scope 'item': target is the exact item key to reset.
//   scope 'section': target is a section/tab name - every resettable key
//     whose most recent entry was logged under that section gets reset.
//   scope 'activity': target is ignored - every resettable key on this
//     Progress row gets reset.
// Returns { ok: false, error } or { ok: true, progress } (dashboard-shaped,
// via rowToDashboardRow_ - this endpoint only ever serves the dashboard).
function applyTeacherReset_(teacherEmail, studentEmail, activityId, scope, target) {
  if (['item', 'section', 'activity'].indexOf(scope) === -1) {
    return { ok: false, error: 'Unknown reset scope' };
  }
  if ((scope === 'item' || scope === 'section') && !target) {
    return { ok: false, error: 'Missing reset target' };
  }

  const sheet = ss_().getSheetByName('Progress');
  const map = colMap_(sheet);
  const data = sheet.getDataRange().getValues();
  let rowNumber = -1;
  for (let r = 1; r < data.length; r++) {
    if (data[r][map['Email']] === studentEmail && data[r][map['ActivityId']] === activityId) { rowNumber = r + 1; break; }
  }
  if (rowNumber === -1) return { ok: false, error: 'No progress found for that student/activity' };

  const row = sheet.getRange(rowNumber, 1, 1, sheet.getLastColumn()).getValues()[0];
  const submissions = JSON.parse(row[map['SubmissionsLog']] || '[]');

  // Most recent entry per key, so a key already reset (nothing done since)
  // isn't reset again, and a section reset knows which section a key's
  // current attempt actually belongs to.
  const latestByKey = {};
  submissions.forEach((s) => { latestByKey[s.key] = s; });

  // A key logged before section started being persisted (see /CLAUDE.md's
  // "section had to start being persisted server-side" note) has no
  // `section` field at all - it can never match a section-scope target, no
  // matter which section it actually belongs to on the page. Tracked
  // separately so the caller can tell a teacher "N item(s) couldn't be
  // included" instead of a section reset silently doing much less than
  // expected with no explanation (this is exactly what was reported: a
  // section reset that only affected the one item logged after this fix
  // shipped, leaving every older item in that same section untouched).
  let skippedNoSection = 0;
  let targetKeys;
  if (scope === 'item') {
    targetKeys = latestByKey[target] ? [target] : [];
  } else {
    targetKeys = Object.keys(latestByKey).filter((key) => {
      if (!isResettableKey_(key)) return false;
      if (latestByKey[key].verdict === 'reset') return false;
      if (scope === 'section') {
        if (!latestByKey[key].section) { skippedNoSection++; return false; }
        if (latestByKey[key].section !== target) return false;
      }
      return true;
    });
  }
  if (scope === 'item') targetKeys = targetKeys.filter((key) => latestByKey[key].verdict !== 'reset');
  if (!targetKeys.length) {
    return {
      ok: false,
      error: skippedNoSection
        ? `Nothing to reset - the ${skippedNoSection} item(s) logged for this activity have no recorded section (they predate section tracking). Use "Reset entire activity" instead.`
        : 'Nothing to reset - no prior attempts found for that item/section.'
    };
  }

  const now = new Date().toISOString();
  targetKeys.forEach((key) => {
    submissions.push({
      // The item's own real label (not a generic "Reset by teacher (item)"
      // string) - keeps the Item column consistent with every other row
      // for this key, since the dashboard's Verdict pill (`reset (<scope>)`)
      // already says what happened; repeating the scope in both columns
      // read as redundant/confusing (see /CLAUDE.md's reset-mechanism notes).
      key,
      label: latestByKey[key].label || key,
      answer: '',
      verdict: 'reset',
      section: latestByKey[key].section || '',
      resetScope: scope,
      resetBy: teacherEmail,
      timestamp: now
    });
  });

  row[map['SubmissionsLog']] = JSON.stringify(submissions);
  sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
  return { ok: true, progress: rowToDashboardRow_(row, map), resetCount: targetKeys.length, skippedNoSection };
}

function rowToProgress_(row, map) {
  return {
    email: row[map['Email']], studentName: row[map['StudentName']], grade: row[map['Grade']],
    activityId: row[map['ActivityId']], activityTitle: row[map['ActivityTitle']],
    itemsAttempted: row[map['ItemsAttempted']], itemsCorrect: row[map['ItemsCorrect']],
    scorePct: row[map['ScorePct']], SubmissionsLog: row[map['SubmissionsLog']] || '[]'
  };
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function isTeacher_(email) {
  const sheet = ss_().getSheetByName('Teachers');
  const map = colMap_(sheet);
  return !!findRowByEmail_(sheet, map['Email'], email);
}

// Teachers tab optionally has a `Scope` column. Blank or the literal
// string "All" (including a Teachers row with no Scope column at all)
// means unrestricted - sees every student, same as before this existed.
// Any other value must exactly match a name used in Roster's own
// `Teacher` column, and restricts that account to only those students.
// Returns null for "unrestricted", or the Roster.Teacher name string to
// filter by.
function getTeacherScope_(email) {
  const sheet = ss_().getSheetByName('Teachers');
  const map = colMap_(sheet);
  const found = findRowByEmail_(sheet, map['Email'], email);
  if (!found || map['Scope'] === undefined) return null;
  const scope = found.row[map['Scope']];
  return (!scope || scope === 'All') ? null : scope;
}

// null scope (unrestricted) returns null - callers treat a null email
// set as "don't filter". A restricted scope returns the set of student
// emails whose Roster.Teacher matches, so Progress/AccessLog rows (which
// don't carry a teacher name a restricted account could match against
// directly, and shouldn't have to re-derive it) can be filtered by email
// instead.
function getScopedEmailSet_(scope) {
  if (!scope) return null;
  const sheet = ss_().getSheetByName('Roster');
  const map = colMap_(sheet);
  const data = sheet.getDataRange().getValues();
  const set = {};
  for (let r = 1; r < data.length; r++) {
    if (data[r][map['Teacher']] === scope) set[data[r][map['Email']]] = true;
  }
  return set;
}

function rowToDashboardRow_(row, map) {
  return {
    email: row[map['Email']],
    studentName: row[map['StudentName']],
    grade: row[map['Grade']],
    teacher: row[map['Teacher']],
    activityId: row[map['ActivityId']],
    activityTitle: row[map['ActivityTitle']],
    firstStartedAt: row[map['FirstStartedAt']],
    lastSubmittedAt: row[map['LastSubmittedAt']],
    itemsAttempted: row[map['ItemsAttempted']],
    itemsCorrect: row[map['ItemsCorrect']],
    scorePct: row[map['ScorePct']],
    status: row[map['Status']],
    submissionsLog: row[map['SubmissionsLog']] || '[]',
    flagReason: row[map['FlagReason']],
    reviewedByTeacher: row[map['ReviewedByTeacher']],
    reviewedAt: row[map['ReviewedAt']]
  };
}

// emailSet is null (unrestricted) or a { email: true } lookup from
// getScopedEmailSet_ - a scoped teacher only ever gets rows for their
// own students back from the backend, never filtered client-side, so
// there's no way for the dashboard's own JS to accidentally leak the
// unfiltered set.
function getAllProgressForDashboard_(emailSet) {
  const sheet = ss_().getSheetByName('Progress');
  const map = colMap_(sheet);
  const data = sheet.getDataRange().getValues();
  const rows = [];
  for (let r = 1; r < data.length; r++) {
    const row = rowToDashboardRow_(data[r], map);
    if (!emailSet || emailSet[row.email]) rows.push(row);
  }
  return rows;
}

function getRosterForDashboard_(emailSet) {
  const sheet = ss_().getSheetByName('Roster');
  const map = colMap_(sheet);
  const data = sheet.getDataRange().getValues();
  const rows = [];
  for (let r = 1; r < data.length; r++) {
    const email = data[r][map['Email']];
    if (emailSet && !emailSet[email]) continue;
    rows.push({
      email: email,
      studentName: data[r][map['StudentName']],
      grade: data[r][map['Grade']],
      teacher: data[r][map['Teacher']],
      section: data[r][map['Section']],
      status: data[r][map['Status']]
    });
  }
  return rows;
}

function getActivityCatalogForDashboard_() {
  const sheet = ss_().getSheetByName('ActivityCatalog');
  const map = colMap_(sheet);
  const data = sheet.getDataRange().getValues();
  const rows = [];
  for (let r = 1; r < data.length; r++) {
    rows.push({
      activityId: data[r][map['ActivityId']],
      title: data[r][map['Title']],
      grade: data[r][map['Grade']],
      unit: data[r][map['Unit']],
      active: data[r][map['Active']] === true || data[r][map['Active']] === 'TRUE'
    });
  }
  return rows;
}

function getAccessLogForDashboard_(emailSet) {
  const sheet = ss_().getSheetByName('AccessLog');
  const map = colMap_(sheet);
  const data = sheet.getDataRange().getValues();
  const rows = [];
  for (let r = 1; r < data.length; r++) {
    const email = data[r][map['Email']];
    if (emailSet && !emailSet[email]) continue;
    rows.push({
      timestamp: data[r][map['Timestamp']],
      email: email,
      activityId: data[r][map['ActivityId']],
      studentGrade: data[r][map['StudentGrade']],
      requiredGrade: data[r][map['RequiredGrade']],
      result: data[r][map['Result']],
      reason: data[r][map['Reason']]
    });
  }
  return rows;
}
