"use client";

import Link from "next/link";
import taxonomy from "../../content/taxonomy.json";
import RequireRole from "../components/RequireRole";

function computeStats() {
  let totalSubjects = 0;
  let totalTopics = 0;
  let totalPages = 0;
  for (const grade of taxonomy.grades) {
    totalSubjects += grade.subjects.length;
    for (const subject of grade.subjects) {
      totalTopics += subject.topics.length;
      for (const topic of subject.topics) {
        totalPages += topic.pages.length;
      }
    }
  }
  return { grades: taxonomy.grades.length, totalSubjects, totalTopics, totalPages };
}

export default function AdminDashboard() {
  const stats = computeStats();

  return (
    <RequireRole roles={["admin"]}>
      <div className="page-shell">
        <section className="hero-card">
          <span className="eyebrow">Administration</span>
          <h1>Admin Dashboard</h1>
          <p>Manage curriculum content, users, and site settings.</p>

          <div className="admin-stat-grid">
            <div className="admin-stat-card">
              <div className="admin-stat-card__value">{stats.grades}</div>
              <div className="admin-stat-card__label">Grades</div>
            </div>
            <div className="admin-stat-card">
              <div className="admin-stat-card__value">{stats.totalSubjects}</div>
              <div className="admin-stat-card__label">Subjects</div>
            </div>
            <div className="admin-stat-card">
              <div className="admin-stat-card__value">{stats.totalTopics}</div>
              <div className="admin-stat-card__label">Topics</div>
            </div>
            <div className="admin-stat-card">
              <div className="admin-stat-card__value">{stats.totalPages}</div>
              <div className="admin-stat-card__label">Pages</div>
            </div>
          </div>

          <div className="admin-toolbar">
            <Link href="/admin/topics/new" className="btn-primary">+ New Topic</Link>
            <Link href="/" className="btn-ghost">← Back to Curriculum</Link>
          </div>
        </section>

        <section className="panel">
          <h2 className="grade-heading">Quick Links</h2>
          <ul className="admin-link-list">
            <li>
              <Link href="/admin/topics/new">📝 Create a new topic</Link>
            </li>
            <li>
              <Link href="/">📚 View full curriculum index</Link>
            </li>
          </ul>
        </section>

        <section className="panel">
          <h2 className="grade-heading">Curriculum Overview</h2>
          {taxonomy.grades.map((grade) => (
            <div key={grade.id} className="subject-section">
              <h3 className="subject-heading">{grade.title}</h3>
              {grade.subjects.map((subject) => (
                <div key={subject.id} style={{ marginBottom: "0.5rem" }}>
                  <strong style={{ fontSize: "0.85rem", color: "var(--muted)" }}>
                    {subject.title}
                  </strong>
                  <ul className="admin-link-list" style={{ marginTop: "0.4rem" }}>
                    {subject.topics.map((topic) => (
                      <li key={topic.id}>
                        <Link
                          href={`/admin/topics/${grade.slug}/${subject.slug}/${topic.slug}/`}
                        >
                          ✏️ {topic.title}
                          <span style={{ marginLeft: "auto", fontSize: "0.72rem", color: "var(--muted)" }}>
                            {topic.standard}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ))}
        </section>
      </div>
    </RequireRole>
  );
}
