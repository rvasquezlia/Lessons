/**
 * lib/content-filter.js
 * ──────────────────────
 * Publishing pipeline utilities.
 *
 * At build time, filter out pages that are not in "published" status so
 * that draft and in-review content is never included in the static export.
 *
 * Page JSON schema (content/{grade}/{subject}/{topic}/{page}.json):
 * {
 *   "title": "...",
 *   "status": "draft" | "in_review" | "published",
 *   "taxonomy": { "gradeId": "...", "subjectId": "...", "topicId": "..." },
 *   "body": "<html>...",
 *   "updatedAt": "ISO8601",
 *   ...
 * }
 */

/** Pages with this status are visible in the static export. */
export const PUBLISHED_STATUS = "published";

/**
 * Filter a list of page metadata objects, returning only published ones.
 *
 * @param {Array<{status?: string, [key: string]: unknown}>} pages
 * @returns {Array}
 */
export function filterPublished(pages) {
  if (!Array.isArray(pages)) return [];
  return pages.filter((p) => p.status === PUBLISHED_STATUS);
}

/**
 * Given a taxonomy grade object, return a copy with non-published pages
 * removed from every topic.
 *
 * @param {object} grade  - Taxonomy grade node
 * @param {Map<string,object>} pageMetaMap  - Map of pageId → page JSON metadata
 * @returns {object}  Filtered grade
 */
export function filterGradeForExport(grade, pageMetaMap) {
  return {
    ...grade,
    subjects: grade.subjects.map((subject) => ({
      ...subject,
      topics: subject.topics.map((topic) => ({
        ...topic,
        pages: topic.pages.filter((page) => {
          const meta = pageMetaMap.get(page.id);
          // If no JSON metadata exists yet (legacy HTML), include it by default.
          // Once migrated, only "published" pages are included.
          if (!meta) return true;
          return meta.status === PUBLISHED_STATUS;
        }),
      })),
    })),
  };
}
