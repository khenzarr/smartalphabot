# Roadmap

Phase 1: supported EVM early-buyer extraction, grouped wallet analysis, optional persistence, and CLI reporting.

Phase 2A: batch seed-token discovery, repeated early-buyer aggregation, candidate smart-wallet export.

Phase 2B: wallet historical trade + approximate PnL engine, `analyze-wallet` CLI, persisted/mock/provider wallet trade sources, optional seed-batch wallet enrichment, and persistence snapshots.

Next:

- improve historical pricing reliability and confidence scoring
- add Solana wallet historical analysis support
- harden realtime alert pipeline for Telegram notifications

## Monitoring MVP (current)

Delivered in this phase:

- candidate shortlist import into local monitor watchlist (`monitor:import-candidates`)
- file-based watchlist artifacts (`data/monitor-wallets.json`, meta file)
- recent EVM incoming ERC20 transfer scan heuristic (`eth_getLogs` bounded windows)
- token enrichment via DexScreener provider with graceful failure handling
- grouped monitor signal builder + v1 scoring + categories (`strong/watch/weak/ignored`)
- monitor poll CLI outputs (`events.json`, `signals.json`, `signals.csv`, `monitor-summary.json`)
- Telegram message formatter + dry-run mode + optional guarded sending
- file-based signal dedupe (`data/monitor-sent-signals.local.json`, 30-minute bucket)
- provider strategy modes: `auto`, `rpc-addressless`, `rpc-known-tokens`
- provider strategy modes: `auto`, `rpc-addressless`, `rpc-known-tokens`, `explorer`, `auto-indexer`
- graceful fallback/warnings when public RPC rejects addressless `eth_getLogs`
- known-token builder helper (`monitor:build-known-tokens`) for public-RPC-compatible monitoring
- explorer/indexer wallet activity provider (Blockscout-compatible + optional Etherscan v2 path)

Next (Monitoring Phase 2):

- DEX-context buy classification (separate swaps from generic transfers)
- stronger anti-spam heuristics and zero-value transfer filtering
- add robust managed indexer provider(s) for higher-throughput production use
- DB-backed persistence for historical monitoring state
- Telegram bot user commands for personal watchlist management
