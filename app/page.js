"use client";

import Link from "next/link";
import taxonomy from "../content/taxonomy.json";
import { useAuth } from "./contexts/AuthContext";
import SignInButton from "./components/SignInButton";

const PAGE_ORDER = [
  "vocabulary",
  "explanation",
  "guided",
  "exercises",
  "enrichment",
  "assessment",
  "teacher-guide",
];

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

export default function HomePage() {
  const { user, loading } = useAuth();
  const role = user?.role ?? null;
  const canEdit = role === "admin" || role === "editor";
  const canSeeTeacherGuide = canEdit;
  const isAdmin = role === "admin";

  // Show login page while loading or when signed out
  if (loading) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-card__logo">📚</div>
          <h1 className="login-card__title">LIA Math Curriculum</h1>
          <p className="login-card__sub">Loading…</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-card__logo">📚</div>
          <h1 className="login-card__title">LIA Math Curriculum</h1>
          <p className="login-card__sub">
            Sign in with your school GitHub account to access lessons, activities, and
            teacher resources.
          </p>
          <div className="login-card__actions">
            <SignInButton />
          </div>
          <p className="login-card__hint">
            Access is granted to staff and enrolled students only.
          </p>
        </div>
      </div>
    );
  }

  const stats = computeStats();

  return (
    <div className="page-shell">
      {/* Welcome / stats bar */}
      <section className="hero-card">
        <span className="eyebrow">Curriculum Index</span>
        <h1>LIA Math Curriculum</h1>
        <p>Welcome back, <strong>{user.name}</strong>.</p>

        {isAdmin && (
          <dl className="stats">
            <div>
              <dt>Grades</dt>
              <dd>{stats.grades}</dd>
            </div>
            <div>
              <dt>Subjects</dt>
              <dd>{stats.totalSubjects}</dd>
            </div>
            <div>
              <dt>Topics</dt>
              <dd>{stats.totalTopics}</dd>
            </div>
            <div>
              <dt>Pages</dt>
              <dd>{stats.totalPages}</dd>
            </div>
          </dl>
        )}

        {isAdmin && (
          <div className="admin-toolbar" style={{ marginTop: "1rem" }}>
            <Link href="/admin" className="btn-primary">Admin Dashboard</Link>
            <Link href="/admin/topics/new" className="btn-ghost">+ New Topic</Link>
          </div>
        )}
      </section>

      {taxonomy.grades.map((grade) => (
        <section key={grade.id} className="panel">
          <h2 className="grade-heading">{grade.title}</h2>

          {grade.subjects.map((subject) => (
            <div key={subject.id} className="subject-section">
              <div className="subject-section__header">
                <h3 className="subject-heading">{subject.title}</h3>
                {canEdit && (
                  <Link
                    href={`/admin/topics/new?grade=${grade.slug}&subject=${subject.slug}`}
                    className="btn-ghost btn-ghost--sm"
                  >
                    + New Topic
                  </Link>
                )}
              </div>

              <div className="topic-grid">
                {subject.topics.map((topic) => {
                  const pages = PAGE_ORDER.map((slug) =>
                    topic.pages.find((p) => p.slug === slug),
                  ).filter(
                    (p) => p && (canSeeTeacherGuide || p.id !== "teacher-guide"),
                  );

                  return (
                    <article key={topic.id} className="topic-card">
                      <header className="topic-card__header">
                        <h4 className="topic-card__title">{topic.title}</h4>
                        <div className="topic-card__meta">
                          <span className="topic-card__standard">{topic.standard}</span>
                          {canEdit && (
                            <Link
                              href={`/admin/topics/${grade.slug}/${subject.slug}/${topic.slug}/`}
                              className="topic-card__edit-btn"
                              title="Edit topic"
                            >
                              ✏️
                            </Link>
                          )}
                        </div>
                      </header>

                      {topic.summary && (
                        <p className="topic-card__summary">{topic.summary}</p>
                      )}

                      <div className="page-buttons">
                        {pages.map((page) => (
                          <Link
                            key={page.id}
                            href={`/curriculum/${grade.slug}/${subject.slug}/${topic.slug}/${page.slug}/`}
                            className={`page-btn page-btn--${page.id}`}
                          >
                            {page.label ?? page.title}
                          </Link>
                        ))}
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}


