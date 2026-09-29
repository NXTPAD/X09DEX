# X09 DEX

Swap any token on **Solana + 8 EVM chains**, explore trending/new coins, and **launch tokens** — all in the X09 black-and-white terminal style. Lives at **dex.x09hub.com**.

- **Swap** — Solana via Jupiter (best price across Jupiter, JupiterZ, DFlow, OKX). EVM via KyberSwap on Ethereum, Base, Arbitrum, BNB Chain, Polygon, Optimism, Avalanche and Robinhood Chain.
- **Your fee** — `FEE_BPS` (default 0.5%) is added to every swap and paid straight to your wallets on-chain.
- **Explore** — trending, new pairs, search, and "Launched on X09" for every chain (GeckoTerminal data). Click any row to trade it.
- **Launch** — EVM: deploys a fixed-supply token, adds Uniswap/PancakeSwap V2 liquidity, anti-snipe max-wallet window, burns LP, optional renounce. Solana: Token-2022 token with on-chain metadata, revoked mint authority. $1 launch fee (configurable) in the chain's native coin.
- **Non-custodial** — users connect Phantom/Solflare/Backpack/Jupiter (Solana) or MetaMask/Coinbase/Rabby/etc. (EVM). Nothing is ever signed on the server.

## Locked access (developer code)

The whole site is locked behind a developer code. Visitors see a lock screen; entering the code unlocks that browser for 30 days.

- **Set the code:** Cloudflare → Workers → `x09-dex` → Settings → Variables and Secrets → add `DEV_CODE` as a **Secret**. Until it's set, nobody can unlock.
- **Change the code:** update `DEV_CODE` — every device is signed out.
- **Lock this device again:** visit `/__dev/lock`.
- Wrong codes are limited to 10 per IP per 15 minutes.
- Signing in to X09 Hub with an account in the Hub's `X09_OWNER_EMAILS` secret also gets you in.
- `/meta/…` (token logos and metadata) stays public so launched tokens still display in wallets and explorers.

## Deploy (GitHub + Cloudflare Workers)

1. Cloudflare dashboard → **Workers & Pages → Create → Import a repository** → pick this repo.
2. Deploy command: `npm run deploy` (build command empty). The build step finds or creates the `x09-dex-kv` storage namespace by itself.
3. Add your fee wallets in `wrangler.jsonc` → `vars` (or dashboard → Worker → Settings → Variables): `EVM_FEE_WALLET`, `SOL_FEE_WALLET`, `JUP_REFERRAL_ACCOUNT` (below).
4. `dex.x09hub.com` is already in `routes` and attaches on deploy, since x09hub.com is on your Cloudflare account.

### Solana swap fees (one-time, ~2 minutes)

Jupiter pays integrator fees through its Referral Program:

1. Go to **referral.jup.ag**, connect your Solana wallet, create a referral account under the **Jupiter Ultra** project.
2. Create fee token accounts for **SOL** and **USDC** (add USDT too if you like). Fees in a mint without an account are simply skipped for that swap.
3. Paste the referral account address into `JUP_REFERRAL_ACCOUNT`.

Jupiter keeps 20% of your Solana fee and requires 0.5%–2.55%, so Solana is clamped to that range.

### Strongly recommended secrets

Set with `npx wrangler secret put NAME` or dashboard → Settings → Variables → *Encrypt*:

| Secret | Why |
| --- | --- |
| `JUP_API_KEY` | Free key at developers.jup.ag/portal. Without it Jupiter allows only 0.5 requests/sec shared by all your users. |
| `SOLANA_RPC` | A Helius/QuickNode/Triton URL. The public Solana RPC rate-limits hard. |
| `RPC_BASE`, `RPC_ETHEREUM`, … | Optional private RPC per EVM chain (names: `RPC_` + chain key in caps). |
| `KYBER_API_KEY` | Optional — KyberSwap's gateway with higher limits. |

## Config reference (`vars`)

| Var | Default | Meaning |
| --- | --- | --- |
| `FEE_BPS` | `50` | Swap fee in basis points (50 = 0.5%). EVM max 300. |
| `LAUNCH_FEE_USD` | `1` | Launch fee in USD, charged in the native coin. `0` = free. |
| `KYBER_CLIENT_ID` | `X09DEX` | Identifies you to KyberSwap. |
| `PUBLIC_ORIGIN` | `https://dex.x09hub.com` | Used in token metadata links. |

## How the launch works

**EVM** (`contracts/X09Token.sol`, compiled in the user's browser with the official Solidity 0.8.26 compiler, then cached):
1. Deploy — whole supply minted to the creator, launch fee forwarded to `EVM_FEE_WALLET` in the same transaction.
2. Creator allocation: the creator keeps 0–50% of supply; the rest goes into the pool. Approve + `addLiquidityETH` on Uniswap V2 (PancakeSwap V2 on BNB Chain).
3. `openTrading(pair)` — trading can never be closed again. Anti-sniper: buys from the pool are refused for the first 0–5 blocks, then for the chosen time no wallet can hold more than the max-wallet %.
4. Optional: burn LP to `0x…dEaD`, renounce ownership.

No taxes, no blacklist, no pause, no mint. Robinhood Chain has no verified V2 router yet, so launches there deploy the token with trading open and the creator adds liquidity elsewhere.

**Solana**: one transaction creates a Token-2022 mint with on-chain name/ticker/metadata URI, mints the supply to the creator, and revokes mint authority. The creator then opens a SOL pool on Raydium (link shown after launch); Jupiter routes to it automatically.

Logos and socials are stored in KV and served from `dex.x09hub.com/meta/…`.

## Test before announcing

Do one small real run per chain you care about: a $5 swap on Solana and on Base, and one test launch on Base with 0.001 ETH liquidity. Check the fee landed in your wallet.

## Files

```
src/worker.js        API: quotes, swap relay, explore, metadata, launch registry
src/chains.js        chain list, tokens, routers
public/index.html    app shell
public/app.js        UI: swap, explore, launch, wallets, starfield
public/lib/*.js      EVM + Solana helpers, launch flows
public/solc-worker.js  in-browser Solidity compiler
contracts/X09Token.sol launch token contract (also served at /contracts/X09Token.sol)
```
