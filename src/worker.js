// X09 DEX — Cloudflare Worker
// Serves the app from /public (static assets) and a small JSON API under /api.
// All trading is non-custodial: the Worker only fetches quotes/unsigned transactions
// and relays signed ones. Users sign everything in their own wallets.

import { CHAINS, SOLANA, evmChainByKey } from "./chains.js";
import { ownerCheck, lockedApi, lockedPage } from "./owner-gate.js";

const JUP = "https://api.jup.ag";
const GT = "https://api.geckoterminal.com/api/v2";
const MAX_META_BYTES = 700_000; // logo + json, per launch

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
      // Token metadata stays public: launched tokens point wallets and explorers at /meta/…
      if (url.pathname.startsWith("/meta/")) return await serveMeta(env, url);

      // Everything else is owner-only (see owner-gate.js)
      const check = await ownerCheck(request, env);
      if (!check.owner) return url.pathname.startsWith("/api/") ? cors(lockedApi(check)) : lockedPage(request, check);

      if (url.pathname.startsWith("/api/")) return cors(await api(request, env, ctx, url));
      const res = await env.ASSETS.fetch(request);
      const out = new Response(res.body, res);
      out.headers.set("cache-control", "private, no-store"); // never let a shared cache serve the app to others
      out.headers.set("x-robots-tag", "noindex");
      return out;
    } catch (err) {
      return cors(json({ error: err.message || String(err) }, err.status || 500));
    }
  },
};

// ------------------------------------------------------------------ routing

async function api(request, env, ctx, url) {
  const p = url.pathname.replace(/^\/api/, "");
  const q = url.searchParams;
  const cfg = config(env);

  switch (`${request.method} ${p}`) {
    case "GET /config":
      return json({
        feeBps: cfg.feeBps,
        solFeeBps: cfg.solFeeBps,
        solFeesActive: !!env.JUP_REFERRAL_ACCOUNT,
        evmFeesActive: !!env.EVM_FEE_WALLET,
        launchFeeUsd: cfg.launchFeeUsd,
        evmFeeWallet: env.EVM_FEE_WALLET || null,
        solFeeWallet: env.SOL_FEE_WALLET || null,
        chains: CHAINS.map(publicChain),
        solana: publicChain(SOLANA),
      });

    // ---------- Solana (Jupiter Swap API v2, meta-aggregator)
    case "GET /sol/order": {
      const params = new URLSearchParams({
        inputMint: need(q, "inputMint"),
        outputMint: need(q, "outputMint"),
        amount: need(q, "amount"),
      });
      if (q.get("taker")) params.set("taker", q.get("taker"));
      if (env.JUP_REFERRAL_ACCOUNT) {
        params.set("referralAccount", env.JUP_REFERRAL_ACCOUNT);
        params.set("referralFee", String(cfg.solFeeBps));
      }
      return passthrough(await fetch(`${JUP}/swap/v2/order?${params}`, { headers: jupHeaders(env) }));
    }
    case "POST /sol/execute": {
      const body = await request.json();
      if (!body.signedTransaction || !body.requestId) throw httpErr(400, "signedTransaction and requestId required");
      return passthrough(
        await fetch(`${JUP}/swap/v2/execute`, {
          method: "POST",
          headers: { ...jupHeaders(env), "content-type": "application/json" },
          body: JSON.stringify({ signedTransaction: body.signedTransaction, requestId: body.requestId }),
        })
      );
    }
    case "GET /sol/tokens": {
      const query = need(q, "q");
      return cached(ctx, request, 60, () =>
        fetch(`${JUP}/tokens/v2/search?query=${encodeURIComponent(query)}`, { headers: jupHeaders(env) })
      );
    }
    case "POST /sol/rpc":
      return solRpc(request, env);

    // ---------- EVM (KyberSwap aggregator)
    case "GET /evm/route": {
      const chain = evmChainOr404(q.get("chain"));
      const params = new URLSearchParams({
        tokenIn: need(q, "tokenIn"),
        tokenOut: need(q, "tokenOut"),
        amountIn: need(q, "amountIn"),
        gasInclude: "true",
      });
      if (q.get("origin")) params.set("origin", q.get("origin"));
      if (env.EVM_FEE_WALLET && cfg.feeBps > 0) {
        params.set("feeAmount", String(cfg.feeBps));
        params.set("chargeFeeBy", "currency_in");
        params.set("isInBps", "true");
        params.set("feeReceiver", env.EVM_FEE_WALLET);
      }
      return passthrough(await fetch(`${kyberBase(env)}/${chain.kyber}/api/v1/routes?${params}`, { headers: kyberHeaders(env) }));
    }
    case "POST /evm/build": {
      const body = await request.json();
      const chain = evmChainOr404(body.chain);
      const rs = body.routeSummary;
      if (!rs) throw httpErr(400, "routeSummary required");
      // Refuse routes that don't carry the configured X09 fee.
      if (env.EVM_FEE_WALLET && cfg.feeBps > 0) {
        const f = rs.extraFee || {};
        if (String(f.feeReceiver || "").toLowerCase() !== env.EVM_FEE_WALLET.toLowerCase() || Number(String(f.feeAmount).split(",")[0]) !== cfg.feeBps) {
          throw httpErr(400, "Route is missing the X09 fee — refresh the quote");
        }
      }
      const slippage = Math.min(Math.max(Number(body.slippageBps) || 50, 1), 2000);
      return passthrough(
        await fetch(`${kyberBase(env)}/${chain.kyber}/api/v1/route/build`, {
          method: "POST",
          headers: { ...kyberHeaders(env), "content-type": "application/json" },
          body: JSON.stringify({
            routeSummary: rs,
            sender: body.sender,
            recipient: body.recipient || body.sender,
            origin: body.sender,
            slippageTolerance: slippage,
            deadline: Math.floor(Date.now() / 1000) + 1200,
            source: "X09DEX",
            enableGasEstimation: true,
          }),
        })
      );
    }
    case "POST /evm/rpc":
      return evmRpc(request, env, q.get("chain"));

    // ---------- Explore (GeckoTerminal)
    case "GET /explore": {
      const chainKey = q.get("chain") || "solana";
      const chain = chainKey === "solana" ? SOLANA : evmChainOr404(chainKey);
      const kind = q.get("kind") === "new" ? "new_pools" : "trending_pools";
      const page = Math.min(Math.max(parseInt(q.get("page") || "1", 10), 1), 5);
      return cached(ctx, request, 60, () =>
        fetch(`${GT}/networks/${chain.gecko}/${kind}?include=base_token,quote_token&page=${page}`, {
          headers: { accept: "application/json" },
        }).then((r) => reshapePools(r, chain.key))
      );
    }
    case "GET /search": {
      const query = need(q, "q");
      const chainKey = q.get("chain");
      const chain = chainKey === "solana" ? SOLANA : chainKey ? evmChainOr404(chainKey) : null;
      const params = new URLSearchParams({ query, include: "base_token,quote_token" });
      if (chain) params.set("network", chain.gecko);
      return cached(ctx, request, 60, () =>
        fetch(`${GT}/search/pools?${params}`, { headers: { accept: "application/json" } }).then((r) =>
          reshapePools(r, chain ? chain.key : null)
        )
      );
    }

    // ---------- Prices (launch fee)
    case "GET /price": {
      return cached(ctx, request, 300, async () => {
        const ids = [...new Set([SOLANA, ...CHAINS].map((c) => c.coingecko))].join(",");
        const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, {
          headers: { accept: "application/json" },
        });
        if (!r.ok) throw httpErr(502, "price feed unavailable");
        const data = await r.json();
        const out = {};
        for (const c of [SOLANA, ...CHAINS]) out[c.key] = data[c.coingecko]?.usd ?? null;
        return json(out);
      });
    }

    // ---------- Launch metadata + registry
    case "POST /meta":
      return createMeta(request, env, url);
    case "POST /launches":
      return recordLaunch(request, env);
    case "GET /launches": {
      const list = (await env.KV.get("launches:recent", "json")) || [];
      const chain = q.get("chain");
      return json(chain ? list.filter((l) => l.chain === chain) : list);
    }
  }
  throw httpErr(404, "Not found");
}

// ------------------------------------------------------------------ helpers

function config(env) {
  const feeBps = clamp(parseInt(env.FEE_BPS ?? "50", 10), 0, 300);
  return {
    feeBps,
    // Jupiter referral fees must be 50–255 bps.
    solFeeBps: clamp(feeBps, 50, 255),
    launchFeeUsd: Math.max(0, parseFloat(env.LAUNCH_FEE_USD ?? "1") || 0),
  };
}

function publicChain(c) {
  const { rpc, ...rest } = c;
  return rest;
}

function evmChainOr404(key) {
  const c = evmChainByKey(key);
  if (!c) throw httpErr(400, `Unknown chain: ${key}`);
  return c;
}

function jupHeaders(env) {
  const h = { accept: "application/json" };
  if (env.JUP_API_KEY) h["x-api-key"] = env.JUP_API_KEY;
  return h;
}

function kyberBase(env) {
  return env.KYBER_API_KEY ? "https://api.kyberswap.com/swap" : "https://aggregator-api.kyberswap.com";
}

function kyberHeaders(env) {
  const h = { accept: "application/json", "x-client-id": env.KYBER_CLIENT_ID || "X09DEX" };
  if (env.KYBER_API_KEY) h["X-Api-Key"] = env.KYBER_API_KEY;
  return h;
}

const SOL_RPC_ALLOW = new Set([
  "getBalance",
  "getLatestBlockhash",
  "getMinimumBalanceForRentExemption",
  "getAccountInfo",
  "getMultipleAccounts",
  "getParsedTokenAccountsByOwner",
  "getTokenAccountsByOwner",
  "getSignatureStatuses",
  "getTokenSupply",
  "sendTransaction",
  "simulateTransaction",
  "getFeeForMessage",
  "getSlot",
  "getBlockHeight",
]);

async function solRpc(request, env) {
  const body = await request.json();
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length > 10) throw httpErr(400, "too many calls");
  for (const c of calls) if (!SOL_RPC_ALLOW.has(c.method)) throw httpErr(403, `RPC method not allowed: ${c.method}`);
  const rpc = env.SOLANA_RPC || SOLANA.rpc;
  return passthrough(await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
}

const EVM_RPC_ALLOW = new Set([
  "eth_call",
  "eth_getBalance",
  "eth_getCode",
  "eth_getTransactionReceipt",
  "eth_blockNumber",
  "eth_chainId",
  "eth_gasPrice",
  "eth_estimateGas",
]);

async function evmRpc(request, env, chainKey) {
  const chain = evmChainOr404(chainKey);
  const body = await request.json();
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length > 20) throw httpErr(400, "too many calls");
  for (const c of calls) if (!EVM_RPC_ALLOW.has(c.method)) throw httpErr(403, `RPC method not allowed: ${c.method}`);
  const override = env[`RPC_${chain.key.toUpperCase()}`];
  return passthrough(
    await fetch(override || chain.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  );
}

async function rpcCall(endpoint, method, params) {
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function reshapePools(res, chainKey) {
  if (!res.ok) throw httpErr(502, `market data unavailable (${res.status})`);
  const data = await res.json();
  const tokens = new Map();
  for (const inc of data.included || []) if (inc.type === "token") tokens.set(inc.id, inc.attributes);
  const pools = (data.data || []).map((p) => {
    const a = p.attributes || {};
    const baseId = p.relationships?.base_token?.data?.id;
    const quoteId = p.relationships?.quote_token?.data?.id;
    const base = tokens.get(baseId) || {};
    const quote = tokens.get(quoteId) || {};
    const net = (baseId || "").split("_")[0];
    return {
      chain: chainKey || geckoToKey(net),
      pool: a.address,
      name: a.name,
      dex: p.relationships?.dex?.data?.id || null,
      token: {
        address: base.address || (baseId || "").split("_").slice(1).join("_"),
        symbol: base.symbol,
        name: base.name,
        image: base.image_url && base.image_url !== "missing.png" ? base.image_url : null,
        decimals: base.decimals ?? null,
      },
      quote: { address: quote.address, symbol: quote.symbol },
      priceUsd: num(a.base_token_price_usd),
      change1h: num(a.price_change_percentage?.h1),
      change24h: num(a.price_change_percentage?.h24),
      volume24h: num(a.volume_usd?.h24),
      liquidity: num(a.reserve_in_usd),
      fdv: num(a.fdv_usd),
      marketCap: num(a.market_cap_usd),
      buys24h: a.transactions?.h24?.buys ?? null,
      sells24h: a.transactions?.h24?.sells ?? null,
      createdAt: a.pool_created_at || null,
    };
  });
  return json(pools);
}

function geckoToKey(net) {
  if (net === SOLANA.gecko) return "solana";
  return CHAINS.find((c) => c.gecko === net)?.key || net;
}

// ---- metadata (logo + socials), stored in KV and served from /meta/<id>

async function createMeta(request, env, url) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_META_BYTES * 1.4) throw httpErr(413, "Upload too large");
  const body = await request.json();
  const name = clean(body.name, 32);
  const symbol = clean(body.symbol, 10).toUpperCase();
  if (!name || !symbol) throw httpErr(400, "name and symbol required");

  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  const origin = env.PUBLIC_ORIGIN || url.origin;
  let image = null;

  if (body.image) {
    const m = /^data:(image\/(png|jpeg|webp|gif));base64,(.+)$/.exec(body.image);
    if (!m) throw httpErr(400, "Logo must be PNG, JPG, WEBP or GIF");
    const bytes = Uint8Array.from(atob(m[3]), (ch) => ch.charCodeAt(0));
    if (bytes.byteLength > MAX_META_BYTES) throw httpErr(413, "Logo too large (max ~700 KB)");
    const ext = m[2] === "jpeg" ? "jpg" : m[2];
    await env.KV.put(`img:${id}`, bytes, { metadata: { type: m[1] } });
    image = `${origin}/meta/${id}.${ext}`;
  }

  const meta = {
    name,
    symbol,
    description: clean(body.description, 500),
    image,
    external_url: cleanUrl(body.website),
    extensions: {
      website: cleanUrl(body.website),
      twitter: cleanUrl(body.twitter),
      telegram: cleanUrl(body.telegram),
      discord: cleanUrl(body.discord),
    },
    createdOn: "X09 DEX",
  };
  await env.KV.put(`meta:${id}`, JSON.stringify(meta));
  return json({ id, uri: `${origin}/meta/${id}.json`, image });
}

async function serveMeta(env, url) {
  const m = /^\/meta\/([a-f0-9]{20})\.(json|png|jpg|webp|gif)$/.exec(url.pathname);
  if (!m) return new Response("Not found", { status: 404 });
  const headers = { "access-control-allow-origin": "*", "cache-control": "public, max-age=86400, immutable" };
  if (m[2] === "json") {
    const meta = await env.KV.get(`meta:${m[1]}`);
    if (!meta) return new Response("Not found", { status: 404 });
    return new Response(meta, { headers: { ...headers, "content-type": "application/json" } });
  }
  const { value, metadata } = await env.KV.getWithMetadata(`img:${m[1]}`, "arrayBuffer");
  if (!value) return new Response("Not found", { status: 404 });
  return new Response(value, { headers: { ...headers, "content-type": metadata?.type || "image/png" } });
}

// ---- launch registry: verifies the token really exists on-chain before listing it

async function recordLaunch(request, env) {
  const b = await request.json();
  const chainKey = String(b.chain || "");
  const address = String(b.address || "");
  const entry = {
    chain: chainKey,
    address,
    name: clean(b.name, 32),
    symbol: clean(b.symbol, 10).toUpperCase(),
    image: cleanUrl(b.image),
    tx: String(b.tx || "").slice(0, 100),
    at: Date.now(),
  };

  if (chainKey === "solana") {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) throw httpErr(400, "bad mint");
    const info = await rpcCall(env.SOLANA_RPC || SOLANA.rpc, "getAccountInfo", [address, { encoding: "base64" }]);
    const owner = info?.value?.owner;
    if (owner !== "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" && owner !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
      throw httpErr(400, "Token not found on Solana yet");
  } else {
    const chain = evmChainOr404(chainKey);
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw httpErr(400, "bad address");
    const code = await rpcCall(env[`RPC_${chain.key.toUpperCase()}`] || chain.rpc, "eth_getCode", [address, "latest"]);
    if (!code || code === "0x") throw httpErr(400, "Contract not found on-chain yet");
  }

  const list = (await env.KV.get("launches:recent", "json")) || [];
  const next = [entry, ...list.filter((l) => !(l.chain === entry.chain && l.address.toLowerCase() === address.toLowerCase()))].slice(0, 200);
  await env.KV.put("launches:recent", JSON.stringify(next));
  const total = parseInt((await env.KV.get("launches:count")) || "0", 10) + 1;
  await env.KV.put("launches:count", String(total));
  return json({ ok: true, total });
}

// ---- generic

async function cached(ctx, request, seconds, produce) {
  const cache = caches.default;
  const key = new Request(request.url, { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await produce();
  if (!res.ok) return passthrough(res);
  const body = await res.arrayBuffer();
  const out = new Response(body, {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": `public, max-age=${seconds}` },
  });
  ctx.waitUntil(cache.put(key, out.clone()));
  return out;
}

async function passthrough(res) {
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") || "application/json" },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function cors(res) {
  const h = new Headers(res.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-headers", "content-type");
  h.set("access-control-allow-methods", "GET,POST,OPTIONS");
  return new Response(res.body, { status: res.status, headers: h });
}

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function need(q, k) {
  const v = q.get(k);
  if (!v) throw httpErr(400, `${k} required`);
  return v;
}

function clamp(n, lo, hi) {
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : lo;
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function clean(s, max) {
  return String(s ?? "")
    .replace(/[\u0000-\u001f<>]/g, "")
    .trim()
    .slice(0, max);
}

function cleanUrl(s) {
  const v = String(s ?? "").trim();
  if (!v) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString().slice(0, 200) : null;
  } catch {
    return null;
  }
}
