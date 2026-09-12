// Pilot integration with the shared progress-tracking backend documented
// in /CLAUDE.md - see that file before changing the URL/Client ID below or
// the request shapes. Only pages that include this script gate behind
// Google sign-in and sync progress; every other lesson page is untouched.
const LESSON_SYNC_API_URL = 'https://script.google.com/macros/s/AKfycbyC7mb1TKfg3JvhiZftXMf7oXkzrBMWJczZSURC7sIfoIxYnZrrumYfx-j7JYTY0A9i/exec';
const LESSON_GOOGLE_CLIENT_ID = '478111261772-7l1qamohr0fjsa7ekosuhpj9jum1q4vc.apps.googleusercontent.com';
// document.currentScript is only valid while this script is first
// evaluating - captured here, at load time, rather than inside a later
// callback where it would be null. teacher-dashboard.html always lives
// next to lesson-auth.js regardless of how deeply nested the calling
// lesson page is, so this resolves correctly from any page depth.
const TEACHER_DASHBOARD_URL = new URL('teacher-dashboard.html', document.currentScript.src).href;

const LessonSync = (() => {
  let activityId = null;
  let idToken = null;
  let ready = false;
  // Captured before the patch below replaces LessonProgress.record, so
  // restoreSubmissions() can update the printed-report log directly
  // without going back through onRecord() and re-posting to the backend
  // every time the page loads.
  const originalRecord = LessonProgress.record;

  // Apps Script cold-starts can take a few seconds - without a timeout, a
  // slow or stuck response leaves the gate showing "Checking access..."
  // forever with no way to retry short of reloading.
  function fetchWithTimeout(url, opts, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 15000);
    return fetch(url, Object.assign({}, opts, { signal: controller.signal })).finally(() => clearTimeout(timer));
  }

  function setStatus(msg, isError) {
    const el = document.getElementById('lesson-gate-status');
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? 'var(--error)' : 'var(--primary)';
  }

  // Re-locks and re-displays every previously answered problem on reload.
  // Only works for the common single-input-per-problem pattern (an input
  // and a feedback div both id'd "<key>-input" / "<key>-feedback", sharing
  // a parent with the Check button) - that's what renderPracticeList()
  // produces, and covers this pilot page's six tabs. A page with a
  // different DOM shape (radio-button groups, multi-field problems) would
  // silently skip restoring those items until this is extended.
  function restoreSubmissions(submissionsLogJson) {
    let submissions;
    try { submissions = JSON.parse(submissionsLogJson || '[]'); } catch (e) { submissions = []; }
    const latestByKey = {};
    submissions.forEach((s) => { latestByKey[s.key] = s; }); // log is append-only; last entry per key wins
    Object.keys(latestByKey).forEach((key) => {
      const s = latestByKey[key];
      const input = document.getElementById(`${key}-input`);
      const feedback = document.getElementById(`${key}-feedback`);
      if (!input || !feedback) return;
      input.value = s.answer;
      input.disabled = true;
      const btn = input.parentElement && input.parentElement.querySelector('button');
      if (btn) { btn.disabled = true; btn.style.cursor = 'not-allowed'; }
      feedback.style.display = 'block';
      if (s.verdict === 'correct') {
        feedback.className = 'feedback-msg success locked';
        feedback.innerHTML = 'Correct! <span style="opacity:.75;">(restored from your last session)</span>';
      } else {
        feedback.className = 'feedback-msg error locked';
        feedback.innerHTML = 'Recorded from your last session - your teacher can review it on your printed report. <span style="opacity:.75;">(restored)</span>';
      }
      originalRecord(key, s.label, s.answer, s.verdict, s.section);
    });
  }

  function showAppContainer() {
    document.getElementById('lesson-gate').hidden = true;
    document.querySelector('.app-container').hidden = false;
  }

  function unlock(student, progress) {
    ready = true;
    showAppContainer();
    const nameField = document.getElementById('student-name');
    if (nameField && student && student.name) {
      nameField.value = student.name;
      nameField.disabled = true;
    }
    if (progress && progress.SubmissionsLog) restoreSubmissions(progress.SubmissionsLog);
    trackCurrentTab(); // log whichever tab is visible by default, even if the student never clicks another one
  }

  // Logs which tab is currently visible as its own synced item, separate
  // from LessonProgress/LessonCheck - this is what lets pages with no
  // graded questions at all (or a teacher wanting engagement instead of
  // scores) still show up on the dashboard: whether a student opened the
  // page, which tabs they viewed, and whether they reached the last one.
  // Reads DOM state (.active classes) rather than taking a tabId param,
  // so it works identically whether called right after sign-in or right
  // after a tab switch.
  function trackCurrentTab() {
    if (!ready || !idToken) return;
    const activeBtn = document.querySelector('.tab-btn.active');
    const activePanel = document.querySelector('.panel.active');
    if (!activeBtn || !activePanel) return;
    onRecord({ key: `tab-${activePanel.id}`, label: `Viewed tab: ${activeBtn.textContent.trim()}`, answer: '', verdict: 'viewed', section: 'Navigation' });
    const allTabs = [...document.querySelectorAll('.tab-btn')];
    if (allTabs.length && activeBtn === allTabs[allTabs.length - 1]) {
      onRecord({ key: 'reached-end', label: 'Reached last tab', answer: 'yes', verdict: 'reached-end', section: 'Navigation' });
    }
  }

  // switchTab() is declared with `function` (not const/let) on every
  // lesson page, so it's a real window property we can wrap - same trick
  // as the LessonProgress.record patch below. Only takes effect once the
  // page's own script has defined it, which init() guarantees since
  // function declarations are hoisted before any code in that script runs.
  function patchSwitchTab() {
    if (typeof window.switchTab !== 'function') return;
    const originalSwitchTab = window.switchTab;
    window.switchTab = function (tabId) {
      originalSwitchTab(tabId);
      trackCurrentTab();
    };
  }

  // Fills in every problem with its correct answer instead of the
  // interactive check flow. Reads window.listRegistry, which pages using
  // the renderPracticeList()/checkPractice() pattern expose for exactly
  // this - a page with a different DOM shape (radio groups, multi-field
  // problems) won't have anything filled in until this is extended for
  // that pattern too.
  function unlockTeacherView(teacherName) {
    showAppContainer();
    const nameField = document.getElementById('student-name');
    if (nameField) {
      nameField.value = `Answer Key (viewed by ${teacherName || 'teacher'})`;
      nameField.disabled = true;
    }
    const banner = document.createElement('div');
    banner.style.cssText = 'background:var(--accent);color:#fff;font-weight:700;text-align:center;padding:10px;border-radius:10px;margin:0 24px 16px 24px;';
    banner.innerHTML = `TEACHER VIEW - answer key shown below, not a student submission.
      &nbsp;&nbsp;<a href="${TEACHER_DASHBOARD_URL}" target="_blank" style="color:#fff;text-decoration:underline;">Open Teacher Dashboard &rarr;</a>`;
    document.querySelector('.app-container').prepend(banner);

    const registry = window.listRegistry || {};
    Object.keys(registry).forEach((keyPrefix) => {
      const problems = registry[keyPrefix].problems || [];
      problems.forEach((p, i) => {
        const input = document.getElementById(`${keyPrefix}-${i}-input`);
        const feedback = document.getElementById(`${keyPrefix}-${i}-feedback`);
        if (!input || !feedback) return;
        const answer = p.displayAnswer || (p.a !== undefined ? String(p.a) : (p.accepted ? p.accepted[0] : ''));
        input.value = answer;
        input.disabled = true;
        const btn = input.parentElement && input.parentElement.querySelector('button');
        if (btn) { btn.disabled = true; btn.style.cursor = 'not-allowed'; }
        feedback.style.display = 'block';
        feedback.className = 'feedback-msg success locked';
        feedback.innerHTML = `Answer key: <strong>${answer}</strong>`;
      });
    });

    // Extension point for pages whose problems aren't in window.listRegistry
    // (multiple bespoke check functions, select dropdowns, multi-field
    // answers) - such a page defines window.revealAnswerKey itself and this
    // just calls it.
    if (typeof window.revealAnswerKey === 'function') window.revealAnswerKey();
  }

  async function handleGoogleSignIn(response) {
    idToken = response.credential;
    setStatus('Checking access...', false);
    try {
      const res = await fetchWithTimeout(LESSON_SYNC_API_URL, {
        method: 'POST',
        body: JSON.stringify({ idToken, type: 'access-check', activityId })
      });
      const result = await res.json();
      if (!result.ok) { setStatus(result.error || 'Could not verify your account.', true); return; }
      if (!result.allowed) { setStatus(result.reason || 'Access denied.', true); return; }
      if (result.role === 'teacher') { unlockTeacherView(result.student && result.student.name); return; }
      unlock(result.student, result.progress);
    } catch (err) {
      setStatus("Couldn't reach the roster - check your connection and try again.", true);
    }
  }
  window.handleGoogleSignIn = handleGoogleSignIn;

  function onRecord(item) {
    if (!ready || !idToken) return;
    fetchWithTimeout(LESSON_SYNC_API_URL, {
      method: 'POST',
      body: JSON.stringify({ idToken, type: 'submission', activityId, item })
    }).catch((err) => console.warn('Progress sync failed (kept on this page only):', err));
  }

  // LessonProgress.record() already exists (lesson-shared.js) and is
  // called by every LessonCheck.check()/submit() - wrapping it here, only
  // on pages that load this script, means no per-page call site needs to
  // change to get synced.
  LessonProgress.record = function (key, label, answer, verdict, section) {
    originalRecord(key, label, answer, verdict, section);
    onRecord({ key, label, answer, verdict, section });
  };

  function init(id) {
    activityId = id;
    patchSwitchTab();
  }

  return { init };
})();
