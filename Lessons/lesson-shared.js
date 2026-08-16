// Shared answer-checking behavior for all Q0xWxx lesson pages (Sixth/Seventh/Eighth).
//
// Every practice item follows the same rule: students submit their own
// answer first. Correct -> praise. Wrong -> a review hint, no answer given
// away. Wrong a second time on the same problem -> the correct procedure is
// shown. LessonCheck tracks attempts per problem key and renders the right
// message for each outcome.
//
// LessonCheck also keeps a running log of every item a student has
// answered (LessonProgress) so the page can print a "proof of completion"
// summary - see printProgressReport() below.
const LessonProgress = (() => {
  const items = []; // ordered list of {key, label, answer, verdict}
  let openEndedCounter = 0;

  // Records/updates one practice item. verdict is 'correct', 'incomplete'
  // (never got it right), or 'reflection' (open-ended, no right answer).
  function record(key, label, answer, verdict) {
    const idx = items.findIndex((i) => i.key === key);
    const entry = { key, label, answer: answer || '(blank)', verdict };
    if (idx >= 0) items[idx] = entry;
    else items.push(entry);
  }

  // For open-ended reflection fields that don't go through LessonCheck.
  function recordText(label, text) {
    openEndedCounter++;
    record(`text-${openEndedCounter}-${label}`, label, text, 'reflection');
  }

  function all() {
    return items;
  }

  return { record, recordText, all };
})();

const LessonCheck = (() => {
  const attempts = {};

  // Returns 'correct', 'retry' (1st wrong attempt), or 'reveal' (2nd+ wrong attempt).
  function evaluate(key, isCorrect) {
    if (isCorrect) {
      attempts[key] = 0;
      return 'correct';
    }
    attempts[key] = (attempts[key] || 0) + 1;
    return attempts[key] >= 2 ? 'reveal' : 'retry';
  }

  function reset(key) {
    attempts[key] = 0;
  }

  function show(feedbackEl, outcome, messages) {
    feedbackEl.style.display = 'block';
    if (outcome === 'correct') {
      feedbackEl.className = 'feedback-msg success';
      feedbackEl.innerHTML = messages.correct;
    } else if (outcome === 'reveal') {
      feedbackEl.className = 'feedback-msg error';
      feedbackEl.innerHTML = messages.reveal;
    } else {
      feedbackEl.className = 'feedback-msg error';
      feedbackEl.innerHTML = messages.retry || "That's not correct yet. Review your work and try again.";
    }
    if (window.MathJax && window.MathJax.typesetPromise) {
      MathJax.typesetPromise([feedbackEl]).catch((err) => console.log(err));
    }
  }

  // One call that evaluates + renders together, for the common case.
  // Pass `record` as {label, answer} to log this item for the printable
  // progress report; omit it for items that shouldn't appear there.
  function check(key, isCorrect, feedbackEl, messages, record) {
    const outcome = evaluate(key, isCorrect);
    show(feedbackEl, outcome, messages);
    if (record) {
      LessonProgress.record(key, record.label, record.answer, outcome === 'correct' ? 'correct' : 'incomplete');
    }
    return outcome;
  }

  function numericMatch(raw, expected, tolerance = 0.01) {
    const v = parseFloat(String(raw || '').replace(/[^0-9.\-]/g, ''));
    return !isNaN(v) && Math.abs(v - expected) <= tolerance;
  }

  return { evaluate, reset, show, check, numericMatch };
})();

// ==========================================
// PRINTABLE PROGRESS / PROOF OF COMPLETION
// ==========================================
// Builds a print-only report (name, date, lesson title, every logged
// item with the student's answer and result) into a hidden #print-report
// element, then opens the browser print dialog. Students can print it or
// "Save as PDF" to submit as proof of completion to Google Classroom.
function printProgressReport(lessonTitle) {
  const nameField = document.getElementById('student-name');
  const name = (nameField && nameField.value.trim()) || '_________________________';
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const items = LessonProgress.all();

  let rows = '';
  if (items.length === 0) {
    rows = '<tr><td colspan="3" style="text-align:center; padding:16px;">No activities completed yet - work through the tabs on this page, then come back and print.</td></tr>';
  } else {
    items.forEach((item, i) => {
      const verdictLabel = item.verdict === 'correct' ? 'Correct'
        : item.verdict === 'reflection' ? 'Submitted'
        : 'Needs review';
      rows += `
        <tr>
          <td>${i + 1}. ${item.label}</td>
          <td>${item.answer}</td>
          <td>${verdictLabel}</td>
        </tr>`;
    });
  }

  const total = items.length;
  const correct = items.filter((i) => i.verdict === 'correct').length;

  const report = document.getElementById('print-report');
  report.innerHTML = `
    <h1>${lessonTitle}</h1>
    <p class="print-meta"><strong>Student:</strong> ${name} &nbsp;&nbsp; <strong>Date:</strong> ${today}</p>
    <p class="print-meta"><strong>Activities logged:</strong> ${total} &nbsp;&nbsp; <strong>Correct on first or second try:</strong> ${correct}</p>
    <table class="print-table">
      <thead><tr><th>Activity</th><th>Your Answer</th><th>Result</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="print-footer">Printed from the interactive lesson page as proof of completion.</p>
  `;

  window.print();
}
