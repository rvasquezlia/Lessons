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
  const items = []; // ordered list of {key, label, section, answer, verdict}
  let openEndedCounter = 0;

  // Records/updates one practice item. verdict is 'correct', 'incomplete'
  // (never got it right), 'reflection' (open-ended or submit-only, no
  // right answer graded on screen), or 'not-attempted' (pre-registered,
  // never touched). `section` is the tab/section name shown on the
  // printed report - pass it every time an item is first registered.
  function record(key, label, answer, verdict, section) {
    const idx = items.findIndex((i) => i.key === key);
    const entry = {
      key,
      label,
      section: section || (idx >= 0 ? items[idx].section : ''),
      answer: (answer === '' || answer === undefined || answer === null) ? '(blank)' : answer,
      verdict
    };
    if (idx >= 0) items[idx] = entry;
    else items.push(entry);
  }

  // For open-ended reflection fields that don't go through LessonCheck.
  function recordText(label, text, section) {
    openEndedCounter++;
    record(`text-${openEndedCounter}-${label}`, label, text, 'reflection', section);
  }

  // Pre-registers a question as "not attempted" so it always shows up on
  // the printed report, in its correct section and position, even if the
  // student never touches it. Call once per question at render time -
  // record()/submit() later update this same entry in place once the
  // student actually answers, without disturbing its position.
  function preRegister(key, label, section) {
    if (!items.find((i) => i.key === key)) {
      items.push({ key, label, section: section || '', answer: '', verdict: 'not-attempted' });
    }
  }

  function all() {
    return items;
  }

  return { record, recordText, preRegister, all };
})();

const LessonCheck = (() => {
  const attempts = {};
  const locked = {};

  // Returns 'correct', 'retry' (1st wrong attempt), 'reveal' (2nd wrong
  // attempt - the correct procedure is shown and the problem locks), or
  // 'locked' (any attempt after that). Once locked, a problem can never
  // flip back to 'correct' - this stops a student from copying the
  // just-revealed answer back into the box to fake a correct result.
  function evaluate(key, isCorrect) {
    if (locked[key]) return 'locked';
    if (isCorrect) {
      attempts[key] = 0;
      return 'correct';
    }
    attempts[key] = (attempts[key] || 0) + 1;
    if (attempts[key] >= 2) {
      locked[key] = true;
      return 'reveal';
    }
    return 'retry';
  }

  function reset(key) {
    attempts[key] = 0;
    locked[key] = false;
  }

  function show(feedbackEl, outcome, messages) {
    feedbackEl.style.display = 'block';
    if (outcome === 'correct') {
      feedbackEl.className = 'feedback-msg success';
      feedbackEl.innerHTML = messages.correct;
    } else if (outcome === 'reveal' || outcome === 'locked') {
      feedbackEl.className = 'feedback-msg error' + (outcome === 'locked' ? ' locked' : '');
      feedbackEl.innerHTML = messages.reveal;
    } else {
      feedbackEl.className = 'feedback-msg error';
      feedbackEl.innerHTML = messages.retry || "That's not correct yet. Review your work and try again.";
    }
    if (window.MathJax && window.MathJax.typesetPromise) {
      MathJax.typesetPromise([feedbackEl]).catch((err) => console.log(err));
    }
  }

  // Disables the button that was just clicked (and any input/textarea
  // sharing its immediate container) so a locked problem can't be
  // resubmitted after the answer has been shown.
  function lockControls(feedbackEl) {
    const btn = window.event && window.event.target;
    if (btn && typeof btn.disabled !== 'undefined') {
      btn.disabled = true;
      btn.style.cursor = 'not-allowed';
      const container = btn.closest('.form-group, .challenge-box, .step-box, .station-card, .guided-practice, td, .carousel-card') || btn.parentElement;
      if (container) {
        container.querySelectorAll('input, textarea, select').forEach((el) => { el.disabled = true; });
      }
    }
    if (feedbackEl) feedbackEl.classList.add('locked');
  }

  // One call that evaluates + renders together, for the common case.
  // Pass `record` as {label, answer, section} to log this item for the
  // printable progress report; omit it for items that shouldn't appear
  // there.
  function check(key, isCorrect, feedbackEl, messages, record) {
    const outcome = evaluate(key, isCorrect);
    show(feedbackEl, outcome, messages);
    if (outcome === 'reveal') {
      lockControls(feedbackEl);
    }
    // 'locked' means this was already recorded when it first revealed -
    // never overwrite that with a later (possibly copied-in) answer.
    if (record && outcome !== 'locked') {
      LessonProgress.record(key, record.label, record.answer, outcome === 'correct' ? 'correct' : 'incomplete', record.section);
    }
    return outcome;
  }

  function numericMatch(raw, expected, tolerance = 0.01) {
    const v = parseFloat(String(raw || '').replace(/[^0-9.\-]/g, ''));
    return !isNaN(v) && Math.abs(v - expected) <= tolerance;
  }

  // For multi-field problems (a number plus an explanation, several sub-
  // answers, etc.): call this instead of check() when some field is still
  // blank. It shows a "fill everything in" message WITHOUT touching the
  // attempt counter, so a student mid-filling the form never burns one of
  // their two tries just for not being done yet.
  function incomplete(feedbackEl, message) {
    feedbackEl.style.display = 'block';
    feedbackEl.className = 'feedback-msg error';
    feedbackEl.innerHTML = message || "Please fill in every field before checking - an incomplete submission doesn't count as an attempt.";
    if (window.MathJax && window.MathJax.typesetPromise) {
      MathJax.typesetPromise([feedbackEl]).catch((err) => console.log(err));
    }
  }

  // For "submit-only" items (anything that isn't a formally labeled
  // Guided Practice section): records the answer for the printed report
  // without grading it on screen - the on-screen message is always the
  // same neutral "Submitted!" success box, whether or not the answer is
  // right, so nothing is revealed to the student here. No attempt
  // counter either. The submission itself is final: once a non-blank
  // answer goes through, the fields lock (same as a revealed Guided
  // Practice problem) so the printed answer can't be quietly edited
  // afterward.
  //
  // `record` is required: {key, label, answer, section, correct}.
  // `correct` is optional - pass true/false when this item has a single
  // checkable right answer (an equation, a classification, ...) so the
  // printed audit shows a real Correct/Needs review verdict instead of
  // just "Submitted". Omit it for genuinely open-ended items (written
  // explanations, recommendations) that have no one right answer - those
  // stay "Submitted" and are judged by the teacher from the printout.
  function submit(feedbackEl, record, message) {
    if (feedbackEl) {
      feedbackEl.style.display = 'block';
      feedbackEl.className = 'feedback-msg success locked';
      feedbackEl.innerHTML = message || 'Submitted! This will be reviewed from your printed progress report.';
      if (window.MathJax && window.MathJax.typesetPromise) {
        MathJax.typesetPromise([feedbackEl]).catch((err) => console.log(err));
      }
    }
    if (record) {
      const verdict = record.correct === true ? 'correct' : record.correct === false ? 'incomplete' : 'reflection';
      LessonProgress.record(record.key, record.label, record.answer, verdict, record.section);
    }
    lockControls(feedbackEl);
  }

  return { evaluate, reset, show, check, numericMatch, incomplete, submit };
})();

// ==========================================
// NUMBER LINE DIAGRAM (reusable, no external library)
// ==========================================
// Renders a horizontal number line into the element with id `containerId`.
// opts: { min, max, step (tick spacing, default 1),
//         points: [{value, label, color}],
//         arrows: [{from, to, label, color, row}] } - `row` (0, 1, 2...)
//         stacks an arrow's arc higher so it doesn't overlap arrows on row 0.
// Pure inline SVG - prints correctly (no CSS background-image reliance) and
// needs no external charting library or CDN script.
function renderNumberLine(containerId, opts) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const min = opts.min, max = opts.max, step = opts.step || 1;
  const arrows = opts.arrows || [];
  const points = opts.points || [];
  const maxRow = arrows.reduce((m, a) => Math.max(m, a.row || 0), 0);
  const width = 600;
  const height = 90 + maxRow * 30;
  const marginX = 26;
  const lineY = height - 32;
  const usableWidth = width - marginX * 2;
  const xFor = (v) => marginX + ((v - min) / (max - min)) * usableWidth;

  let defs = '';
  let body = `<line x1="${marginX}" y1="${lineY}" x2="${width - marginX}" y2="${lineY}" stroke="#1e3a8a" stroke-width="2"/>`;

  for (let v = min; v <= max; v += step) {
    const x = xFor(v);
    body += `<line x1="${x}" y1="${lineY - 6}" x2="${x}" y2="${lineY + 6}" stroke="#1e3a8a" stroke-width="2"/>`;
    body += `<text x="${x}" y="${lineY + 22}" text-anchor="middle" font-size="13" fill="#334155" font-family="Montserrat, sans-serif">${v}</text>`;
  }

  arrows.forEach((a, i) => {
    const x1 = xFor(a.from), x2 = xFor(a.to);
    const arcHeight = 26 + (a.row || 0) * 30;
    const midX = (x1 + x2) / 2;
    const topY = lineY - arcHeight;
    const color = a.color || '#d97706';
    const markerId = `nl-arrow-${containerId}-${i}`;
    defs += `<marker id="${markerId}" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="${color}"/></marker>`;
    body += `<path d="M ${x1} ${lineY - 4} Q ${midX} ${topY} ${x2} ${lineY - 4}" fill="none" stroke="${color}" stroke-width="2.5" marker-end="url(#${markerId})"/>`;
    if (a.label) {
      body += `<text x="${midX}" y="${topY - 6}" text-anchor="middle" font-size="12" fill="${color}" font-weight="700" font-family="Montserrat, sans-serif">${a.label}</text>`;
    }
  });

  points.forEach((p) => {
    const x = xFor(p.value);
    const color = p.color || '#1e3a8a';
    body += `<circle cx="${x}" cy="${lineY}" r="5" fill="${color}"/>`;
    if (p.label) {
      body += `<text x="${x}" y="${lineY - 12}" text-anchor="middle" font-size="12" fill="${color}" font-weight="700" font-family="Montserrat, sans-serif">${p.label}</text>`;
    }
  });

  el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" style="width:100%; max-width:600px; display:block; margin:12px auto;" role="img" aria-label="Number line diagram from ${min} to ${max}"><defs>${defs}</defs>${body}</svg>`;
}

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

  const verdictLabel = (v) => v === 'correct' ? 'Correct'
    : v === 'reflection' ? 'Submitted'
    : v === 'not-attempted' ? 'Not attempted'
    : 'Needs review';

  let rows = '';
  if (items.length === 0) {
    rows = '<tr><td colspan="3" style="text-align:center; padding:16px;">No activities on this page yet - work through the tabs, then come back and print.</td></tr>';
  } else {
    // Group by section, then order sections by their leading "N." number
    // (matching tab/page order) rather than insertion order - insertion
    // order depends on each page's init-script call sequence, which is
    // easy to get wrong and shouldn't be load-bearing for report order.
    const sectionOrder = [];
    const bySection = {};
    items.forEach((item) => {
      const sec = item.section || 'This Page';
      if (!bySection[sec]) { bySection[sec] = []; sectionOrder.push(sec); }
      bySection[sec].push(item);
    });
    sectionOrder.sort((a, b) => {
      const na = parseInt(a, 10);
      const nb = parseInt(b, 10);
      const aHas = !isNaN(na), bHas = !isNaN(nb);
      if (aHas && bHas) return na - nb;
      if (aHas) return -1;
      if (bHas) return 1;
      return 0;
    });

    let n = 0;
    sectionOrder.forEach((sec) => {
      rows += `<tr class="print-section-row"><td colspan="3">${sec}</td></tr>`;
      bySection[sec].forEach((item) => {
        n++;
        const answerText = item.verdict === 'not-attempted'
          ? '<span class="print-blank">&mdash;</span>'
          : item.answer;
        rows += `
          <tr>
            <td>${n}. ${item.label}</td>
            <td>${answerText}</td>
            <td>${verdictLabel(item.verdict)}</td>
          </tr>`;
      });
    });
  }

  const total = items.length;
  const attempted = items.filter((i) => i.verdict !== 'not-attempted').length;
  const correct = items.filter((i) => i.verdict === 'correct').length;

  const report = document.getElementById('print-report');
  report.innerHTML = `
    <h1>${lessonTitle}</h1>
    <p class="print-meta"><strong>Student:</strong> ${name} &nbsp;&nbsp; <strong>Date:</strong> ${today}</p>
    <p class="print-meta"><strong>Questions on this page:</strong> ${total} &nbsp;&nbsp; <strong>Attempted:</strong> ${attempted} &nbsp;&nbsp; <strong>Correct on first or second try:</strong> ${correct}</p>
    <table class="print-table">
      <thead><tr><th>Activity</th><th>Answer Given</th><th>Result</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="print-footer">Printed from the interactive lesson page as a full record of this student's work, section by section.</p>
  `;

  window.print();
}

// ============================================================
// TEACHER PRINT MODE - "Print Class Progress"
//
// A teacher who didn't finish a lesson can check off which tabs were
// actually covered today, then print those tabs as a clean handout -
// carousels expanded to every worked example (not just whichever one
// was on screen), everything else as-is. Activated by loading a lesson
// page with ?teacherPrint=1; entry-point links live in the Teacher Guide.
//
// A page with carousels should call TeacherPrint.registerCarousel() once
// per carousel, right after that carousel's data array and render
// function are defined, so the full-expansion printout can reuse the
// page's own existing render logic instead of duplicating it here.
// ============================================================
const TeacherPrint = (function () {
  const carousels = []; // {containerId, count, showAtFn}
  const answerLists = []; // {listContainerId, items: [{inputId, answerText}]}

  function registerCarousel(containerId, count, showAtFn) {
    carousels.push({ containerId, count, showAtFn });
  }

  // items: array of {inputId, answerText} - inputId is the <input>/<select>
  // id already used by the page's own Check button for that item, so the
  // answer key can be printed right next to the field a student would
  // have filled in. answerText is a plain string, e.g. "16.85".
  function registerAnswerList(listContainerId, items) {
    answerLists.push({ listContainerId, items });
  }

  function buildBar() {
    const tabs = [...document.querySelectorAll('.tab-btn')];
    if (!tabs.length) return;

    const checklistHtml = tabs.map((t) => {
      const m = (t.getAttribute('onclick') || '').match(/switchTab\('([^']+)'\)/);
      if (!m) return '';
      return `<label><input type="checkbox" class="tp-cb" value="${m[1]}" checked> ${t.textContent.trim()}</label>`;
    }).join('');

    const bar = document.createElement('div');
    bar.className = 'tp-control-bar no-print';
    bar.innerHTML = `
      <div class="tp-title">Print Class Progress - check what you covered today, then generate</div>
      <div class="tp-checklist">${checklistHtml}</div>
      <label style="display:flex; align-items:center; gap:6px; margin-bottom:12px; width:fit-content;"><input type="checkbox" id="tp-include-answers"> Include answer key (for your copy, not the students')</label>
      <button type="button">Generate Printable</button>
    `;
    document.body.insertBefore(bar, document.body.firstChild);
    bar.querySelector('button').addEventListener('click', generate);
  }

  function generate() {
    const checked = [...document.querySelectorAll('.tp-cb:checked')].map((cb) => cb.value);
    const includeAnswers = document.getElementById('tp-include-answers')?.checked;

    document.querySelectorAll('.panel').forEach((panel) => {
      panel.classList.toggle('active', checked.includes(panel.id));
    });

    carousels.forEach((c) => {
      const container = document.getElementById(c.containerId);
      if (!container) return;
      const panel = container.closest('.panel');
      if (!panel || !checked.includes(panel.id)) return;

      // The interactive shell around a carousel (its nav bar, and the
      // heading introducing it as "interactive") doesn't apply once
      // expanded to a flat list of worked examples - hide the whole shell
      // and its heading rather than just the content div, so an empty
      // bordered card isn't left behind wasting most of a page.
      const card = container.closest('.carousel-card') || container;
      const heading = card.previousElementSibling;
      if (heading && heading.tagName === 'H3') heading.classList.add('no-print');
      card.classList.add('no-print');

      let printDiv = document.getElementById(c.containerId + '-tp-all');
      if (!printDiv) {
        printDiv = document.createElement('div');
        printDiv.id = c.containerId + '-tp-all';
        printDiv.className = 'tp-print-all';
        card.parentNode.insertBefore(printDiv, card.nextSibling);
      }
      let html = '';
      for (let i = 0; i < c.count; i++) {
        c.showAtFn(i);
        html += `<div class="tp-example">${container.innerHTML}</div>`;
      }
      printDiv.innerHTML = html;
    });

    if (includeAnswers) {
      answerLists.forEach((a) => {
        const list = document.getElementById(a.listContainerId);
        if (!list) return;
        const panel = list.closest('.panel');
        if (!panel || !checked.includes(panel.id)) return;
        a.items.forEach((item) => {
          const input = document.getElementById(item.inputId);
          if (!input) return;
          const tag = document.createElement('span');
          tag.className = 'tp-answer-tag';
          tag.textContent = `Answer: ${item.answerText}`;
          input.insertAdjacentElement('afterend', tag);
        });
      });
    }

    document.body.classList.add('teacher-print-mode');

    const finish = () => window.print();
    if (window.MathJax && window.MathJax.typesetPromise) {
      MathJax.typesetPromise().then(finish).catch(finish);
    } else {
      finish();
    }
  }

  function init() {
    if (new URLSearchParams(window.location.search).get('teacherPrint') !== '1') return;
    document.addEventListener('DOMContentLoaded', buildBar);
  }

  init();
  return { registerCarousel, registerAnswerList };
})();
