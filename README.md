## Auto Discovery (Fast + Observable Defaults)

Run:

`npm run discovery:auto -- --target-count 30 --include-query-discovery true --batch-max-buyers 50 --batch-max-hours 6 --max-per-query 10`

### Default public-RPC-safe behavior

- `--target-count 30`
- `--batch-max-buyers 50`
- `--batch-max-hours 6`
- `--batch-min-appearances 2`
- `--max-per-query 10`
- `--max-query-seconds 20`
- `--max-total-seconds 1800`
- `--only-useful-seeds true`

### Progress visibility

`discovery:auto`, `seeds:auto-expand`, and `discovery:auto-run` now print stage progress, including:

- start of auto discovery and auto expansion
- profile stage (`strict`, `moderate`, `loose`)
- query fallback progress (`query i/n` + query text)
- candidates found so far
- seed batch start + parameters + output directory

### Guardrail options

- `--skip-batch true|false`
- `--batch-max-buyers <n>`
- `--batch-max-hours <n>`
- `--batch-min-appearances <n>`
- `--only-useful-seeds true|false`
- `--max-query-seconds <n>`
- `--max-total-seconds <n>`
- `--max-per-query <n>`
- `--target-count <n>`
- `--queries <comma,separated,list>`
- `--min-liquidity <n>`
- `--min-market-cap <n>`
- `--min-volume-h24 <n>`

### Expanded default query pack

Built-in default query pack is now expanded for broader narrative coverage (memecoin + momentum + narrative terms), and is used automatically unless `--queries` is provided.

# SmartBot Foundation

Multi-chain Telegram signal bot foundation for early smart-wallet analytics.

## Implemented (current)

- EVM early-buyer extraction
- Seed-batch discovery and candidate aggregation
- DexScreener seed-token discovery helper
- Wallet historical analysis (approximate PnL)
- Wallet scoring integration
- Optional candidate wallet enrichment during seed-batch
- Mock and persisted wallet trade sources
- CLI reports + JSON/CSV output

## Not implemented yet

- Solana wallet historical PnL
- Copy trading
- Private key storage
- Transaction signing
- Realtime Telegram alerting loop

## Monitoring MVP (file-based, no DB required)

This pass adds a monitoring-first flow using discovery candidates as watchlist input.

### 1) Import candidates to monitor watchlist

```bash
npm run monitor:import-candidates -- --input output/seed-batch-auto-keep-wide-v1/candidate-shortlist.csv --out data/monitor-wallets.json --min-appearances 2 --min-score 40 --include-rejected true
```

Writes:

- `data/monitor-wallets.json`
- `data/monitor-wallets.meta.json`

### 2) Poll recent watched-wallet token activity

```bash
npm run monitor:poll -- --watchlist data/monitor-wallets.json --chains ethereum,base --max-wallets 20 --ethereum-blocks 100 --base-blocks 300 --out output/monitor-poll-v1 --telegram-dry-run true
```

Provider strategy options:

- `--activity-provider auto` (default): try `rpc-addressless`, fallback to known-tokens mode when available
- `--activity-provider rpc-addressless`: generic addressless `eth_getLogs` scan (may be rejected on public RPC)
- `--activity-provider rpc-known-tokens`: token-address filtered scan (`eth_getLogs` with `address`) for public RPC compatibility
- `--activity-provider explorer`: use explorer/indexer APIs for generic wallet transfer monitoring
- `--activity-provider auto-indexer`: try explorer first; if unavailable fallback to known-token mode when configured

Explorer provider options:

- `--explorer-provider auto|blockscout|etherscan`
- `--explorer-max-pages <n>`
- `--explorer-page-size <n>`
- `--max-transfers-per-wallet <n>`

Recommended Base-first generic monitoring:

```bash
npm run monitor:poll -- --watchlist data/monitor-wallets.json --chains base,ethereum --activity-provider explorer --explorer-provider blockscout --max-wallets 20 --explorer-max-pages 2 --explorer-page-size 50 --max-transfers-per-wallet 100 --out output/monitor-poll-explorer-v1 --telegram-dry-run true --tx-context true --max-tx-context-lookups 50
```

Optional known-token file (required for `rpc-known-tokens`):

```bash
--known-tokens data/monitor-known-tokens.json
```

If your RPC rejects addressless logs with errors like `Please specify an address` or `order a dedicated full node`, poll now completes gracefully and writes outputs with warnings instead of crashing.

Build a known-token list from seed outputs:

```bash
npm run monitor:build-known-tokens -- --seed-summary output/seed-batch-auto-keep-wide-v1/token-buyer-summary.csv --out data/monitor-known-tokens.json --only-keep true
```

Then run known-token monitoring mode:

```bash
npm run monitor:poll -- --watchlist data/monitor-wallets.json --chains ethereum,base --activity-provider rpc-known-tokens --known-tokens data/monitor-known-tokens.json --max-wallets 20 --ethereum-blocks 100 --base-blocks 300 --out output/monitor-poll-known-tokens-v1 --telegram-dry-run true
```

Writes:

- `output/monitor-poll-v1/events.json`
- `output/monitor-poll-v1/signals.json`
- `output/monitor-poll-v1/signals.csv`
- `output/monitor-poll-v1/monitor-summary.json`

### 3) Optional guarded Telegram sending

By default, poll does not send Telegram messages.

To enable sending for `strong_signal` + `watch_signal`:

- set `TELEGRAM_BOT_TOKEN` in `.env`
- pass `--send-telegram true --telegram-chat-id <CHAT_ID>`

### 4) Local state files

- `data/user-watchlists.example.json` (sample schema)
- `data/user-watchlists.local.json` (local, gitignored)
- `data/monitor-sent-signals.local.json` (dedupe state, gitignored)

### Monitoring limitations

- Incoming ERC20 transfer activity is **not guaranteed buy confirmation**.
- RPC-only `eth_getLogs` heuristics can miss complex swap routes.
- Public RPC providers may reject addressless `eth_getLogs`; use known-token mode or an indexer/API provider.
- `rpc-known-tokens` cannot discover brand-new tokens unless they are already in your known-token set.
- Explorer APIs can be rate-limited and may lag slightly behind chain head.
- Spam/airdrop/router movements can appear.
- Manual review is required before acting on any signal.

## Operator quickstart

1) Install dependencies

```bash
npm install
```

2) Configure `.env`

- Set EVM RPC URLs for chains you will analyze (`ETHEREUM_RPC_URL`, `BSC_RPC_URL`, `BASE_RPC_URL`).
- Set `DATABASE_URL` only if you want persisted workflows.

3) Analyze a single token

```bash
npm run analyze:token -- --chain base --token 0x... --max-buyers 100 --max-hours 6 --persist false --json false --out output/base-token
```

4) Run seed batch

```bash
npm run analyze:seed-batch -- --input data/seed-tokens.example.json --max-buyers 100 --max-hours 6 --min-token-appearances 2 --persist false --csv true --out output/seed-batch
```

## Fast bootstrap (automated seed expansion + discovery)

If you want to skip manual contract hunting for now, run:

```bash
npm run discovery:auto
```

This command does two steps:

1. `seeds:auto-expand`
   - starts from `data/seed-tokens.keep.json`
   - runs DexScreener discovery with staged profiles: `strict -> moderate -> loose`
   - falls back to query-based search (`search_queries`) when profile discovery is too small
   - filters invalid/low-quality candidates
   - writes:
     - `data/seed-tokens.auto-discovered.json`
     - `data/seed-tokens.auto-next.json`
     - `data/seed-tokens.auto-next.meta.json`
     - `output/auto-seed-expansion/auto-expansion-report.json`

2. `discovery:auto-run`
   - runs seed batch from `data/seed-tokens.auto-next.json`
   - writes full discovery artifacts in `output/discovery-auto-v1`
   - includes:
     - `candidate-shortlist.csv`
     - `next-seeds.keep.json`
     - `next-seeds.drop.json`
     - `next-seeds.investigate.json`

If candidate count is low, treat this as a bootstrap pass and then improve inputs (custom queries, manual curated seeds later, stronger market data coverage, or looser filters).

### Query fallback controls

`seeds:auto-expand` and `discovery:auto` support:

```bash
--include-query-discovery true
--queries pepe,wojak,cult,mog,turbo,neiro,ai,agent
--max-per-query 10
--target-count 30
```

Defaults:

- `include-query-discovery=true`
- built-in query pack used when `--queries` is omitted
- `max-per-query=10`

Inspect these outputs after a run:

- `data/seed-tokens.auto-discovered.json`
- `candidate-shortlist.csv`
- `output/auto-seed-expansion/auto-expansion-report.json`

Recommended fast workflow:

1. `npm run discovery:auto`
2. inspect `data/seed-tokens.auto-discovered.json`
3. inspect `candidate-shortlist.csv`
4. rerun with custom queries if candidate count is low

4.5) Discover seed tokens from DexScreener

```bash
npm run discover:seeds -- --chains ethereum,base,bsc --limit 30 --min-market-cap 1000000 --min-liquidity 100000 --min-volume-h24 100000 --out data/seed-tokens.generated.json
```

Then feed the generated file into seed-batch:

```bash
npm run analyze:seed-batch -- --input data/seed-tokens.generated.json --max-buyers 100 --max-hours 6 --min-token-appearances 2 --persist false --csv true --out output/generated-seed-batch
```

5) Analyze a wallet

```bash
npm run analyze:wallet -- --chain base --wallet 0x... --source persisted --enrich-prices true --json false
```

6) Run enriched seed batch

```bash
npm run analyze:seed-batch -- --input data/seed-tokens.example.json --max-buyers 100 --min-token-appearances 2 --enrich-wallets true --max-wallets-to-enrich 25 --wallet-source persisted --csv true --out output/enriched-seed-batch
```

7) Where outputs are written

With `--out <dir>`, commands produce JSON/CSV artifacts plus `output-index.json` for programmatic inspection.

Wallet analysis writes:

- `wallet-analysis.json`
- `wallet-token-performances.csv`
- `output-index.json`

Seed batch writes:

- `batch-summary.json`
- `candidate-wallets.json`
- `candidate-wallets.csv` (if `--csv true`)
- `token-results.json`
- `errors.json`
- `token-buyer-summary.json`
- `token-buyer-summary.csv` (if `--csv true`)
- `candidate-evidence.json`
- `candidate-evidence.csv` (if `--csv true`)
- `wallet-overlap-matrix.json`
- `wallet-overlap-matrix.csv` (if `--csv true`)
- `token-overlap-summary.json`
- `token-overlap-summary.csv` (if `--csv true`)
- `next-seeds.keep.json`
- `next-seeds.drop.json`
- `next-seeds.investigate.json`
- `candidate-shortlist.json`
- `candidate-shortlist.csv` (if `--csv true`)
- `output-index.json`

### Seed pool expansion workflow

1) Normalize manual seed drafts (`.txt/.csv/.json`) into clean seed JSON:

```bash
npm run seeds:normalize -- --input data/manual-seeds.txt --out data/seed-tokens.expansion.json --default-narrative ethereum_meme
```

2) Merge with current keep pool:

```bash
npm run seeds:merge -- --base data/seed-tokens.keep.json --add data/seed-tokens.expansion.json --out data/seed-tokens.next.json
```

3) Run batch discovery on merged seeds:

```bash
npm run analyze:seed-batch -- --input data/seed-tokens.next.json --max-buyers 200 --max-hours 24 --min-token-appearances 2 --persist false --csv true --out output/seed-batch-next-v1
```

Use `next-seeds.keep/drop/investigate` to curate the next cycle. Use `candidate-shortlist.*` as an operator review list for monitoring candidates (analytics only; not investment advice).

### New automation scripts

- `npm run seeds:auto-expand`
- `npm run discovery:auto-run`
- `npm run discovery:auto`

`discovery:auto` is the recommended first command to accelerate from small curated keep seeds without manual CA hunting.

### Seed-batch evidence quick inspection

After running `analyze:seed-batch`, use these files for operator review:

- `token-buyer-summary.*`: token-level quality (buyers count, scan coverage, warning density)
- `candidate-evidence.*`: per wallet-token evidence rows explaining why a wallet appears
- `wallet-overlap-matrix.*`: token-pair overlap counts/rates for shared early-buyer clusters
- `token-overlap-summary.*`: strongest overlap partner + deterministic usefulness score per token

For cross-chain overlap rows in the matrix, opt in explicitly:

```bash
npm run analyze:seed-batch -- --input data/seed-tokens.example.json --include-cross-chain-overlap true
```

DexScreener seed discovery writes:

- `seed-tokens.generated.json`
- `seed-tokens.generated.meta.json`
- `output-index.json`

8) Known limitations

- PnL is approximate and depends on available historical/current USD fields.
- Seed-batch scoring is evidence-based unless wallet enrichment is enabled.
- Solana wallet historical PnL is not implemented.
- This project is analytics only (no copy trading, no private keys, no signing).

Default behavior keeps runs cheap: `--enrich-wallets` defaults to `false`.












