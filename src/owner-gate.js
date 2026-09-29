// Owner-only access for X09 DEX.
//
// Everyone signs in on X09 Hub, which sets the shared `x09_sid` cookie for all of x09hub.com.
// On every request the DEX asks X09 Hub who that cookie belongs to (GET /api/me) and only lets
// the request through when the Hub marks the account as an owner — i.e. its email is listed in
// the Hub's X09_OWNER_EMAILS secret. (The developer code in dev-gate.js is the other way in.)
//
// The Hub is reached through an optional HUB service binding when one is configured, otherwise
// over the public URL. If the Hub can't be reached the DEX stays locked (fails closed).

const HUB_ORIGIN = "https://x09hub.com";
const SESSION_COOKIES = ["x09_sid", "x09_session", "x09docs_session"];
const CACHE_MS = 60_000; // how long one owner check is reused per session
const cache = new Map(); // session cookie hash -> { owner, expires }

export async function ownerCheck(request, env) {
  const cookies = sessionCookies(request);
  if (!cookies) return { owner: false, signedIn: false };

  const key = await sha256(cookies);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.result;

  let result;
  try {
    const req = new Request(`${HUB_ORIGIN}/api/me`, { headers: { cookie: cookies, accept: "application/json" } });
    const res = env.HUB ? await env.HUB.fetch(req) : await fetch(req);
    if (res.status === 401 || res.status === 403) {
      result = { owner: false, signedIn: false };
    } else if (!res.ok) {
      return { owner: false, signedIn: false, error: true }; // not cached: try again next request
    } else {
      const data = await res.json().catch(() => ({}));
      const user = data && data.user;
      result = { owner: !!(user && user.owner === true), signedIn: !!user };
    }
  } catch {
    return { owner: false, signedIn: false, error: true };
  }

  cache.set(key, { result, expires: Date.now() + CACHE_MS });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return result;
}

// Only forward the X09 session cookies to the Hub, nothing else from the browser.
function sessionCookies(request) {
  const header = request.headers.get("cookie") || "";
  const parts = header.split(";").map((c) => c.trim()).filter((c) => SESSION_COOKIES.includes(c.split("=")[0]));
  return parts.length ? parts.join("; ") : null;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
