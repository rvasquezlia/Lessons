/**
 * docs/oauth-proxy-example.js
 * ────────────────────────────────────────────────────────────────────
 * Reference implementation of the GitHub OAuth token-exchange proxy.
 *
 * Because this project is a static Next.js export (GitHub Pages), it
 * cannot host a server-side API route. The GitHub OAuth flow requires
 * a backend to exchange the authorization code for an access token
 * (to keep GITHUB_CLIENT_SECRET off the client).
 *
 * DEPLOYMENT OPTIONS
 * ──────────────────
 * 1. Vercel Edge Function  — copy this file to /api/auth/github/route.js,
 *    remove `output: "export"` from next.config.js, and deploy to Vercel.
 *
 * 2. Cloudflare Worker / Netlify Function — adapt the fetch calls below
 *    to your serverless runtime.
 *
 * 3. Self-hosted micro-service — run this as a tiny Node/Express app.
 *
 * 4. Gatekeeper (open-source OAuth proxy) — see https://github.com/prose/gatekeeper
 *
 * ENV VARS NEEDED (server-side only, never NEXT_PUBLIC_):
 *   GITHUB_CLIENT_ID
 *   GITHUB_CLIENT_SECRET
 *
 * Once deployed, set:
 *   NEXT_PUBLIC_OAUTH_PROXY_URL=https://your-proxy.example.com/auth/github
 */

// ── Next.js App Router Route Handler (for Vercel / full Next.js deploy) ──
export const dynamic = "force-dynamic";

const GH_API = "https://api.github.com";

function ghHeaders(token) {
  return {
    Authorization: "token " + token,
    Accept: "application/vnd.github+json",
  };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");

  if (!code) {
    return Response.json({ error: "missing code" }, { status: 400 });
  }

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return Response.json({ error: "OAuth credentials not configured" }, { status: 500 });
  }

  // 1. Exchange code → access token
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });

  if (!tokenRes.ok) {
    return Response.json({ error: "token exchange failed" }, { status: 502 });
  }

  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;

  if (!accessToken) {
    return Response.json(
      { error: tokenData.error_description ?? "no access_token" },
      { status: 400 },
    );
  }

  // 2. Fetch user profile
  const profileRes = await fetch(GH_API + "/user", { headers: ghHeaders(accessToken) });
  if (!profileRes.ok) {
    return Response.json({ error: "failed to fetch profile" }, { status: 502 });
  }
  const profile = await profileRes.json();

  // 3. Fetch primary verified email
  let email = profile.email ?? "";
  if (!email) {
    const emailRes = await fetch(GH_API + "/user/emails", { headers: ghHeaders(accessToken) });
    if (emailRes.ok) {
      const emails = await emailRes.json();
      const primary = emails.find((e) => e.primary && e.verified);
      email = primary?.email ?? emails[0]?.email ?? "";
    }
  }

  return Response.json({
    login: profile.login,
    name: profile.name ?? profile.login,
    email,
    avatar_url: profile.avatar_url ?? "",
  });
}
