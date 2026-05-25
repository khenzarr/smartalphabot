## Auto Discovery Validation (Fast / Observable)

Recommended command:

`npm run discovery:auto -- --target-count 30 --include-query-discovery true --batch-max-buyers 50 --batch-max-hours 6 --max-per-query 10`

### What to verify in logs

- stage transitions are visible (no long silent periods)
- profile discovery logs (`strict`, `moderate`, `loose`)
- query fallback logs (`query i/n`, text)
- candidates found so far counter advances
- batch stage start/finish is printed

### Timeout/guardrail checks

Validate these flags work and produce partial output on timeout:

- `--max-query-seconds`
- `--max-total-seconds`
- `--skip-batch`
- `--batch-max-buyers`
- `--batch-max-hours`
- `--batch-min-appearances`
- `--only-useful-seeds`

### If auto discovered count is low

1. Retry with custom broader queries (`--queries ...`)
2. Validate RPC stability and rate limits
3. Keep `target-count` realistic for current data coverage
4. Add curated manual seeds later

### If candidate count is low

1. Use stable RPC endpoints
2. Run wider batch window (`--batch-max-hours`, `--batch-max-buyers`)
3. Keep `--only-useful-seeds true`
4. Add curated keep-seed set and rerun

### If RPC timeouts occur

1. Keep guardrail limits enabled
2. Retry from last generated seed file (`data/seed-tokens.auto-next.json`)
3. Reduce run width temporarily, then scale up gradually

### If too many seeds are dropped

1. Inspect `next-seeds.drop.json` reasons
2. Check chain/parser support and liquidity quality
3. Improve input seed quality before increasing run size

# Real Data Validation Checklist

Use this checklist before moving to realtime Telegram alerts.

## 1) Required environment variables

- EVM RPC URLs (at least for chains you test):
  - `ETHEREUM_RPC_URL`
  - `BSC_RPC_URL`
  - `BASE_RPC_URL`
- Optional market data integrations if configured in your environment.
- `DATABASE_URL` (required only when using persisted mode / persistence).

## 2) Recommended first commands

Fast bootstrap (no manual seed hunting required initially):

```bash
npm run discovery:auto
```

This runs automated seed expansion and then seed-batch discovery in one command.
It now includes query-based fallback if the profile-based expansion is too small.

Analyze one Base token:

```bash
npm run analyze:token -- --chain base --token 0x... --max-buyers 100 --max-hours 6 --persist false --json false --out output/base-token-test
```

Analyze one BSC token:

```bash
npm run analyze:token -- --chain bsc --token 0x... --max-buyers 100 --max-hours 6 --persist false --json false --out output/bsc-token-test
```

Run seed batch without persistence:

```bash
npm run analyze:seed-batch -- --input data/seed-tokens.local.json --max-buyers 100 --max-hours 6 --min-token-appearances 2 --persist false --csv false --out output/seed-batch-no-persist
```

Run seed batch with CSV output:

```bash
npm run analyze:seed-batch -- --input data/seed-tokens.local.json --max-buyers 100 --max-hours 6 --min-token-appearances 2 --persist false --csv true --out output/seed-batch-csv
```

Direct automation steps (if you want to run separately):

```bash
npm run seeds:auto-expand
npm run discovery:auto-run
```

Custom query example:

```bash
npm run seeds:auto-expand -- --base data/seed-tokens.keep.json --out data/seed-tokens.auto-next.json --target-count 30 --include-query-discovery true --queries pepe,wojak,cult,mog,turbo,neiro,ai,agent
```

Discover DexScreener seed candidates:

```bash
npm run discover:seeds -- --chains ethereum,base,bsc --limit 30 --min-market-cap 1000000 --min-liquidity 100000 --min-volume-h24 100000 --out data/seed-tokens.generated.json
```

Then run seed batch on the generated file:

```bash
npm run analyze:seed-batch -- --input data/seed-tokens.generated.json --max-buyers 100 --max-hours 6 --min-token-appearances 2 --persist false --csv true --out output/generated-seed-batch
```

Analyze one candidate wallet from persisted trades:

```bash
npm run analyze:wallet -- --chain base --wallet 0x... --source persisted --json false --out output/persisted-wallet-analysis
```

Run candidate enrichment:

```bash
npm run analyze:seed-batch -- --input data/seed-tokens.local.json --max-buyers 100 --min-token-appearances 2 --enrich-wallets true --max-wallets-to-enrich 25 --wallet-source persisted --csv true --out output/enriched-seed-batch
```

## 3) What to inspect in outputs

- Unsupported pool warnings.
- Zero-buyer results for specific tokens.
- Missing USD warnings in wallet analysis / enrichment outputs.
- Duplicated wallets across seed tokens.
- Candidate ranking quality (appearances, ranks, warnings).
- Enriched PnL fields in candidate outputs.
- DexScreener helper output shape and warnings.
- Dense RPC log ranges: look for adaptive chunking warnings (`rpc_log_range_too_dense`, `adaptive_chunking_used`, `chunk_reduced`).
- If `min_chunk_size_reached` appears, lower `--max-hours` / `--max-buyers` or use a better RPC provider.
- For fast bootstrap runs, inspect `candidate-shortlist.csv`, `next-seeds.keep.json`, `next-seeds.drop.json`, `next-seeds.investigate.json` first.
- For auto expansion, inspect `data/seed-tokens.auto-discovered.json` and `output/auto-seed-expansion/auto-expansion-report.json`.
- If query discovery is thin, rerun with custom queries or looser filters.

### Seed-batch evidence files (new)

- `token-buyer-summary.json/csv`
  - Verify which tokens actually produced buyers (`buyersFound`).
  - Identify weak seeds quickly (`buyersFound=0`, high `warningsCount`).
  - Inspect scanner coverage (`scanFromBlock`, `scanToBlock`, `logsScanned`, `tradesExtracted`).
  - Inspect adaptive fields when present (`adaptiveChunkingUsed`, `chunkReductions`, `failedChunksCount`, `minChunkSizeReached`).

- `candidate-evidence.json/csv`
  - One row per wallet-token appearance.
  - Validate repeated-candidate reasoning via `tokenLabel`, `firstBuyRank`, `firstBuyTimestamp`, and `warnings`.

- `wallet-overlap-matrix.json/csv`
  - Check pairwise shared early buyers (`overlapWalletCount`).
  - Use `overlapRateA/B` to compare relative overlap strength.
  - By default, overlap is same-chain only; enable cross-chain explicitly if needed.

- `token-overlap-summary.json/csv`
  - Review token usefulness at a glance.
  - Confirm strongest overlap links (`strongestOverlapTokenLabel`, `strongestOverlapCount`).
  - Use `usefulnessScore` for deterministic seed triage.

## 4) Good signs

- Non-zero buyers on at least part of tested tokens.
- Repeated wallets across multiple seed tokens.
- Clean CSV exports (correct headers/escaping, no malformed rows).
- Evidence outputs make candidate and token quality easy to inspect without manual JSON grep.
- Warnings are understandable and actionable.
- Commands continue safely on unsupported pools (no crashes).

## 5) Bad signs

- All pools unsupported for the selected seed set.
- All candidates only appear in one token (weak evidence set).
- Missing `DATABASE_URL` when persistence is expected.
- Excessive scan windows causing slow/expensive runs.
- `auto_discovered_seed_count_low` warning and/or no seed growth in auto expansion.
- `insufficient_auto_discovered_candidates` warning from query fallback.
- Candidate count = 0 after auto run.

If candidate count is 0:
- add manual curated seeds later,
- use custom queries,
- use stable RPC,
- retry with larger `--max-hours`,
- lower `--min-token-appearances` only for debugging.

## 6) Safety reminders

- No private keys are required.
- No copy trading is implemented.
- This system is analytics only, not financial advice.
