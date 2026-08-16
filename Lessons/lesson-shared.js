// Shared answer-checking behavior for all Q0xWxx lesson pages (Sixth/Seventh/Eighth).
//
// Every practice item follows the same rule: students submit their own
// answer first. Correct -> praise. Wrong -> a review hint, no answer given
// away. Wrong a second time on the same problem -> the correct procedure is
// shown. LessonCheck tracks attempts per problem key and renders the right
// message for each outcome.
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
  function check(key, isCorrect, feedbackEl, messages) {
    const outcome = evaluate(key, isCorrect);
    show(feedbackEl, outcome, messages);
    return outcome;
  }

  function numericMatch(raw, expected, tolerance = 0.01) {
    const v = parseFloat(String(raw || '').replace(/[^0-9.\-]/g, ''));
    return !isNaN(v) && Math.abs(v - expected) <= tolerance;
  }

  return { evaluate, reset, show, check, numericMatch };
})();
