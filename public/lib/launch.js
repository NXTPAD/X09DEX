// Token launch flows for EVM chains and Solana.
import * as evm from "./evm.js";
import * as sol from "./sol.js";

// ---------------------------------------------------------------- shared

async function uploadMeta(ctx, form) {
  ctx.log("uploading logo + metadata…");
  const meta = await ctx.getJSON("/api/meta", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: form.name,
      symbol: form.symbol,
      description: form.description,
      website: form.website,
      twitter: form.twitter,
      telegram: form.telegram,
      discord: form.discord,
      image: form.image,
    }),
  });
  ctx.log(`metadata stored ✓`, "ok");
  return meta;
}

async function recordLaunch(ctx, entry) {
  // The Worker checks the token exists on-chain; RPCs can lag a few seconds.
  for (let i = 0; i < 5; i++) {
    try {
      await ctx.getJSON("/api/launches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(entry) });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

function feeInNative(ctx, decimals) {
  const usd = ctx.cfg.launchFeeUsd;
  const wallet = ctx.chain.vm === "svm" ? ctx.cfg.solFeeWallet : ctx.cfg.evmFeeWallet;
  if (!(usd > 0) || !wallet) return { amount: 0n, wallet: null };
  const price = ctx.prices?.[ctx.chain.key];
  if (!price) throw new Error("Price feed is busy — try again in a minute.");
  // Round up to 6 significant digits of the native unit.
  const units = Math.ceil((usd / price) * 1e6);
  return { amount: (BigInt(units) * 10n ** BigInt(decimals)) / 1_000_000n, wallet };
}

// ---------------------------------------------------------------- EVM

const SOURCE_URL = "/contracts/X09Token.sol";

async function compileToken(log) {
  const source = await fetch(SOURCE_URL).then((r) => r.text());
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  const key = `x09dex:build:${hash}`;
  try {
    const hit = JSON.parse(localStorage.getItem(key) || "null");
    if (hit?.bytecode) {
      log("contract build loaded from cache ✓", "ok");
      return hit;
    }
  } catch {}

  log("compiling token contract with solc 0.8.26 (first time takes ~10-20s)…");
  const result = await new Promise((resolve, reject) => {
    const w = new Worker("/solc-worker.js");
    const timer = setTimeout(() => { w.terminate(); reject(new Error("Compiler timed out — check your connection and retry")); }, 120000);
    w.onmessage = (e) => {
      if (e.data.progress) return log(e.data.progress + "…");
      clearTimeout(timer);
      w.terminate();
      e.data.ok ? resolve(e.data) : reject(new Error("Compile failed: " + e.data.error));
    };
    w.onerror = (e) => { clearTimeout(timer); w.terminate(); reject(new Error("Compiler failed to load: " + (e.message || "network error"))); };
    w.postMessage({ source });
  });
  const build = { bytecode: result.bytecode, methods: result.methods };
  try { localStorage.setItem(key, JSON.stringify(build)); } catch {}
  log("contract compiled ✓", "ok");
  return build;
}

const sel = (methods, sig) => {
  const id = methods[sig];
  if (!id) throw new Error(`missing method ${sig}`);
  return "0x" + id;
};

export async function launchEvm(ctx, form) {
  const { chain, provider, owner, log } = ctx;
  log(`network: ${chain.name}`);
  await evm.ensureChain(provider, chain);

  const meta = await uploadMeta(ctx, form);
  const build = await compileToken(log);
  const fee = feeInNative(ctx, 18);

  const supply = BigInt(form.supply);
  const total = supply * 10n ** 18n;
  const withLiq = form.addLiquidity && !!chain.v2Router;
  const snipe = withLiq && form.antiSnipe;
  const maxWalletBps = snipe ? Math.max(1, Math.round(form.maxWalletPct * 100)) : 10000;
  const snipeBlocks = snipe ? form.snipeBlocks : 0;
  const deadBlocks = snipe ? form.deadBlocks : 0;
  const poolPct = 100 - form.creatorPct;

  const args = evm.abiEncode(
    ["string", "string", "uint256", "uint256", "uint256", "uint256", "bool", "string", "address"],
    [form.name, form.symbol, supply, maxWalletBps, snipeBlocks, deadBlocks, !withLiq, meta.uri, fee.wallet || owner]
  );

  log(`deploying ${form.symbol}${fee.amount ? ` (launch fee ${Number(fee.amount) / 1e18} ${chain.native.symbol})` : ""} — confirm in wallet`);
  const deployHash = await evm.sendTx(provider, { from: owner, data: "0x" + build.bytecode + args, value: fee.amount });
  log(`tx sent <a href="${chain.explorer}/tx/${deployHash}" target="_blank" rel="noopener">${deployHash.slice(0, 12)}…</a>`);
  const rcpt = await evm.waitReceipt(provider, chain.key, deployHash);
  const token = rcpt.contractAddress;
  if (!token) throw new Error("Deployment receipt has no contract address");
  log(`token deployed at ${token} ✓`, "ok");

  recordLaunch(ctx, { chain: chain.key, address: token, name: form.name, symbol: form.symbol, image: meta.image, tx: deployHash });

  if (!withLiq) {
    log("trading is open. add liquidity on any DEX to let people buy.");
    return { address: token, image: meta.image, tradable: false };
  }

  // ---- liquidity
  const router = chain.v2Router;
  const liqTokens = (total * BigInt(Math.round(poolPct * 100))) / 10000n;
  log(`creator allocation: ${form.creatorPct}% stays in your wallet, ${poolPct}% goes to the pool`);
  const liqNative = parseNative(form.liqNative);
  const call = (to, data) => provider.request({ method: "eth_call", params: [{ to, data }, "latest"] });
  const send = async (label, tx) => {
    log(`${label} — confirm in wallet`);
    const h = await evm.sendTx(provider, { from: owner, ...tx });
    await evm.waitReceipt(provider, chain.key, h);
    log(`${label} ✓`, "ok");
    return h;
  };

  await send(`approve ${chain.v2Name}`, { to: token, data: evm.callData(evm.SEL.approve, ["address", "uint256"], [router, liqTokens]) });

  const deadline = Math.floor(Date.now() / 1000) + 1800;
  await send(`add liquidity (${form.liqNative} ${chain.native.symbol} + ${poolPct}% supply)`, {
    to: router,
    value: liqNative,
    data: evm.callData(
      evm.SEL.addLiquidityETH,
      ["address", "uint256", "uint256", "uint256", "address", "uint256"],
      [token, liqTokens, liqTokens, liqNative, owner, deadline]
    ),
  });

  const factory = evm.decodeAddress(await call(router, evm.SEL.factory));
  const weth = evm.decodeAddress(await call(router, evm.SEL.WETH));
  let pairAddr = "0x" + "0".repeat(40);
  for (let i = 0; i < 6 && /^0x0+$/.test(pairAddr); i++) {
    pairAddr = evm.decodeAddress(await call(factory, evm.callData(evm.SEL.getPair, ["address", "address"], [token, weth])));
    if (/^0x0+$/.test(pairAddr)) await new Promise((r) => setTimeout(r, 2000));
  }
  if (/^0x0+$/.test(pairAddr)) throw new Error("Could not find the new pool — open trading manually from the explorer (openTrading).");
  log(`pool: ${pairAddr}`);

  await send(
    snipe
      ? `open trading (anti-sniper: ${deadBlocks ? `buys blocked for ${deadBlocks} block${deadBlocks > 1 ? "s" : ""}, then ` : ""}max wallet ${form.maxWalletPct}% for ${snipeBlocks} blocks)`
      : "open trading",
    {
    to: token,
    data: sel(build.methods, "openTrading(address)") + evm.abiEncode(["address"], [pairAddr]),
    }
  );

  if (form.burnLp) {
    let lp = 0n;
    for (let i = 0; i < 5 && lp === 0n; i++) {
      lp = evm.decodeUint(await call(pairAddr, evm.callData(evm.SEL.balanceOf, ["address"], [owner])));
      if (lp === 0n) await new Promise((r) => setTimeout(r, 2000));
    }
    if (lp === 0n) log("could not read LP balance — burn it later by sending the pool token to 0x…dEaD", "err");
    if (lp > 0n) await send("burn LP tokens", { to: pairAddr, data: evm.callData(evm.SEL.transfer, ["address", "uint256"], [evm.DEAD, lp]) });
  }

  if (form.renounce) await send("renounce ownership", { to: token, data: sel(build.methods, "renounceOwnership()") });

  return { address: token, image: meta.image, tradable: true, pair: pairAddr };
}

function parseNative(str) {
  const [i, f = ""] = String(str).trim().split(".");
  return BigInt(i || "0") * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18) || "0");
}

// ---------------------------------------------------------------- Solana (Token-2022 + metadata extension)

export async function launchSolana(ctx, form) {
  const { log, wallet, account, owner } = ctx;
  log("network: Solana");
  const meta = await uploadMeta(ctx, form);

  log("loading Solana libraries…");
  const { web3, spl, meta: tm } = await sol.loadSolanaLibs();
  const { PublicKey, Keypair, SystemProgram, Transaction } = web3;

  const payer = new PublicKey(owner);
  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;
  const programId = spl.TOKEN_2022_PROGRAM_ID;
  const decimals = form.decimals;
  const amount = BigInt(form.supply) * 10n ** BigInt(decimals);

  const tokenMeta = { mint, name: form.name, symbol: form.symbol, uri: meta.uri, additionalMetadata: [], updateAuthority: payer };
  const mintLen = spl.getMintLen([spl.ExtensionType.MetadataPointer]);
  const metaLen = spl.TYPE_SIZE + spl.LENGTH_SIZE + tm.pack(tokenMeta).length;
  const lamports = await sol.rpc("getMinimumBalanceForRentExemption", [mintLen + metaLen]);
  const ata = spl.getAssociatedTokenAddressSync(mint, payer, false, programId);
  const fee = feeInNative(ctx, 9);

  const tx = new Transaction();
  if (fee.amount > 0n) {
    tx.add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(fee.wallet), lamports: fee.amount }));
  }
  tx.add(
    SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: mint, space: mintLen, lamports, programId }),
    spl.createInitializeMetadataPointerInstruction(mint, payer, mint, programId),
    spl.createInitializeMintInstruction(mint, decimals, payer, null, programId),
    tm.createInitializeInstruction({
      programId,
      metadata: mint,
      updateAuthority: payer,
      mint,
      mintAuthority: payer,
      name: form.name,
      symbol: form.symbol,
      uri: meta.uri,
    }),
    spl.createAssociatedTokenAccountIdempotentInstruction(payer, ata, payer, mint, programId),
    spl.createMintToInstruction(mint, ata, payer, amount, [], programId)
  );
  if (form.revokeMint) {
    tx.add(spl.createSetAuthorityInstruction(mint, payer, spl.AuthorityType.MintTokens, null, [], programId));
  }

  const { value: bh } = await sol.rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
  tx.recentBlockhash = bh.blockhash;
  tx.feePayer = payer;

  log(`creating ${form.symbol}${fee.amount ? ` (launch fee ${Number(fee.amount) / 1e9} SOL)` : ""} — confirm in wallet`);
  const unsigned = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  const walletSigned = await sol.signBytes(wallet, account, unsigned);

  // Wallet signs first, then the new mint's key adds its signature.
  const signedTx = Transaction.from(walletSigned);
  signedTx.partialSign(mintKp);
  const raw = signedTx.serialize();

  const sig = await sol.rpc("sendTransaction", [sol.bytesToB64(raw), { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 5 }]);
  log(`tx sent <a href="https://solscan.io/tx/${sig}" target="_blank" rel="noopener">${sig.slice(0, 12)}…</a>`);
  await sol.waitSignature(sig);
  const address = mint.toBase58();
  log(`token created: ${address} ✓`, "ok");
  if (form.revokeMint) log("mint authority revoked ✓", "ok");

  await recordLaunch(ctx, { chain: "solana", address, name: form.name, symbol: form.symbol, image: meta.image, tx: sig });
  const poolPct = 100 - form.creatorPct;
  log(`next: keep ${form.creatorPct}% and put the other ${poolPct}% into a SOL pool on Raydium to open trading.`);
  return { address, image: meta.image, tradable: false };
}
