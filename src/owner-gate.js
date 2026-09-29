// Owner-only access for X09 DEX.
//
// Everyone signs in on X09 Hub, which sets the shared `x09_sid` cookie for all of x09hub.com.
// On every request the DEX asks X09 Hub who that cookie belongs to (GET /api/me) and only lets
// the request through when the Hub marks the account as an owner — i.e. its email is listed in
// the Hub's X09_OWNER_EMAILS secret. Anyone else gets a locked page (or a 403 from the API).
//
// The Hub is reached through the HUB service binding (wrangler.jsonc) when present, otherwise
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

export function lockedApi(check) {
  return new Response(JSON.stringify({ error: check.error ? "Owner check unavailable" : "X09 DEX is owner-only" }), {
    status: check.error ? 503 : 403,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
}

export function lockedPage(request, check) {
  const next = encodeURIComponent(new URL(request.url).href);
  const msg = check.error
    ? "Couldn't verify your account right now. Try again in a moment."
    : check.signedIn
      ? "This account doesn't have access. X09 DEX is limited to the owner account."
      : "X09 DEX is limited to the owner account. Sign in on X09 Hub to continue.";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>X09 DEX — Locked</title>
<style>
  html,body{height:100%;margin:0;background:#000;color:#f5f5f5;font-family:ui-monospace,"JetBrains Mono",Menlo,Consolas,monospace}
  main{min-height:100%;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
  .box{max-width:460px;width:100%;border:1px solid rgba(255,255,255,.2);border-radius:16px;padding:28px;background:#0a0a0a}
  h1{margin:0 0 12px;font-size:20px} p{margin:0 0 22px;color:#a3a3a3;line-height:1.55;font-size:15px}
  a{display:inline-block;padding:12px 20px;border-radius:999px;background:#f5f5f5;color:#000;text-decoration:none;font-weight:600}
</style></head>
<body><main><div class="box">
  <h1>&gt; access locked_</h1>
  <p>${msg}</p>
  <a href="${HUB_ORIGIN}/?next=${next}">Go to X09 Hub</a>
</div></main></body></html>`;
  return new Response(html, {
    status: check.error ? 503 : 403,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
}
