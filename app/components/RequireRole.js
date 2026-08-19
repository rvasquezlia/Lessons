"use client";

import Link from "next/link";
import { useAuth } from "../contexts/AuthContext";

/**
 * Renders children only when the signed-in user has one of the allowed roles.
 * Otherwise shows an access-denied message with a link back home.
 */
export default function RequireRole({ roles = ["admin", "editor"], children }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="access-denied">
        <p className="access-denied__sub">Loading…</p>
      </div>
    );
  }

  if (!user || !roles.includes(user.role)) {
    return (
      <div className="access-denied">
        <div className="access-denied__icon">🔒</div>
        <h2 className="access-denied__title">Access Restricted</h2>
        <p className="access-denied__sub">
          You need {roles.join(" or ")} access to view this page.
        </p>
        <Link href="/" className="btn-primary">Back to Curriculum</Link>
      </div>
    );
  }

  return children;
}
