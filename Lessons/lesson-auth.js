// Pilot integration with the shared progress-tracking backend documented
// in /CLAUDE.md - see that file before changing the URL/Client ID below or
// the request shapes. Only pages that include this script gate behind
// Google sign-in and sync progress; every other lesson page is untouched.
const LESSON_SYNC_API_URL = 'https://script.google.com/macros/s/AKfycbyC7mb1TKfg3JvhiZftXMf7oXkzrBMWJczZSURC7sIfoIxYnZrrumYfx-j7JYTY0A9i/exec';
const LESSON_GOOGLE_CLIENT_ID = '478111261772-7l1qamohr0fjsa7ekosuhpj9jum1q4vc.apps.googleusercontent.com';

const LessonSync = (() => {
  let activityId = null;
  let idToken = null;
  let ready = false;

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

  function unlock(student) {
    ready = true;
    document.getElementById('lesson-gate').hidden = true;
    document.querySelector('.app-container').hidden = false;
    const nameField = document.getElementById('student-name');
    if (nameField && student && student.name) {
      nameField.value = student.name;
      nameField.disabled = true;
    }
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
      unlock(result.student);
    } catch (err) {
      setStatus("Couldn't reach the roster - check your connection and try again.", true);
    }
  }
  window.handleGoogleSignIn = handleGoogleSignIn;

  // Fired on every LessonProgress.record() call (see the patch below) -
  // pushes that same item to the backend so SubmissionsLog stays in sync
  // with what the printed report shows, without every lesson page needing
  // its own explicit sync call at each Check button.
  function onRecord(item) {
    if (!ready || !idToken) return;
    fetchWithTimeout(LESSON_SYNC_API_URL, {
      method: 'POST',
      body: JSON.stringify({ idToken, type: 'submission', activityId, item })
    }).catch((err) => console.warn('Progress sync failed (kept on this page only):', err));
  }

  function init(id) {
    activityId = id;
  }

  return { init, onRecord };
})();

// LessonProgress.record() already exists (lesson-shared.js) and is called
// by every LessonCheck.check()/submit() - wrapping it here, only on pages
// that load this script, means no per-page call site needs to change to
// get synced.
const _lessonProgressRecord = LessonProgress.record;
LessonProgress.record = function (key, label, answer, verdict, section) {
  _lessonProgressRecord(key, label, answer, verdict, section);
  LessonSync.onRecord({ key, label, answer, verdict, section });
};
