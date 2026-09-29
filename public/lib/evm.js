// Minimal EVM helpers: wallet discovery (EIP-6963), ABI encoding, reads via the Worker RPC proxy.
// No external libraries, so nothing to load from a CDN.

export const NATIVE = "0xEeeeeEeeeEeEeEeEeEeEeEEEeeeeEeeeeeeeEEeE";
export const DEAD = "0x000000000000000000000000000000000000dEaD";

export const SEL = {
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  balanceOf: "0x70a08231",
  allowance: "0xdd62ed3e",
  approve: "0x095ea7b3",
  transfer: "0xa9059cbb",
  factory: "0xc45a0155",
  WETH: "0xad5c4648",
  getPair: "0xe6a43905",
  addLiquidityETH: "0xf305d719",
};

export const isNative = (a) => String(a).toLowerCase() === NATIVE.toLowerCase();
export const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || "").trim());

// ---------------------------------------------------------------- wallet discovery

const providers = new Map(); // uuid -> { info, provider }
const listeners = new Set();

window.addEventListener("eip6963:announceProvider", (e) => {
  const { info, provider } = e.detail || {};
  if (!info || !provider) return;
  providers.set(info.uuid, { info, provider });
  listeners.forEach((fn) => fn());
});
window.dispatchEvent(new Event("eip6963:requestProvider"));

export function evmWallets() {
  const list = [...providers.values()];
  if (!list.length && window.ethereum) {
    list.push({ info: { uuid: "injected", name: "Browser wallet", icon: null, rdns: "injected" }, provider: window.ethereum });
  }
  return list;
}
export const onEvmWallets = (fn) => listeners.add(fn);

// ---------------------------------------------------------------- abi

const strip = (h) => String(h).replace(/^0x/, "");
const pad32 = (h) => strip(h).padStart(64, "0");
const utf8 = new TextEncoder();

function encodeStatic(type, v) {
  if (type === "address") {
    if (!isAddress(v)) throw new Error(`bad address: ${v}`);
    return pad32(strip(v).toLowerCase());
  }
  if (type === "bool") return pad32(v ? "1" : "0");
  if (type === "uint256") {
    const n = BigInt(v);
    if (n < 0n) throw new Error("uint256 cannot be negative");
    return n.toString(16).padStart(64, "0");
  }
  throw new Error(`unsupported static type ${type}`);
}

function encodeDynamic(type, v) {
  if (type !== "string" && type !== "bytes") throw new Error(`unsupported dynamic type ${type}`);
  const bytes = type === "string" ? utf8.encode(String(v)) : hexToBytes(v);
  const hex = bytesToHex(bytes).slice(2);
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
  return BigInt(bytes.length).toString(16).padStart(64, "0") + padded;
}

/** ABI-encode a tuple of values. Supports address, bool, uint256, string, bytes. Returns hex without 0x. */
export function abiEncode(types, values) {
  const dynamic = (t) => t === "string" || t === "bytes";
  let head = "";
  let tail = "";
  const headSize = types.length * 32;
  types.forEach((t, i) => {
    if (dynamic(t)) {
      head += BigInt(headSize + tail.length / 2).toString(16).padStart(64, "0");
      tail += encodeDynamic(t, values[i]);
    } else {
      head += encodeStatic(t, values[i]);
    }
  });
  return head + tail;
}

export const callData = (selector, types = [], values = []) => selector + abiEncode(types, values);

export function decodeUint(hex) {
  const h = strip(hex);
  return h ? BigInt("0x" + h.slice(0, 64)) : 0n;
}
export function decodeAddress(hex) {
  return "0x" + strip(hex).slice(24, 64);
}
export function decodeString(hex) {
  const h = strip(hex);
  if (!h) return "";
  if (h.length === 64) {
    // bytes32 style (old tokens like MKR)
    return new TextDecoder().decode(hexToBytes("0x" + h).filter((b) => b !== 0));
  }
  const off = Number(BigInt("0x" + h.slice(0, 64))) * 2;
  const len = Number(BigInt("0x" + h.slice(off, off + 64)));
  return new TextDecoder().decode(hexToBytes("0x" + h.slice(off + 64, off + 64 + len * 2)));
}

export function hexToBytes(hex) {
  const h = strip(hex);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
export function bytesToHex(bytes) {
  return "0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const toHex = (n) => "0x" + BigInt(n).toString(16);

// ---------------------------------------------------------------- reads (through the Worker)

let rpcId = 1;
export async function rpc(chainKey, method, params) {
  const r = await fetch(`/api/evm/rpc?chain=${chainKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result;
}

export const ethCall = (chainKey, to, data) => rpc(chainKey, "eth_call", [{ to, data }, "latest"]);

export async function tokenInfo(chainKey, address) {
  const [name, symbol, decimals] = await Promise.all([
    ethCall(chainKey, address, SEL.name).then(decodeString).catch(() => ""),
    ethCall(chainKey, address, SEL.symbol).then(decodeString).catch(() => ""),
    ethCall(chainKey, address, SEL.decimals).then((h) => Number(decodeUint(h))),
  ]);
  return { address, name: name || symbol || "Unknown", symbol: symbol || "???", decimals };
}

export async function balanceOf(chainKey, token, owner) {
  if (isNative(token)) return BigInt(await rpc(chainKey, "eth_getBalance", [owner, "latest"]));
  return decodeUint(await ethCall(chainKey, token, callData(SEL.balanceOf, ["address"], [owner])));
}

export async function allowanceOf(chainKey, token, owner, spender) {
  return decodeUint(await ethCall(chainKey, token, callData(SEL.allowance, ["address", "address"], [owner, spender])));
}

// ---------------------------------------------------------------- writes (through the wallet)

export async function ensureChain(provider, chain) {
  const current = parseInt(await provider.request({ method: "eth_chainId" }), 16);
  if (current === chain.chainId) return;
  const chainId = toHex(chain.chainId);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (err) {
    if (err?.code === 4902 || /unrecognized|not added|unknown chain/i.test(err?.message || "")) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId,
          chainName: chain.name,
          nativeCurrency: { name: chain.native.name || chain.native.symbol, symbol: chain.native.symbol, decimals: chain.native.decimals },
          rpcUrls: [chain.publicRpc],
          blockExplorerUrls: [chain.explorer],
        }],
      });
    } else throw err;
  }
}

export async function sendTx(provider, tx) {
  const clean = { ...tx };
  if (clean.value !== undefined) clean.value = toHex(clean.value);
  return provider.request({ method: "eth_sendTransaction", params: [clean] });
}

export async function waitReceipt(provider, chainKey, hash, { timeoutMs = 180_000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let rcpt = null;
    try {
      rcpt = await provider.request({ method: "eth_getTransactionReceipt", params: [hash] });
    } catch {
      rcpt = await rpc(chainKey, "eth_getTransactionReceipt", [hash]).catch(() => null);
    }
    if (rcpt) {
      if (rcpt.status === "0x0") throw new Error(`Transaction reverted: ${hash}`);
      return rcpt;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Timed out waiting for confirmation — check the explorer.");
}

export function walletError(err) {
  if (!err) return "Unknown error";
  if (err.code === 4001 || /user (rejected|denied)/i.test(err.message || "")) return "Cancelled in wallet";
  const m = err.data?.message || err.message || String(err);
  return m.replace(/^execution reverted:?\s*/i, "Reverted: ").slice(0, 220);
}
