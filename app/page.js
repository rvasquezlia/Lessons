"use client";

import Link from "next/link";
import taxonomy from "../content/taxonomy.json";
import { useAuth } from "./contexts/AuthContext";

const PAGE_ORDER = [
  "vocabulary",
  "explanation",
  "guided",
  "exercises",
  "enrichment",
  "assessment",
  "teacher-guide",
];

export default function HomePage() {
  const { user } = useAuth();
  const role = user?.role ?? "student";
  const canSeeTeacherGuide = role === "admin" || role === "editor";

  return (
    <div className="page-shell">
      <section className="hero-card">
        <span className="eyebrow">Curriculum Index</span>
        <h1>LIA Math Curriculum</h1>
        <p>
          Select a grade and topic below to begin. Sign in with your school Google account
          to access the full curriculum.
        </p>
      </section>

      {taxonomy.grades.map((grade) => (
        <section key={grade.id} className="panel">
          <h2 className="grade-heading">{grade.title}</h2>

          {grade.subjects.map((subject) => (
            <div key={subject.id} className="subject-section">
              <h3 className="subject-heading">{subject.title}</h3>

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
                        <span className="topic-card__standard">{topic.standard}</span>
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


