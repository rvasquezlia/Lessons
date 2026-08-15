let currentSlide = 0;
let isDarkMode = true;

function closeDisclaimer() {
    document.getElementById('disclaimerModal').style.display = 'none';
}

function toggleTheme() {
    isDarkMode = !isDarkMode;
    const body = document.body;
    const themeBtn = document.getElementById('themeToggle');

    if (isDarkMode) {
        body.classList.remove('light-mode');
        themeBtn.innerHTML = 'Light Mode';
    } else {
        body.classList.add('light-mode');
        themeBtn.innerHTML = 'Dark Mode';
    }
}

function safeMathTypeset(targetEl) {
    if (window.MathJax && typeof window.MathJax.typesetPromise === 'function') {
        MathJax.typesetPromise(targetEl ? [targetEl] : []).catch(function(err) {
            console.warn('MathJax typeset warning:', err);
        });
    }
}

// Derives the active topic from the dropdown's own option values, so the
// highlighted topic always matches the slides it actually points to.
function syncTopicSelector() {
    const topicSelect = document.getElementById('topicSelect');
    const values = Array.from(topicSelect.options).map(opt => parseInt(opt.value, 10));
    let selected = values[0];
    for (const value of values) {
        if (currentSlide >= value) selected = value;
    }
    topicSelect.value = String(selected);
}

function renderSlide() {
    const slide = slides[currentSlide];
    document.getElementById('badge').innerText = slide.category;
    document.getElementById('ccssBadge').innerText = slide.ccss;
    document.getElementById('title').innerText = slide.title;

    const contentEl = document.getElementById('content');
    contentEl.innerHTML = slide.content;

    document.getElementById('counter').innerText = `Slide ${currentSlide + 1} of ${slides.length}`;
    document.getElementById('prevBtn').disabled = (currentSlide === 0);
    document.getElementById('nextBtn').disabled = (currentSlide === slides.length - 1);

    const progress = ((currentSlide + 1) / slides.length) * 100;
    document.getElementById('progressBar').style.width = `${progress}%`;

    syncTopicSelector();

    safeMathTypeset(contentEl);
}

function nextSlide() {
    if (currentSlide < slides.length - 1) {
        currentSlide++;
        renderSlide();
    }
}

function prevSlide() {
    if (currentSlide > 0) {
        currentSlide--;
        renderSlide();
    }
}

function jumpToTopic(slideIndex) {
    currentSlide = Math.min(parseInt(slideIndex, 10), slides.length - 1);
    renderSlide();
}

function toggleSolution(id) {
    const el = document.getElementById(id);
    if (el.style.display === "block") {
        el.style.display = "none";
    } else {
        el.style.display = "block";
        safeMathTypeset(el);
    }
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') nextSlide();
    if (e.key === 'ArrowLeft') prevSlide();
});

// Initial render
renderSlide();
