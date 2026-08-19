"use client";

/**
 * TaxonomySelector
 * ─────────────────
 * Inline Grade → Subject → Topic picker embedded in the CMS editor.
 * Updates the page's metadata categorization on change.
 */
import { useState, useEffect } from "react";
import taxonomy from "../../../content/taxonomy.json";

export default function TaxonomySelector({ value = {}, onChange }) {
  const [gradeId, setGradeId] = useState(value.gradeId ?? "");
  const [subjectId, setSubjectId] = useState(value.subjectId ?? "");
  const [topicId, setTopicId] = useState(value.topicId ?? "");

  const grade = taxonomy.grades.find((g) => g.id === gradeId);
  const subject = grade?.subjects.find((s) => s.id === subjectId);

  // Emit changes up
  useEffect(() => {
    const g = taxonomy.grades.find((gr) => gr.id === gradeId);
    const s = g?.subjects.find((su) => su.id === subjectId);
    const t = s?.topics.find((to) => to.id === topicId);
    onChange?.({ gradeId, subjectId, topicId, gradeMeta: g, subjectMeta: s, topicMeta: t });
  }, [gradeId, subjectId, topicId, onChange]);

  const handleGradeChange = (e) => {
    setGradeId(e.target.value);
    setSubjectId("");
    setTopicId("");
  };

  const handleSubjectChange = (e) => {
    setSubjectId(e.target.value);
    setTopicId("");
  };

  return (
    <div className="taxonomy-selector">
      <label className="taxonomy-selector__label">
        Grade
        <select
          className="taxonomy-selector__select"
          value={gradeId}
          onChange={handleGradeChange}
        >
          <option value="">— select —</option>
          {taxonomy.grades.map((g) => (
            <option key={g.id} value={g.id}>
              {g.title}
            </option>
          ))}
        </select>
      </label>

      <label className="taxonomy-selector__label">
        Subject
        <select
          className="taxonomy-selector__select"
          value={subjectId}
          onChange={handleSubjectChange}
          disabled={!gradeId}
        >
          <option value="">— select —</option>
          {grade?.subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
      </label>

      <label className="taxonomy-selector__label">
        Topic
        <select
          className="taxonomy-selector__select"
          value={topicId}
          onChange={(e) => setTopicId(e.target.value)}
          disabled={!subjectId}
        >
          <option value="">— select —</option>
          {subject?.topics.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
