# Wallet Historical Analysis

Analyze a wallet’s past trades to estimate approximate realized and unrealized PnL.

## Sources

- `persisted`: queries stored trades from the database
- `mock`: deterministic local sample data for testing/demo
- `provider`: current adapter stub / live provider path

## Example

```bash
npm run analyze:wallet -- --chain base --wallet 0x... --source persisted --enrich-prices true --json false
```

## Notes

- PnL is approximate, not tax-lot accounting
- Missing USD data is tolerated
- Solana wallet historical analysis is currently unsupported
- Unrealized PnL is omitted when current price data is unavailable
