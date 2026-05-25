# Phase 1 Early-Buyer Extraction

## Works now
- EVM token analysis for `ethereum`, `base`, `bsc`
- DexScreener profile selection
- V2/V3-compatible pool classification
- bounded swap-log scanning
- earliest-buyer grouping by wallet
- optional Prisma persistence

## Supported parser types
- `uniswap_v2_compatible`
- `uniswap_v3_compatible`

## Required env
- `DATABASE_URL`
- `ETHEREUM_RPC_URL`
- `BASE_RPC_URL`
- `BSC_RPC_URL`
- `SOLANA_RPC_URL`
- `TELEGRAM_BOT_TOKEN`

## Example commands
```bash
npm run analyze:token -- --chain base --token 0x...
npm run analyze:token -- --chain ethereum --token 0x... --json true
npm run analyze:token -- --chain bsc --token 0x... --persist true
```

## Guardrails
- scan ranges are bounded
- unsupported pools return warnings
- Solana early-buyer extraction is not implemented yet
- historical USD may be omitted when unreliable

## Limitations
- no PnL
- no smart-wallet ranking completeness claim
- no Solana parsing yet
- no copy trading or signing

## Interpretation
The output shows the earliest observed buyers in the scanned pool window, grouped by wallet, not a full lifetime wallet ledger.

## Next phase
Expand DEX coverage and add better price/hold-period analytics.