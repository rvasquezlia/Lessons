"use client";

import { useAuth } from "../contexts/AuthContext";

const GITHUB_CLIENT_ID = process.env.NEXT_PUBLIC_GITHUB_CLIENT_ID ?? "";

const ROLE_COLORS = { admin: "#dc2626", editor: "#d97706", student: "#16a34a" };

export default function SignInButton() {
  const { user, loading, accessDenied, signIn, signOut } = useAuth();

  if (loading) return null;

  if (!GITHUB_CLIENT_ID) {
    return (
      <span
        className="auth-badge auth-badge--dev"
        title="Set NEXT_PUBLIC_GITHUB_CLIENT_ID to enable auth"
      >
        Dev mode
      </span>
    );
  }

  if (accessDenied) {
    return (
      <div className="user-chip user-chip--denied">
        <span className="user-chip__name">Access Denied</span>
        <button className="user-chip__signout" onClick={signOut} aria-label="Sign out">
          ✕
        </button>
      </div>
    );
  }

  if (user) {
    return (
      <div className="user-chip">
        {user.avatarUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={user.avatarUrl}
            alt=""
            className="user-chip__avatar"
            referrerPolicy="no-referrer"
          />
        )}
        <div className="user-chip__info">
          <span className="user-chip__name">{user.name}</span>
          <span
            className="user-chip__role"
            style={{ color: ROLE_COLORS[user.role] ?? "#475569" }}
          >
            {user.role}
          </span>
        </div>
        <button className="user-chip__signout" onClick={signOut} aria-label="Sign out">
          ✕
        </button>
      </div>
    );
  }

  return (
    <button className="github-signin-btn" onClick={signIn}>
      <svg
        height="18"
        viewBox="0 0 16 16"
        width="18"
        aria-hidden="true"
        fill="currentColor"
        style={{ marginRight: 8, verticalAlign: "middle" }}
      >
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
          0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13
          -.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87
          2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95
          0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82
          .64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82
          .44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15
          0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48
          0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8
          c0-4.42-3.58-8-8-8z" />
      </svg>
      Sign in with GitHub
    </button>
  );
}

