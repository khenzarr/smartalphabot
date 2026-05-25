# Batch Seed Discovery

Use seed-token JSON files to analyze many known winners, aggregate repeated early buyers, and export candidate smart-wallets.

## Input

```json
[
  {
    "chain": "base",
    "tokenAddress": "0x...",
    "label": "EXAMPLE",
    "narrative": "meme",
    "notes": "Known winner token used for discovery"
  }
]
```

## Run

```bash
npm run analyze:seed-batch -- --input data/seed-tokens.example.json --max-buyers 100 --max-hours 6 --csv true --out output/seed-batch
```

Optional wallet enrichment:

```bash
npm run analyze:seed-batch -- --input data/seed-tokens.example.json --enrich-wallets true --max-wallets-to-enrich 25 --wallet-source persisted
```

Optional cross-chain overlap matrix rows:

```bash
npm run analyze:seed-batch -- --input data/seed-tokens.example.json --include-cross-chain-overlap true
```

Focus candidate aggregation on useful seeds only (while still reporting all seeds):

```bash
npm run analyze:seed-batch -- --input data/seed-tokens.example.json --only-useful-seeds true
```

## Outputs

- `batch-summary.json`
- `candidate-wallets.json`
- `candidate-wallets.csv`
- `token-results.json`
- `errors.json`
- `token-buyer-summary.json`
- `token-buyer-summary.csv`
- `candidate-evidence.json`
- `candidate-evidence.csv`
- `wallet-overlap-matrix.json`
- `wallet-overlap-matrix.csv`
- `token-overlap-summary.json`
- `token-overlap-summary.csv`
- `next-seeds.keep.json`
- `next-seeds.drop.json`
- `next-seeds.investigate.json`
- `candidate-shortlist.json`
- `candidate-shortlist.csv`

## Evidence inspection workflow

1) **Token quality first** (`token-buyer-summary.*`)
- Check `buyersFound` / `uniqueBuyersFound`.
- Check warning-heavy tokens with `warningsCount` and `topWarnings`.
- Drop weak seeds (zero buyers / repeated parser warnings).
- If adaptive chunking is triggered, review `adaptiveChunkingUsed`, `chunkReductions`, `failedChunksCount`, and `minChunkSizeReached`.

2) **Candidate reason trace** (`candidate-evidence.*`)
- One row = one wallet-token appearance.
- Inspect `firstBuyRank`, `firstBuyTimestamp`, `buyCount`, and `warnings`.
- For repeated candidates, you should see multiple rows (e.g. PEPE + ASTEROID evidence rows).

3) **Cluster overlap map** (`wallet-overlap-matrix.*`)
- `overlapWalletCount` shows shared early-buyer wallets across token pairs.
- `overlapRateA/B` normalizes overlap by each token’s buyer set.
- `overlapWalletsSample` gives quick spot-check addresses.

4) **Seed usefulness scoring** (`token-overlap-summary.*`)
- `strongestOverlapTokenLabel` / `strongestOverlapCount` identify strongest pair links.
- `usefulnessScore` combines buyers, overlap, and warning penalty for quick triage.
- `seedTriageStatus` / `seedTriageReason` indicate whether a seed should be kept, dropped, or investigated.

## Seed triage statuses

- `keep`: supported parser + buyers found
- `zero_buyers`: supported parser but no buyers found in bounded window
- `dense_pool`: adaptive split guardrail reached (`max_adaptive_splits_reached` / dense scan)
- `unsupported_pool`: parser coverage not currently supported
- `weak_seed`: skipped/non-priority seed for current phase
- `failed`: RPC/provider or execution failure
- `investigate`: ambiguous diagnostics

When `--only-useful-seeds true` is enabled, candidate aggregation only uses `keep` seeds.
All seeds still appear in summaries and output files.

## Seed pool expansion loop

### 1) Normalize manual seed drafts

```bash
npm run seeds:normalize -- --input data/manual-seeds.txt --out data/seed-tokens.expansion.json --default-narrative ethereum_meme
```

Supported input formats:
- `.txt` with chain headings (`ethereum:`, `base:`, `bsc:`)
- `.csv` columns: `chain,tokenAddress,label,narrative,notes`
- `.json` seed arrays

Normalization behavior:
- chain aliases: `eth -> ethereum`, `binance -> bsc`
- validates EVM addresses
- dedupes by `chain + lowercase(tokenAddress)`
- auto-labels missing labels like `ETHEREUM_SEED_001`

### 2) Merge with current keep pool

```bash
npm run seeds:merge -- --base data/seed-tokens.keep.json --add data/seed-tokens.expansion.json --out data/seed-tokens.next.json
```

Merge behavior:
- dedupes by `chain + lowercase(tokenAddress)`
- preserves existing metadata when duplicates exist
- sorts output by chain then label
- writes merge metadata summary (`*.meta.json`)

### 3) Run discovery on next pool

```bash
npm run analyze:seed-batch -- --input data/seed-tokens.next.json --max-buyers 200 --max-hours 24 --min-token-appearances 2 --persist false --csv true --out output/seed-batch-next-v1
```

### 4) Use automatic curation outputs

- `next-seeds.keep.json`: reusable productive seeds
- `next-seeds.drop.json`: weak/unsupported/dense/failed seeds to remove
- `next-seeds.investigate.json`: ambiguous or retry-needed seeds

Recommended actions in curation rows:
- `keep_for_future_batches`
- `drop_from_seed_pool`
- `retry_with_better_rpc`
- `investigate_parser_or_pair_selection`
- `retry_with_wider_window`
- `retry_with_smaller_window`

### 5) Inspect candidate shortlist

Use `candidate-shortlist.*` for operator review before monitoring.

Default shortlist filters:
- `appearances >= 2`
- `score >= 40`
- `averageFirstBuyRank <= 150`

CLI controls:
- `--shortlist-min-appearances`
- `--shortlist-min-score`
- `--shortlist-max-average-rank`
- `--shortlist-include-rejected`

## Current parser coverage note

Active coverage for the discovery loop right now:
- Uniswap V2 compatible
- Uniswap V3 compatible

Diagnostic-only / future coverage (not blocking current discovery loop):
- Aerodrome / Solidly variants
- Uniswap v4 PoolManager
- Algebra
- Solana Raydium / Meteora / Pump.fun

## Notes

- EVM chains only for now: `ethereum`, `base`, `bsc`
- Solana seed-batch discovery is skipped with a warning
- Candidate scoring is evidence-based only; it is **not** full realized PnL yet
- Default `min-token-appearances` is `2`
- Wallet enrichment is optional and defaults to off to keep runs cheap
- Same-chain overlap comparison is default; cross-chain overlap is opt-in (`--include-cross-chain-overlap true`)
- Public RPC providers may reject dense log scans; adaptive chunking helps, but better RPCs or smaller scan windows are still recommended.
- Dense/unproductive pools should be triaged and optionally dropped so they do not block smart-wallet discovery progress.
