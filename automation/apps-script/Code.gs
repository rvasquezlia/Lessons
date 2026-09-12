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
  const studentRow = findRow_(roster, rMap['Email'], email);
  if (!studentRow || studentRow.row[rMap['Status']] !== 'Active') {
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
  const requiredGrade = activityRow.row[cMap['Grade']];
  if (String(student.grade) !== String(requiredGrade)) {
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
    const studentRow = findRow_(roster, rMap['Email'], auth.email);
    if (!studentRow || studentRow.row[rMap['Status']] !== 'Active') {
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
  if (body.type === 'teacher-data') {
    if (!isTeacher_(auth.email)) return jsonOut_({ ok: false, error: 'Not authorized' });
    return jsonOut_({
      ok: true,
      rows: getAllProgressForDashboard_(),
      roster: getRosterForDashboard_(),
      activityCatalog: getActivityCatalogForDashboard_(),
      accessLog: getAccessLogForDashboard_()
    });
  }

  // Everything below this line can write to Progress/AccessLog - only
  // these two hold the lock.
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
      return jsonOut_({ ok: true, allowed: true, role: 'student', student: access.student, progress });
    }

    if (body.type === 'submission') {
      const access = checkAccess_(auth.email, body.activityId);
      if (!access.allowed) return jsonOut_({ ok: false, error: access.reason });
      const updated = recordSubmission_(auth.email, body.activityId, access.student, access.activityTitle, body.item);
      return jsonOut_({ ok: true, progress: updated });
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
  for (let r = 1; r < data.length; r++) {
    if (data[r][map['Email']] === email && data[r][map['ActivityId']] === activityId) {
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

function recordSubmission_(email, activityId, student, activityTitle, item) {
  const sheet = ss_().getSheetByName('Progress');
  const map = colMap_(sheet);
  const data = sheet.getDataRange().getValues();
  let rowNumber = -1;
  for (let r = 1; r < data.length; r++) {
    if (data[r][map['Email']] === email && data[r][map['ActivityId']] === activityId) { rowNumber = r + 1; break; }
  }
  if (rowNumber === -1) {
    getOrCreateProgressRow_(email, activityId, student, activityTitle);
    return recordSubmission_(email, activityId, student, activityTitle, item);
  }

  const row = sheet.getRange(rowNumber, 1, 1, sheet.getLastColumn()).getValues()[0];
  const submissions = JSON.parse(row[map['SubmissionsLog']] || '[]');
  const attemptNumber = submissions.filter((s) => s.key === item.key).length + 1;
  submissions.push({ key: item.key, label: item.label, answer: item.answer, verdict: item.verdict, attemptNumber, timestamp: new Date().toISOString() });

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
  return !!findRow_(sheet, map['Email'], email);
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

function getAllProgressForDashboard_() {
  const sheet = ss_().getSheetByName('Progress');
  const map = colMap_(sheet);
  const data = sheet.getDataRange().getValues();
  const rows = [];
  for (let r = 1; r < data.length; r++) rows.push(rowToDashboardRow_(data[r], map));
  return rows;
}

function getRosterForDashboard_() {
  const sheet = ss_().getSheetByName('Roster');
  const map = colMap_(sheet);
  const data = sheet.getDataRange().getValues();
  const rows = [];
  for (let r = 1; r < data.length; r++) {
    rows.push({
      email: data[r][map['Email']],
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

function getAccessLogForDashboard_() {
  const sheet = ss_().getSheetByName('AccessLog');
  const map = colMap_(sheet);
  const data = sheet.getDataRange().getValues();
  const rows = [];
  for (let r = 1; r < data.length; r++) {
    rows.push({
      timestamp: data[r][map['Timestamp']],
      email: data[r][map['Email']],
      activityId: data[r][map['ActivityId']],
      studentGrade: data[r][map['StudentGrade']],
      requiredGrade: data[r][map['RequiredGrade']],
      result: data[r][map['Result']],
      reason: data[r][map['Reason']]
    });
  }
  return rows;
}
