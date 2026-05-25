import type { SupportedChain } from '../chains/chain.types.js';

export type SeedDiscoverySource = 'latest_profiles' | 'latest_boosts' | 'top_boosts' | 'search_queries' | 'manual';

export interface DiscoveredSeedCandidate {
  chain: SupportedChain;
  tokenAddress: string;
  symbol?: string;
  name?: string;
  dexId?: string;
  pairAddress?: string;
  marketCap?: number;
  fdv?: number;
  liquidityUsd?: number;
  volumeH24?: number;
  priceChangeH24?: number;
  pairCreatedAt?: string;
  dexUrl?: string;
  sourceQuery?: string;
  source: SeedDiscoverySource[];
  score: number;
  warnings: string[];
}

export interface SeedDiscoveryResult {
  generatedAt: string;
  inputSummary: {
    chains: SupportedChain[];
    includeLatestProfiles: boolean;
    includeLatestBoosts: boolean;
    includeTopBoosts: boolean;
    minMarketCap?: number;
    minLiquidityUsd?: number;
    minVolumeH24?: number;
    minPriceChangeH24?: number;
    maxAgeDays?: number;
    limit: number;
  };
  diagnostics?: {
    sourceFetchCounts: Record<string, number>;
    candidatesAfterChainFilter: number;
    candidatesAfterDedupe: number;
    pairDataUnavailable: number;
    skippedByFilter: {
      minMarketCap: number;
      minLiquidityUsd: number;
      minVolumeH24: number;
      minPriceChangeH24: number;
      maxAgeDays: number;
    };
    skippedExamples: Array<{ key: string; reason: string }>;
    suggestion?: string;
  };
  candidates: DiscoveredSeedCandidate[];
  warnings: string[];
  outputFiles: Record<string, string>;
}
