import type { SupportedChain } from '../chains/chain.types.js';
import { DexScreenerClient } from '../providers/market/dexscreener.client.js';
import type { CurrentTokenPriceMap } from './wallet-performance.types.js';

const RUN_CACHE = new Map<string, CurrentTokenPriceMap[string]>();

export async function enrichCurrentTokenPrices(input: {
  chain: SupportedChain;
  tokenAddresses: string[];
  client?: Pick<DexScreenerClient, 'getTokenProfile'>;
}): Promise<{ prices: CurrentTokenPriceMap; warnings: string[] }> {
  const client = input.client ?? new DexScreenerClient();
  const warnings = new Set<string>();
  const prices: CurrentTokenPriceMap = {};
  const uniqueTokens = Array.from(new Set(input.tokenAddresses.map((x) => x.toLowerCase())));

  for (const tokenAddress of uniqueTokens) {
    const cacheKey = `${input.chain}:${tokenAddress}`;
    const cached = RUN_CACHE.get(cacheKey);
    if (cached) {
      prices[tokenAddress] = cached;
      continue;
    }

    try {
      const profile = await client.getTokenProfile(input.chain, tokenAddress);
      if (!profile) {
        const miss = { warnings: ['token_profile_not_found'] };
        prices[tokenAddress] = miss;
        RUN_CACHE.set(cacheKey, miss);
        warnings.add(`price_enrichment_missing_profile:${tokenAddress}`);
        continue;
      }

      prices[tokenAddress] = {
        priceUsd: profile.priceUsd,
        liquidityUsd: profile.liquidityUsd,
        marketCap: profile.marketCap,
        symbol: profile.symbol,
        warnings: profile.warnings,
      };
      RUN_CACHE.set(cacheKey, prices[tokenAddress]!);

      for (const warning of profile.warnings) warnings.add(`price_enrichment:${tokenAddress}:${warning}`);
    } catch (error) {
      const fail = { warnings: ['token_profile_fetch_failed'] };
      prices[tokenAddress] = fail;
      RUN_CACHE.set(cacheKey, fail);
      warnings.add(`price_enrichment_error:${tokenAddress}:${error instanceof Error ? error.message : 'unknown_error'}`);
    }
  }

  return {
    prices,
    warnings: [...warnings],
  };
}
