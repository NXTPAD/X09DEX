import * as evm from "./lib/evm.js";
import * as sol from "./lib/sol.js";
import { launchEvm, launchSolana } from "./lib/launch.js";

// ================================================================ utils
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseUnits(str, decimals) {
  const s = String(str || "").trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return 0n;
  const [i, f = ""] = s.split(".");
  return BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}
export function formatUnits(v, decimals, maxFrac = 6) {
  const neg = v < 0n;
  let x = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const i = x / base;
  let f = (x % base).toString().padStart(decimals, "0");
  // keep more precision for tiny amounts
  let keep = maxFrac;
  if (i === 0n) {
    const firstNz = f.search(/[1-9]/);
    if (firstNz >= maxFrac) keep = Math.min(firstNz + 3, decimals);
  }
  f = f.slice(0, keep).replace(/0+$/, "");
  return (neg ? "-" : "") + i.toLocaleString("en-US") + (f ? "." + f : "");
}
const fmtUsd = (n) => {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  if (n >= 1) return "$" + n.toFixed(2);
  if (n === 0) return "$0";
  const d = Math.max(2, -Math.floor(Math.log10(n)) + 2);
  return "$" + n.toFixed(Math.min(d, 12));
};
const fmtPct = (n) => (n == null || !Number.isFinite(n) ? "—" : `${Math.abs(n).toFixed(Math.abs(n) >= 100 ? 0 : 1)}%`);
const pctClass = (n) => (n == null ? "" : n >= 0 ? "up" : "down");
const age = (iso) => {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 60) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / (86400 * 30))}mo`;
};

function toast(msg, isErr = false, ms = 5000) {
  const t = document.createElement("div");
  t.className = "toast" + (isErr ? " err" : "");
  t.innerHTML = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), ms);
}

function tokenIcon(t, size = 24) {
  if (t?.image || t?.icon) return `<img class="tokimg" style="width:${size}px;height:${size}px" src="${esc(t.image || t.icon)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'tokimg',textContent:'${esc((t.symbol || "?").slice(0, 3))}'}))">`;
  return `<span class="tokimg" style="width:${size}px;height:${size}px">${esc((t?.symbol || "?").slice(0, 3))}</span>`;
}

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`Bad response (${r.status})`); }
  if (!r.ok) throw new Error(j.error || j.message || j.errorMessage || `Request failed (${r.status})`);
  return j;
}

const store = {
  get(k, d) { try { const v = localStorage.getItem("x09dex:" + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("x09dex:" + k, JSON.stringify(v)); } catch {} },
};

// ================================================================ state
const S = {
  cfg: null,
  chains: [],
  chain: store.get("chain", "solana"),
  tab: "swap",
  pairs: store.get("pairs", {}), // chainKey -> {sell, buy}
  amount: "",
  quote: null,
  quoting: false,
  slippageBps: store.get("slip", 50),
  sol: { wallet: null, account: null, address: null },
  evm: { provider: null, info: null, address: null },
  explore: { chain: "solana", kind: "trending", q: "", minLiq: 0, rows: [] },
  prices: null,
};
const chainOf = (k) => S.chains.find((c) => c.key === k);
const cur = () => chainOf(S.chain);
const isSol = (c = cur()) => c?.vm === "svm";
const addrFor = (c = cur()) => (isSol(c) ? S.sol.address : S.evm.address);

function pair() {
  const c = cur();
  let p = S.pairs[c.key];
  if (!p || !p.sell || !p.buy) {
    p = { sell: c.tokens[0], buy: c.tokens[1] || c.tokens[0] };
    S.pairs[c.key] = p;
  }
  return p;
}
const plainTok = (t) => t && { address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, image: t.image || null };
const savePairs = () =>
  store.set("pairs", Object.fromEntries(Object.entries(S.pairs).map(([k, p]) => [k, { sell: plainTok(p.sell), buy: plainTok(p.buy) }])));

// ================================================================ boot
(async function boot() {
  stars();
  x09Logo($("#x09Logo"), 32);
  bindSwitcher();
  bindTabs();
  try {
    S.cfg = await getJSON("/api/config");
  } catch (e) {
    toast("Could not reach X09 DEX backend: " + esc(e.message), true, 10000);
    return;
  }
  S.chains = [S.cfg.solana, ...S.cfg.chains];
  if (!chainOf(S.chain)) S.chain = "solana";

  $("#statChains").textContent = S.chains.length;
  $("#statFee").textContent = (S.cfg.feeBps / 100).toFixed(2).replace(/\.?0+$/, "") + "%";

  renderChainRow("#swapChains", S.chain, (k) => setChain(k));
  renderChainRow("#exploreChains", S.explore.chain, (k) => { S.explore.chain = k; loadExplore(); });
  renderSlippage();
  bindSwap();
  bindWallet();
  bindExplore();
  bindLaunch();
  setChain(S.chain);
  termLines();
  restoreWallets();

  const hash = location.hash.replace("#", "");
  if (["swap", "explore", "launch"].includes(hash)) showTab(hash);

  setInterval(() => { if (S.tab === "swap" && !S.quoting && S.amount && document.visibilityState === "visible") requote(); }, 20000);
})();

function termLines() {
  const c = S.cfg;
  const lines = [
    `<span class="ok">✓</span> backend online`,
    `<span class="ok">✓</span> solana routing: jupiter meta-aggregator`,
    `<span class="ok">✓</span> evm routing: kyberswap aggregator (${c.chains.length} chains)`,
    `<span class="ok">✓</span> x09 fee: ${(c.feeBps / 100).toFixed(2)}% per swap`,
    `<span class="ok">✓</span> non-custodial — keys never leave your wallet`,
  ];
  if (!c.solFeesActive || !c.evmFeesActive) lines.push(`<span class="err">!</span> fee wallet not configured (${[!c.solFeesActive && "solana", !c.evmFeesActive && "evm"].filter(Boolean).join(", ")})`);
  $("#swapLog").innerHTML = lines.join("\n");
}

// ================================================================ tabs
function bindTabs() {
  $$("nav.tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
}
function showTab(tab) {
  S.tab = tab;
  $$("nav.tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  $$(".view").forEach((v) => v.classList.toggle("on", v.id === `view-${tab}`));
  history.replaceState(null, "", tab === "swap" ? location.pathname : `#${tab}`);
  if (tab === "explore" && !S.explore.rows.length) loadExplore();
  if (tab === "launch") { loadLaunches(); updateLaunchCost(); }
  updateWalletBtn();
}

// ================================================================ chains
function renderChainRow(sel, active, onPick) {
  const row = $(sel);
  row.innerHTML = S.chains
    .map((c) => `<button class="chip" data-chain="${c.key}" aria-pressed="${c.key === active}">${esc(c.name.toUpperCase())}</button>`)
    .join("");
  row.onclick = (e) => {
    const b = e.target.closest("[data-chain]");
    if (!b) return;
    $$("[data-chain]", row).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    onPick(b.dataset.chain);
  };
}

function setChain(key) {
  S.chain = key;
  store.set("chain", key);
  $$("#swapChains [data-chain]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.chain === key)));
  const c = cur();
  $("#netLabel").textContent = c.name.toUpperCase();
  $("#statRouter").textContent = isSol(c) ? "JUPITER" : "KYBER";
  S.quote = null;
  renderLegs();
  updateWalletBtn();
  refreshBalances();
  requote();
}

// ================================================================ swap
function renderSlippage() {
  const opts = [50, 100, 300];
  $("#slipChips").innerHTML = opts.map((b) => `<button class="chip" data-slip="${b}" aria-pressed="${S.slippageBps === b}">${b / 100}%</button>`).join(" ");
  if (!opts.includes(S.slippageBps)) $("#slipCustom").value = S.slippageBps / 100;
  $("#slipChips").onclick = (e) => {
    const b = e.target.closest("[data-slip]");
    if (!b) return;
    setSlip(Number(b.dataset.slip));
    $("#slipCustom").value = "";
  };
  $("#slipCustom").oninput = (e) => {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v) && v > 0 && v <= 20) setSlip(Math.round(v * 100));
  };
}
function setSlip(bps) {
  S.slippageBps = bps;
  store.set("slip", bps);
  $$("#slipChips [data-slip]").forEach((x) => x.setAttribute("aria-pressed", String(Number(x.dataset.slip) === bps)));
  if (S.quote) renderQuote();
}

function renderLegs() {
  const p = pair();
  $("#sellTok").innerHTML = `${tokenIcon(p.sell)}<span>${esc(p.sell.symbol)}</span> ▾`;
  $("#buyTok").innerHTML = `${tokenIcon(p.buy)}<span>${esc(p.buy.symbol)}</span> ▾`;
  $("#sellAmt").value = S.amount;
}

function bindSwap() {
  let t;
  $("#sellAmt").addEventListener("input", (e) => {
    const v = e.target.value.replace(/,/g, ".").replace(/[^\d.]/g, "");
    e.target.value = v;
    S.amount = v;
    clearTimeout(t);
    t = setTimeout(requote, 450);
  });
  $("#flipBtn").onclick = () => {
    const p = pair();
    [p.sell, p.buy] = [p.buy, p.sell];
    savePairs();
    S.amount = S.quote?.outHuman && Number(S.quote.outHuman.replace(/,/g, "")) ? S.quote.outHuman.replace(/,/g, "") : S.amount;
    renderLegs();
    refreshBalances();
    requote();
  };
  $("#maxBtn").onclick = () => {
    const p = pair();
    if (p.sell.bal == null) return;
    let v = p.sell.bal;
    // leave gas for native coins
    if ((isSol() && p.sell.address === sol.WSOL) || (!isSol() && evm.isNative(p.sell.address))) {
      const reserve = isSol() ? 10_000_000n : 10n ** 15n * (cur().key === "ethereum" ? 5n : 1n);
      v = v > reserve ? v - reserve : 0n;
    }
    S.amount = formatUnits(v, p.sell.decimals, p.sell.decimals).replace(/,/g, "");
    $("#sellAmt").value = S.amount;
    requote();
  };
  $("#sellTok").onclick = () => openTokenPicker("sell");
  $("#buyTok").onclick = () => openTokenPicker("buy");
  $("#swapBtn").onclick = onSwapClick;
}

async function refreshBalances() {
  const c = cur();
  const owner = addrFor(c);
  const p = pair();
  for (const leg of ["sell", "buy"]) {
    const tok = p[leg];
    $(`#${leg}Bal`).textContent = owner ? "…" : "—";
    if (!owner) { tok.bal = null; continue; }
    try {
      const bal = isSol(c) ? await sol.balance(owner, tok.address) : await evm.balanceOf(c.key, tok.address, owner);
      if (pair()[leg] !== tok) continue;
      tok.bal = bal;
      $(`#${leg}Bal`).textContent = formatUnits(bal, tok.decimals, 4);
    } catch {
      $(`#${leg}Bal`).textContent = "—";
    }
  }
  updateSwapBtn();
}

let quoteSeq = 0;
async function requote() {
  const c = cur();
  const p = pair();
  const seq = ++quoteSeq;
  const amt = parseUnits(S.amount, p.sell.decimals);
  S.quote = null;
  $("#buyAmt").value = "";
  $("#buyUsd").textContent = "";
  $("#sellUsd").textContent = "";
  $("#quoteDetails").hidden = true;
  if (amt === 0n || p.sell.address === p.buy.address) { updateSwapBtn(); return; }
  S.quoting = true;
  updateSwapBtn();
  $("#buyAmt").placeholder = "quoting…";
  try {
    const q = isSol(c) ? await quoteSol(p, amt) : await quoteEvm(c, p, amt);
    if (seq !== quoteSeq) return;
    q.at = Date.now();
    q.chain = c.key;
    q.sell = p.sell;
    q.buy = p.buy;
    q.amountIn = amt;
    S.quote = q;
    renderQuote();
  } catch (e) {
    if (seq !== quoteSeq) return;
    S.quote = { error: e.message };
    $("#quoteDetails").hidden = false;
    $("#quoteDetails").innerHTML = `<div><span class="warn">${esc(e.message)}</span></div>`;
  } finally {
    if (seq === quoteSeq) {
      S.quoting = false;
      $("#buyAmt").placeholder = "0.0";
      updateSwapBtn();
    }
  }
}

async function quoteSol(p, amt) {
  const params = new URLSearchParams({ inputMint: p.sell.address, outputMint: p.buy.address, amount: amt.toString() });
  if (S.sol.address) params.set("taker", S.sol.address);
  const o = await getJSON(`/api/sol/order?${params}`);
  if (o.error || (!o.outAmount && o.errorMessage)) throw new Error(o.error || o.errorMessage);
  const out = BigInt(o.outAmount || "0");
  if (out === 0n) throw new Error("No route found for this pair");
  const impact = o.priceImpactPct != null ? Number(o.priceImpactPct) * 100 : o.priceImpact != null ? Number(o.priceImpact) : null;
  return {
    kind: "sol",
    raw: o,
    out,
    inUsd: num(o.inUsdValue),
    outUsd: num(o.outUsdValue),
    impact: Number.isFinite(impact) ? Math.abs(impact) : null,
    feeBps: o.feeBps ?? null,
    route: o.router ? o.router.toUpperCase() : "JUPITER",
    minOut: o.otherAmountThreshold ? BigInt(o.otherAmountThreshold) : null,
    slippageBps: o.slippageBps ?? null,
  };
}

async function quoteEvm(c, p, amt) {
  const params = new URLSearchParams({ chain: c.key, tokenIn: p.sell.address, tokenOut: p.buy.address, amountIn: amt.toString() });
  if (S.evm.address) params.set("origin", S.evm.address);
  const r = await getJSON(`/api/evm/route?${params}`);
  if (r.code && r.code !== 0) throw new Error(kyberMsg(r));
  const rs = r.data?.routeSummary;
  if (!rs) throw new Error("No route found for this pair");
  const inUsd = num(rs.amountInUsd), outUsd = num(rs.amountOutUsd);
  const exch = [...new Set((rs.route || []).flat().map((h) => h.exchange))].slice(0, 3).join(" + ");
  return {
    kind: "evm",
    raw: r.data,
    out: BigInt(rs.amountOut),
    inUsd,
    outUsd,
    // USD values include the X09 fee (charged on the input), so take it out of the impact figure.
    impact: inUsd && outUsd ? Math.max(0, (1 - outUsd / inUsd) * 100 - (S.cfg.evmFeesActive ? S.cfg.feeBps / 100 : 0)) : null,
    feeBps: S.cfg.evmFeesActive ? S.cfg.feeBps : 0,
    gasUsd: num(rs.gasUsd),
    route: exch ? exch.toUpperCase() : "KYBERSWAP",
  };
}
const kyberMsg = (r) => ({ 4008: "No route found for this pair", 4011: "Token not found on this chain", 4010: "No liquidity for this pair" }[r.code] || r.message || "Quote failed");
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

function renderQuote() {
  const q = S.quote;
  if (!q || q.error) return;
  const outHuman = formatUnits(q.out, q.buy.decimals, 6);
  q.outHuman = outHuman;
  $("#buyAmt").value = outHuman;
  $("#sellUsd").textContent = q.inUsd ? "≈ " + fmtUsd(q.inUsd) : "";
  $("#buyUsd").textContent = q.outUsd ? "≈ " + fmtUsd(q.outUsd) : "";

  const inF = Number(S.amount), outF = Number(outHuman.replace(/,/g, ""));
  const rate = inF > 0 && outF > 0 ? outF / inF : null;
  const slip = q.kind === "sol" && q.slippageBps != null ? q.slippageBps : S.slippageBps;
  const minOut = q.minOut ?? (q.out * BigInt(10000 - slip)) / 10000n;
  const rows = [
    ["RATE", rate ? `1 ${esc(q.sell.symbol)} = ${rate < 0.0001 ? rate.toExponential(3) : rate.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${esc(q.buy.symbol)}` : "—"],
    ["MIN RECEIVED", `${formatUnits(minOut, q.buy.decimals, 6)} ${esc(q.buy.symbol)}`],
    ["SLIPPAGE", q.kind === "sol" ? `${(slip / 100).toFixed(2)}% (auto)` : `${(slip / 100).toFixed(2)}%`],
    ["PRICE IMPACT", q.impact == null ? "—" : `<span class="${q.impact > 5 ? "warn" : ""}">${q.impact < 0.01 ? "<0.01" : q.impact.toFixed(2)}%</span>`],
    ["FEES", q.feeBps != null ? `${(q.feeBps / 100).toFixed(2)}% incl. X09` : "—"],
    ["ROUTE", esc(q.route)],
  ];
  if (q.gasUsd) rows.push(["NETWORK FEE", "≈ " + fmtUsd(q.gasUsd)]);
  $("#quoteDetails").innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("");
  $("#quoteDetails").hidden = false;
  if (q.kind === "sol") $("#slipChips").parentElement.style.opacity = 0.5;
  else $("#slipChips").parentElement.style.opacity = 1;
}

function updateSwapBtn(label) {
  const b = $("#swapBtn");
  const p = pair();
  const amt = parseUnits(S.amount, p.sell.decimals);
  b.disabled = false;
  if (label) { b.innerHTML = label; b.disabled = true; return; }
  if (!addrFor()) { b.textContent = "CONNECT WALLET"; return; }
  if (amt === 0n) { b.textContent = "ENTER AMOUNT"; b.disabled = true; return; }
  if (p.sell.bal != null && amt > p.sell.bal) { b.textContent = `INSUFFICIENT ${p.sell.symbol}`; b.disabled = true; return; }
  if (S.quoting) { b.innerHTML = `<span class="spin"></span> QUOTING`; b.disabled = true; return; }
  if (!S.quote || S.quote.error) { b.textContent = S.quote?.error ? "NO ROUTE" : "ENTER AMOUNT"; b.disabled = true; return; }
  b.textContent = S.quote.impact > 15 ? "SWAP ANYWAY (HIGH IMPACT)" : "SWAP";
}

async function onSwapClick() {
  if (!addrFor()) return openWalletModal(isSol() ? "svm" : "evm");
  if (!S.quote || S.quote.error) return;
  const c = cur();
  try {
    if (isSol(c)) await swapSol();
    else await swapEvm(c);
  } catch (e) {
    toast(esc(evm.walletError(e)), true, 8000);
  } finally {
    updateSwapBtn();
  }
}

async function swapSol() {
  const p = pair();
  const amt = parseUnits(S.amount, p.sell.decimals);
  updateSwapBtn(`<span class="spin"></span> PREPARING`);
  // Always fetch a fresh order with the taker so the transaction is current.
  const params = new URLSearchParams({ inputMint: p.sell.address, outputMint: p.buy.address, amount: amt.toString(), taker: S.sol.address });
  const order = await getJSON(`/api/sol/order?${params}`);
  if (!order.transaction) throw new Error(order.errorMessage || "Could not build transaction (check balance / SOL for fees)");
  updateSwapBtn(`<span class="spin"></span> CONFIRM IN WALLET`);
  const signed = await sol.signBytes(S.sol.wallet, S.sol.account, sol.b64ToBytes(order.transaction));
  updateSwapBtn(`<span class="spin"></span> SENDING`);
  const res = await getJSON("/api/sol/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedTransaction: sol.bytesToB64(signed), requestId: order.requestId }),
  });
  if (res.status !== "Success") throw new Error(res.error || `Swap failed (code ${res.code})`);
  const got = res.totalOutputAmount ? formatUnits(BigInt(res.totalOutputAmount), p.buy.decimals, 6) : "";
  toast(`✓ Swapped for ${got} ${esc(p.buy.symbol)} — <a href="https://solscan.io/tx/${res.signature}" target="_blank" rel="noopener">view tx</a>`, false, 10000);
  afterSwap();
}

async function swapEvm(c) {
  const p = pair();
  const { provider } = S.evm;
  const owner = S.evm.address;
  updateSwapBtn(`<span class="spin"></span> SWITCHING NETWORK`);
  await evm.ensureChain(provider, c);

  // Fresh route right before building.
  const amt = parseUnits(S.amount, p.sell.decimals);
  const q = Date.now() - S.quote.at > 15000 ? await quoteEvm(c, p, amt) : S.quote;
  const router = q.raw.routerAddress;

  if (!evm.isNative(p.sell.address)) {
    const allowed = await evm.allowanceOf(c.key, p.sell.address, owner, router);
    if (allowed < amt) {
      updateSwapBtn(`<span class="spin"></span> APPROVE ${esc(p.sell.symbol)}`);
      const h = await evm.sendTx(provider, { from: owner, to: p.sell.address, data: evm.callData(evm.SEL.approve, ["address", "uint256"], [router, amt]) });
      updateSwapBtn(`<span class="spin"></span> WAITING FOR APPROVAL`);
      await evm.waitReceipt(provider, c.key, h);
    }
  }

  updateSwapBtn(`<span class="spin"></span> BUILDING`);
  const built = await getJSON("/api/evm/build", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chain: c.key, routeSummary: q.raw.routeSummary, sender: owner, slippageBps: S.slippageBps }),
  });
  if (built.code && built.code !== 0) throw new Error(kyberMsg(built));
  const d = built.data;
  updateSwapBtn(`<span class="spin"></span> CONFIRM IN WALLET`);
  const hash = await evm.sendTx(provider, { from: owner, to: d.routerAddress, data: d.data, value: BigInt(d.transactionValue || "0") });
  updateSwapBtn(`<span class="spin"></span> CONFIRMING`);
  await evm.waitReceipt(provider, c.key, hash);
  toast(`✓ Swapped ${esc(S.amount)} ${esc(p.sell.symbol)} → ${esc(p.buy.symbol)} — <a href="${c.explorer}/tx/${hash}" target="_blank" rel="noopener">view tx</a>`, false, 10000);
  afterSwap();
}

function afterSwap() {
  S.amount = "";
  $("#sellAmt").value = "";
  S.quote = null;
  $("#buyAmt").value = "";
  $("#quoteDetails").hidden = true;
  $("#sellUsd").textContent = $("#buyUsd").textContent = "";
  setTimeout(refreshBalances, 1500);
}

// ================================================================ token picker
let pickLeg = "sell";
function openTokenPicker(leg) {
  pickLeg = leg;
  $("#tokSearch").value = "";
  renderTokenList(baseTokens());
  openModal("#tokModal");
  setTimeout(() => $("#tokSearch").focus(), 50);
}

function baseTokens() {
  const c = cur();
  const custom = store.get(`custom:${c.key}`, []);
  const seen = new Set();
  return [...c.tokens, ...custom].filter((t) => {
    const k = t.address.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function renderTokenList(list, note = "") {
  $("#tokList").innerHTML =
    (note ? `<div class="empty" style="padding:14px">${note}</div>` : "") +
    list
      .map(
        (t, i) => `<button class="tok-item" data-i="${i}">${tokenIcon(t, 30)}<span><b>${esc(t.symbol)}</b><small>${esc(t.name || "")} · ${esc(short(t.address))}</small></span></button>`
      )
      .join("");
  $("#tokList").onclick = async (e) => {
    const b = e.target.closest("[data-i]");
    if (!b) return;
    await pickToken(list[Number(b.dataset.i)]);
  };
}

async function pickToken(t) {
  const c = cur();
  let tok = { address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, image: t.image || t.icon || null };
  if (tok.decimals == null) {
    try {
      tok = { ...tok, ...(isSol(c) ? {} : await evm.tokenInfo(c.key, tok.address)), image: tok.image };
    } catch {
      return toast("Could not read that token's decimals", true);
    }
  }
  const custom = store.get(`custom:${c.key}`, []);
  if (!c.tokens.some((x) => x.address.toLowerCase() === tok.address.toLowerCase()) && !custom.some((x) => x.address.toLowerCase() === tok.address.toLowerCase())) {
    store.set(`custom:${c.key}`, [tok, ...custom].slice(0, 30));
  }
  const p = pair();
  const other = pickLeg === "sell" ? "buy" : "sell";
  if (p[other].address.toLowerCase() === tok.address.toLowerCase()) p[other] = p[pickLeg];
  p[pickLeg] = tok;
  savePairs();
  closeModals();
  renderLegs();
  refreshBalances();
  requote();
}

let searchT;
$("#tokSearch").addEventListener("input", (e) => {
  clearTimeout(searchT);
  const q = e.target.value.trim();
  const local = baseTokens().filter((t) => !q || t.symbol.toLowerCase().includes(q.toLowerCase()) || t.name?.toLowerCase().includes(q.toLowerCase()) || t.address.toLowerCase() === q.toLowerCase());
  renderTokenList(local);
  if (q.length < 2) return;
  searchT = setTimeout(() => searchTokens(q, local), 350);
});

async function searchTokens(q, local) {
  const c = cur();
  renderTokenList(local, `<span class="spin"></span> searching…`);
  try {
    let found = [];
    if (isSol(c)) {
      const res = await getJSON(`/api/sol/tokens?q=${encodeURIComponent(q)}`);
      found = (Array.isArray(res) ? res : res.tokens || []).slice(0, 25).map((t) => ({
        address: t.id || t.address || t.mint,
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
        image: t.icon || t.logoURI || null,
      }));
    } else if (evm.isAddress(q)) {
      found = [await evm.tokenInfo(c.key, q)];
    } else {
      const pools = await getJSON(`/api/search?q=${encodeURIComponent(q)}&chain=${c.key}`);
      const seen = new Set();
      for (const p of pools) {
        const t = p.token;
        if (!t?.address || seen.has(t.address.toLowerCase())) continue;
        seen.add(t.address.toLowerCase());
        found.push({ address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, image: t.image });
      }
    }
    if ($("#tokSearch").value.trim() !== q) return;
    const localKeys = new Set(local.map((t) => t.address.toLowerCase()));
    const merged = [...local, ...found.filter((t) => t.address && !localKeys.has(t.address.toLowerCase()))];
    renderTokenList(merged, merged.length ? "" : "No tokens found. Paste the contract address.");
  } catch (e) {
    renderTokenList(local, esc(e.message));
  }
}

// ================================================================ wallets
function bindWallet() {
  $("#walletBtn").onclick = () => openWalletModal();
  sol.onSolWallets(() => { if ($("#walletModal").classList.contains("on")) renderWalletList(); });
  evm.onEvmWallets(() => { if ($("#walletModal").classList.contains("on")) renderWalletList(); });
  $$(".modal").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("[data-close]")) closeModals(); }));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModals(); });
}

function openModal(sel) { closeModals(); $(sel).classList.add("on"); }
function closeModals() { $$(".modal").forEach((m) => m.classList.remove("on")); }

let walletFocus = null;
function openWalletModal(focus) {
  walletFocus = focus || (S.tab === "launch" ? launchVm() : isSol() ? "svm" : "evm");
  renderWalletList();
  openModal("#walletModal");
}

function renderWalletList() {
  const solList = sol.solWallets();
  const evmList = evm.evmWallets();
  const here = encodeURIComponent(location.href);
  const section = (title, vm, items, connected) => {
    let h = `<p class="prompt" style="margin-top:6px">${title}</p>`;
    if (connected) {
      h += `<div class="wallet-item" style="cursor:default"><span class="dot"></span><span><b>${esc(connected.name)}</b><br><small style="color:var(--dim)">${esc(short(connected.address))}</small></span><button class="btn small" style="margin-left:auto" data-disc="${vm}">DISCONNECT</button></div>`;
      return h;
    }
    if (!items.length) {
      h += vm === "svm"
        ? `<div class="term" style="margin-bottom:12px">No Solana wallet detected. <a href="https://phantom.app/ul/browse/${here}?ref=${encodeURIComponent(location.origin)}">Open in Phantom</a> · <a href="https://solflare.com/ul/v1/browse/${here}?ref=${encodeURIComponent(location.origin)}">Open in Solflare</a></div>`
        : `<div class="term" style="margin-bottom:12px">No EVM wallet detected. <a href="https://metamask.app.link/dapp/${location.host}${location.pathname}">Open in MetaMask</a> · <a href="https://go.cb-w.com/dapp?cb_url=${here}">Open in Coinbase Wallet</a></div>`;
      return h;
    }
    h += items.map((w, i) => `<button class="wallet-item" data-vm="${vm}" data-i="${i}">${w.icon ? `<img src="${esc(w.icon)}" alt="">` : `<span class="tokimg">W</span>`}<b>${esc(w.name)}</b></button>`).join("");
    return h;
  };
  const solSec = section("SOLANA", "svm", solList.map((w) => ({ name: w.name, icon: w.icon })), S.sol.address && { name: S.sol.wallet.name, address: S.sol.address });
  const evmSec = section("EVM · ETH · BASE · BNB · ARB · POL · OP · AVAX · HOOD", "evm", evmList.map((w) => ({ name: w.info.name, icon: w.info.icon })), S.evm.address && { name: S.evm.info.name, address: S.evm.address });
  $("#walletList").innerHTML = walletFocus === "evm" ? evmSec + solSec : solSec + evmSec;
  $("#walletList").onclick = async (e) => {
    const d = e.target.closest("[data-disc]");
    if (d) return disconnectWallet(d.dataset.disc);
    const b = e.target.closest("[data-vm]");
    if (!b) return;
    const i = Number(b.dataset.i);
    if (b.dataset.vm === "svm") await connectSol(solList[i]);
    else await connectEvm(evmList[i]);
  };
}

async function connectSol(w, silent = false) {
  try {
    const account = await sol.connect(w);
    S.sol = { wallet: w, account, address: account.address };
    store.set("solWallet", w.name);
    w.features["standard:events"]?.on("change", ({ accounts }) => {
      if (!accounts) return;
      if (!accounts.length) return disconnectWallet("svm");
      S.sol.account = accounts[0];
      S.sol.address = accounts[0].address;
      onWalletChange();
    });
    if (!silent) { closeModals(); toast(`Connected ${esc(w.name)} · ${short(account.address)}`); }
    onWalletChange();
  } catch (e) {
    if (!silent) toast(esc(evm.walletError(e)), true);
  }
}

async function connectEvm(w, silent = false) {
  try {
    const accounts = await w.provider.request({ method: silent ? "eth_accounts" : "eth_requestAccounts" });
    if (!accounts?.length) return;
    S.evm = { provider: w.provider, info: w.info, address: accounts[0] };
    store.set("evmWallet", w.info.rdns || w.info.name);
    w.provider.on?.("accountsChanged", (a) => {
      if (!a.length) return disconnectWallet("evm");
      S.evm.address = a[0];
      onWalletChange();
    });
    if (!silent) { closeModals(); toast(`Connected ${esc(w.info.name)} · ${short(accounts[0])}`); }
    onWalletChange();
  } catch (e) {
    if (!silent) toast(esc(evm.walletError(e)), true);
  }
}

async function disconnectWallet(vm) {
  if (vm === "svm") {
    if (S.sol.wallet) await sol.disconnect(S.sol.wallet);
    S.sol = { wallet: null, account: null, address: null };
    store.set("solWallet", null);
  } else {
    try { await S.evm.provider?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }); } catch {}
    S.evm = { provider: null, info: null, address: null };
    store.set("evmWallet", null);
  }
  onWalletChange();
  if ($("#walletModal").classList.contains("on")) renderWalletList();
}

function onWalletChange() {
  updateWalletBtn();
  refreshBalances();
  if (S.amount) requote();
  updateLaunchCost();
}

function updateWalletBtn() {
  const vm = S.tab === "launch" ? launchVm() : isSol() ? "svm" : "evm";
  const a = vm === "svm" ? S.sol.address : S.evm.address;
  $("#walletBtn").innerHTML = a ? `<span class="dot"></span> ${short(a)}` : "Connect";
  $("#walletBtn").classList.toggle("connected", !!a);
  if (S.tab === "swap") updateSwapBtn();
}

async function restoreWallets() {
  await sleep(400); // give wallets time to announce
  const sName = store.get("solWallet");
  if (sName) {
    const w = sol.solWallets().find((x) => x.name === sName);
    if (w) await connectSol(w, true);
  }
  const eName = store.get("evmWallet");
  if (eName) {
    const w = evm.evmWallets().find((x) => (x.info.rdns || x.info.name) === eName);
    if (w) await connectEvm(w, true);
  }
}

// ================================================================ explore
function bindExplore() {
  $$("[data-kind]").forEach((b) =>
    b.addEventListener("click", () => {
      $$("[data-kind]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      S.explore.kind = b.dataset.kind;
      S.explore.q = "";
      $("#exploreSearch").value = "";
      loadExplore();
    })
  );
  let t;
  $("#exploreSearch").addEventListener("input", (e) => {
    clearTimeout(t);
    t = setTimeout(() => { S.explore.q = e.target.value.trim(); loadExplore(); }, 400);
  });
  $("#minLiq").addEventListener("change", (e) => { S.explore.minLiq = Number(e.target.value); renderExplore(); });
  $("#exploreBody").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-i]");
    if (!tr) return;
    const r = S.explore.shown[Number(tr.dataset.i)];
    tradeToken(r.chain, r.token);
  });
  setInterval(() => { if (S.tab === "explore" && document.visibilityState === "visible" && !S.explore.q) loadExplore(true); }, 60000);
}

let exploreSeq = 0;
async function loadExplore(quiet = false) {
  const seq = ++exploreSeq;
  const { chain, kind, q } = S.explore;
  if (!quiet) $("#exploreBody").innerHTML = `<tr><td colspan="8" class="empty"><span class="spin"></span> scanning ${esc(chainOf(chain)?.name || chain)}…</td></tr>`;
  try {
    let rows;
    if (kind === "x09" && !q) {
      const list = await getJSON(`/api/launches?chain=${chain}`);
      rows = list.map((l) => ({ chain: l.chain, token: { address: l.address, symbol: l.symbol, name: l.name, image: l.image }, createdAt: new Date(l.at).toISOString(), x09: true }));
    } else if (q) {
      rows = await getJSON(`/api/search?q=${encodeURIComponent(q)}&chain=${chain}`);
    } else {
      const [p1, p2] = await Promise.all([
        getJSON(`/api/explore?chain=${chain}&kind=${kind}&page=1`),
        getJSON(`/api/explore?chain=${chain}&kind=${kind}&page=2`).catch(() => []),
      ]);
      rows = [...p1, ...p2];
    }
    if (seq !== exploreSeq) return;
    // One row per token (best-liquidity pool).
    const best = new Map();
    for (const r of rows) {
      const k = `${r.chain}:${(r.token.address || "").toLowerCase()}`;
      if (!best.has(k) || (r.liquidity || 0) > (best.get(k).liquidity || 0)) best.set(k, r);
    }
    S.explore.rows = [...best.values()];
    renderExplore();
    $("#exploreMeta").textContent = `${S.explore.rows.length} TOKENS · ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    if (seq !== exploreSeq) return;
    $("#exploreBody").innerHTML = `<tr><td colspan="8" class="empty">${esc(e.message)}</td></tr>`;
  }
}

function renderExplore() {
  const rows = S.explore.rows.filter((r) => r.x09 || (r.liquidity || 0) >= S.explore.minLiq);
  S.explore.shown = rows;
  if (!rows.length) {
    $("#exploreBody").innerHTML = `<tr><td colspan="8" class="empty">${S.explore.kind === "x09" ? "No X09 launches on this chain yet — be first on the LAUNCH tab." : "Nothing matches."}</td></tr>`;
    return;
  }
  $("#exploreBody").innerHTML = rows
    .map(
      (r, i) => `<tr data-i="${i}">
      <td><div class="tokcell">${tokenIcon(r.token, 30)}<span><b>${esc(r.token.symbol || "?")}</b><small>${esc(r.token.name || short(r.token.address))}</small></span></div></td>
      <td>${fmtUsd(r.priceUsd)}</td>
      <td class="hide-sm ${pctClass(r.change1h)}">${fmtPct(r.change1h)}</td>
      <td class="${pctClass(r.change24h)}">${fmtPct(r.change24h)}</td>
      <td class="hide-sm">${fmtUsd(r.volume24h)}</td>
      <td>${fmtUsd(r.liquidity)}</td>
      <td class="hide-sm">${fmtUsd(r.marketCap ?? r.fdv)}</td>
      <td class="hide-sm">${age(r.createdAt)}</td>
    </tr>`
    )
    .join("");
}

function tradeToken(chainKey, token) {
  const c = chainOf(chainKey);
  if (!c) return;
  S.chain = chainKey;
  const p = S.pairs[chainKey] || {};
  p.sell = c.tokens[0];
  p.buy = { address: token.address, symbol: token.symbol, name: token.name, decimals: token.decimals ?? null, image: token.image };
  S.pairs[chainKey] = p;
  showTab("swap");
  renderChainRow("#swapChains", chainKey, (k) => setChain(k));
  // Resolve decimals if the market feed didn't include them.
  const finish = () => { savePairs(); setChain(chainKey); };
  if (p.buy.decimals == null) {
    (c.vm === "svm"
      ? getJSON(`/api/sol/tokens?q=${token.address}`).then((r) => { const t = (Array.isArray(r) ? r : [])[0]; p.buy.decimals = t?.decimals ?? 6; })
      : evm.tokenInfo(chainKey, token.address).then((t) => { p.buy.decimals = t.decimals; })
    )
      .catch(() => { p.buy.decimals = c.vm === "svm" ? 6 : 18; })
      .finally(finish);
  } else finish();
  $("#sellAmt").focus();
}

// ================================================================ launch
const launchVm = () => (chainOf($("#lChain")?.value)?.vm === "svm" ? "svm" : "evm");
let logoData = null;

function bindLaunch() {
  $("#lChain").innerHTML = S.chains.map((c) => `<option value="${c.key}">${esc(c.name)}</option>`).join("");
  $("#lChain").value = S.chain;
  $("#lChain").addEventListener("change", onLaunchChain);
  onLaunchChain();

  $("#lLogo").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      logoData = await resizeImage(f, 512);
      $("#lLogoPrev").style.backgroundImage = `url(${logoData})`;
      $("#lLogoPrev").textContent = "";
    } catch {
      toast("Could not read that image", true);
    }
  });
  const toggles = () => {
    $("#liqOpts").style.display = $("#lAddLiq").checked ? "" : "none";
    $("#snipeOpts").style.display = $("#lSnipe").checked ? "" : "none";
    updateSnipeBox();
    updateAllocation();
    updateLaunchCost();
  };
  ["lAddLiq", "lSnipe"].forEach((id) => $("#" + id).addEventListener("change", toggles));
  ["lLiqNative", "lSupply", "lCreatorPct"].forEach((id) => $("#" + id).addEventListener("input", () => { updateAllocation(); updateLaunchCost(); }));
  $("#lSnipeSecs").addEventListener("input", updateSnipeBox);
  toggles();
  $("#launchForm").addEventListener("submit", onLaunch);
  $("#launchList").addEventListener("click", (e) => {
    const it = e.target.closest("[data-la]");
    if (it) tradeToken(it.dataset.chain, { address: it.dataset.la, symbol: it.dataset.sym, name: it.dataset.name, image: it.dataset.img || null });
  });
}

// Seconds per block as seen by the token contract's block.number
// (Arbitrum-based chains report Ethereum block numbers, ~12s).
const BLOCK_SECS = { ethereum: 12, base: 2, optimism: 2, bsc: 0.75, polygon: 2, avalanche: 2, arbitrum: 12, robinhood: 12 };
const snipeBlocksFor = (key, secs) => Math.min(1000, Math.max(1, Math.ceil(secs / (BLOCK_SECS[key] || 2))));

function updateSnipeBox() {
  const c = chainOf($("#lChain").value);
  if (!c) return;
  const svm = c.vm === "svm";
  const canLiq = !svm && $("#lAddLiq").checked && !!c.v2Router;
  $("#snipeOn").hidden = !canLiq;
  $("#snipeOff").hidden = canLiq;
  if (svm) {
    $("#snipeOff").innerHTML = "Solana tokens can't limit wallets or block buys without a custom on-chain program, so the contract-level anti-sniper is EVM-only for now.<br><br><b>Best protection on Solana:</b> launch, create the Raydium pool right away, and only then post the contract address.";
  } else if (!c.v2Router) {
    $("#snipeOff").textContent = `Anti-sniper needs X09 to add the liquidity, which isn't available on ${c.name} yet. Trading opens as soon as the token deploys.`;
  } else {
    $("#snipeOff").textContent = "Turn on \"Add liquidity now\" to use the anti-sniper — it activates when X09 opens trading.";
  }
  const secs = Number($("#lSnipeSecs").value) || 0;
  const blocks = snipeBlocksFor(c.key, secs);
  $("#lBlockHint").textContent = svm ? "" : `≈ ${blocks} blocks on ${c.name}${blocks === 1000 ? " (max)" : ""}`;
}

function updateAllocation() {
  const c = chainOf($("#lChain").value);
  if (!c) return;
  const pct = Math.min(50, Math.max(0, Number($("#lCreatorPct").value) || 0));
  let supply = 0;
  try { supply = Number(BigInt($("#lSupply").value || "0")); } catch {}
  const fmt = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  const mine = (supply * pct) / 100, pool = supply - mine;
  const withPool = c.vm === "svm" || $("#lAddLiq").checked;
  $("#lSplit").value = withPool ? `You ${pct}% · Pool ${+(100 - pct).toFixed(1)}%` : `You 100%`;
  $("#lAllocNote").textContent =
    c.vm === "svm"
      ? `You'll receive all ${fmt(supply)} tokens. Keep ${fmt(mine)} and put ${fmt(pool)} into the Raydium pool.`
      : withPool
        ? `${fmt(mine)} tokens stay in your wallet, ${fmt(pool)} go into the pool.`
        : `Without X09 liquidity the whole supply goes to your wallet.`;
}

function onLaunchChain() {
  const c = chainOf($("#lChain").value);
  const svm = c.vm === "svm";
  $("#evmOpts").hidden = svm;
  $("#solOpts").hidden = !svm;
  if (!svm) {
    $("#lNativeSym").textContent = c.native.symbol;
    const canLiq = !!c.v2Router;
    $("#lAddLiq").disabled = !canLiq;
    if (!canLiq) $("#lAddLiq").checked = false;
    $("#lDexName").textContent = c.v2Name || "— (not available on this chain yet)";
    $("#lAddLiq").dispatchEvent(new Event("change"));
    $("#lLiqNative").value = { ethereum: 0.1, bsc: 0.2, polygon: 100, avalanche: 3 }[c.key] ?? 0.05;
  }
  updateSnipeBox();
  updateAllocation();
  updateWalletBtn();
  updateLaunchCost();
}

async function updateLaunchCost() {
  if (!S.cfg || S.tab !== "launch") return;
  const c = chainOf($("#lChain").value);
  if (!S.prices) S.prices = await getJSON("/api/price").catch(() => null);
  const price = S.prices?.[c.key];
  const usd = S.cfg.launchFeeUsd;
  const feeWallet = c.vm === "svm" ? S.cfg.solFeeWallet : S.cfg.evmFeeWallet;
  const sym = c.native.symbol;
  const rows = [];
  if (usd > 0 && feeWallet) rows.push(["LAUNCH FEE", price ? `$${usd} ≈ ${(usd / price).toPrecision(3)} ${sym}` : `$${usd} in ${sym}`]);
  else rows.push(["LAUNCH FEE", "FREE"]);
  if (c.vm === "evm" && $("#lAddLiq").checked) rows.push(["LIQUIDITY", `${$("#lLiqNative").value || 0} ${sym} + ${+(100 - (Number($("#lCreatorPct").value) || 0)).toFixed(1)}% of supply`]);
  if (c.vm === "svm") rows.push(["RENT", "≈ 0.004 SOL (account storage)"]);
  rows.push(["NETWORK GAS", "paid in your wallet"]);
  $("#launchCost").innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("");
}

function resizeImage(file, max) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement("canvas");
      cv.width = Math.round(img.width * s);
      cv.height = Math.round(img.height * s);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      let data = cv.toDataURL("image/webp", 0.85);
      if (!data.startsWith("data:image/webp")) data = cv.toDataURL("image/png");
      URL.revokeObjectURL(img.src);
      resolve(data);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function launchLogger() {
  const box = $("#launchLog");
  box.innerHTML = "";
  return (msg, cls = "") => {
    const line = document.createElement("div");
    if (cls) line.className = cls;
    line.innerHTML = `> ${msg}`;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  };
}

async function onLaunch(e) {
  e.preventDefault();
  const c = chainOf($("#lChain").value);
  const svm = c.vm === "svm";
  if (svm ? !S.sol.address : !S.evm.address) return openWalletModal(svm ? "svm" : "evm");

  const form = {
    name: $("#lName").value.trim(),
    symbol: $("#lSym").value.trim().toUpperCase(),
    description: $("#lDesc").value.trim(),
    supply: $("#lSupply").value.trim(),
    website: $("#lWeb").value.trim(),
    twitter: $("#lX").value.trim(),
    telegram: $("#lTg").value.trim(),
    discord: $("#lDc").value.trim(),
    image: logoData,
    // evm
    addLiquidity: !svm && $("#lAddLiq").checked,
    creatorPct: Number($("#lCreatorPct").value) || 0,
    liqNative: $("#lLiqNative").value.trim(),
    burnLp: $("#lBurnLp").checked,
    antiSnipe: $("#lSnipe").checked,
    maxWalletPct: Number($("#lMaxWallet").value),
    snipeBlocks: snipeBlocksFor(c.key, Number($("#lSnipeSecs").value) || 0),
    deadBlocks: Number($("#lDeadBlocks").value),
    renounce: $("#lRenounce").checked,
    // solana
    decimals: Number($("#lDecimals").value),
    revokeMint: $("#lRevoke").checked,
  };

  const problem =
    (!form.name && "Enter a name") ||
    (!/^[A-Z0-9$]{1,10}$/.test(form.symbol) && "Ticker: 1-10 letters/numbers") ||
    (!/^\d+$/.test(form.supply) || BigInt(form.supply) < 1n || BigInt(form.supply) > 10n ** 15n ? "Supply: whole number between 1 and 1,000,000,000,000,000" : "") ||
    (!(form.creatorPct >= 0 && form.creatorPct <= 50) && "Creator allocation must be 0-50%") ||
    (form.addLiquidity && !(Number(form.liqNative) > 0) && `Enter how much ${c.native.symbol} to pair`) ||
    (form.addLiquidity && form.antiSnipe && !(form.maxWalletPct > 0 && form.maxWalletPct <= 100) && "Max wallet must be 0.01-100%") ||
    (form.addLiquidity && form.antiSnipe && !(Number($("#lSnipeSecs").value) >= 10) && "Anti-sniper duration must be at least 10 seconds");
  if (problem) return toast(esc(problem), true);

  if (!S.prices) S.prices = await getJSON("/api/price").catch(() => null);
  const log = launchLogger();
  const btn = $("#launchBtn");
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span> LAUNCHING`;
  $("#launchResult").innerHTML = "";
  try {
    const ctx = { chain: c, cfg: S.cfg, prices: S.prices, log, getJSON };
    const res = svm
      ? await launchSolana({ ...ctx, wallet: S.sol.wallet, account: S.sol.account, owner: S.sol.address }, form)
      : await launchEvm({ ...ctx, provider: S.evm.provider, owner: S.evm.address }, form);
    log(`<b>LAUNCH COMPLETE</b>`, "ok");
    showLaunchResult(c, res, form);
    loadLaunches();
    toast(`✓ ${esc(form.symbol)} is live on ${esc(c.name)}`, false, 8000);
  } catch (err) {
    log(esc(evm.walletError(err)), "err");
    toast(esc(evm.walletError(err)), true, 9000);
  } finally {
    btn.disabled = false;
    btn.textContent = "LAUNCH TOKEN";
  }
}

function showLaunchResult(c, res, form) {
  const svm = c.vm === "svm";
  const link = svm ? `https://solscan.io/token/${res.address}` : `${c.explorer}/token/${res.address}`;
  $("#launchResult").innerHTML = `<div class="result">
    <p class="prompt">${esc(form.symbol)} deployed</p>
    <div class="term"><code>${esc(res.address)}</code></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
      <button class="btn small" id="copyCa">COPY CA</button>
      <a class="btn small" href="${link}" target="_blank" rel="noopener">EXPLORER</a>
      ${res.tradable ? `<button class="btn small solid" id="tradeNew">TRADE IT</button>` : ""}
      ${svm ? `<a class="btn small" href="https://raydium.io/liquidity/create-pool/" target="_blank" rel="noopener">ADD LIQUIDITY (RAYDIUM)</a>` : ""}
    </div>
    ${svm ? `<div class="hint" style="margin-top:8px;font-size:11px;color:var(--dim)">Pair it with SOL on Raydium to open trading. X09 DEX will route to the pool automatically.</div>` : ""}
  </div>`;
  $("#copyCa").onclick = () => navigator.clipboard.writeText(res.address).then(() => toast("Contract address copied"));
  if (res.tradable)
    $("#tradeNew").onclick = () => tradeToken(c.key, { address: res.address, symbol: form.symbol, name: form.name, decimals: svm ? form.decimals : 18, image: res.image });
}

async function loadLaunches() {
  try {
    const list = await getJSON("/api/launches");
    $("#launchCount").textContent = list.length ? `[${list.length}]` : "";
    $("#launchList").innerHTML = list.length
      ? list
          .slice(0, 12)
          .map(
            (l) => `<div class="launch-item" data-la="${esc(l.address)}" data-chain="${esc(l.chain)}" data-sym="${esc(l.symbol)}" data-name="${esc(l.name)}" data-img="${esc(l.image || "")}">
          ${tokenIcon({ image: l.image, symbol: l.symbol }, 30)}<span><b>${esc(l.symbol)}</b> <small>${esc(l.name)} · ${esc(chainOf(l.chain)?.name || l.chain)} · ${age(new Date(l.at).toISOString())} ago</small></span></div>`
          )
          .join("")
      : `<div class="term">No launches yet. Yours could be first.</div>`;
  } catch {
    $("#launchList").innerHTML = `<div class="term">—</div>`;
  }
}

// ================================================================ X09 header
function bindSwitcher() {
  const btn = $("#switchBtn"), menu = $("#switchMenu");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const show = menu.hidden;
    menu.hidden = !show;
    btn.setAttribute("aria-expanded", String(show));
  });
  document.addEventListener("click", (e) => {
    if (!$("#switcher").contains(e.target)) { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); }
  });
}

// The animated X09 logo (same as X09 Hub): the moon orbits and dips behind the planet; rings spin on hover/tap.
function x09Logo(el, size = 28) {
  const id = "x" + Math.random().toString(36).slice(2, 7);
  el.innerHTML = `<svg viewBox="0 0 64 64" width="${size}" height="${size}" fill="none" aria-hidden="true">
    <defs><radialGradient id="${id}p" cx="34%" cy="30%" r="78%"><stop offset="0" stop-color="#fff"/><stop offset=".38" stop-color="#e2e2e2"/><stop offset=".72" stop-color="#6b6b6b"/><stop offset="1" stop-color="#161616"/></radialGradient></defs>
    <g class="rb"></g><circle class="mb" r="2.7" fill="#fff"/><circle cx="32" cy="32" r="14.5" fill="url(#${id}p)"/><g class="rf"></g><circle class="mf" r="2.7" fill="#fff"/></svg>`;
  const svg = el.firstElementChild, rb = svg.querySelector(".rb"), rf = svg.querySelector(".rf");
  const mb = svg.querySelector(".mb"), mf = svg.querySelector(".mf");
  const rx = 29, ry = 8.6;
  const arc = (deg, front) => {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const P = (t) => { const x = rx * Math.cos(t), y = ry * Math.sin(t); return `${(32 + x * c - y * s).toFixed(2)} ${(32 + x * s + y * c).toFixed(2)}`; };
    const pts = []; for (let i = 0; i <= 24; i++) pts.push(P((front ? 0 : Math.PI) + (i / 24) * Math.PI));
    return "M" + pts.join(" L");
  };
  let spin = 0, vspin = 0, t = Math.random() * 6;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.addEventListener("pointerenter", () => (vspin += 140));
  el.addEventListener("click", () => (vspin += 260));
  let last = performance.now();
  (function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (!reduce) { vspin += (-spin * 30 - vspin * 5) * dt; spin += vspin * dt; t += dt * 0.9; }
    const A = -30 + spin * 0.12, Bd = 30 - spin * 0.12;
    rb.innerHTML = `<path d="${arc(A, false)}" stroke="#fff" stroke-opacity=".55" stroke-width="2.2" stroke-linecap="round"/><path d="${arc(Bd, false)}" stroke="#fff" stroke-opacity=".55" stroke-width="2.2" stroke-linecap="round"/>`;
    rf.innerHTML = [A, Bd].map((d) => `<path d="${arc(d, true)}" stroke="#000" stroke-width="6"/><path d="${arc(d, true)}" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>`).join("");
    const a = (-58 * Math.PI) / 180, x = 25 * Math.cos(t), y = 7 * Math.sin(t);
    const mx = 32 + x * Math.cos(a) - y * Math.sin(a), my = 32 + x * Math.sin(a) + y * Math.cos(a);
    const front = Math.sin(t) > 0;
    (front ? mf : mb).setAttribute("cx", mx.toFixed(2)); (front ? mf : mb).setAttribute("cy", my.toFixed(2));
    (front ? mf : mb).style.opacity = 1; (front ? mb : mf).style.opacity = 0;
    if (el.isConnected) requestAnimationFrame(tick);
  })(last);
}

// ================================================================ starfield
function stars() {
  const cv = $("#stars");
  const ctx = cv.getContext("2d");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let w, h, dpr, pts;
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = cv.width = innerWidth * dpr;
    h = cv.height = innerHeight * dpr;
    const n = Math.round(Math.min(360, (innerWidth * innerHeight) / 5200));
    pts = Array.from({ length: n }, () => spawn(true));
  }
  function spawn(anywhere) {
    return { x: (Math.random() - 0.5) * w, y: (Math.random() - 0.5) * h, z: anywhere ? Math.random() * w : w, tw: Math.random() * Math.PI * 2 };
  }
  addEventListener("resize", resize);
  addEventListener("pointermove", (e) => { mouse.tx = (e.clientX / innerWidth - 0.5) * 40; mouse.ty = (e.clientY / innerHeight - 0.5) * 40; });
  resize();
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(50, now - last);
    last = now;
    mouse.x += (mouse.tx - mouse.x) * 0.05;
    mouse.y += (mouse.ty - mouse.y) * 0.05;
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(0, 0, w, h);
    const cx = w / 2 + mouse.x * dpr, cy = h / 2 + mouse.y * dpr;
    const speed = reduce ? 0 : 0.06 * dt * dpr;
    for (const p of pts) {
      const pz = p.z;
      p.z -= speed * 8;
      if (p.z <= 1) Object.assign(p, spawn(false));
      const k = w / 2 / p.z;
      const x = cx + p.x * k * 0.5, y = cy + p.y * k * 0.5;
      if (x < 0 || x > w || y < 0 || y > h) { Object.assign(p, spawn(false)); continue; }
      const kp = w / 2 / pz;
      const px = cx + p.x * kp * 0.5, py = cy + p.y * kp * 0.5;
      p.tw += 0.002 * dt;
      const a = Math.min(1, (1 - p.z / w) * 1.4) * (0.75 + 0.25 * Math.sin(p.tw));
      const size = Math.max(0.4, (1 - p.z / w) * 2.2) * dpr;
      ctx.strokeStyle = `rgba(255,255,255,${a})`;
      ctx.lineWidth = size;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(x + 0.1, y + 0.1);
      ctx.stroke();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
