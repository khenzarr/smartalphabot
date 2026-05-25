# DexScreener Seed Token Discovery Helper

This helper discovers additional **seed token candidates** from DexScreener discovery-style endpoints and exports a seed JSON file compatible with `analyze:seed-batch`.

> This is an operator utility only. It is not trading automation.

## Safety and scope

- No private keys
- No transaction signing
- No copy-trading execution
- No Telegram alert loop here
- Analytics-only helper for preparing seed inputs

## Data sources

The helper collects token candidates from:

- `latest token profiles`
- `latest token boosts`
- `top token boosts`

Then it fetches token pair market data and ranks candidates locally.

## Supported chains

- `ethereum`
- `base`
- `bsc`

Solana is intentionally excluded in this helper for now.

## Command

```bash
npm run discover:seeds -- --chains ethereum,base,bsc --limit 30 --out data/seed-tokens.generated.json
```

Useful filters:

```bash
npm run discover:seeds -- --chains ethereum,base,bsc --limit 30 --min-market-cap 1000000 --min-liquidity 100000 --min-volume-h24 100000 --min-price-change-h24 0 --max-age-days 3650 --out data/seed-tokens.generated.json
```

## Output files

If `--out data/seed-tokens.generated.json` is used, the helper writes:

- `data/seed-tokens.generated.json`
- `data/seed-tokens.generated.meta.json`
- `data/output-index.json`

Seed file format (compatible with `analyze:seed-batch`):

```json
[
  {
    "chain": "base",
    "tokenAddress": "0x...",
    "label": "SYMBOL",
    "narrative": "dexscreener_discovered",
    "notes": "Discovered via DexScreener seed helper. marketCap=..., h24=..., liquidity=..."
  }
]
```

## Ranking logic

Candidates are scored by:

- higher market cap (or FDV fallback with warning)
- higher 24h price change
- higher liquidity
- higher 24h volume
- pair creation timestamp presence
- fewer warnings

## Limitations

- DexScreener endpoint coverage may change over time.
- Missing fields are common (`priceChange.h24`, `marketCap`) and are handled with warnings/fallbacks.
- This helper ranks by current snapshot metrics, not full historical wallet performance.

## Next step

After generating seeds, run:

```bash
npm run analyze:seed-batch -- --input data/seed-tokens.generated.json --max-buyers 100 --max-hours 6 --min-token-appearances 2 --persist false --csv true --out output/generated-seed-batch
```
