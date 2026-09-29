// Developer-code gate for X09 DEX.
//
// The code lives only in the DEV_CODE secret (Cloudflare → Worker → Settings → Variables →
// Encrypt, or `npx wrangler secret put DEV_CODE`). Entering it on the lock screen sets an
// HttpOnly cookie holding an HMAC of the code, so the code itself is never stored in the
// browser. Changing DEV_CODE signs every device out. If DEV_CODE isn't set, nobody can unlock.

const COOKIE = "x09dex_dev";
const COOKIE_DAYS = 30;
const MAX_TRIES = 10; // wrong codes allowed per IP ...
const WINDOW_SEC = 15 * 60; // ... per 15 minutes

export const UNLOCK_PATH = "/__dev/unlock";
export const LOCK_PATH = "/__dev/lock";

async function token(env) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.DEV_CODE), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("x09dex-dev-v1"));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function getCookie(request, name) {
  const m = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

export async function devUnlocked(request, env) {
  if (!env.DEV_CODE) return false;
  const c = getCookie(request, COOKIE);
  return !!c && safeEqual(c, await token(env));
}

// POST /__dev/unlock  (form field "code")
export async function handleUnlock(request, env) {
  if (request.method !== "POST") return redirect("/");
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return lockedPage(request, { error: "Blocked." }, 403);

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const rlKey = `devgate:tries:${ip}`;
  const tries = env.KV ? Number((await env.KV.get(rlKey)) || 0) : 0;
  if (tries >= MAX_TRIES) return lockedPage(request, { error: "Too many attempts. Try again in 15 minutes." }, 429);

  const form = await request.formData().catch(() => null);
  const code = String((form && form.get("code")) || "");
  const next = safeNext(form && form.get("next"));

  if (env.DEV_CODE && code && safeEqual(code, String(env.DEV_CODE))) {
    if (env.KV) await env.KV.delete(rlKey);
    return redirect(next, `${COOKIE}=${await token(env)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_DAYS * 86400}`);
  }
  if (env.KV) await env.KV.put(rlKey, String(tries + 1), { expirationTtl: WINDOW_SEC });
  return lockedPage(request, { error: "Wrong code.", next }, 401);
}

// GET or POST /__dev/lock — forget this device
export function handleLock() {
  return redirect("/", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

function safeNext(v) {
  const s = String(v || "/");
  return s.startsWith("/") && !s.startsWith("//") && !s.startsWith(UNLOCK_PATH) ? s : "/";
}

function redirect(to, cookie) {
  const h = new Headers({ location: to, "cache-control": "no-store" });
  if (cookie) h.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers: h });
}

export function lockedApi() {
  return new Response(JSON.stringify({ error: "X09 DEX is locked" }), {
    status: 403,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function lockedPage(request, opts = {}, status = 403) {
  const u = new URL(request.url);
  const next = opts.next || (u.pathname.startsWith("/__dev/") ? "/" : u.pathname + u.search);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>X09 DEX — Locked</title>
<style>
  html,body{height:100%;margin:0;background:#000;color:#f5f5f5;font-family:ui-monospace,"JetBrains Mono",Menlo,Consolas,monospace}
  main{min-height:100%;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
  form{max-width:420px;width:100%;border:1px solid rgba(255,255,255,.2);border-radius:16px;padding:28px;background:#0a0a0a;display:flex;flex-direction:column;gap:14px}
  h1{margin:0;font-size:20px} p{margin:0;color:#a3a3a3;line-height:1.55;font-size:14px}
  label{font-size:13px;color:#a3a3a3}
  input{font:inherit;font-size:16px;padding:12px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.25);background:#000;color:#f5f5f5}
  input:focus{outline:2px solid #f5f5f5;outline-offset:1px}
  button{font:inherit;font-weight:600;font-size:15px;padding:12px;border:0;border-radius:999px;background:#f5f5f5;color:#000;cursor:pointer}
  .err{color:#fff;font-size:14px}
</style></head>
<body><main>
<form method="post" action="${UNLOCK_PATH}" autocomplete="off">
  <h1>&gt; access locked_</h1>
  <p>X09 DEX is in development. Enter the developer code to continue.</p>
  ${opts.error ? `<div class="err" role="alert">${esc(opts.error)}</div>` : ""}
  <label for="code">Developer code</label>
  <input id="code" name="code" type="password" required autofocus>
  <input type="hidden" name="next" value="${esc(next)}">
  <button type="submit">Unlock</button>
</form>
</main></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
}
