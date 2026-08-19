"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import roles from "../../config/roles.json";

const GITHUB_CLIENT_ID = process.env.NEXT_PUBLIC_GITHUB_CLIENT_ID ?? "";
const OAUTH_PROXY_URL = process.env.NEXT_PUBLIC_OAUTH_PROXY_URL ?? "";

// GitHub OAuth redirect URL — must match the one registered in your GitHub App
const REDIRECT_URI =
  typeof window !== "undefined"
    ? `${window.location.origin}${window.location.pathname}`
    : "";

const AuthContext = createContext(null);

/**
 * Derive role from email by cross-referencing /config/roles.json.
 *
 * Hierarchy:
 *  1. email in admins[]        → "admin"
 *  2. email in editors[]       → "editor"
 *  3. domain in allowedDomains → "student"
 *  4. else                     → null (access denied)
 */
export function deriveRole(email) {
  if (!email) return null;
  const lower = email.toLowerCase();
  const { admins = [], editors = [], allowedDomains = [] } = roles.roles;

  if (admins.map((e) => e.toLowerCase()).includes(lower)) return "admin";
  if (editors.map((e) => e.toLowerCase()).includes(lower)) return "editor";

  const domain = lower.split("@")[1] ?? "";
  if (allowedDomains.map((d) => d.toLowerCase()).includes(domain)) return "student";

  return null; // access denied
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null); // { name, email, login, avatarUrl, role } | null
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);

  /** Exchange a GitHub OAuth code for a user profile via the OAuth proxy. */
  const handleCode = useCallback(async (code) => {
    if (!OAUTH_PROXY_URL) {
      console.warn(
        "NEXT_PUBLIC_OAUTH_PROXY_URL is not set. " +
        "Deploy an OAuth proxy (see docs/oauth-proxy-example.js) and set this variable.",
      );
      setLoading(false);
      return;
    }
    try {
      const res = await fetch(`${OAUTH_PROXY_URL}?code=${encodeURIComponent(code)}`);
      if (!res.ok) throw new Error("token exchange failed");
      const data = await res.json();

      const email = data.email ?? "";
      const role = deriveRole(email);

      if (!role) {
        setAccessDenied(true);
        setLoading(false);
        return;
      }

      const profile = {
        name: data.name ?? data.login,
        email,
        login: data.login,
        avatarUrl: data.avatar_url ?? "",
        role,
      };
      setUser(profile);
      sessionStorage.setItem("auth_user", JSON.stringify(profile));
    } catch {
      // network / API failure — stay signed out
    } finally {
      setLoading(false);
    }
  }, []);

  const signIn = useCallback(() => {
    if (!GITHUB_CLIENT_ID) return;
    const state = crypto.randomUUID();
    sessionStorage.setItem("oauth_state", state);
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", GITHUB_CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("scope", "read:user user:email");
    url.searchParams.set("state", state);
    window.location.href = url.toString();
  }, []);

  const signOut = useCallback(() => {
    setUser(null);
    setAccessDenied(false);
    sessionStorage.removeItem("auth_user");
    sessionStorage.removeItem("oauth_state");
  }, []);

  // Restore session from sessionStorage on mount
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem("auth_user");
      if (stored) {
        const parsed = JSON.parse(stored);
        // Re-derive role in case roles.json changed
        const role = deriveRole(parsed.email);
        if (role) {
          setUser({ ...parsed, role });
        } else {
          sessionStorage.removeItem("auth_user");
          setAccessDenied(true);
        }
      }
    } catch {
      // ignore
    }
    setLoading(false);
  }, []);

  // Handle OAuth callback code in URL
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    const storedState = sessionStorage.getItem("oauth_state");

    if (code && state && state === storedState) {
      sessionStorage.removeItem("oauth_state");
      // Clean URL
      window.history.replaceState({}, "", window.location.pathname);
      setLoading(true);
      handleCode(code);
    }
  }, [handleCode]);

  return (
    <AuthContext.Provider value={{ user, loading, accessDenied, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

