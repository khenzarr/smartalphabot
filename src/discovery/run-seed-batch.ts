import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SupportedChain } from '../chains/chain.types.js';
import { env } from '../config/env.js';
import { extractEarlyBuyers, type ExtractEarlyBuyersResult } from './extract-early-buyers.js';
import { seedTokenBatchSchema, type SeedTokenInput } from './seed-token-input.js';
import { aggregateCandidateWallets, type CandidateWallet } from './aggregate-candidate-wallets.js';
import { toCsv } from '../utils/csv.js';
import { safeJsonStringify, toJsonSafe } from '../utils/json.js';
import { createAnalysisJob, updateAnalysisJobResult } from '../db/repositories/analysis-job.repository.js';
import { upsertSeedBatchCandidateWallet } from '../db/repositories/wallet.repository.js';
import { createWalletScoreSnapshot } from '../db/repositories/wallet-score-snapshot.repository.js';
import { analyzeWallet } from '../analysis/wallet-analyzer.js';

export interface SeedBatchRunInput {
  inputPath: string;
  maxBuyers?: number;
  maxHoursAfterCreation?: number;
  maxBlocksAfterCreation?: number;
  minTokenAppearances?: number;
  persist?: boolean;
  json?: boolean;
  csv?: boolean;
  outDir?: string;
  enrichWallets?: boolean;
  walletSource?: 'persisted' | 'mock' | 'provider';
  maxWalletsToEnrich?: number;
  maxWalletTrades?: number;
  includeCrossChainOverlap?: boolean;
  onlyUsefulSeeds?: boolean;
  shortlistMinAppearances?: number;
  shortlistMinScore?: number;
  shortlistMaxAverageRank?: number;
  shortlistIncludeRejected?: boolean;
}

export type SeedCurationRecommendedAction =
  | 'keep_for_future_batches'
  | 'drop_from_seed_pool'
  | 'retry_with_better_rpc'
  | 'investigate_parser_or_pair_selection'
  | 'retry_with_wider_window'
  | 'retry_with_smaller_window';

export interface CuratedSeedItem {
  chain: string;
  tokenAddress: string;
  label?: string;
  narrative?: string;
  notes?: string;
  seedTriageStatus: SeedTriageStatus;
  seedTriageReason: string;
  buyersFound: number;
  parserType?: string;
  dexId?: string;
  poolAddress?: string;
  warningsCount: number;
  usefulnessScore?: number;
  lastAnalyzedAt: string;
  recommendedAction: SeedCurationRecommendedAction;
}

export interface CandidateShortlistItem {
  rank: number;
  chain: SupportedChain;
  walletAddress: string;
  score: number;
  category: string;
  tokenAppearances: number;
  tokensAppearedIn: string[];
  narratives: string[];
  averageFirstBuyRank: number;
  bestFirstBuyRank: number;
  totalBuyCountAcrossSeeds: number;
  earliestObservedBuyAt: string;
  reasons: string[];
  riskFlags: string[];
  evidenceSummary: string;
  monitorRecommendation: 'monitor_candidate' | 'watch_after_pnl_enrichment' | 'ignore_low_sample' | 'investigate_high_activity';
}

export type SeedTriageStatus =
  | 'keep'
  | 'weak_seed'
  | 'dense_pool'
  | 'unsupported_pool'
  | 'zero_buyers'
  | 'failed'
  | 'investigate';

export interface SeedBatchTokenResult {
  seed: SeedTokenInput | { chain: string; tokenAddress: string; label?: string; narrative?: string; notes?: string };
  status: 'success' | 'failed' | 'skipped';
  result?: ExtractEarlyBuyersResult;
  error?: string;
  warnings: string[];
  seedTriageStatus: SeedTriageStatus;
  seedTriageReason: string;
}

export interface SeedBatchRunResult {
  generatedAt: string;
  inputSummary: {
    inputPath: string;
    totalSeedTokens: number;
    maxBuyers: number;
    maxHoursAfterCreation: number;
    maxBlocksAfterCreation: number;
    minTokenAppearances: number;
    persist: boolean;
    enrichWallets: boolean;
    walletSource: 'persisted' | 'mock' | 'provider';
    maxWalletsToEnrich: number;
    maxWalletTrades: number;
    onlyUsefulSeeds: boolean;
  };
  summary: {
    analyzed: number;
    succeeded: number;
    failed: number;
    skipped: number;
    totalUniqueEarlyBuyers: number;
    candidateWalletsFound: number;
  };
  tokenResults: SeedBatchTokenResult[];
  candidates: CandidateWallet[];
  warnings: string[];
  errors: Array<{ tokenAddress: string; chain: string; error: string }>;
  outputFiles: Record<string, string>;
  seedCuration: {
    keep: CuratedSeedItem[];
    drop: CuratedSeedItem[];
    investigate: CuratedSeedItem[];
  };
  candidateShortlist: CandidateShortlistItem[];
}

function buildCandidateCsvRows(candidates: CandidateWallet[]) {
  return candidates.map((candidate) =>
    toJsonSafe({
      rank: candidate.rank,
      chain: candidate.chain,
      walletAddress: candidate.walletAddress,
      score: candidate.scoreResult.score,
      category: candidate.scoreResult.category,
      tokenAppearances: candidate.tokenAppearances,
      averageFirstBuyRank: candidate.averageFirstBuyRank,
      medianFirstBuyRank: candidate.medianFirstBuyRank,
      bestFirstBuyRank: candidate.bestFirstBuyRank,
      totalBuyCountAcrossSeeds: candidate.totalBuyCountAcrossSeeds,
      earliestObservedBuyAt: candidate.earliestObservedBuyAt.toISOString(),
      tokensAppearedIn: candidate.labelsOrTokensAppearedIn,
      narratives: candidate.narratives,
      warningCount: candidate.warningCount,
      winRate: candidate.walletEnrichment?.winRate,
      totalRealizedPnlUsd: candidate.walletEnrichment?.totalRealizedPnlUsd,
      totalUnrealizedPnlUsd: candidate.walletEnrichment?.totalUnrealizedPnlUsd,
      totalPnlUsd: candidate.walletEnrichment?.approximateTotalPnlUsd,
      medianRoi: candidate.walletEnrichment?.medianRoi,
      averageHoldSeconds: candidate.walletEnrichment?.averageHoldSeconds,
      enrichedScore: candidate.walletEnrichment?.score,
      enrichedCategory: candidate.walletEnrichment?.category,
      reasons: candidate.scoreResult.reasons,
      riskFlags: candidate.scoreResult.riskFlags,
    }) as Record<string, unknown>,
  );
}

type SuccessfulSeedResult = SeedBatchTokenResult & { seed: SeedTokenInput; status: 'success'; result: ExtractEarlyBuyersResult };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function getNumberLike(value: unknown): number | string | undefined {
  if (typeof value === 'number' || typeof value === 'string') return value;
  return undefined;
}

export function deriveSeedTriage(input: {
  status: SeedBatchTokenResult['status'];
  parserType?: unknown;
  buyersFound: number;
  warnings: string[];
  error?: string;
}): { seedTriageStatus: SeedTriageStatus; seedTriageReason: string } {
  const parserType = typeof input.parserType === 'string' ? input.parserType : undefined;
  const warningSet = new Set(input.warnings);
  const errorText = input.error ?? '';

  if (input.status === 'failed') {
    if (errorText.includes('rpc') || errorText.includes('provider') || errorText.includes('rate')) {
      return { seedTriageStatus: 'failed', seedTriageReason: 'rpc_or_provider_error' };
    }
    return { seedTriageStatus: 'failed', seedTriageReason: input.error ?? 'seed_failed' };
  }

  if (parserType === 'unsupported' || warningSet.has('unsupported_pool_parser')) {
    return { seedTriageStatus: 'unsupported_pool', seedTriageReason: 'unsupported_pool_parser' };
  }

  if (
    warningSet.has('max_adaptive_splits_reached') ||
    warningSet.has('dense_pool_scan_guardrail_hit') ||
    [...warningSet].some((w) => w.includes('max_adaptive_splits_reached'))
  ) {
    return { seedTriageStatus: 'dense_pool', seedTriageReason: 'dense_pool_scan_guardrail_hit' };
  }

  if (input.status === 'skipped') {
    return { seedTriageStatus: 'weak_seed', seedTriageReason: 'skipped_for_current_phase' };
  }

  if (input.buyersFound > 0 && parserType && parserType !== 'unsupported') {
    return { seedTriageStatus: 'keep', seedTriageReason: 'supported_parser_with_buyers' };
  }

  if (input.buyersFound > 0 && !parserType) {
    return { seedTriageStatus: 'keep', seedTriageReason: 'buyers_found_parser_not_reported' };
  }

  if (input.buyersFound === 0 && parserType && parserType !== 'unsupported') {
    return { seedTriageStatus: 'zero_buyers', seedTriageReason: 'supported_parser_zero_buyers' };
  }

  if (input.buyersFound === 0 && input.status === 'success') {
    return { seedTriageStatus: 'zero_buyers', seedTriageReason: 'zero_buyers_in_bounded_window' };
  }

  return { seedTriageStatus: 'investigate', seedTriageReason: 'ambiguous_seed_diagnostics' };
}

function buildTokenBuyerSummaryRows(tokenResults: SeedBatchTokenResult[]) {
  return tokenResults.map((item) => {
    const result = item.result;
    const tokenProfile = result?.tokenProfile;
    const classification = asRecord(result?.poolClassification);
    const scanMetadata = asRecord(result?.scanMetadata);
    const logSummary = Array.isArray(scanMetadata?.logSummary) ? scanMetadata.logSummary : [];
    const logsScannedFromSummary = logSummary.reduce((sum, row) => {
      const record = asRecord(row);
      const count = getNumberLike(record?.count);
      const parsed = typeof count === 'string' ? Number(count) : count;
      return sum + (typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : 0);
    }, 0);
    const logsScanned =
      (typeof scanMetadata?.logsScanned === 'number' ? scanMetadata.logsScanned : undefined) ?? logsScannedFromSummary;
    const firstBuyer = result?.earliestBuyers[0];
    const topWarnings = [...(item.warnings ?? [])].slice(0, 5);

    return toJsonSafe({
      chain: item.seed.chain,
      tokenLabel: 'label' in item.seed && item.seed.label ? item.seed.label : result?.tokenProfile?.symbol ?? item.seed.tokenAddress,
      tokenSymbol: tokenProfile?.symbol,
      tokenAddress: item.seed.tokenAddress,
      narrative: 'narrative' in item.seed ? item.seed.narrative : undefined,
      status: item.status,
      parserType: classification?.parserType,
      dexId: tokenProfile?.dexId,
      poolAddress: tokenProfile?.poolAddress ?? tokenProfile?.pairAddress,
      marketCap: tokenProfile?.marketCap,
      liquidityUsd: tokenProfile?.liquidityUsd,
      pairCreatedAt: tokenProfile?.pairCreatedAt?.toISOString(),
      buyersFound: result?.earliestBuyers.length ?? 0,
      uniqueBuyersFound: result?.earliestBuyers.length ?? 0,
      firstBuyerWallet: firstBuyer?.walletAddress,
      firstBuyerTimestamp: firstBuyer?.firstBuyTimestamp?.toISOString(),
      firstBuyerTxHash: firstBuyer?.firstBuyTxHash,
      firstBuyerBlockNumber: firstBuyer?.firstBuyBlockNumber,
      scanFromBlock: getNumberLike(scanMetadata?.fromBlock),
      scanToBlock: getNumberLike(scanMetadata?.toBlock),
      topicFilterUsed: scanMetadata?.topicFilterUsed,
      swapTopic: scanMetadata?.swapTopic,
      logsScanned,
      tradesExtracted: getNumberLike(scanMetadata?.tradesExtracted),
      adaptiveChunkingUsed: scanMetadata?.adaptiveChunkingUsed,
      chunkReductions: getNumberLike(scanMetadata?.chunkReductions),
      failedChunksCount: Array.isArray(scanMetadata?.failedChunks) ? scanMetadata.failedChunks.length : 0,
      minChunkSizeReached: scanMetadata?.minChunkSizeReached,
      warningsCount: item.warnings.length,
      topWarnings,
      seedTriageStatus: item.seedTriageStatus,
      seedTriageReason: item.seedTriageReason,
    }) as Record<string, unknown>;
  });
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toCuratedSeedItem(
  item: SeedBatchTokenResult,
  usefulnessScoreByKey: Map<string, number>,
  generatedAt: string,
): CuratedSeedItem {
  const tokenProfile = item.result?.tokenProfile;
  const parserType = asString(asRecord(item.result?.poolClassification)?.parserType);
  const buyersFound = item.result?.earliestBuyers.length ?? 0;
  const key = `${item.seed.chain}:${item.seed.tokenAddress.toLowerCase()}`;
  const usefulnessScore = usefulnessScoreByKey.get(key);

  let recommendedAction: SeedCurationRecommendedAction = 'investigate_parser_or_pair_selection';
  if (item.seedTriageStatus === 'keep') {
    recommendedAction = 'keep_for_future_batches';
  } else if (
    item.seedTriageStatus === 'zero_buyers' ||
    item.seedTriageStatus === 'unsupported_pool' ||
    item.seedTriageStatus === 'dense_pool' ||
    item.seedTriageStatus === 'weak_seed'
  ) {
    recommendedAction = item.seedTriageStatus === 'dense_pool' ? 'retry_with_smaller_window' : 'drop_from_seed_pool';
  } else if (item.seedTriageStatus === 'failed') {
    const reason = `${item.seedTriageReason} ${item.error ?? ''}`.toLowerCase();
    if (reason.includes('rpc') || reason.includes('provider') || reason.includes('rate')) {
      recommendedAction = 'retry_with_better_rpc';
    } else {
      recommendedAction = 'investigate_parser_or_pair_selection';
    }
  } else if (buyersFound > 0 && parserType && usefulnessScore !== undefined && usefulnessScore < 5) {
    recommendedAction = 'retry_with_wider_window';
  }

  return {
    chain: item.seed.chain,
    tokenAddress: item.seed.tokenAddress,
    label: 'label' in item.seed ? item.seed.label : undefined,
    narrative: 'narrative' in item.seed ? item.seed.narrative : undefined,
    notes: 'notes' in item.seed ? item.seed.notes : undefined,
    seedTriageStatus: item.seedTriageStatus,
    seedTriageReason: item.seedTriageReason,
    buyersFound,
    parserType,
    dexId: tokenProfile?.dexId,
    poolAddress: tokenProfile?.poolAddress ?? tokenProfile?.pairAddress,
    warningsCount: item.warnings.length,
    usefulnessScore,
    lastAnalyzedAt: generatedAt,
    recommendedAction,
  };
}

function buildSeedCurationLists(input: {
  tokenResults: SeedBatchTokenResult[];
  tokenOverlapSummaryRows: Record<string, unknown>[];
  generatedAt: string;
}) {
  const usefulnessScoreByKey = new Map<string, number>();
  for (const row of input.tokenOverlapSummaryRows) {
    const chain = asString(row.chain);
    const tokenAddress = asString(row.tokenAddress);
    const usefulnessScore = typeof row.usefulnessScore === 'number' ? row.usefulnessScore : undefined;
    if (chain && tokenAddress && usefulnessScore !== undefined) {
      usefulnessScoreByKey.set(`${chain}:${tokenAddress.toLowerCase()}`, usefulnessScore);
    }
  }

  const curated = input.tokenResults.map((item) => toCuratedSeedItem(item, usefulnessScoreByKey, input.generatedAt));

  const keep = curated.filter(
    (x) =>
      x.seedTriageStatus === 'keep' &&
      x.buyersFound > 0 &&
      x.parserType !== undefined &&
      x.parserType !== 'unsupported',
  );

  const dropStatuses: SeedTriageStatus[] = ['zero_buyers', 'unsupported_pool', 'dense_pool', 'failed', 'weak_seed'];
  const drop = curated.filter((x) => dropStatuses.includes(x.seedTriageStatus));

  const investigate = curated.filter((x) => {
    if (keep.some((k) => k.chain === x.chain && k.tokenAddress.toLowerCase() === x.tokenAddress.toLowerCase())) return false;
    if (drop.some((d) => d.chain === x.chain && d.tokenAddress.toLowerCase() === x.tokenAddress.toLowerCase())) {
      return x.seedTriageStatus === 'failed' && x.recommendedAction !== 'drop_from_seed_pool';
    }
    if (x.seedTriageStatus === 'investigate') return true;
    if (x.parserType && x.parserType !== 'unsupported' && x.buyersFound > 0 && x.buyersFound <= 1) return true;
    return false;
  });

  return { keep, drop, investigate };
}

function buildCandidateShortlist(input: {
  candidates: CandidateWallet[];
  minAppearances: number;
  minScore: number;
  maxAverageRank: number;
  includeRejected: boolean;
}): CandidateShortlistItem[] {
  const shortlist = input.candidates
    .filter((candidate) => {
      const byThreshold =
        candidate.tokenAppearances >= input.minAppearances &&
        candidate.scoreResult.score >= input.minScore &&
        candidate.averageFirstBuyRank <= input.maxAverageRank;
      const includeRejected = input.includeRejected && candidate.scoreResult.category === 'rejected';
      return byThreshold || includeRejected;
    })
    .map((candidate) => {
      const hasLowSample = candidate.scoreResult.riskFlags.some((flag) => flag.includes('low_sample'));
      const hasHighActivity = candidate.totalBuyCountAcrossSeeds >= 20;
      let monitorRecommendation: CandidateShortlistItem['monitorRecommendation'] = 'watch_after_pnl_enrichment';
      if (hasLowSample) monitorRecommendation = 'ignore_low_sample';
      else if (hasHighActivity) monitorRecommendation = 'investigate_high_activity';
      else if (candidate.tokenAppearances >= 3 && candidate.scoreResult.score >= 50) monitorRecommendation = 'monitor_candidate';

      const topEvidence = [...candidate.evidence]
        .sort((a, b) => a.firstBuyRank - b.firstBuyRank)
        .slice(0, 3)
        .map((e) => `${e.tokenLabel ?? e.tokenAddress}#${e.firstBuyRank}`)
        .join('; ');

      return {
        rank: candidate.rank,
        chain: candidate.chain,
        walletAddress: candidate.walletAddress,
        score: candidate.scoreResult.score,
        category: candidate.scoreResult.category,
        tokenAppearances: candidate.tokenAppearances,
        tokensAppearedIn: candidate.labelsOrTokensAppearedIn,
        narratives: candidate.narratives,
        averageFirstBuyRank: candidate.averageFirstBuyRank,
        bestFirstBuyRank: candidate.bestFirstBuyRank,
        totalBuyCountAcrossSeeds: candidate.totalBuyCountAcrossSeeds,
        earliestObservedBuyAt: candidate.earliestObservedBuyAt.toISOString(),
        reasons: candidate.scoreResult.reasons,
        riskFlags: candidate.scoreResult.riskFlags,
        evidenceSummary: topEvidence,
        monitorRecommendation,
      } as CandidateShortlistItem;
    })
    .sort((a, b) => {
      if (a.monitorRecommendation !== b.monitorRecommendation) return a.monitorRecommendation.localeCompare(b.monitorRecommendation);
      if (b.tokenAppearances !== a.tokenAppearances) return b.tokenAppearances - a.tokenAppearances;
      if (b.score !== a.score) return b.score - a.score;
      return a.walletAddress.localeCompare(b.walletAddress);
    })
    .map((item, index) => ({ ...item, rank: index + 1 }));

  return shortlist;
}

function buildCandidateEvidenceRows(candidates: CandidateWallet[]) {
  return candidates.flatMap((candidate) =>
    candidate.evidence.map((evidence) =>
      toJsonSafe({
        rank: candidate.rank,
        chain: candidate.chain,
        walletAddress: candidate.walletAddress,
        candidateScore: candidate.scoreResult.score,
        candidateCategory: candidate.scoreResult.category,
        tokenAppearances: candidate.tokenAppearances,
        tokenLabel: evidence.tokenLabel,
        tokenSymbol: evidence.tokenSymbol,
        tokenAddress: evidence.tokenAddress,
        narrative: evidence.narrative,
        firstBuyRank: evidence.firstBuyRank,
        firstBuyBlockNumber: evidence.firstBuyBlockNumber,
        firstBuyTimestamp: evidence.firstBuyTimestamp.toISOString(),
        firstBuyTxHash: evidence.firstBuyTxHash,
        buyCount: evidence.buyCount,
        warningsCount: evidence.warnings.length,
        warnings: evidence.warnings,
      }) as Record<string, unknown>,
    ),
  );
}

function buildWalletOverlapMatrixRows(successful: SuccessfulSeedResult[], includeCrossChainOverlap: boolean) {
  const tokenWalletSets = successful.map((item) => ({
    chain: item.result.chain,
    tokenLabel: item.seed.label ?? item.result.tokenProfile?.symbol ?? item.result.tokenAddress,
    tokenSymbol: item.result.tokenProfile?.symbol,
    tokenAddress: item.result.tokenAddress,
    wallets: new Set(item.result.earliestBuyers.map((b) => b.walletAddress.toLowerCase())),
  }));

  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < tokenWalletSets.length; i += 1) {
    for (let j = i + 1; j < tokenWalletSets.length; j += 1) {
      const a = tokenWalletSets[i];
      const b = tokenWalletSets[j];
      if (!a || !b) continue;
      if (!includeCrossChainOverlap && a.chain !== b.chain) continue;

      const overlapWallets = [...a.wallets].filter((wallet) => b.wallets.has(wallet));
      const overlapWalletCount = overlapWallets.length;
      const overlapRateA = a.wallets.size > 0 ? Number((overlapWalletCount / a.wallets.size).toFixed(6)) : 0;
      const overlapRateB = b.wallets.size > 0 ? Number((overlapWalletCount / b.wallets.size).toFixed(6)) : 0;

      rows.push(
        toJsonSafe({
          chainA: a.chain,
          tokenLabelA: a.tokenLabel,
          tokenSymbolA: a.tokenSymbol,
          tokenAddressA: a.tokenAddress,
          chainB: b.chain,
          tokenLabelB: b.tokenLabel,
          tokenSymbolB: b.tokenSymbol,
          tokenAddressB: b.tokenAddress,
          overlapWalletCount,
          overlapWalletsSample: overlapWallets.slice(0, 5),
          overlapRateA,
          overlapRateB,
        }) as Record<string, unknown>,
      );
    }
  }

  return rows;
}

function buildTokenOverlapSummaryRows(tokenRows: Record<string, unknown>[], matrixRows: Record<string, unknown>[]) {
  const overlapByToken = new Map<string, Record<string, unknown>[]>();
  for (const row of matrixRows) {
    const keyA = `${row.chainA}:${String(row.tokenAddressA).toLowerCase()}`;
    const keyB = `${row.chainB}:${String(row.tokenAddressB).toLowerCase()}`;
    overlapByToken.set(keyA, [...(overlapByToken.get(keyA) ?? []), row]);
    overlapByToken.set(keyB, [...(overlapByToken.get(keyB) ?? []), row]);
  }

  return tokenRows.map((token) => {
    const key = `${token.chain}:${String(token.tokenAddress).toLowerCase()}`;
    const tokenOverlaps = overlapByToken.get(key) ?? [];
    let strongestOverlapCount = 0;
    let strongestOverlapTokenLabel: string | undefined;
    let strongestOverlapTokenSymbol: string | undefined;
    let totalOverlappingWallets = 0;

    for (const overlap of tokenOverlaps) {
      const overlapCount = Number(overlap.overlapWalletCount ?? 0);
      totalOverlappingWallets += overlapCount;
      if (overlapCount > strongestOverlapCount) {
        strongestOverlapCount = overlapCount;
        const isA = `${overlap.chainA}:${String(overlap.tokenAddressA).toLowerCase()}` === key;
        strongestOverlapTokenLabel = String(isA ? overlap.tokenLabelB : overlap.tokenLabelA);
        strongestOverlapTokenSymbol = String(isA ? overlap.tokenSymbolB : overlap.tokenSymbolA);
      }
    }

    const buyersFound = Number(token.buyersFound ?? 0);
    const warningsCount = Number(token.warningsCount ?? 0);
    const overlapWithOtherTokensCount = tokenOverlaps.filter((x) => Number(x.overlapWalletCount ?? 0) > 0).length;
    const usefulnessScore = Number(
      (buyersFound + totalOverlappingWallets * 2 + overlapWithOtherTokensCount * 3 - warningsCount * 1.5).toFixed(4),
    );

    return toJsonSafe({
      chain: token.chain,
      tokenLabel: token.tokenLabel,
      tokenSymbol: token.tokenSymbol,
      tokenAddress: token.tokenAddress,
      buyersFound,
      overlapWithOtherTokensCount,
      totalOverlappingWallets,
      strongestOverlapTokenLabel,
      strongestOverlapTokenSymbol,
      strongestOverlapCount,
      usefulnessScore,
      seedTriageStatus: token.seedTriageStatus,
      seedTriageReason: token.seedTriageReason,
    }) as Record<string, unknown>;
  });
}

export async function runSeedBatch(input: SeedBatchRunInput): Promise<SeedBatchRunResult> {
  const maxBuyers = input.maxBuyers ?? 100;
  const maxHoursAfterCreation = input.maxHoursAfterCreation ?? 6;
  const maxBlocksAfterCreation = input.maxBlocksAfterCreation ?? 20_000;
  const minTokenAppearances = input.minTokenAppearances ?? 2;
  const persist = input.persist ?? false;
  const csv = input.csv ?? true;
  const outDir = input.outDir ?? 'output/seed-batch';
  const enrichWallets = input.enrichWallets ?? false;
  const walletSource = input.walletSource ?? 'persisted';
  const maxWalletsToEnrich = input.maxWalletsToEnrich ?? 50;
  const maxWalletTrades = input.maxWalletTrades ?? 1000;
  const includeCrossChainOverlap = input.includeCrossChainOverlap ?? false;
  const onlyUsefulSeeds = input.onlyUsefulSeeds ?? false;
  const shortlistMinAppearances = input.shortlistMinAppearances ?? 2;
  const shortlistMinScore = input.shortlistMinScore ?? 40;
  const shortlistMaxAverageRank = input.shortlistMaxAverageRank ?? 150;
  const shortlistIncludeRejected = input.shortlistIncludeRejected ?? true;

  if (persist && !env.DATABASE_URL) {
    throw new Error('persist_requested_but_database_url_missing');
  }

  const raw = await readFile(input.inputPath, 'utf8');
  const parsedJson = JSON.parse(raw);
  if (!Array.isArray(parsedJson)) {
    throw new Error('seed_batch_input_must_be_array');
  }

  await mkdir(outDir, { recursive: true });

  const tokenResults: SeedBatchTokenResult[] = [];
  const warnings: string[] = [];
  const errors: Array<{ tokenAddress: string; chain: string; error: string }> = [];

  let batchJobId: string | undefined;
  const batchChain = ((parsedJson.find((x) => x && typeof x === 'object' && typeof x.chain === 'string' && x.chain !== 'solana') as {
    chain?: SupportedChain;
  })?.chain ?? 'ethereum') as SupportedChain;

  if (persist) {
    const batchJob = await createAnalysisJob({
      chain: batchChain,
      jobType: 'seed_batch_analysis',
      targetType: 'seed_batch',
      targetValue: path.basename(input.inputPath),
      status: 'running',
      input,
    });
    batchJobId = batchJob.id;
  }

  const validSeeds: SeedTokenInput[] = [];
  for (const item of parsedJson) {
    const parsedSeed = seedTokenBatchSchema.element.safeParse(item);
    if (!parsedSeed.success) {
      const chain = typeof (item as { chain?: unknown })?.chain === 'string' ? String((item as { chain?: string }).chain) : 'unknown';
      const tokenAddress =
        typeof (item as { tokenAddress?: unknown })?.tokenAddress === 'string'
          ? String((item as { tokenAddress?: string }).tokenAddress)
          : 'unknown';
      const warning = `invalid_seed_token_input: ${parsedSeed.error.issues.map((x) => x.message).join(';')}`;
      errors.push({ tokenAddress, chain, error: warning });
      tokenResults.push({
        seed: {
          chain,
          tokenAddress,
          label: typeof (item as { label?: unknown })?.label === 'string' ? (item as { label?: string }).label : undefined,
          narrative:
            typeof (item as { narrative?: unknown })?.narrative === 'string'
              ? (item as { narrative?: string }).narrative
              : undefined,
          notes: typeof (item as { notes?: unknown })?.notes === 'string' ? (item as { notes?: string }).notes : undefined,
        },
        status: 'failed',
        warnings: [warning],
        error: warning,
        seedTriageStatus: 'failed',
        seedTriageReason: 'invalid_seed_input',
      });
      continue;
    }
    validSeeds.push(parsedSeed.data);
  }

  for (const seed of validSeeds) {
    if (seed.chain === 'solana') {
      const warning = 'Solana batch discovery is not implemented yet.';
      warnings.push(`${seed.tokenAddress}: ${warning}`);
      tokenResults.push({
        seed,
        status: 'skipped',
        warnings: [warning],
        seedTriageStatus: 'weak_seed',
        seedTriageReason: 'solana_not_supported_in_this_phase',
      });
      continue;
    }

    try {
      const result = await extractEarlyBuyers({
        chain: seed.chain,
        tokenAddress: seed.tokenAddress,
        maxBuyers,
        maxHoursAfterCreation,
        maxBlocksAfterCreation,
        persist,
      });
      const triage = deriveSeedTriage({
        status: 'success',
        parserType: (result.poolClassification as Record<string, unknown> | undefined)?.parserType,
        buyersFound: result.earliestBuyers.length,
        warnings: result.warnings,
      });
      tokenResults.push({
        seed,
        status: 'success',
        result,
        warnings: result.warnings,
        seedTriageStatus: triage.seedTriageStatus,
        seedTriageReason: triage.seedTriageReason,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_seed_token_error';
      errors.push({ tokenAddress: seed.tokenAddress, chain: seed.chain, error: message });
      const triage = deriveSeedTriage({ status: 'failed', buyersFound: 0, warnings: [], error: message });
      tokenResults.push({
        seed,
        status: 'failed',
        error: message,
        warnings: [],
        seedTriageStatus: triage.seedTriageStatus,
        seedTriageReason: triage.seedTriageReason,
      });
    }
  }

  const successful = tokenResults.filter((x): x is SuccessfulSeedResult => x.status === 'success' && Boolean(x.result));
  const successfulForCandidates = onlyUsefulSeeds
    ? successful.filter((x) => x.seedTriageStatus === 'keep')
    : successful;

  const candidates = aggregateCandidateWallets({
    tokenResults: successfulForCandidates.map((x) => ({ seed: x.seed, result: x.result })),
    minTokenAppearances,
  });

  if (enrichWallets && candidates.length) {
    const limit = Math.max(0, Math.min(maxWalletsToEnrich, candidates.length));
    for (let i = 0; i < limit; i += 1) {
      const candidate = candidates[i];
      if (!candidate) continue;

      try {
        const walletAnalysis = await analyzeWallet({
          chain: candidate.chain,
          walletAddress: candidate.walletAddress,
          source: walletSource,
          maxTrades: maxWalletTrades,
          enrichPrices: true,
          persist: false,
        });

        candidate.walletEnrichment = {
          source: walletSource,
          analyzedTradeCount: walletAnalysis.summary.totalTrades,
          analyzedTokenCount: walletAnalysis.summary.analyzedTokenCount,
          approximateTotalPnlUsd: walletAnalysis.summary.totalPnlUsd,
          totalRealizedPnlUsd: walletAnalysis.summary.totalRealizedPnlUsd,
          totalUnrealizedPnlUsd: walletAnalysis.summary.totalUnrealizedPnlUsd,
          winRate: walletAnalysis.summary.winRate,
          medianRoi: walletAnalysis.summary.medianRoi,
          averageHoldSeconds: walletAnalysis.summary.averageHoldSeconds,
          score: walletAnalysis.scoreResult.score,
          category: walletAnalysis.scoreResult.category,
          warnings: walletAnalysis.warnings,
          limitations: walletAnalysis.limitations,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'wallet_enrichment_failed';
        candidate.warnings.push(`wallet_enrichment_failed:${message}`);
        candidate.warningCount = new Set(candidate.warnings).size;
      }
    }
  }

  if (persist) {
    for (const candidate of candidates) {
      const wallet = await upsertSeedBatchCandidateWallet({
        chain: candidate.chain,
        address: candidate.walletAddress,
        scoreLatest: candidate.scoreResult.score,
        label: 'candidate',
      });

      await createWalletScoreSnapshot({
        walletId: wallet.id,
        chain: candidate.chain,
        score: candidate.scoreResult.score,
        category: candidate.scoreResult.category,
        reasons: candidate.scoreResult.reasons,
        riskFlags: candidate.scoreResult.riskFlags,
      });
    }
  }

  const uniqueWallets = new Set(
    successful.flatMap((x) => x.result.earliestBuyers.map((buyer) => `${x.result.chain}:${buyer.walletAddress.toLowerCase()}`)),
  );

  const result: SeedBatchRunResult = {
    generatedAt: new Date().toISOString(),
    inputSummary: {
      inputPath: input.inputPath,
      totalSeedTokens: parsedJson.length,
      maxBuyers,
      maxHoursAfterCreation,
      maxBlocksAfterCreation,
      minTokenAppearances,
      persist,
      enrichWallets,
      walletSource,
      maxWalletsToEnrich,
      maxWalletTrades,
      onlyUsefulSeeds,
    },
    summary: {
      analyzed: parsedJson.length,
      succeeded: tokenResults.filter((x) => x.status === 'success').length,
      failed: tokenResults.filter((x) => x.status === 'failed').length,
      skipped: tokenResults.filter((x) => x.status === 'skipped').length,
      totalUniqueEarlyBuyers: uniqueWallets.size,
      candidateWalletsFound: candidates.length,
    },
    tokenResults,
    candidates,
    warnings: [...new Set(warnings.concat(candidates.flatMap((c) => c.warnings)))],
    errors,
    outputFiles: {},
    seedCuration: {
      keep: [],
      drop: [],
      investigate: [],
    },
    candidateShortlist: [],
  };

  const batchSummaryPath = path.join(outDir, 'batch-summary.json');
  const candidateJsonPath = path.join(outDir, 'candidate-wallets.json');
  const candidateCsvPath = path.join(outDir, 'candidate-wallets.csv');
  const tokenResultsPath = path.join(outDir, 'token-results.json');
  const errorsPath = path.join(outDir, 'errors.json');
  const tokenBuyerSummaryCsvPath = path.join(outDir, 'token-buyer-summary.csv');
  const tokenBuyerSummaryJsonPath = path.join(outDir, 'token-buyer-summary.json');
  const candidateEvidenceCsvPath = path.join(outDir, 'candidate-evidence.csv');
  const candidateEvidenceJsonPath = path.join(outDir, 'candidate-evidence.json');
  const walletOverlapMatrixCsvPath = path.join(outDir, 'wallet-overlap-matrix.csv');
  const walletOverlapMatrixJsonPath = path.join(outDir, 'wallet-overlap-matrix.json');
  const tokenOverlapSummaryCsvPath = path.join(outDir, 'token-overlap-summary.csv');
  const tokenOverlapSummaryJsonPath = path.join(outDir, 'token-overlap-summary.json');
  const nextSeedsKeepJsonPath = path.join(outDir, 'next-seeds.keep.json');
  const nextSeedsDropJsonPath = path.join(outDir, 'next-seeds.drop.json');
  const nextSeedsInvestigateJsonPath = path.join(outDir, 'next-seeds.investigate.json');
  const candidateShortlistCsvPath = path.join(outDir, 'candidate-shortlist.csv');
  const candidateShortlistJsonPath = path.join(outDir, 'candidate-shortlist.json');
  const outputIndexPath = path.join(outDir, 'output-index.json');

  const tokenBuyerSummaryRows = buildTokenBuyerSummaryRows(tokenResults);
  const candidateEvidenceRows = buildCandidateEvidenceRows(candidates);
  const walletOverlapMatrixRows = buildWalletOverlapMatrixRows(successful, includeCrossChainOverlap);
  const tokenOverlapSummaryRows = buildTokenOverlapSummaryRows(tokenBuyerSummaryRows, walletOverlapMatrixRows);
  const seedCuration = buildSeedCurationLists({
    tokenResults,
    tokenOverlapSummaryRows,
    generatedAt: result.generatedAt,
  });
  const candidateShortlist = buildCandidateShortlist({
    candidates,
    minAppearances: shortlistMinAppearances,
    minScore: shortlistMinScore,
    maxAverageRank: shortlistMaxAverageRank,
    includeRejected: shortlistIncludeRejected,
  });

  await writeFile(
    batchSummaryPath,
    safeJsonStringify(
      {
        generatedAt: result.generatedAt,
        inputSummary: result.inputSummary,
        summary: result.summary,
        warnings: result.warnings,
      },
      2,
    ),
    'utf8',
  );

  await writeFile(
    candidateJsonPath,
    safeJsonStringify(
      {
        generatedAt: result.generatedAt,
        inputSummary: result.inputSummary,
        rankingRules: [
          'Higher tokenAppearances first',
          'Lower averageFirstBuyRank first',
          'Lower medianFirstBuyRank first',
          'Higher scoreResult.score next',
          'Lower warningCount next',
          'Lexicographic walletAddress tiebreaker',
        ],
        limitations: ['Seed-batch score uses early-entry evidence only, not full realized PnL.'],
        candidates,
        warnings: result.warnings,
      },
      2,
    ),
    'utf8',
  );

  if (csv) {
    const rows = buildCandidateCsvRows(candidates);
    const csvText = toCsv(rows, [
      'rank',
      'chain',
      'walletAddress',
      'score',
      'category',
      'tokenAppearances',
      'averageFirstBuyRank',
      'medianFirstBuyRank',
      'bestFirstBuyRank',
      'totalBuyCountAcrossSeeds',
      'earliestObservedBuyAt',
      'tokensAppearedIn',
      'narratives',
      'warningCount',
      'winRate',
      'totalRealizedPnlUsd',
      'totalUnrealizedPnlUsd',
      'totalPnlUsd',
      'medianRoi',
      'averageHoldSeconds',
      'enrichedScore',
      'enrichedCategory',
      'reasons',
      'riskFlags',
    ]);
    await writeFile(candidateCsvPath, csvText, 'utf8');
  }

  await writeFile(
    tokenResultsPath,
    safeJsonStringify(
      tokenResults.map((item) => ({
        seed: item.seed,
        status: item.status,
        error: item.error,
        warnings: item.warnings,
        seedTriageStatus: item.seedTriageStatus,
        seedTriageReason: item.seedTriageReason,
        result: item.result
          ? {
              chain: item.result.chain,
              tokenAddress: item.result.tokenAddress,
              tokenProfile: item.result.tokenProfile,
              earliestBuyers: item.result.earliestBuyers,
              warnings: item.result.warnings,
              scanMetadata: item.result.scanMetadata,
              seedRecommendation: item.result.seedRecommendation,
            }
          : undefined,
      })),
      2,
    ),
    'utf8',
  );

  await writeFile(errorsPath, safeJsonStringify(errors, 2), 'utf8');

  await writeFile(tokenBuyerSummaryJsonPath, safeJsonStringify(tokenBuyerSummaryRows, 2), 'utf8');
  await writeFile(candidateEvidenceJsonPath, safeJsonStringify(candidateEvidenceRows, 2), 'utf8');
  await writeFile(walletOverlapMatrixJsonPath, safeJsonStringify(walletOverlapMatrixRows, 2), 'utf8');
  await writeFile(tokenOverlapSummaryJsonPath, safeJsonStringify(tokenOverlapSummaryRows, 2), 'utf8');
  await writeFile(nextSeedsKeepJsonPath, safeJsonStringify(seedCuration.keep, 2), 'utf8');
  await writeFile(nextSeedsDropJsonPath, safeJsonStringify(seedCuration.drop, 2), 'utf8');
  await writeFile(nextSeedsInvestigateJsonPath, safeJsonStringify(seedCuration.investigate, 2), 'utf8');
  await writeFile(candidateShortlistJsonPath, safeJsonStringify(candidateShortlist, 2), 'utf8');

  if (csv) {
    await writeFile(
      tokenBuyerSummaryCsvPath,
      toCsv(tokenBuyerSummaryRows, [
        'chain',
        'tokenLabel',
        'tokenSymbol',
        'tokenAddress',
        'narrative',
        'status',
        'parserType',
        'dexId',
        'poolAddress',
        'marketCap',
        'liquidityUsd',
        'pairCreatedAt',
        'buyersFound',
        'uniqueBuyersFound',
        'firstBuyerWallet',
        'firstBuyerTimestamp',
        'firstBuyerTxHash',
        'firstBuyerBlockNumber',
        'scanFromBlock',
        'scanToBlock',
        'logsScanned',
        'tradesExtracted',
        'adaptiveChunkingUsed',
        'chunkReductions',
        'failedChunksCount',
        'minChunkSizeReached',
        'warningsCount',
        'topWarnings',
        'seedTriageStatus',
        'seedTriageReason',
      ]),
      'utf8',
    );

    await writeFile(
      candidateEvidenceCsvPath,
      toCsv(candidateEvidenceRows, [
        'rank',
        'chain',
        'walletAddress',
        'candidateScore',
        'candidateCategory',
        'tokenAppearances',
        'tokenLabel',
        'tokenSymbol',
        'tokenAddress',
        'narrative',
        'firstBuyRank',
        'firstBuyBlockNumber',
        'firstBuyTimestamp',
        'firstBuyTxHash',
        'buyCount',
        'warningsCount',
        'warnings',
      ]),
      'utf8',
    );

    await writeFile(
      walletOverlapMatrixCsvPath,
      toCsv(walletOverlapMatrixRows, [
        'chainA',
        'tokenLabelA',
        'tokenSymbolA',
        'tokenAddressA',
        'chainB',
        'tokenLabelB',
        'tokenSymbolB',
        'tokenAddressB',
        'overlapWalletCount',
        'overlapWalletsSample',
        'overlapRateA',
        'overlapRateB',
      ]),
      'utf8',
    );

    await writeFile(
      tokenOverlapSummaryCsvPath,
      toCsv(tokenOverlapSummaryRows, [
        'chain',
        'tokenLabel',
        'tokenSymbol',
        'tokenAddress',
        'buyersFound',
        'overlapWithOtherTokensCount',
        'totalOverlappingWallets',
        'strongestOverlapTokenLabel',
        'strongestOverlapTokenSymbol',
        'strongestOverlapCount',
        'usefulnessScore',
        'seedTriageStatus',
        'seedTriageReason',
      ]),
      'utf8',
    );

    await writeFile(
      candidateShortlistCsvPath,
      toCsv(
        candidateShortlist.map((x) => toJsonSafe(x) as Record<string, unknown>),
        [
          'rank',
          'chain',
          'walletAddress',
          'score',
          'category',
          'tokenAppearances',
          'tokensAppearedIn',
          'narratives',
          'averageFirstBuyRank',
          'bestFirstBuyRank',
          'totalBuyCountAcrossSeeds',
          'earliestObservedBuyAt',
          'reasons',
          'riskFlags',
          'evidenceSummary',
          'monitorRecommendation',
        ],
      ),
      'utf8',
    );
  }

  await writeFile(
    outputIndexPath,
    safeJsonStringify(
      {
        generatedAt: result.generatedAt,
        commandType: 'seed_batch_analysis',
        inputFile: input.inputPath,
        files: {
          batchSummaryJson: batchSummaryPath,
          candidateWalletsJson: candidateJsonPath,
          candidateWalletsCsv: candidateCsvPath,
          tokenResultsJson: tokenResultsPath,
          errorsJson: errorsPath,
          tokenBuyerSummaryCsv: tokenBuyerSummaryCsvPath,
          tokenBuyerSummaryJson: tokenBuyerSummaryJsonPath,
          candidateEvidenceCsv: candidateEvidenceCsvPath,
          candidateEvidenceJson: candidateEvidenceJsonPath,
          walletOverlapMatrixCsv: walletOverlapMatrixCsvPath,
          walletOverlapMatrixJson: walletOverlapMatrixJsonPath,
          tokenOverlapSummaryCsv: tokenOverlapSummaryCsvPath,
          tokenOverlapSummaryJson: tokenOverlapSummaryJsonPath,
          nextSeedsKeepJson: nextSeedsKeepJsonPath,
          nextSeedsDropJson: nextSeedsDropJsonPath,
          nextSeedsInvestigateJson: nextSeedsInvestigateJsonPath,
          candidateShortlistCsv: candidateShortlistCsvPath,
          candidateShortlistJson: candidateShortlistJsonPath,
        },
      },
      2,
    ),
    'utf8',
  );

  result.outputFiles = {
    batchSummaryJson: batchSummaryPath,
    candidateWalletsJson: candidateJsonPath,
    candidateWalletsCsv: candidateCsvPath,
    tokenResultsJson: tokenResultsPath,
    errorsJson: errorsPath,
    outputIndexJson: outputIndexPath,
    tokenBuyerSummaryCsv: tokenBuyerSummaryCsvPath,
    tokenBuyerSummaryJson: tokenBuyerSummaryJsonPath,
    candidateEvidenceCsv: candidateEvidenceCsvPath,
    candidateEvidenceJson: candidateEvidenceJsonPath,
    walletOverlapMatrixCsv: walletOverlapMatrixCsvPath,
    walletOverlapMatrixJson: walletOverlapMatrixJsonPath,
    tokenOverlapSummaryCsv: tokenOverlapSummaryCsvPath,
    tokenOverlapSummaryJson: tokenOverlapSummaryJsonPath,
    nextSeedsKeepJson: nextSeedsKeepJsonPath,
    nextSeedsDropJson: nextSeedsDropJsonPath,
    nextSeedsInvestigateJson: nextSeedsInvestigateJsonPath,
    candidateShortlistCsv: candidateShortlistCsvPath,
    candidateShortlistJson: candidateShortlistJsonPath,
  };

  result.seedCuration = seedCuration;
  result.candidateShortlist = candidateShortlist;

  if (persist && batchJobId) {
    await updateAnalysisJobResult({
      id: batchJobId,
      status: errors.length ? 'partial_success' : 'success',
      result: {
        summary: result.summary,
        outputFiles: result.outputFiles,
      },
      warnings: result.warnings,
      error: errors.length ? safeJsonStringify(errors) : undefined,
    });
  }

  return result;
}
