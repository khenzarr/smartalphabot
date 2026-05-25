# Smart Wallet Scoring

V1 score evaluates sample size, early success repeatability, pnl, win rate, ROI, hold quality, rug exposure, suspicious flags.

## Wallet analysis inputs

Historical wallet analysis feeds the score model with approximate realized/unrealized PnL, win rate, ROI, and hold duration.
Results are intentionally conservative and may omit unrealized PnL when current price data is missing.

## Seed-batch mode

Seed-batch candidate scoring maps repeated early-entry evidence into the wallet score model.
This is **not** a realized-profit score yet.

Typical mapping:

- `totalTrades` → total early buys across seed tokens
- `earlyEntryCount` → token appearances
- `successfulEarlyEntryCount` → token appearances
- `suspiciousFlags` → warning-derived flags

## Limitations

- PnL is approximate, not tax-lot accounting
- Missing USD trade data reduces accuracy
- Open positions depend on current price enrichment
- Solana wallet historical analysis is not yet supported



