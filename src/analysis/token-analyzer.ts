import type { NormalizedTokenProfile, SupportedChain } from '../chains/chain.types.js';
import { DexScreenerClient } from '../providers/market/dexscreener.client.js';

export interface TokenAnalysisResult {
  tokenProfile: NormalizedTokenProfile | null;
  providerSource: 'dexscreener';
  warnings: string[];
  raw?: unknown;
}

export class TokenAnalyzer {
  constructor(private readonly marketProvider = new DexScreenerClient()) {}

  async analyze(chain: SupportedChain, tokenAddress: string): Promise<TokenAnalysisResult> {
    const tokenProfile = await this.marketProvider.getTokenProfile(chain, tokenAddress);
    const warnings: string[] = [];

    if (!tokenProfile) {
      warnings.push('token_profile_not_found');
      return { tokenProfile: null, providerSource: 'dexscreener', warnings };
    }

    if (!tokenProfile.poolAddress && !tokenProfile.pairAddress) warnings.push('pair_or_pool_address_missing');
    if (!tokenProfile.dexId) warnings.push('dexscreener_missing_dex_id');
    if (!tokenProfile.pairCreatedAt) warnings.push('pair_created_at_missing');
    if (tokenProfile.priceUsd === undefined) warnings.push('price_usd_missing');
    if (tokenProfile.marketCap === undefined) warnings.push('market_cap_missing');
    if (tokenProfile.fdv === undefined) warnings.push('fdv_missing');
    if (tokenProfile.liquidityUsd === undefined) warnings.push('liquidity_usd_missing');

    return {
      tokenProfile: {
        ...tokenProfile,
        warnings: [...tokenProfile.warnings, ...warnings],
      },
      providerSource: 'dexscreener',
      warnings,
      raw: tokenProfile.raw,
    };
  }
}
