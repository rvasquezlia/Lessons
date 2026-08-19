"use client";

import Link from "next/link";
import { useState } from "react";
import taxonomy from "../../content/taxonomy.json";
import { useAuth } from "../contexts/AuthContext";

/**
 * Collapsible sidebar that renders the full Grade → Subject → Topic tree
 * from /content/taxonomy.json. Teacher-guide pages are only shown to
 * editors and admins.
 */
export default function Sidebar() {
  const { user } = useAuth();
  const role = user?.role ?? "student";
  const canSeeTeacherGuide = role === "admin" || role === "editor";

  return (
    <nav className="sidebar" aria-label="Curriculum navigation">
      <div className="sidebar__logo">
        <Link href="/" className="sidebar__home-link">
          📚 Lessons
        </Link>
      </div>

      {taxonomy.grades.map((grade) => (
        <GradeSection
          key={grade.id}
          grade={grade}
          canSeeTeacherGuide={canSeeTeacherGuide}
        />
      ))}
    </nav>
  );
}

function GradeSection({ grade, canSeeTeacherGuide }) {
  const [open, setOpen] = useState(true);

  return (
    <section className="sidebar__grade">
      <button
        className="sidebar__grade-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="sidebar__grade-label">{grade.title}</span>
        <span className="sidebar__chevron">{open ? "▾" : "▸"}</span>
      </button>

      {open &&
        grade.subjects.map((subject) => (
          <SubjectSection
            key={subject.id}
            subject={subject}
            gradeSlug={grade.slug}
            canSeeTeacherGuide={canSeeTeacherGuide}
          />
        ))}
    </section>
  );
}

function SubjectSection({ subject, gradeSlug, canSeeTeacherGuide }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="sidebar__subject">
      <button
        className="sidebar__subject-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span>{subject.title}</span>
        <span className="sidebar__chevron">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <ul className="sidebar__topics">
          {subject.topics.map((topic) => (
            <TopicItem
              key={topic.id}
              topic={topic}
              gradeSlug={gradeSlug}
              subjectSlug={subject.slug}
              canSeeTeacherGuide={canSeeTeacherGuide}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function TopicItem({ topic, gradeSlug, subjectSlug, canSeeTeacherGuide }) {
  const [open, setOpen] = useState(false);

  const visiblePages = topic.pages.filter(
    (p) => canSeeTeacherGuide || p.id !== "teacher-guide",
  );

  return (
    <li className="sidebar__topic">
      <button
        className="sidebar__topic-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span>{topic.title}</span>
        <span className="sidebar__chevron">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <ul className="sidebar__pages">
          {visiblePages.map((page) => (
            <li key={page.id}>
              <Link
                href={`/curriculum/${gradeSlug}/${subjectSlug}/${topic.slug}/${page.slug}/`}
                className="sidebar__page-link"
              >
                {page.label ?? page.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
