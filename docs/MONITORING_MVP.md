# Monitoring MVP (File-Based)

This document describes the monitoring MVP added after discovery.

Scope:

- import candidate wallets from discovery shortlist
- poll recent watched wallet ERC20 incoming transfer activity
- enrich tokens with market profile data
- group activity into monitor signals
- write local artifacts and optionally format/send Telegram alerts

Out of scope:

- trading, copy trading, private keys, signing
- Postgres requirement
- paid API requirement
- Solana monitoring in this pass

Provider stability note:

- For production-like monitoring, use private/free-tier RPC endpoints for Ethereum and Base.
- BSC RPC is optional in this pass.
- Public RPC endpoints can work for MVP but may rate-limit or reject some requests.

## 1) Import candidates

Command:

```bash
npm run monitor:import-candidates -- --input output/seed-batch-auto-keep-wide-v1/candidate-shortlist.csv --out data/monitor-wallets.json --min-appearances 2 --min-score 40 --include-rejected true
```

Input:

- `candidate-shortlist.csv`

Output:

- `data/monitor-wallets.json`
- `data/monitor-wallets.meta.json`

Behavior:

- dedupe by `chain + walletAddress`
- keep discovery fields (score/category/appearances/reasons/risk flags)
- append monitor fields (`source`, `importedAt`, `enabled`, `tags`)

## 2) User watchlist local schema

- `data/user-watchlists.example.json`
- optional local file: `data/user-watchlists.local.json` (gitignored)

This prepares future Telegram wallet management commands.

## 3) Polling watched wallets

Command:

```bash
npm run monitor:poll -- --watchlist data/monitor-wallets.json --chains ethereum,base --max-wallets 20 --ethereum-blocks 100 --base-blocks 300 --out output/monitor-poll-v1 --telegram-dry-run true
```

Provider modes:

- `--activity-provider auto` (default)
- `--activity-provider rpc-addressless`
- `--activity-provider rpc-known-tokens --known-tokens data/monitor-known-tokens.json`
- `--activity-provider explorer`
- `--activity-provider auto-indexer`

Explorer provider options:

- `--explorer-provider auto|blockscout|etherscan`
- `--explorer-max-pages <n>`
- `--explorer-page-size <n>`
- `--max-transfers-per-wallet <n>`

Behavior:

- `auto`: tries `rpc-addressless`; if provider rejects addressless `eth_getLogs`, records warning and falls back to `rpc-known-tokens` when known tokens are configured.
- `rpc-addressless`: generic scan with `eth_getLogs` topics filter and no `address` field.
- `rpc-known-tokens`: per-token scan with `eth_getLogs` including `address: tokenAddress` for public-RPC compatibility.
- `explorer`: fetch wallet transfer history from explorer/indexer APIs and normalize to monitor events.
- `auto-indexer`: tries explorer first; if explorer fails/unavailable, falls back to known-token mode when `--known-tokens` is configured.

Why explorer/indexer mode is needed:

- `rpc-known-tokens` only scans token contracts we already know.
- it cannot discover brand-new/trending contracts first touched by watched wallets.
- public RPCs often reject addressless generic scans (`eth_getLogs` without `address`).
- explorer/indexer APIs provide generic wallet token transfer history without requiring paid infra.

Addressless restriction classification:

- `Please specify an address`
- `address required`
- `eth_getLogs requires address`
- `restricted`
- `order a dedicated full node`

These are classified as `addressless_logs_not_supported`. Poll continues, outputs are still written, and warnings are recorded.

Method:

- bounded `eth_getLogs` windows per EVM chain
- filter incoming ERC20 `Transfer` logs by `topics[2] = watched wallet`
- decode `tokenAddress/from/to/rawAmount/txHash/blockNumber/logIndex`

Guardrails:

- default max wallets per run
- default max logs per wallet
- configurable per-chain block window
- skip disabled wallets

## 4) Signal semantics

Incoming transfer activity is heuristic and not guaranteed buy confirmation.

Each event includes warning labels:

- `incoming_transfer_not_confirmed_buy`
- `requires_dex_context`

Signal wording is intentionally conservative:

- watched wallet token activity
- likely accumulation candidate
- manual review required

## 5) Enrichment + grouping

Enrichment uses DexScreener market provider when available.

Captured profile fields include:

- symbol/name
- priceUsd/marketCap/fdv
- liquidityUsd/volumeH24/priceChangeH24
- pairCreatedAt/tokenAgeSeconds
- dexUrl

Grouping key:

- `chain + tokenAddress`

Signal categories:

- `strong_signal`
- `watch_signal`
- `weak_signal`
- `ignored`

Stablecoins and wrapped native assets are down-ranked/ignored by scoring heuristics.

## 6) Output artifacts

`monitor:poll` writes:

- `events.json`
- `signals.json`
- `signals.csv`
- `monitor-summary.json`

Summary includes:

- provider mode requested/used
- provider fallback used (`true/false`)
- `activityProvider`
- `explorerProvider`
- `explorerRequests`
- `explorerTransfersFetched`
- `explorerFailures`
- `explorerFailuresByChain`
- `explorerWarnings`
- `fallbackUsed`
- `sourceBreakdown` (`rpc-known-tokens`, `rpc-addressless`, `explorer`)
- chains scanned
- wallets scanned
- wallet scan failures
- addressless logs supported (`true/false/unknown`)
- known tokens count (when used)
- watched wallets scanned
- events found
- token groups found
- strong/watch/weak/ignored counts
- warnings
- output file paths

## 7) Telegram modes

Dry-run only formatting:

- `--telegram-dry-run true`
- prints formatted messages to console

Optional send mode:

- `--send-telegram true --telegram-chat-id <CHAT_ID>`
- requires `TELEGRAM_BOT_TOKEN`
- sends only strong/watch signals by default
- applies basic rate limiting

## 8) Signal dedupe

Local state file:

- `data/monitor-sent-signals.local.json` (gitignored)

Dedupe key:

- `chain + tokenAddress + sorted watchedWallets + time bucket`

Default time bucket:

- 30 minutes

## 9) Limitations

- incoming transfers can be buy/airdrop/claim/router/spam movement
- RPC-only method can miss complex DEX flow context
- public RPCs often reject addressless `eth_getLogs`; generic monitoring should use indexer/API provider for production
- explorer/indexer APIs can be rate-limited (`explorer_rate_limited`)
- explorer transfer history can lag behind chain head
- explorer events are still heuristic until tx-context confirms likely buy
- no execution/trading path is implemented
- manual review remains mandatory

## 10) Known-token helper

Build known-token list from seed-batch summary CSV:

```bash
npm run monitor:build-known-tokens -- --seed-summary output/seed-batch-auto-keep-wide-v1/token-buyer-summary.csv --out data/monitor-known-tokens.json --only-keep true
```

Input filter used by helper:

- `status = success`
- `seedTriageStatus = keep` (when `--only-keep true`)
- token address present

Writes:

- `data/monitor-known-tokens.json`
- `data/monitor-known-tokens.meta.json`

## 11) Next phase

- DEX-context buy classification
- better anti-spam filtering
- improved provider/indexer strategy
- DB persistence for monitor history
- Telegram user watchlist commands
