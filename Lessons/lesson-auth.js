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
  let googleLoaded = false;
  let initCalled = false;
  let googleInitialized = false;
  // Guards against a slow, stale request "winning" after a faster later
  // one already resolved things - without this, an earlier attempt that
  // times out AFTER a second attempt already unlocked the page can still
  // run its failure handler and re-reveal the sign-in gate on top of
  // already-unlocked content. Every call into proceedWithToken() captures
  // the generation at its start and checks it's still current before
  // touching the DOM; resolved permanently retires all of them once one
  // attempt actually succeeds.
  let requestGeneration = 0;
  let resolved = false;
  // Captured before the patch below replaces LessonProgress.record, so
  // restoreSubmissions() can update the on-page log directly without
  // going back through onRecord() and re-posting to the backend every
  // time the page loads.
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
        feedback.innerHTML = 'Recorded from your last session - your teacher can review it on the dashboard. <span style="opacity:.75;">(restored)</span>';
      }
      originalRecord(key, s.label, s.answer, s.verdict, s.section);
    });
  }

  function hideLoadingIndicator() {
    const el = document.getElementById('lesson-loading');
    // #lesson-loading has its own `display: flex` CSS rule (to center the
    // spinner) which beats the browser's default [hidden] { display:none }
    // on specificity - the hidden attribute alone doesn't hide it. Setting
    // style.display directly always wins.
    if (el) el.style.display = 'none';
  }

  function showAppContainer() {
    hideLoadingIndicator();
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
    // Full-width and flush against the container's own edges (no margin)
    // so it sits inside .app-container's rounded top corners instead of
    // floating above them - margins here used to leave a gap that broke
    // the rounded-corner illusion and made the header look disconnected
    // from the rest of the card. Styled via the .teacher-view-banner
    // class in lesson-shared.css rather than inline, including a real
    // pill-button treatment for the dashboard link instead of a plain
    // underlined link.
    const banner = document.createElement('div');
    banner.className = 'teacher-view-banner';
    banner.innerHTML = `<span>TEACHER VIEW - answer key shown below, not a student submission.</span>
      <a href="${TEACHER_DASHBOARD_URL}" target="_blank">Open Teacher Dashboard &rarr;</a>`;
    document.querySelector('.app-container').prepend(banner);

    const registry = window.listRegistry || {};
    Object.keys(registry).forEach((keyPrefix) => {
      const problems = registry[keyPrefix].problems || [];
      problems.forEach((p, i) => {
        const input = document.getElementById(`${keyPrefix}-${i}-input`);
        const feedback = document.getElementById(`${keyPrefix}-${i}-feedback`);
        if (!input || !feedback) return;
        const rawAnswer = p.displayAnswer || (p.a !== undefined ? String(p.a) : (p.accepted ? p.accepted[0] : ''));
        // displayAnswer isn't stored consistently site-wide: most units
        // store bare LaTeX ("\dfrac{V}{\pi r^2}"), but every Review.html
        // (plus one Vocabulary-Literacy) bakes its own \( \) delimiters
        // in already ("\(\frac{6}{9}\)"), since that string is also used
        // directly inside a "Correct! ..." message elsewhere on those
        // pages. Stripping any existing wrapper before using it either
        // way means both conventions produce the same result here,
        // instead of double-wrapping the second one into invalid,
        // unrenderable LaTeX (a literal stray \( inside the math itself).
        const answer = rawAnswer.replace(/^\\\(|\\\)$/g, '');
        // A plain <input>/<select> can't render LaTeX at all - only a
        // <math-field> parses it as real math. Several numeric-answer
        // items (p.a defined) also carry a richer displayAnswer meant for
        // the feedback text below (e.g. "-\frac{5}{6} \approx -0.83", the
        // fraction-equivalent shown alongside a decimal answer) - filling
        // that raw LaTeX into a plain input just showed the literal
        // unrendered source, cut off by the box's width. On anything but
        // a <math-field>, fall back to the bare numeric p.a instead - the
        // feedback text below still gets the richer `answer` either way.
        input.value = (input.tagName !== 'MATH-FIELD' && p.a !== undefined) ? String(p.a) : answer;
        input.disabled = true;
        const btn = input.parentElement && input.parentElement.querySelector('button');
        if (btn) { btn.disabled = true; btn.style.cursor = 'not-allowed'; }
        feedback.style.display = 'block';
        feedback.className = 'feedback-msg success locked';
        // Wrapped in \( \) so MathJax actually typesets it - unlike
        // input.value (which a math-field renders directly from raw
        // LaTeX with no MathJax involved), this is plain innerHTML text
        // with no renderer of its own - without delimiters it used to
        // show the literal LaTeX source instead of a rendered fraction,
        // easy to miss on a plain <input> (which showed that same
        // unrendered LaTeX as its own value, so nothing looked
        // inconsistent) but glaring next to a math-field rendering the
        // same answer correctly right above it.
        feedback.innerHTML = `Answer key: <strong>\\(${answer}\\)</strong>`;
      });
    });

    // Extension point for pages whose problems aren't in window.listRegistry
    // (multiple bespoke check functions, select dropdowns, multi-field
    // answers) - such a page defines window.revealAnswerKey itself and this
    // just calls it.
    if (typeof window.revealAnswerKey === 'function') window.revealAnswerKey();

    // Every gated page defines its own triggerMathJax() (checks
    // window.MathJax/typesetPromise before calling) - the answer-key text
    // just inserted above is new DOM content MathJax has never scanned,
    // so nothing renders until this runs.
    if (typeof triggerMathJax === 'function') triggerMathJax();
  }

  // Shared by a fresh button click/One Tap response and a cached token
  // resumed silently on page load - both end up here with just the raw
  // JWT string, so unlock()/unlockTeacherView() don't need to know which
  // path got them here. The gate stays hidden (see init()/tryStart())
  // until this actually fails, so a successful cached-token resume never
  // flashes any sign-in UI at all - only a failure reveals the gate and
  // brings up the real Google button/One Tap as a fallback.
  //
  // Apps Script's response time is genuinely variable (cold starts can
  // take several seconds) - isRetry lets a single transient failure retry
  // once with a longer timeout before actually giving up, instead of
  // immediately showing an error for what's often just a slow first
  // request. The generation check after every await is what stops a
  // slow, now-superseded attempt from undoing a later one that already
  // succeeded (see requestGeneration/resolved above).
  async function proceedWithToken(rawToken, isRetry) {
    const myGeneration = ++requestGeneration;
    idToken = rawToken;
    setStatus('Checking access...', false);
    try {
      const res = await fetchWithTimeout(LESSON_SYNC_API_URL, {
        method: 'POST',
        body: JSON.stringify({ idToken, type: 'access-check', activityId })
      }, isRetry ? 25000 : 15000);
      const result = await res.json();
      if (resolved || myGeneration !== requestGeneration) return; // superseded - ignore this stale result entirely
      if (!result.ok) {
        TokenCache.clear(); // token was rejected outright (expired/invalid) - don't keep retrying it silently
        showGateAndPromptSignIn();
        setStatus(result.error || 'Could not verify your account.', true);
        return;
      }
      TokenCache.save(rawToken);
      if (!result.allowed) {
        showGateAndPromptSignIn();
        setStatus(result.reason || 'Access denied.', true);
        return;
      }
      resolved = true;
      if (result.role === 'teacher') { unlockTeacherView(result.student && result.student.name); return; }
      unlock(result.student, result.progress);
    } catch (err) {
      if (resolved || myGeneration !== requestGeneration) return;
      if (!isRetry) {
        setStatus('Still checking - the server is taking a moment...', false);
        await new Promise((r) => setTimeout(r, 1200));
        if (resolved || myGeneration !== requestGeneration) return;
        return proceedWithToken(rawToken, true);
      }
      showGateAndPromptSignIn();
      setStatus("Couldn't reach the roster - check your connection and try again.", true);
    }
  }

  async function handleGoogleSignIn(response) {
    await proceedWithToken(response.credential);
  }
  window.handleGoogleSignIn = handleGoogleSignIn;

  // Reveals the gate and brings up Google's real sign-in UI (button +
  // One Tap) - only called once we know a silent cached-token resume
  // isn't going to work (none cached, or one failed after its retry).
  // Guarded so a second call (e.g. one failure path triggering another)
  // doesn't re-initialize or re-prompt on top of an already-visible
  // button.
  function showGateAndPromptSignIn() {
    if (resolved) return; // a later attempt already succeeded - never reveal the gate over already-unlocked content
    hideLoadingIndicator();
    const gate = document.getElementById('lesson-gate');
    if (gate) gate.hidden = false;
    if (googleInitialized) return;
    googleInitialized = true;
    google.accounts.id.initialize({
      client_id: LESSON_GOOGLE_CLIENT_ID,
      callback: handleGoogleSignIn,
      auto_select: true
    });
    const btnContainer = document.querySelector('#lesson-gate .g_id_signin');
    if (btnContainer) google.accounts.id.renderButton(btnContainer, { type: 'standard' });
    google.accounts.id.prompt();
  }

  // Only starts once both the page's own script has called init() (so
  // activityId is known) and the GIS library has actually finished
  // loading (it's async, so this can resolve before or after init() -
  // see the onload="onGoogleLibraryLoad()" attribute on the gsi/client
  // script tag). Whichever happens second runs this.
  function tryStart() {
    if (!googleLoaded || !initCalled) return;
    const cached = TokenCache.load();
    if (cached) {
      proceedWithToken(cached);
    } else {
      showGateAndPromptSignIn();
    }
  }

  function onGoogleLibraryLoad() {
    googleLoaded = true;
    tryStart();
  }
  window.onGoogleLibraryLoad = onGoogleLibraryLoad;

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
    initCalled = true;
    tryStart();
  }

  return { init };
})();
