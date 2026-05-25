import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SupportedChain } from '../chains/chain.types.js';
import { DexScreenerClient } from '../providers/market/dexscreener.client.js';
import { isEvmAddress } from '../utils/address.js';
import { safeJsonStringify } from '../utils/json.js';
import type { DiscoveredSeedCandidate, SeedDiscoveryResult, SeedDiscoverySource } from './seed-discovery.types.js';

export interface SeedDiscoveryFilters {
  chains?: SupportedChain[];
  limit?: number;
  minMarketCap?: number;
  minLiquidityUsd?: number;
  minVolumeH24?: number;
  minPriceChangeH24?: number;
  maxAgeDays?: number;
  includeLatestProfiles?: boolean;
  includeLatestBoosts?: boolean;
  includeTopBoosts?: boolean;
}

export interface SeedDiscoveryDeps {
  client?: Pick<
    DexScreenerClient,
    'getLatestTokenProfiles' | 'getLatestTokenBoosts' | 'getTopTokenBoosts' | 'getTokenPairsBatch' | 'getTokenPairs'
  >;
  now?: () => Date;
}

interface DiscoverySourceToken {
  chain: SupportedChain;
  tokenAddress: string;
  source: SeedDiscoverySource[];
}

type CountableSeedDiscoverySource = Exclude<SeedDiscoverySource, 'manual'>;

interface PairLike {
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
}

const SUPPORTED_DISCOVERY_CHAINS: SupportedChain[] = ['ethereum', 'base', 'bsc'];

function normalizeChainId(chainId?: string): SupportedChain | null {
  if (!chainId) return null;
  const normalized = chainId.toLowerCase();
  if (normalized === 'ethereum' || normalized === 'base' || normalized === 'bsc') return normalized;
  return null;
}

function toAddress(value?: string): string | null {
  if (!value || !isEvmAddress(value)) return null;
  return value.toLowerCase();
}

function dedupeTokens(items: DiscoverySourceToken[]): DiscoverySourceToken[] {
  const map = new Map<string, DiscoverySourceToken>();
  for (const item of items) {
    const key = `${item.chain}:${item.tokenAddress.toLowerCase()}`;
    const current = map.get(key);
    if (!current) {
      map.set(key, item);
      continue;
    }
    for (const source of item.source) {
      if (!current.source.includes(source)) current.source.push(source);
    }
  }
  return [...map.values()];
}

function selectBestPair(pairs: PairLike[]): PairLike | null {
  if (!pairs.length) return null;
  return [...pairs].sort((a, b) => {
    const aLiquidity = a.liquidity?.usd ?? 0;
    const bLiquidity = b.liquidity?.usd ?? 0;
    if (bLiquidity !== aLiquidity) return bLiquidity - aLiquidity;
    return (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0);
  })[0] ?? null;
}

function ageInDays(pairCreatedAt?: number): number | undefined {
  if (!pairCreatedAt) return undefined;
  return (Date.now() - pairCreatedAt) / (1000 * 60 * 60 * 24);
}

function scoreCandidate(candidate: Omit<DiscoveredSeedCandidate, 'score'>): number {
  const marketCap = candidate.marketCap ?? candidate.fdv ?? 0;
  const priceChange = candidate.priceChangeH24 ?? 0;
  const liquidity = candidate.liquidityUsd ?? 0;
  const volume = candidate.volumeH24 ?? 0;
  const ageBonus = candidate.pairCreatedAt ? 500 : 0;
  const warningPenalty = candidate.warnings.length * 250;

  return (
    marketCap * 0.000001 +
    priceChange * 10 +
    liquidity * 0.00001 +
    volume * 0.000001 +
    ageBonus -
    warningPenalty
  );
}

function buildSeedTokens(candidates: DiscoveredSeedCandidate[]) {
  return candidates.map((candidate) => ({
    chain: candidate.chain,
    tokenAddress: candidate.tokenAddress,
    label: candidate.symbol ?? candidate.tokenAddress,
    narrative: 'dexscreener_discovered',
    notes: `Discovered via DexScreener seed helper. marketCap=${candidate.marketCap ?? 'n/a'}, h24=${candidate.priceChangeH24 ?? 'n/a'}, liquidity=${candidate.liquidityUsd ?? 'n/a'}`,
  }));
}

export async function discoverSeedTokens(input: SeedDiscoveryFilters = {}, deps: SeedDiscoveryDeps = {}): Promise<SeedDiscoveryResult> {
  const client = deps.client ?? new DexScreenerClient();
  const now = deps.now ?? (() => new Date());
  const chains = (input.chains?.length ? input.chains : SUPPORTED_DISCOVERY_CHAINS).filter((chain) => SUPPORTED_DISCOVERY_CHAINS.includes(chain));
  const limit = Math.max(1, input.limit ?? 30);
  const includeLatestProfiles = input.includeLatestProfiles ?? true;
  const includeLatestBoosts = input.includeLatestBoosts ?? true;
  const includeTopBoosts = input.includeTopBoosts ?? true;

  const warnings: string[] = [];
  const tokens: DiscoverySourceToken[] = [];
  const diagnostics = {
    sourceFetchCounts: {
      latest_profiles: 0,
      latest_boosts: 0,
      top_boosts: 0,
      search_queries: 0,
    },
    candidatesAfterChainFilter: 0,
    candidatesAfterDedupe: 0,
    pairDataUnavailable: 0,
    skippedByFilter: {
      minMarketCap: 0,
      minLiquidityUsd: 0,
      minVolumeH24: 0,
      minPriceChangeH24: 0,
      maxAgeDays: 0,
    },
    skippedExamples: [] as Array<{ key: string; reason: string }>,
    suggestion: undefined as string | undefined,
  };

  if (includeLatestProfiles) {
    const profiles = await client.getLatestTokenProfiles();
    diagnostics.sourceFetchCounts.latest_profiles = profiles.length;
    for (const profile of profiles) {
      const chain = normalizeChainId(profile.chainId);
      const tokenAddress = toAddress(profile.tokenAddress);
      if (!chain || !tokenAddress || !chains.includes(chain)) continue;
      tokens.push({ chain, tokenAddress, source: ['latest_profiles'] });
    }
  }

  const boostCollector = async (
    source: CountableSeedDiscoverySource,
    getter: () => Promise<Array<{ chainId?: string; tokenAddress?: string }>>,
  ) => {
    const items = await getter();
    diagnostics.sourceFetchCounts[source] = items.length;
    for (const item of items) {
      const chain = normalizeChainId(item.chainId);
      const tokenAddress = toAddress(item.tokenAddress);
      if (!chain || !tokenAddress || !chains.includes(chain)) continue;
      tokens.push({ chain, tokenAddress, source: [source] });
    }
  };

  if (includeLatestBoosts) await boostCollector('latest_boosts', () => client.getLatestTokenBoosts());
  if (includeTopBoosts) await boostCollector('top_boosts', () => client.getTopTokenBoosts());

  diagnostics.candidatesAfterChainFilter = tokens.length;
  const deduped = dedupeTokens(tokens);
  diagnostics.candidatesAfterDedupe = deduped.length;
  const byChain = new Map<SupportedChain, string[]>();
  for (const item of deduped) {
    const list = byChain.get(item.chain) ?? [];
    list.push(item.tokenAddress);
    byChain.set(item.chain, list);
  }

  const pairMap = new Map<string, PairLike[]>();
  for (const [chain, addresses] of byChain.entries()) {
    if (!addresses.length) continue;
    const pairs = await client.getTokenPairsBatch(chain, addresses);
    for (const pair of pairs as PairLike[]) {
      const tokenAddress = toAddress(pair.baseToken?.address);
      if (!tokenAddress) continue;
      const key = `${chain}:${tokenAddress}`;
      const current = pairMap.get(key) ?? [];
      current.push(pair);
      pairMap.set(key, current);
    }
  }

  const candidates: DiscoveredSeedCandidate[] = [];
  for (const item of deduped) {
    const key = `${item.chain}:${item.tokenAddress}`;
    const pairs = pairMap.get(key) ?? [];
    if (!pairs.length) {
      warnings.push(`${key}: pair_data_unavailable`);
      diagnostics.pairDataUnavailable += 1;
      if (diagnostics.skippedExamples.length < 10) diagnostics.skippedExamples.push({ key, reason: 'pair_data_unavailable' });
      continue;
    }

    const best = selectBestPair(pairs);
    if (!best) {
      warnings.push(`${key}: pair_data_unavailable`);
      continue;
    }

    const pairCreatedAt = best.pairCreatedAt ? new Date(best.pairCreatedAt).toISOString() : undefined;
    const candidateWarnings: string[] = [];
    const marketCap = best.marketCap ?? best.fdv;
    if (best.marketCap === undefined && best.fdv !== undefined) candidateWarnings.push('marketcap_fallback_to_fdv');
    if (best.priceChange?.h24 === undefined) candidateWarnings.push('pricechange_h24_missing');

    if (input.minMarketCap !== undefined && (marketCap ?? 0) < input.minMarketCap) {
      diagnostics.skippedByFilter.minMarketCap += 1;
      if (diagnostics.skippedExamples.length < 10) diagnostics.skippedExamples.push({ key, reason: 'minMarketCap' });
      continue;
    }
    if (input.minLiquidityUsd !== undefined && (best.liquidity?.usd ?? 0) < input.minLiquidityUsd) {
      diagnostics.skippedByFilter.minLiquidityUsd += 1;
      if (diagnostics.skippedExamples.length < 10) diagnostics.skippedExamples.push({ key, reason: 'minLiquidityUsd' });
      continue;
    }
    if (input.minVolumeH24 !== undefined && (best.volume?.h24 ?? 0) < input.minVolumeH24) {
      diagnostics.skippedByFilter.minVolumeH24 += 1;
      if (diagnostics.skippedExamples.length < 10) diagnostics.skippedExamples.push({ key, reason: 'minVolumeH24' });
      continue;
    }
    if (input.minPriceChangeH24 !== undefined && (best.priceChange?.h24 ?? Number.NEGATIVE_INFINITY) < input.minPriceChangeH24) {
      diagnostics.skippedByFilter.minPriceChangeH24 += 1;
      if (diagnostics.skippedExamples.length < 10) diagnostics.skippedExamples.push({ key, reason: 'minPriceChangeH24' });
      continue;
    }
    if (input.maxAgeDays !== undefined) {
      const days = ageInDays(best.pairCreatedAt);
      if (days !== undefined && days > input.maxAgeDays) {
        diagnostics.skippedByFilter.maxAgeDays += 1;
        if (diagnostics.skippedExamples.length < 10) diagnostics.skippedExamples.push({ key, reason: 'maxAgeDays' });
        continue;
      }
    }

    const candidateBase: Omit<DiscoveredSeedCandidate, 'score'> = {
      chain: item.chain,
      tokenAddress: item.tokenAddress,
      symbol: best.baseToken?.symbol,
      name: best.baseToken?.name,
      dexId: best.dexId,
      pairAddress: best.pairAddress,
      marketCap,
      fdv: best.fdv,
      liquidityUsd: best.liquidity?.usd,
      volumeH24: best.volume?.h24,
      priceChangeH24: best.priceChange?.h24,
      pairCreatedAt,
      dexUrl: best.url,
      source: item.source,
      warnings: candidateWarnings,
    };

    const score = scoreCandidate(candidateBase);
    candidates.push({ ...candidateBase, score });
  }

  candidates.sort((a, b) => b.score - a.score);

  const resultCandidates = candidates.slice(0, limit).map((candidate) => ({
    ...candidate,
    warnings: [...new Set(candidate.warnings)].sort(),
  }));

  if (!resultCandidates.length) {
    diagnostics.suggestion =
      diagnostics.pairDataUnavailable > 0
        ? 'DexScreener pair data was unavailable for the discovered tokens; try looser filters or different chains.'
        : 'No candidates passed the current filters; reduce market cap / liquidity / volume thresholds or disable one filter at a time.';
  }

  const generatedAt = now().toISOString();
  return {
    generatedAt,
    inputSummary: {
      chains,
      includeLatestProfiles,
      includeLatestBoosts,
      includeTopBoosts,
      minMarketCap: input.minMarketCap,
      minLiquidityUsd: input.minLiquidityUsd,
      minVolumeH24: input.minVolumeH24,
      minPriceChangeH24: input.minPriceChangeH24,
      maxAgeDays: input.maxAgeDays,
      limit,
    },
    diagnostics,
    candidates: resultCandidates,
    warnings: [...new Set(warnings)].sort(),
    outputFiles: {},
  };
}

export async function writeSeedDiscoveryOutputs(result: SeedDiscoveryResult, outPath: string) {
  await mkdir(path.dirname(outPath), { recursive: true });

  const seedTokens = buildSeedTokens(result.candidates);
  const metaPath = outPath.replace(/\.json$/i, '.meta.json');
  const outputIndexPath = path.join(path.dirname(outPath), 'output-index.json');

  await writeFile(outPath, safeJsonStringify(seedTokens, 2), 'utf8');
  await writeFile(
    metaPath,
    safeJsonStringify(
      {
        generatedAt: result.generatedAt,
        filters: result.inputSummary,
        diagnostics: result.diagnostics,
        candidates: result.candidates,
        warnings: result.warnings,
      },
      2,
    ),
    'utf8',
  );
  await writeFile(
    outputIndexPath,
    safeJsonStringify(
      {
        generatedAt: result.generatedAt,
        commandType: 'seed_discovery',
        inputFile: undefined,
        files: {
          seedTokensJson: outPath,
          seedTokensMetaJson: metaPath,
        },
      },
      2,
    ),
    'utf8',
  );

  return {
    seedTokens,
    metaPath,
    outputIndexPath,
  };
}
