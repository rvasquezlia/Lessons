"use client";

import { useEffect, useRef } from "react";
import { useAuth } from "../contexts/AuthContext";

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";

/**
 * Renders the Google "Sign in with Google" button or a signed-in user chip.
 */
export default function SignInButton() {
  const { user, loading, signOut } = useAuth();
  const buttonRef = useRef(null);

  useEffect(() => {
    if (user || loading || !GOOGLE_CLIENT_ID) return;
    if (!buttonRef.current) return;

    const render = () => {
      window.google?.accounts.id.renderButton(buttonRef.current, {
        type: "standard",
        shape: "pill",
        theme: "outline",
        size: "medium",
        text: "signin_with",
        logo_alignment: "left",
      });
    };

    if (window.google) {
      render();
    } else {
      // SDK not yet loaded — wait for it
      const interval = setInterval(() => {
        if (window.google) {
          clearInterval(interval);
          render();
        }
      }, 100);
      return () => clearInterval(interval);
    }
  }, [user, loading]);

  if (loading) return null;

  if (!GOOGLE_CLIENT_ID) {
    return (
      <span className="auth-badge auth-badge--dev" title="Set NEXT_PUBLIC_GOOGLE_CLIENT_ID to enable auth">
        Dev mode
      </span>
    );
  }

  if (user) {
    const roleColors = { admin: "#dc2626", editor: "#d97706", student: "#16a34a" };
    return (
      <div className="user-chip">
        {user.picture && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user.picture} alt="" className="user-chip__avatar" referrerPolicy="no-referrer" />
        )}
        <div className="user-chip__info">
          <span className="user-chip__name">{user.name}</span>
          <span
            className="user-chip__role"
            style={{ color: roleColors[user.role] ?? "#475569" }}
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

  return <div ref={buttonRef} className="gsi-button-container" />;
}
