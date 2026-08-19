#!/usr/bin/env node
/**
 * scripts/migrate-legacy.js
 * ──────────────────────────────────────────────────────────────────────
 * Migration utility: parse existing legacy HTML/JS exercise files into
 * the new /content/{grade}/{subject}/{topic}/{page}.json schema.
 *
 * Usage:
 *   node scripts/migrate-legacy.js [--dry-run] [--grade <slug>]
 *
 * What it does:
 *  1. Reads content/taxonomy.json to discover all known grade/subject/topic/page paths.
 *  2. For each page that has a "sourcePath" pointing to a legacy HTML file:
 *       a. Reads the HTML file.
 *       b. Extracts the main content element (<article>, <main>, or <body>).
 *       c. Auto-repairs broken LaTeX escape strings (\\frac → \frac, etc.).
 *       d. Writes a new JSON file at content/{gradeSlug}/{subjectSlug}/{topicSlug}/{pageSlug}.json
 *          with status "draft" so editors can review before publishing.
 *  3. Regenerates content/taxonomy.json if new topics are discovered in the
 *     legacy Lessons/{Grade}/Topics/ directory tree.
 *
 * Flags:
 *   --dry-run   Print what would be written without creating files.
 *   --grade     Migrate only pages belonging to the given grade slug.
 */

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const TAXONOMY_PATH = path.join(REPO_ROOT, "content", "taxonomy.json");
const CONTENT_ROOT = path.join(REPO_ROOT, "content");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const GRADE_FILTER = (() => {
  const idx = args.indexOf("--grade");
  return idx !== -1 ? args[idx + 1] : null;
})();

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Auto-repair broken LaTeX escape sequences in HTML content.
 * Legacy files often contain \\frac, \\sqrt etc. from copy-paste.
 */
function repairLatex(str) {
  // Double-backslash before LaTeX command → single backslash
  return str.replace(/\\{2}([a-zA-Z{}\[\]()^_])/g, "\\$1");
}

/**
 * Extract the main content HTML from a legacy HTML file.
 * Priority: <article>, <main>, <div class="content">, <body>
 */
function extractContent(html) {
  // Very lightweight extraction without a full DOM parser
  // to avoid requiring additional npm packages at migration time.
  const candidates = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<body[^>]*>([\s\S]*?)<\/body>/i,
  ];

  for (const re of candidates) {
    const m = html.match(re);
    if (m) return m[1].trim();
  }
  return html; // fallback: return entire file
}

/**
 * Extract the <title> tag value from an HTML file.
 */
function extractTitle(html) {
  const m = html.match(/<title[^>]*>(.*?)<\/title>/i);
  return m ? m[1].trim() : "";
}

/**
 * Convert a file-system slug/path to a content-schema path segment.
 */
function toSlug(str) {
  return str.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

// ──────────────────────────────────────────────────────────────────────────
// Migration core
// ──────────────────────────────────────────────────────────────────────────

function migratePage({ gradeSlug, subjectSlug, topicSlug, page }) {
  const sourcePath = page.sourcePath;
  if (!sourcePath) {
    console.warn(`  [SKIP] ${page.id}: no sourcePath`);
    return null;
  }

  const absoluteSource = path.join(REPO_ROOT, sourcePath);
  if (!fs.existsSync(absoluteSource)) {
    console.warn(`  [SKIP] ${page.id}: file not found → ${absoluteSource}`);
    return null;
  }

  const rawHtml = fs.readFileSync(absoluteSource, "utf8");
  const body = repairLatex(extractContent(rawHtml));
  const htmlTitle = extractTitle(rawHtml);

  const pageJson = {
    schemaVersion: 1,
    id: page.id,
    title: htmlTitle || page.title,
    slug: page.slug,
    label: page.label ?? page.title,
    status: "draft", // default — editor must publish
    taxonomy: {
      gradeSlug,
      subjectSlug,
      topicSlug,
    },
    body,
    migratedFrom: sourcePath,
    migratedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const destDir = path.join(CONTENT_ROOT, gradeSlug, subjectSlug, topicSlug);
  const destFile = path.join(destDir, `${page.slug}.json`);

  if (DRY_RUN) {
    console.log(`  [DRY-RUN] Would write → ${path.relative(REPO_ROOT, destFile)}`);
    return destFile;
  }

  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(destFile, JSON.stringify(pageJson, null, 2) + "\n", "utf8");
  console.log(`  [MIGRATED] → ${path.relative(REPO_ROOT, destFile)}`);
  return destFile;
}

function run() {
  if (!fs.existsSync(TAXONOMY_PATH)) {
    console.error("ERROR: content/taxonomy.json not found.");
    process.exit(1);
  }

  const taxonomy = JSON.parse(fs.readFileSync(TAXONOMY_PATH, "utf8"));
  let totalPages = 0;
  let migratedPages = 0;

  for (const grade of taxonomy.grades) {
    if (GRADE_FILTER && grade.slug.toLowerCase() !== GRADE_FILTER.toLowerCase()) continue;

    console.log(`\nGrade: ${grade.title} (${grade.slug})`);

    for (const subject of grade.subjects) {
      console.log(`  Subject: ${subject.title}`);

      for (const topic of subject.topics) {
        console.log(`    Topic: ${topic.title}`);

        for (const page of topic.pages) {
          totalPages++;
          const result = migratePage({
            gradeSlug: toSlug(grade.slug),
            subjectSlug: subject.slug,
            topicSlug: topic.slug,
            page,
          });
          if (result) migratedPages++;
        }
      }
    }
  }

  console.log(
    `\n✓ Migration complete. ${migratedPages}/${totalPages} pages ${DRY_RUN ? "(dry-run)" : "written"}.`,
  );

  // ── Taxonomy sync ──
  // Scan legacy Lessons/{Grade}/Topics/ for any topic directories not yet
  // represented in taxonomy.json and log them for manual review.
  console.log("\nScanning for unmapped legacy topics…");
  const legacyRoot = path.join(REPO_ROOT, "Lessons");
  if (fs.existsSync(legacyRoot)) {
    const gradeDirs = fs.readdirSync(legacyRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
      .map((d) => d.name);

    for (const gradeDir of gradeDirs) {
      const topicsDir = path.join(legacyRoot, gradeDir, "Topics");
      if (!fs.existsSync(topicsDir)) continue;

      const topicDirs = fs.readdirSync(topicsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);

      const knownGrade = taxonomy.grades.find(
        (g) => g.slug.toLowerCase() === gradeDir.toLowerCase(),
      );
      const knownTopics = (knownGrade?.subjects ?? [])
        .flatMap((s) => s.topics)
        .map((t) => t.slug);

      for (const topicDir of topicDirs) {
        if (!knownTopics.includes(topicDir)) {
          console.warn(`  [UNMAPPED] ${gradeDir}/Topics/${topicDir} — add to taxonomy.json`);
        }
      }
    }
  }
}

run();
