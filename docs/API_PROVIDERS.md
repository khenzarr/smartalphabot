# API Providers

Current: DexScreener for token profile discovery.

Phase 1 EVM scan stack: chain RPC + log scanning + Uniswap V2/V3-compatible parsers.

Note: public RPCs can reject dense `eth_getLogs` ranges. The scanner now applies adaptive chunking, retries smaller ranges, and uses V2/V3 swap topics when parser type is known.

Planned: Moralis/Bitquery/Alchemy, Helius/Birdeye/Solscan/Jupiter/Raydium/Pump.fun/Meteora.
