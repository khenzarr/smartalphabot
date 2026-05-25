## Fast Auto Mode (Public RPC Safe Defaults)

Primary command:

`npm run discovery:auto -- --target-count 30 --include-query-discovery true --batch-max-buyers 50 --batch-max-hours 6 --max-per-query 10`

### Observability

Auto workflows now print stage-by-stage progress:

- auto discovery start
- base seed loading
- profile discovery phase (`strict`, `moderate`, `loose`)
- query fallback start
- per-query progress (`query i/n`, query text)
- cumulative candidates found
- batch start/finish + output directory

### Timeout and guardrails

Use:

- `--max-query-seconds`
- `--max-total-seconds`
- `--target-count`
- `--skip-batch`
- `--batch-max-buyers`
- `--batch-max-hours`
- `--batch-min-appearances`
- `--only-useful-seeds`

If a stage times out, partial output is still written and warnings include the next recommended command.

### Expanded default query pack

If `--queries` is not provided, built-in expanded narrative terms are used by default.

Use custom query override:

`--queries pepe,wojak,cult,mog,turbo,neiro,agent,agents,virtual,aixbt,goat,meme,base meme,bsc meme`

# Seed Pool Expansion Workflow

Goal: scale discovery from a tiny clean seed set toward larger curated pools while keeping candidate quality high.

## Why this workflow exists

- Raw seed count alone is not enough.
- Weak, unsupported, dense, or noisy seeds can dilute candidate quality.
- Productive discovery comes from repeated early-buyer clusters across high-signal seeds.

## Current coverage

Active parser coverage in this phase:
- Uniswap V2 compatible pools
- Uniswap V3 compatible pools

Future parser coverage (not required in this pass):
- Aerodrome / Solidly variants
- Uniswap v4
- Algebra
- Solana ecosystems

## Step 1: Add manual seeds

Prepare a rough file in `.txt`, `.csv`, or `.json`.

Manual contract hunting is optional for the fast bootstrap path. If you want to skip it, start with:

```bash
npm run discovery:auto
```

That command automatically expands the seed pool from `data/seed-tokens.keep.json`, then runs the seed batch on the merged next-seed file.

It now uses query-based fallback (`search_queries`) when profile discovery does not reach the target. Use custom queries when the default narrative pack is too narrow.

### Example text format

```text
ethereum:
0x...
0x...

base:
0x...
0x...
```

### Example CSV format

```text
chain,tokenAddress,label,narrative,notes
ethereum,0x...,PEPE,meme,known winner
base,0x...,BRETT,meme,high attention
```

## Step 2: Normalize rough seeds

```bash
npm run seeds:normalize -- --input data/manual-seeds.txt --out data/seed-tokens.expansion.json --default-narrative ethereum_meme
```

Normalization behavior:
- chain aliases normalize (`eth -> ethereum`, `binance -> bsc`)
- EVM addresses validated
- dedupe by `chain + lowercase(tokenAddress)`
- labels preserved when present
- fallback labels generated (`ETHEREUM_SEED_001`, etc.)
- invalid lines reported as warnings

## Step 3: Merge with keep pool

```bash
npm run seeds:merge -- --base data/seed-tokens.keep.json --add data/seed-tokens.expansion.json --out data/seed-tokens.next.json
```

Merge behavior:
- dedupe by `chain + lowercase(tokenAddress)`
- existing metadata preserved on duplicates
- new seeds appended
- sorted by chain then label
- summary metadata written to `*.meta.json`

## Step 4: Run seed batch discovery

```bash
npm run analyze:seed-batch -- --input data/seed-tokens.next.json --max-buyers 200 --max-hours 24 --min-token-appearances 2 --persist false --csv true --out output/seed-batch-next-v1
```

Fast path equivalent:

```bash
npm run discovery:auto
```

Outputs to inspect after the fast path:
- `candidate-shortlist.csv`
- `next-seeds.keep.json`
- `next-seeds.drop.json`
- `next-seeds.investigate.json`

Also inspect:
- `data/seed-tokens.auto-discovered.json`
- `output/auto-seed-expansion/auto-expansion-report.json`

Query controls:

```bash
npm run seeds:auto-expand -- --base data/seed-tokens.keep.json --out data/seed-tokens.auto-next.json --target-count 30 --include-query-discovery true --queries pepe,wojak,cult,mog,turbo,neiro,ai,agent
```

Why query-based discovery is lower quality:
- it is broader and less curated than historical winner lists
- search results can be noisy or thin on liquidity
- it is a fallback/bootstrap path, not a replacement for curated seeds

## Step 5: Curate seeds for next cycle

After each run, use:
- `next-seeds.keep.json`
- `next-seeds.drop.json`
- `next-seeds.investigate.json`

Meaning:
- **keep**: productive supported seeds
- **drop**: zero-buyer / unsupported / dense / weak / failed seeds with clear low utility
- **investigate**: ambiguous diagnostics, retry-needed RPC/parser/window issues

Recommended action values:
- `keep_for_future_batches`
- `drop_from_seed_pool`
- `retry_with_better_rpc`
- `investigate_parser_or_pair_selection`
- `retry_with_wider_window`
- `retry_with_smaller_window`

## Step 6: Review candidate shortlist

Review:
- `candidate-shortlist.json`
- `candidate-shortlist.csv`

Default shortlist thresholds:
- appearances >= 2
- score >= 40
- average first-buy rank <= 150

Recommendation labels:
- `monitor_candidate`
- `watch_after_pnl_enrichment`
- `ignore_low_sample`
- `investigate_high_activity`

This shortlist is analytics guidance only (not investment advice).

## Recommended scaling path

1. Start with ~6 clean seeds
2. Expand to 30–50 clean curated seeds
3. Expand to 100+ clean curated seeds
4. Add PnL enrichment to prioritize true smart wallets
5. Activate Telegram monitoring on high-conviction candidates

Automation note: automated expansion is a fast bootstrap, but curated historical winner seeds are still higher quality. Use manual hunting later if the auto-discovered set is too small or noisy.
