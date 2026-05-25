import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SupportedChain } from '../chains/chain.types.js';
import { discoverSeedTokens } from './discover-seed-tokens.js';
import { runSeedBatch, type SeedBatchRunResult } from './run-seed-batch.js';
import type { DiscoveredSeedCandidate } from './seed-discovery.types.js';
import type { SeedTokenInput } from './seed-token-input.js';
import { isEvmAddress } from '../utils/address.js';
import { safeJsonStringify } from '../utils/json.js';
import { DexScreenerClient } from '../providers/market/dexscreener.client.js';

type ExpansionProfileName = 'strict' | 'moderate' | 'loose';

export const EXPANSION_PROFILES: Record<ExpansionProfileName, { minMarketCap: number; minLiquidityUsd: number; minVolumeH24: number; minPriceChangeH24: number }> = {
  strict: {
    minMarketCap: 1_000_000,
    minLiquidityUsd: 100_000,
    minVolumeH24: 100_000,
    minPriceChangeH24: 0,
  },
  moderate: {
    minMarketCap: 250_000,
    minLiquidityUsd: 25_000,
    minVolumeH24: 25_000,
    minPriceChangeH24: -25,
  },
  loose: {
    minMarketCap: 50_000,
    minLiquidityUsd: 10_000,
    minVolumeH24: 5_000,
    minPriceChangeH24: -50,
  },
};

const CHAIN_PRIORITY: Record<'ethereum' | 'base' | 'bsc', number> = {
  ethereum: 0,
  base: 1,
  bsc: 2,
};

type EvmSeedChain = 'ethereum' | 'base' | 'bsc';

export interface AutoExpandSeedsInput {
  basePath: string;
  outPath: string;
  workdir: string;
  chains: EvmSeedChain[];
  targetCount: number;
  defaultNarrative: string;
  dryRun: boolean;
  includeQueryDiscovery?: boolean;
  queries?: string[];
  maxPerQuery?: number;
  maxQuerySeconds?: number;
  maxTotalSeconds?: number;
  minLiquidity?: number;
  minMarketCap?: number;
  minVolumeH24?: number;
  discoveredOutPath?: string;
  metaOutPath?: string;
  log?: (message: string) => void;
}

export interface AutoExpandSeedsResult {
  generatedAt: string;
  baseSeedCount: number;
  autoDiscoveredCount: number;
  discoveredFromProfilesCount: number;
  discoveredFromSearchQueriesCount: number;
  finalSeedCount: number;
  targetCount: number;
  queriesUsed: string[];
  queryCount: number;
  seedGrowth: number;
  acceptedByChain: Record<'ethereum' | 'base' | 'bsc', number>;
  acceptedByProfile: Record<ExpansionProfileName, number>;
  skippedReasonCounts: Record<string, number>;
  warnings: string[];
  outputFiles: {
    autoDiscoveredJson: string;
    mergedNextJson: string;
    mergedNextMetaJson: string;
    reportJson: string;
  };
}

const DEFAULT_QUERY_PACK = [
  'pepe',
  'wojak',
  'cult',
  'mog',
  'turbo',
  'neiro',
  'dog',
  'doge',
  'shib',
  'floki',
  'bonk',
  'cat',
  'popcat',
  'michi',
  'frog',
  'kek',
  'maga',
  'trump',
  'ai',
  'agent',
  'agents',
  'virtual',
  'aixbt',
  'goat',
  'act',
  'fartcoin',
  'based',
  'base',
  'degen',
  'toshi',
  'brett',
  'mfer',
  'higher',
  'moon',
  'meme',
  'eth meme',
  'base meme',
  'bsc meme',
  '100x',
  'banana',
  'terminal',
  'zerebro',
  'ghibli',
  'spx',
  'gigachad',
  'chill',
  'pnut',
  'moodeng',
] as const;

type SearchPair = {
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
};

type QueryFallbackDiagnostics = {
  queryCount: number;
  queriesUsed: string[];
  rawResultsPerQuery: Record<string, number>;
  candidatesAfterNormalization: number;
  candidatesAfterFilters: number;
  candidatesAccepted: number;
  skippedReasons: Record<string, number>;
};

export interface AutoRunDiscoveryInput {
  inputPath: string;
  outDir: string;
  maxBuyers: number;
  maxHours: number;
  minTokenAppearances: number;
  persist: boolean;
  csv: boolean;
  onlyUsefulSeeds?: boolean;
  log?: (message: string) => void;
}

export interface AutoRunDiscoveryResult {
  runResult: SeedBatchRunResult;
  warnings: string[];
  nextRecommendedCommand?: string;
}

function parseSeedArray(input: unknown): SeedTokenInput[] {
  if (!Array.isArray(input)) return [];
  const out: SeedTokenInput[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const seed = item as Partial<SeedTokenInput>;
    if ((seed.chain === 'ethereum' || seed.chain === 'base' || seed.chain === 'bsc') && typeof seed.tokenAddress === 'string') {
      const normalized = seed.tokenAddress.toLowerCase();
      if (isEvmAddress(normalized)) {
        out.push({
          chain: seed.chain,
          tokenAddress: normalized,
          label: typeof seed.label === 'string' ? seed.label : undefined,
          narrative: typeof seed.narrative === 'string' ? seed.narrative : undefined,
          notes: typeof seed.notes === 'string' ? seed.notes : undefined,
        });
      }
    }
  }
  return out;
}

function dedupeSeeds(seeds: SeedTokenInput[]): SeedTokenInput[] {
  const map = new Map<string, SeedTokenInput>();
  for (const seed of seeds) {
    map.set(`${seed.chain}:${seed.tokenAddress.toLowerCase()}`, { ...seed, tokenAddress: seed.tokenAddress.toLowerCase() });
  }
  return [...map.values()];
}

function isSupportedEvmChain(value: unknown): value is EvmSeedChain {
  return value === 'ethereum' || value === 'base' || value === 'bsc';
}

function normalizeChain(value?: string): EvmSeedChain | null {
  if (!value) return null;
  const v = value.toLowerCase();
  return isSupportedEvmChain(v) ? v : null;
}

function parseQueries(inputQueries?: string[]): string[] {
  const base = inputQueries?.length ? inputQueries : [...DEFAULT_QUERY_PACK];
  const normalized = base.map((x) => x.trim()).filter(Boolean);
  return [...new Set(normalized)];
}

function incrementReason(reasons: Record<string, number>, key: string) {
  reasons[key] = (reasons[key] ?? 0) + 1;
}

function withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  if (ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function normalizeQueryCandidate(pair: SearchPair, sourceQuery: string): DiscoveredSeedCandidate | null {
  const chain = normalizeChain(pair.chainId);
  if (!chain) return null;
  const tokenAddress = String(pair.baseToken?.address ?? '').toLowerCase();
  if (!isEvmAddress(tokenAddress)) return null;
  return {
    chain,
    tokenAddress,
    symbol: pair.baseToken?.symbol,
    name: pair.baseToken?.name,
    dexId: pair.dexId,
    pairAddress: pair.pairAddress,
    marketCap: pair.marketCap,
    fdv: pair.fdv,
    liquidityUsd: pair.liquidity?.usd,
    volumeH24: pair.volume?.h24,
    priceChangeH24: pair.priceChange?.h24,
    pairCreatedAt: pair.pairCreatedAt ? new Date(pair.pairCreatedAt).toISOString() : undefined,
    dexUrl: pair.url,
    sourceQuery,
    source: ['search_queries'],
    score: (pair.liquidity?.usd ?? 0) * 0.00001 + ((pair.marketCap ?? pair.fdv ?? 0) * 0.000001) + ((pair.volume?.h24 ?? 0) * 0.000001),
    warnings: [],
  };
}

function passesProfile(candidate: DiscoveredSeedCandidate, profile: ExpansionProfileName, profileMap: typeof EXPANSION_PROFILES): boolean {
  const p = profileMap[profile];
  const marketCapLike = candidate.marketCap ?? candidate.fdv ?? 0;
  return (
    marketCapLike >= p.minMarketCap &&
    (candidate.liquidityUsd ?? 0) >= p.minLiquidityUsd &&
    (candidate.volumeH24 ?? 0) >= p.minVolumeH24 &&
    (candidate.priceChangeH24 === undefined || candidate.priceChangeH24 >= p.minPriceChangeH24)
  );
}

function candidateToSeed(candidate: DiscoveredSeedCandidate, index: number, defaultNarrative: string, profile: ExpansionProfileName): SeedTokenInput {
  return {
    chain: candidate.chain as EvmSeedChain,
    tokenAddress: candidate.tokenAddress.toLowerCase(),
    label: candidate.symbol ? `${candidate.chain.toUpperCase()}_${candidate.symbol}` : `${candidate.chain.toUpperCase()}_AUTO_${String(index + 1).padStart(3, '0')}`,
    narrative: defaultNarrative,
    notes: `auto_discovered:${profile};source=${candidate.source.join('|')};score=${candidate.score.toFixed(2)}`,
  };
}

export async function autoExpandSeeds(
  input: AutoExpandSeedsInput,
  deps: {
    discover?: typeof discoverSeedTokens;
    marketClient?: Pick<DexScreenerClient, 'searchPairs'>;
    now?: () => Date;
  } = {},
): Promise<AutoExpandSeedsResult> {
  const discover = deps.discover ?? discoverSeedTokens;
  const marketClient = deps.marketClient ?? new DexScreenerClient();
  const now = deps.now ?? (() => new Date());
  const warnings: string[] = [];
  const log = input.log ?? ((message: string) => console.log(message));
  const includeQueryDiscovery = input.includeQueryDiscovery ?? true;
  const maxPerQuery = Math.max(1, input.maxPerQuery ?? 10);
  const maxQuerySeconds = Math.max(1, input.maxQuerySeconds ?? 20);
  const maxTotalSeconds = Math.max(1, input.maxTotalSeconds ?? 1800);
  const startedAtMs = Date.now();
  const queriesUsed = parseQueries(input.queries);
  const acceptedByChain: Record<'ethereum' | 'base' | 'bsc', number> = { ethereum: 0, base: 0, bsc: 0 };
  const acceptedByProfile: Record<ExpansionProfileName, number> = { strict: 0, moderate: 0, loose: 0 };

  const discoveredOutPath = input.discoveredOutPath ?? 'data/seed-tokens.auto-discovered.json';
  const metaOutPath = input.metaOutPath ?? input.outPath.replace(/\.json$/i, '.meta.json');
  const reportPath = path.join(input.workdir, 'auto-expansion-report.json');

  log('[auto-expand] loading base seeds');
  const baseRaw = JSON.parse(await readFile(input.basePath, 'utf8')) as unknown;
  const baseSeeds = dedupeSeeds(parseSeedArray(baseRaw));
  const baseKeys = new Set(baseSeeds.map((x) => `${x.chain}:${x.tokenAddress.toLowerCase()}`));

  const selected: Array<{ candidate: DiscoveredSeedCandidate; profile: ExpansionProfileName }> = [];
  const seenGenerated = new Set<string>();
  const profileOrder: ExpansionProfileName[] = ['strict', 'moderate', 'loose'];
  const profileFilters = {
    strict: {
      ...EXPANSION_PROFILES.strict,
      minLiquidityUsd: input.minLiquidity ?? EXPANSION_PROFILES.strict.minLiquidityUsd,
      minMarketCap: input.minMarketCap ?? EXPANSION_PROFILES.strict.minMarketCap,
      minVolumeH24: input.minVolumeH24 ?? EXPANSION_PROFILES.strict.minVolumeH24,
    },
    moderate: {
      ...EXPANSION_PROFILES.moderate,
      minLiquidityUsd: input.minLiquidity ?? EXPANSION_PROFILES.moderate.minLiquidityUsd,
      minMarketCap: input.minMarketCap ?? EXPANSION_PROFILES.moderate.minMarketCap,
      minVolumeH24: input.minVolumeH24 ?? EXPANSION_PROFILES.moderate.minVolumeH24,
    },
    loose: {
      ...EXPANSION_PROFILES.loose,
      minLiquidityUsd: input.minLiquidity ?? EXPANSION_PROFILES.loose.minLiquidityUsd,
      minMarketCap: input.minMarketCap ?? EXPANSION_PROFILES.loose.minMarketCap,
      minVolumeH24: input.minVolumeH24 ?? EXPANSION_PROFILES.loose.minVolumeH24,
    },
  } as const;
  const queryDiagnostics: QueryFallbackDiagnostics = {
    queryCount: includeQueryDiscovery ? queriesUsed.length : 0,
    queriesUsed,
    rawResultsPerQuery: {},
    candidatesAfterNormalization: 0,
    candidatesAfterFilters: 0,
    candidatesAccepted: 0,
    skippedReasons: {},
  };

  for (const profile of profileOrder) {
    if ((Date.now() - startedAtMs) / 1000 >= maxTotalSeconds) {
      warnings.push(`max_total_seconds_reached_during_profile_discovery:${maxTotalSeconds}`);
      break;
    }
    if (selected.length >= input.targetCount) break;
    log(`[auto-expand] running profile discovery: ${profile}`);
    const remaining = Math.max(1, input.targetCount - selected.length);
    const result = await discover({ chains: input.chains as SupportedChain[], limit: remaining, ...profileFilters[profile] });

    for (const candidate of result.candidates) {
      const chain = candidate.chain;
      const token = String(candidate.tokenAddress ?? '').toLowerCase();
      const key = `${chain}:${token}`;

      if (!isSupportedEvmChain(chain)) continue;
      if (!isEvmAddress(token)) continue;
      if (!candidate.pairAddress) continue;
      if ((candidate.liquidityUsd ?? 0) <= 0) continue;
      if (baseKeys.has(key) || seenGenerated.has(key)) continue;

      selected.push({ candidate: { ...candidate, tokenAddress: token }, profile });
      acceptedByChain[chain] += 1;
      acceptedByProfile[profile] += 1;
      seenGenerated.add(key);
      if (selected.length >= input.targetCount) break;
    }
    log(`[auto-expand] profile ${profile} accepted so far: ${selected.length}/${input.targetCount}`);
  }

  const discoveredFromProfilesCount = selected.length;

  if (includeQueryDiscovery && selected.length < input.targetCount) {
    log('[auto-expand] starting query fallback');
    for (const query of queriesUsed) {
      if ((Date.now() - startedAtMs) / 1000 >= maxTotalSeconds) {
        warnings.push(`max_total_seconds_reached_during_query_fallback:${maxTotalSeconds}`);
        break;
      }
      if (selected.length >= input.targetCount) break;
      const queryIndex = queriesUsed.indexOf(query) + 1;
      log(`[auto-expand] query ${queryIndex}/${queriesUsed.length}: "${query}"`);
      let rawPairs: SearchPair[] = [];
      try {
        rawPairs = (await withTimeout(
          Promise.resolve(marketClient.searchPairs(query) as Promise<SearchPair[]>),
          maxQuerySeconds * 1000,
          `query_timeout_seconds:${maxQuerySeconds};query=${query}`,
        )) as SearchPair[];
      } catch (error) {
        const message = error instanceof Error ? error.message : `query_timeout_seconds:${maxQuerySeconds};query=${query}`;
        warnings.push(message);
        incrementReason(queryDiagnostics.skippedReasons, 'query_timeout');
        continue;
      }
      queryDiagnostics.rawResultsPerQuery[query] = rawPairs.length;

      const normalized = rawPairs
        .map((pair) => normalizeQueryCandidate(pair, query))
        .filter((x): x is DiscoveredSeedCandidate => x !== null)
        .slice(0, maxPerQuery);

      queryDiagnostics.candidatesAfterNormalization += normalized.length;

      for (const candidate of normalized) {
        if (selected.length >= input.targetCount) break;
        const chain = candidate.chain;
        const token = candidate.tokenAddress.toLowerCase();
        const key = `${chain}:${token}`;

        if (!isSupportedEvmChain(chain)) {
          incrementReason(queryDiagnostics.skippedReasons, 'unsupported_chain');
          continue;
        }
        if (!isEvmAddress(token)) {
          incrementReason(queryDiagnostics.skippedReasons, 'invalid_token_address');
          continue;
        }
        if (!candidate.pairAddress) {
          incrementReason(queryDiagnostics.skippedReasons, 'missing_pair_data');
          continue;
        }
        if ((candidate.liquidityUsd ?? 0) <= 0) {
          incrementReason(queryDiagnostics.skippedReasons, 'low_liquidity');
          continue;
        }
        if (candidate.marketCap === undefined && candidate.fdv === undefined) {
          incrementReason(queryDiagnostics.skippedReasons, 'missing_market_cap_or_fdv');
          continue;
        }
        if (baseKeys.has(key)) {
          incrementReason(queryDiagnostics.skippedReasons, 'duplicate_base_seed');
          continue;
        }
        if (seenGenerated.has(key)) {
          incrementReason(queryDiagnostics.skippedReasons, 'duplicate_generated');
          continue;
        }

        const profile = profileOrder.find((p) => passesProfile(candidate, p, profileFilters));
        if (!profile) {
          incrementReason(queryDiagnostics.skippedReasons, 'below_staged_filters');
          continue;
        }

        queryDiagnostics.candidatesAfterFilters += 1;
        selected.push({ candidate: { ...candidate, tokenAddress: token }, profile });
        acceptedByChain[chain] += 1;
        acceptedByProfile[profile] += 1;
        seenGenerated.add(key);
        queryDiagnostics.candidatesAccepted += 1;
      }
      log(`[auto-expand] candidates found so far: ${selected.length}/${input.targetCount}`);
    }
  }

  selected.sort((a, b) => {
    const chainSort = CHAIN_PRIORITY[a.candidate.chain as EvmSeedChain] - CHAIN_PRIORITY[b.candidate.chain as EvmSeedChain];
    if (chainSort !== 0) return chainSort;
    return b.candidate.score - a.candidate.score;
  });

  const discoveredSeeds = selected.map((x, idx) => candidateToSeed(x.candidate, idx, input.defaultNarrative, x.profile));
  const mergedSeeds = dedupeSeeds([...baseSeeds, ...discoveredSeeds]);
  const discoveredFromSearchQueriesCount = Math.max(0, selected.length - discoveredFromProfilesCount);

  if (discoveredSeeds.length < 5) {
    warnings.push(`auto_discovered_seed_count_low:${discoveredSeeds.length}`);
  }
  if (mergedSeeds.length <= baseSeeds.length) {
    warnings.push('final_seed_count_did_not_grow');
  }
  if (discoveredSeeds.length < input.targetCount) {
    warnings.push(`insufficient_auto_discovered_candidates:found=${discoveredSeeds.length};target=${input.targetCount}`);
  }

  const generatedAt = now().toISOString();
  log('[auto-expand] auto expansion finished');
  await mkdir(path.dirname(discoveredOutPath), { recursive: true });
  await mkdir(path.dirname(input.outPath), { recursive: true });
  await mkdir(path.dirname(metaOutPath), { recursive: true });
  await mkdir(input.workdir, { recursive: true });

  if (!input.dryRun) {
    log('[auto-expand] writing auto seed files');
    await writeFile(discoveredOutPath, safeJsonStringify(discoveredSeeds, 2), 'utf8');
    await writeFile(input.outPath, safeJsonStringify(mergedSeeds, 2), 'utf8');
  }

  const meta = {
    generatedAt,
    basePath: input.basePath,
    outPath: input.outPath,
    targetCount: input.targetCount,
    chains: input.chains,
    profileOrder,
    profileFilters,
    autoDiscoveredCount: discoveredSeeds.length,
    discoveredFromProfilesCount,
    discoveredFromSearchQueriesCount,
    baseSeedCount: baseSeeds.length,
    finalSeedCount: mergedSeeds.length,
    includeQueryDiscovery,
    queryDiagnostics,
    warnings,
    discoveredFromProfiles: selected.map((x) => ({
      profile: x.profile,
      chain: x.candidate.chain,
      tokenAddress: x.candidate.tokenAddress,
      symbol: x.candidate.symbol,
      score: x.candidate.score,
      source: x.candidate.source,
    })),
  };

  const report = {
    generatedAt,
    dryRun: input.dryRun,
    summary: {
      baseSeedCount: baseSeeds.length,
      discoveredFromProfilesCount,
      discoveredFromSearchQueriesCount,
      autoDiscoveredCount: discoveredSeeds.length,
      finalSeedCount: mergedSeeds.length,
      seedGrowth: mergedSeeds.length - baseSeeds.length,
      targetCount: input.targetCount,
      queriesUsed,
      queryCount: queriesUsed.length,
      acceptedByChain,
      acceptedByProfile,
      skippedReasonCounts: queryDiagnostics.skippedReasons,
      insufficientAutoCandidates: discoveredSeeds.length < input.targetCount,
    },
    topAcceptedSeeds: selected.slice(0, 10).map((x) => ({
      chain: x.candidate.chain,
      tokenAddress: x.candidate.tokenAddress,
      symbol: x.candidate.symbol,
      profile: x.profile,
      source: x.candidate.source,
      sourceQuery: x.candidate.sourceQuery,
      liquidityUsd: x.candidate.liquidityUsd,
      marketCap: x.candidate.marketCap,
      fdv: x.candidate.fdv,
    })),
    topSkippedReasons: Object.entries(queryDiagnostics.skippedReasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([reason, count]) => ({ reason, count })),
    queryDiscovery: queryDiagnostics,
    warnings,
    recommendedNextCommands: [
      `npm run discovery:auto-run -- --input ${input.outPath} --out output/discovery-auto-run-v1 --max-buyers 200 --max-hours 24 --min-token-appearances 2 --persist false --csv true`,
      'npm run analyze:seed-batch -- --input data/seed-tokens.keep.json --max-buyers 200 --max-hours 24 --min-token-appearances 2 --persist false --csv true --out output/seed-batch-keep-baseline',
    ],
  };

  if (mergedSeeds.length <= baseSeeds.length) {
    report.recommendedNextCommands.push(
      'Try custom query discovery: npm run seeds:auto-expand -- --base data/seed-tokens.keep.json --out data/seed-tokens.auto-next.json --target-count 30 --include-query-discovery true --queries pepe,wojak,cult,mog,turbo,neiro,ai,agent',
    );
    report.recommendedNextCommands.push('Add manual seeds to data/seed-tokens.keep.json, then rerun discovery:auto');
    report.recommendedNextCommands.push('If counts remain low, improve market data source coverage and rerun with looser filters.');
  }

  await writeFile(metaOutPath, safeJsonStringify(meta, 2), 'utf8');
  await writeFile(reportPath, safeJsonStringify(report, 2), 'utf8');

  return {
    generatedAt,
    baseSeedCount: baseSeeds.length,
    autoDiscoveredCount: discoveredSeeds.length,
    discoveredFromProfilesCount,
    discoveredFromSearchQueriesCount,
    finalSeedCount: mergedSeeds.length,
    targetCount: input.targetCount,
    queriesUsed,
    queryCount: queriesUsed.length,
    seedGrowth: mergedSeeds.length - baseSeeds.length,
    acceptedByChain,
    acceptedByProfile,
    skippedReasonCounts: queryDiagnostics.skippedReasons,
    warnings,
    outputFiles: {
      autoDiscoveredJson: discoveredOutPath,
      mergedNextJson: input.outPath,
      mergedNextMetaJson: metaOutPath,
      reportJson: reportPath,
    },
  };
}

export async function autoRunDiscovery(
  input: AutoRunDiscoveryInput,
  deps: {
    run?: typeof runSeedBatch;
  } = {},
): Promise<AutoRunDiscoveryResult> {
  const run = deps.run ?? runSeedBatch;
  const log = input.log ?? ((message: string) => console.log(message));
  log('[auto-run] starting seed batch');
  log(`[auto-run] seed input: ${input.inputPath}`);
  log(
    `[auto-run] batch params: maxBuyers=${input.maxBuyers}, maxHours=${input.maxHours}, minTokenAppearances=${input.minTokenAppearances}, onlyUsefulSeeds=${input.onlyUsefulSeeds ?? true}`,
  );
  const runResult = await run({
    inputPath: input.inputPath,
    outDir: input.outDir,
    maxBuyers: input.maxBuyers,
    maxHoursAfterCreation: input.maxHours,
    minTokenAppearances: input.minTokenAppearances,
    persist: input.persist,
    csv: input.csv,
    onlyUsefulSeeds: input.onlyUsefulSeeds ?? true,
  });
  log(`[auto-run] batch finished. output directory: ${input.outDir}`);

  const warnings: string[] = [];
  if (runResult.summary.candidateWalletsFound === 0) {
    warnings.push('candidate_count_zero: add manual seeds later; use stable RPC; retry with larger max-hours; lower min-token-appearances only for debugging');
  }

  if (runResult.summary.candidateWalletsFound < 3) {
    warnings.push('candidate_count_low: try broader queries; use stable RPC; run wider batch; add curated manual seeds later');
  }

  return {
    runResult,
    warnings,
    nextRecommendedCommand:
      'npm run discovery:auto -- --target-count 30 --include-query-discovery true --batch-max-buyers 50 --batch-max-hours 6 --max-per-query 10',
  };
}