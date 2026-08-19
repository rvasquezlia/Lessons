import roles from "../config/roles.json";
import taxonomy from "../content/taxonomy.json";

const gradeCount = taxonomy.grades.length;
const subjectCount = taxonomy.grades.reduce(
  (total, grade) => total + grade.subjects.length,
  0,
);
const topicCount = taxonomy.grades.reduce(
  (total, grade) =>
    total + grade.subjects.reduce((sum, subject) => sum + subject.topics.length, 0),
  0,
);
const pageCount = taxonomy.grades.reduce(
  (total, grade) =>
    total +
    grade.subjects.reduce(
      (subjectTotal, subject) =>
        subjectTotal +
        subject.topics.reduce((topicTotal, topic) => topicTotal + topic.pages.length, 0),
      0,
    ),
  0,
);

const appDirectories = [
  "app/",
  "content/",
  "config/",
  ".github/workflows/",
  "Lessons/",
  "_archive/",
];

export default function HomePage() {
  return (
    <main className="page-shell">
      <section className="hero-card">
        <span className="eyebrow">Phase 1 complete</span>
        <h1>Lessons is now scaffolded as a Next.js static export app.</h1>
        <p>
          This foundation keeps the repository self-contained, Git-backed, and ready for
          GitHub Pages deployment without adding a backend server or external database.
        </p>
      </section>

      <section className="grid">
        <article className="panel">
          <h2>Foundation summary</h2>
          <dl className="stats">
            <div>
              <dt>Grades</dt>
              <dd>{gradeCount}</dd>
            </div>
            <div>
              <dt>Subjects</dt>
              <dd>{subjectCount}</dd>
            </div>
            <div>
              <dt>Topics</dt>
              <dd>{topicCount}</dd>
            </div>
            <div>
              <dt>Pages</dt>
              <dd>{pageCount}</dd>
            </div>
            <div>
              <dt>Admins</dt>
              <dd>{roles.roles.admin.length}</dd>
            </div>
            <div>
              <dt>Editors</dt>
              <dd>{roles.roles.editor.length}</dd>
            </div>
          </dl>
        </article>

        <article className="panel">
          <h2>Repository structure</h2>
          <ul className="stack">
            {appDirectories.map((directory) => (
              <li key={directory}>
                <code>{directory}</code>
              </li>
            ))}
          </ul>
        </article>
      </section>

      <section className="panel">
        <h2>Current taxonomy seed</h2>
        <div className="taxonomy-list">
          {taxonomy.grades.map((grade) => (
            <article key={grade.id} className="taxonomy-card">
              <h3>{grade.title}</h3>
              {grade.subjects.map((subject) => (
                <div key={subject.id} className="subject-block">
                  <p className="subject-title">{subject.title}</p>
                  <ul className="stack">
                    {subject.topics.map((topic) => (
                      <li key={topic.id}>
                        <strong>{topic.title}</strong>
                        <span>{topic.standard}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

