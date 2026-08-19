"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import taxonomy from "../../../../content/taxonomy.json";
import RequireRole from "../../../components/RequireRole";

const PAGE_SLUGS = [
  { id: "vocabulary", label: "Vocabulary" },
  { id: "explanation", label: "Explanation" },
  { id: "guided", label: "Guided Practice" },
  { id: "exercises", label: "Exercises" },
  { id: "enrichment", label: "Enrichment" },
  { id: "assessment", label: "Assessment" },
  { id: "teacher-guide", label: "Teacher Guide" },
];

function NewTopicForm() {
  const searchParams = useSearchParams();

  const [gradeSlug, setGradeSlug] = useState(searchParams.get("grade") ?? "");
  const [subjectSlug, setSubjectSlug] = useState(searchParams.get("subject") ?? "");
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [standard, setStandard] = useState("");
  const [summary, setSummary] = useState("");
  const [selectedPages, setSelectedPages] = useState(
    PAGE_SLUGS.map((p) => p.id),
  );
  const [submitted, setSubmitted] = useState(false);

  const selectedGrade = taxonomy.grades.find((g) => g.slug === gradeSlug);
  const subjects = selectedGrade?.subjects ?? [];
  const selectedSubject = subjects.find((s) => s.slug === subjectSlug);

  function toSlug(str) {
    return str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  function handleTitleChange(e) {
    const val = e.target.value;
    setTitle(val);
    setSlug(toSlug(val));
  }

  function togglePage(id) {
    setSelectedPages((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    );
  }

  function handleSubmit(e) {
    e.preventDefault();
    // In the full implementation this would commit via Octokit.
    // For now, show a success state with the generated JSON.
    setSubmitted(true);
  }

  const newTopicJson = {
    id: slug || "new-topic",
    title,
    slug: slug || "new-topic",
    standard,
    summary,
    pages: selectedPages.map((id) => {
      const def = PAGE_SLUGS.find((p) => p.id === id);
      return {
        id,
        title: def.label,
        slug: id,
        label: def.label,
        sourcePath: `Lessons/${gradeSlug}/Topics/${slug || "new-topic"}/${id === "guided" || id === "exercises" || id === "enrichment" || id === "assessment" ? "practice/" : ""}${id}.html`,
      };
    }),
  };

  return (
    <RequireRole roles={["admin", "editor"]}>
      <div className="page-shell">
        <section className="hero-card">
          <span className="eyebrow">Admin › New Topic</span>
          <h1>Create a New Topic</h1>
          <p>Fill in the topic details. The entry will be added to <code>content/taxonomy.json</code>.</p>
        </section>

        {submitted ? (
          <section className="panel">
            <h2 className="grade-heading">Topic Ready ✅</h2>
            <p>
              Your topic <strong>{title}</strong> has been prepared. The JSON below
              should be committed to <code>content/taxonomy.json</code> under{" "}
              <code>{gradeSlug} → {subjectSlug} → topics[]</code>.
            </p>
            <pre
              style={{
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: "0.5rem",
                padding: "1rem",
                fontSize: "0.78rem",
                overflowX: "auto",
              }}
            >
              {JSON.stringify(newTopicJson, null, 2)}
            </pre>
            <div className="form-actions" style={{ marginTop: "1rem" }}>
              <button className="btn-ghost" onClick={() => setSubmitted(false)}>
                ← Edit
              </button>
              <Link href="/admin" className="btn-primary">Dashboard</Link>
            </div>
          </section>
        ) : (
          <section className="panel">
            <form className="form-stack" onSubmit={handleSubmit}>
              <div className="form-field">
                <label htmlFor="grade">Grade</label>
                <select
                  id="grade"
                  value={gradeSlug}
                  onChange={(e) => { setGradeSlug(e.target.value); setSubjectSlug(""); }}
                  required
                >
                  <option value="">Select a grade…</option>
                  {taxonomy.grades.map((g) => (
                    <option key={g.id} value={g.slug}>{g.title}</option>
                  ))}
                </select>
              </div>

              <div className="form-field">
                <label htmlFor="subject">Subject</label>
                <select
                  id="subject"
                  value={subjectSlug}
                  onChange={(e) => setSubjectSlug(e.target.value)}
                  required
                  disabled={!selectedGrade}
                >
                  <option value="">Select a subject…</option>
                  {subjects.map((s) => (
                    <option key={s.id} value={s.slug}>{s.title}</option>
                  ))}
                </select>
              </div>

              <div className="form-field">
                <label htmlFor="title">Topic Title</label>
                <input
                  id="title"
                  type="text"
                  value={title}
                  onChange={handleTitleChange}
                  placeholder="e.g. Fractions and Mixed Numbers"
                  required
                />
              </div>

              <div className="form-field">
                <label htmlFor="slug">URL Slug (auto-generated)</label>
                <input
                  id="slug"
                  type="text"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="fractions-and-mixed-numbers"
                  required
                />
              </div>

              <div className="form-field">
                <label htmlFor="standard">Standard (e.g. 6.NS.A.1)</label>
                <input
                  id="standard"
                  type="text"
                  value={standard}
                  onChange={(e) => setStandard(e.target.value)}
                  placeholder="6.NS.A.1"
                />
              </div>

              <div className="form-field">
                <label htmlFor="summary">Summary</label>
                <textarea
                  id="summary"
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  placeholder="A short description of what this topic covers…"
                />
              </div>

              <div className="form-field">
                <label>Pages to include</label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "0.25rem" }}>
                  {PAGE_SLUGS.map((page) => (
                    <label
                      key={page.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.3rem",
                        fontSize: "0.85rem",
                        cursor: "pointer",
                        padding: "0.3rem 0.6rem",
                        border: "1px solid var(--border)",
                        borderRadius: "0.4rem",
                        background: selectedPages.includes(page.id) ? "var(--primary-light)" : "var(--bg)",
                        borderColor: selectedPages.includes(page.id) ? "var(--primary)" : "var(--border)",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selectedPages.includes(page.id)}
                        onChange={() => togglePage(page.id)}
                        style={{ margin: 0 }}
                      />
                      {page.label}
                    </label>
                  ))}
                </div>
              </div>

              <div className="form-actions">
                <button type="submit" className="btn-primary" disabled={!selectedSubject}>
                  Create Topic →
                </button>
                <Link href="/admin" className="btn-ghost">Cancel</Link>
              </div>
            </form>
          </section>
        )}
      </div>
    </RequireRole>
  );
}

export default function NewTopicPage() {
  return (
    <Suspense fallback={<div className="page-shell"><section className="panel"><p>Loading…</p></section></div>}>
      <NewTopicForm />
    </Suspense>
  );
}
