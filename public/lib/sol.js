// Solana helpers: Wallet Standard discovery (Phantom, Solflare, Backpack, Jupiter, OKX…),
// raw-byte signing for Jupiter swaps, and a lazy-loaded web3.js for token launches.

export const WSOL = "So11111111111111111111111111111111111111112";
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const CHAIN_ID = "solana:mainnet";

const wallets = new Map(); // name -> wallet
const listeners = new Set();

function isSolanaWallet(w) {
  return (
    w && Array.isArray(w.chains) && w.chains.some((c) => c.startsWith("solana:")) &&
    w.features?.["standard:connect"] && w.features?.["solana:signTransaction"]
  );
}

function register(...ws) {
  for (const w of ws) if (isSolanaWallet(w)) wallets.set(w.name, w);
  listeners.forEach((fn) => fn());
  return () => {};
}

// Wallet Standard handshake (both directions).
window.addEventListener("wallet-standard:register-wallet", (e) => {
  try { e.detail?.({ register }); } catch {}
});
try {
  window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: Object.freeze({ register }) }));
} catch {}

export const solWallets = () => [...wallets.values()];
export const onSolWallets = (fn) => listeners.add(fn);

export async function connect(wallet) {
  const res = await wallet.features["standard:connect"].connect();
  const account = res?.accounts?.[0] || wallet.accounts?.[0];
  if (!account) throw new Error("Wallet returned no account");
  return account;
}

export async function disconnect(wallet) {
  try { await wallet.features["standard:disconnect"]?.disconnect(); } catch {}
}

/** Sign raw transaction bytes with the connected wallet; returns signed bytes. */
export async function signBytes(wallet, account, bytes) {
  const [out] = await wallet.features["solana:signTransaction"].signTransaction({ account, transaction: bytes, chain: CHAIN_ID });
  return out.signedTransaction;
}

// ---------------------------------------------------------------- encoding

export function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
export function bytesToB64(bytes) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(s);
}
export const isSolAddress = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(a || "").trim());

// ---------------------------------------------------------------- RPC (through the Worker)

let id = 1;
export async function rpc(method, params) {
  const r = await fetch("/api/sol/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result;
}

export async function balance(owner, mint) {
  if (mint === WSOL) return BigInt((await rpc("getBalance", [owner, { commitment: "confirmed" }])).value);
  const res = await rpc("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
  let total = 0n;
  for (const acc of res.value || []) total += BigInt(acc.account?.data?.parsed?.info?.tokenAmount?.amount || "0");
  return total;
}

export async function waitSignature(sig, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await rpc("getSignatureStatuses", [[sig], { searchTransactionHistory: false }]).catch(() => null);
    const st = res?.value?.[0];
    if (st?.err) throw new Error(`Transaction failed: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return st;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("Timed out waiting for confirmation — check Solscan.");
}

// ---------------------------------------------------------------- libraries for launches (lazy)

const WEB3 = "https://esm.sh/@solana/web3.js@1.98.0";
const SPL = "https://esm.sh/@solana/spl-token@0.4.9?deps=@solana/web3.js@1.98.0";
const SPL_META = "https://esm.sh/@solana/spl-token-metadata@0.1.6?deps=@solana/web3.js@1.98.0";

let libs = null;
export async function loadSolanaLibs() {
  if (!libs) {
    libs = Promise.all([import(WEB3), import(SPL), import(SPL_META)]).then(([web3, spl, meta]) => ({ web3, spl, meta }));
    libs.catch(() => { libs = null; });
  }
  return libs;
}
