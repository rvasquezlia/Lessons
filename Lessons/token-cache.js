// Shared, dependency-free helper for caching a Google ID token across
// page loads so a student isn't re-asked to sign in on every single
// lesson page. A GIS ID token is valid for about an hour on its own (its
// own `exp` claim) - this never treats it as valid past that real
// expiry, so it never grants access longer than a silent Google
// re-auth already would have anyway. Used by lesson-auth.js and by
// index.html's own gate script.
const TokenCache = (() => {
  const KEY = 'lia_google_id_token';

  function decodeExp(token) {
    try {
      const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return payload.exp; // seconds since epoch
    } catch (e) {
      return 0;
    }
  }

  function save(token) {
    try { localStorage.setItem(KEY, token); } catch (e) { /* private window or storage blocked - falls back to asking every time */ }
  }

  function clear() {
    try { localStorage.removeItem(KEY); } catch (e) { /* nothing to clear */ }
  }

  // Returns a still-valid cached token, or null. "Valid" requires at
  // least 60 seconds of life left, so a request in flight doesn't get
  // rejected mid-air by the backend for expiring a moment after this
  // check passed.
  function load() {
    let token;
    try { token = localStorage.getItem(KEY); } catch (e) { return null; }
    if (!token) return null;
    const exp = decodeExp(token);
    if (!exp || exp * 1000 < Date.now() + 60000) { clear(); return null; }
    return token;
  }

  return { save, clear, load };
})();
