"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import roles from "../../config/roles.json";

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";

const AuthContext = createContext(null);

/**
 * Derive role from email by cross-referencing /config/roles.json.
 * Returns "admin" | "editor" | "student".
 */
function deriveRole(email) {
  if (!email) return "student";
  const lower = email.toLowerCase();
  if (roles.roles.admin.map((e) => e.toLowerCase()).includes(lower)) return "admin";
  if (roles.roles.editor.map((e) => e.toLowerCase()).includes(lower)) return "editor";
  return "student";
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null); // { name, email, picture, role }
  const [loading, setLoading] = useState(true);

  const handleCredentialResponse = useCallback((response) => {
    try {
      // Decode the JWT payload (no crypto verification needed for client-side role display)
      const payload = JSON.parse(atob(response.credential.split(".")[1]));
      const email = payload.email ?? "";
      const role = deriveRole(email);
      const profile = {
        name: payload.name ?? email,
        email,
        picture: payload.picture ?? "",
        role,
      };
      setUser(profile);
      sessionStorage.setItem("auth_user", JSON.stringify(profile));
    } catch {
      // malformed token — stay signed out
    }
  }, []);

  const signOut = useCallback(() => {
    setUser(null);
    sessionStorage.removeItem("auth_user");
    if (typeof window !== "undefined" && window.google) {
      window.google.accounts.id.disableAutoSelect();
    }
  }, []);

  // Restore session on mount
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem("auth_user");
      if (stored) setUser(JSON.parse(stored));
    } catch {
      // ignore
    }
    setLoading(false);
  }, []);

  // Initialize Google Identity Services SDK
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;

    const scriptId = "google-gsi-sdk";
    if (document.getElementById(scriptId)) {
      initGSI();
      return;
    }

    const script = document.createElement("script");
    script.id = scriptId;
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = initGSI;
    document.head.appendChild(script);

    function initGSI() {
      window.google?.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleCredentialResponse,
        auto_select: false,
      });
    }
  }, [handleCredentialResponse]);

  return (
    <AuthContext.Provider value={{ user, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
