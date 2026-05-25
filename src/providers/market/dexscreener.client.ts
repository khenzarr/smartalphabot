import type { NormalizedTokenProfile, SupportedChain } from '../../chains/chain.types.js';
import { CHAIN_CONFIGS } from '../../chains/chain.config.js';
import { env } from '../../config/env.js';
import { ageSeconds } from '../../utils/time.js';
import { withRetry } from '../../utils/retry.js';
import type { IMarketDataProvider } from '../interfaces.js';

interface DexPair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  url?: string;
  pairCreatedAt?: number;
  baseToken?: { address?: string; symbol?: string; name?: string };
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  priceUsd?: string;
}

interface DexSearchResponse {
  pairs?: DexPair[];
}

interface DexTokenProfileItem {
  chainId?: string;
  tokenAddress?: string;
  url?: string;
}

interface DexTokenBoostItem {
  chainId?: string;
  tokenAddress?: string;
  url?: string;
}

export class DexScreenerClient implements IMarketDataProvider {
  private readonly baseUrl = env.DEXSCREENER_BASE_URL;
  private lastRequestAt = 0;

  private async request<T>(path: string): Promise<T> {
    const wait = Math.max(0, 250 - (Date.now() - this.lastRequestAt));
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastRequestAt = Date.now();

    return withRetry(async () => {
      const response = await fetch(`${this.baseUrl}${path}`);
      if (!response.ok) throw new Error(`DexScreener error ${response.status}`);
      return (await response.json()) as T;
    }, 2, 350);
  }

  async getTokenPairs(chain: SupportedChain, tokenAddress: string): Promise<DexPair[]> {
    const cfg = CHAIN_CONFIGS[chain];
    if (!cfg.dexScreenerSlug) return [];
    const payload = await this.request<{ pairs?: DexPair[] }>(`/latest/dex/tokens/${tokenAddress}`);
    return (payload.pairs ?? []).filter((pair) => pair.chainId === cfg.dexScreenerSlug);
  }

  async searchPairs(query: string): Promise<DexPair[]> {
    const q = query.trim();
    if (!q) return [];
    try {
      const payload = await this.request<DexSearchResponse>(`/latest/dex/search?q=${encodeURIComponent(q)}`);
      return payload.pairs ?? [];
    } catch {
      return [];
    }
  }

  async getBestPairForToken(chain: SupportedChain, tokenAddress: string): Promise<DexPair | null> {
    const pairs = await this.getTokenPairs(chain, tokenAddress);
    if (!pairs.length) return null;
    return pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0] ?? null;
  }

  async getLatestTokenProfiles(): Promise<DexTokenProfileItem[]> {
    try {
      const payload = await this.request<{ profiles?: DexTokenProfileItem[] }>(`/token-profiles/latest/v1`);
      return payload.profiles ?? [];
    } catch {
      return [];
    }
  }

  async getLatestTokenBoosts(): Promise<DexTokenBoostItem[]> {
    try {
      const payload = await this.request<{ boosts?: DexTokenBoostItem[] }>(`/token-boosts/latest/v1`);
      return payload.boosts ?? [];
    } catch {
      return [];
    }
  }

  async getTopTokenBoosts(): Promise<DexTokenBoostItem[]> {
    try {
      const payload = await this.request<{ boosts?: DexTokenBoostItem[] }>(`/token-boosts/top/v1`);
      return payload.boosts ?? [];
    } catch {
      return [];
    }
  }

  async getTokenPairsBatch(chain: SupportedChain, tokenAddresses: string[]): Promise<DexPair[]> {
    const cfg = CHAIN_CONFIGS[chain];
    if (!cfg.dexScreenerSlug || !tokenAddresses.length) return [];

    const chunks: string[][] = [];
    for (let i = 0; i < tokenAddresses.length; i += 30) chunks.push(tokenAddresses.slice(i, i + 30));

    const pairs: DexPair[] = [];
    for (const chunk of chunks) {
      try {
        const payload = await this.request<{ pairs?: DexPair[] }>(`/latest/dex/tokens/${chunk.join(',')}`);
        pairs.push(...(payload.pairs ?? []).filter((pair) => pair.chainId === cfg.dexScreenerSlug));
      } catch {
        continue;
      }
    }

    return pairs;
  }

  async getTokenProfile(chain: SupportedChain, tokenAddress: string): Promise<NormalizedTokenProfile | null> {
    const best = await this.getBestPairForToken(chain, tokenAddress);
    if (!best) return null;

    const pairCreatedAt = best.pairCreatedAt ? new Date(best.pairCreatedAt) : undefined;
    const warnings: string[] = [];
    if ((best.liquidity?.usd ?? 0) < 100_000) warnings.push('liquidity_under_100k');
    if ((best.marketCap ?? 0) < 100_000) warnings.push('marketcap_under_100k');

    return {
      chain,
      chainFamily: CHAIN_CONFIGS[chain].chainFamily,
      tokenAddress,
      symbol: best.baseToken?.symbol,
      name: best.baseToken?.name,
      pairAddress: best.pairAddress,
      poolAddress: best.pairAddress,
      dexId: best.dexId,
      priceUsd: best.priceUsd ? Number(best.priceUsd) : undefined,
      marketCap: best.marketCap,
      fdv: best.fdv,
      liquidityUsd: best.liquidity?.usd,
      pairCreatedAt,
      tokenAgeSeconds: ageSeconds(pairCreatedAt),
      dexUrl: best.url,
      warnings,
      raw: best,
    };
  }
}
