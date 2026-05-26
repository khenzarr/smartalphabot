import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import type { AlphaWalletCategory, AlphaWalletReviewEntry, AlphaWalletStatus } from './alpha-wallet-review-store.js';

type JsonValue = Record<string, unknown>;

type CandidateSourceKind =
  | 'shortlist'
  | 'wallets'
  | 'evidence'
  | 'overlap'
  | 'signals'
  | 'watchlist_quality'
  | 'manual';

export interface DiscoveryCandidate {
  chain: string;
  walletAddress: string;
  source: string;
  evidenceCount: number;
  tokenAppearances: number;
  evidenceRows: number;
  firstBuyRanks: number[];
  bestFirstBuyRank?: number;
  averageFirstBuyRank?: number;
  medianFirstBuyRank?: number;
  totalBuyCountAcrossSeeds: number;
  tokensAppearedIn: string[];
  narratives: string[];
  overlapPairs: string[];
  sourceFiles: string[];
  warningCount: number;
  riskFlags: string[];
  existingMonitorStatus?: string;
  existingReviewStatus?: string;
  manualSubmitted: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  knownProfitableSeedCount?: number;
  score: number;
  category: AlphaWalletCategory;
  reasons: string[];
  positiveReasons: string[];
  negativeReasons: string[];
  promotionBlockers: string[];
  qualityNotes: string[];
  activeEvidenceCount: number;
  recentActivityScore: number;
  sourceDiversityScore: number;
  qualityStatus?: 'active_alpha' | 'active_watch' | 'stale' | 'noisy' | 'unknown';
  promotionReadiness: 'eligible' | 'watch_only' | 'blocked' | 'needs_more_evidence';
}

export interface DiscoverySourceScanSummary {
  filesScanned: number;
  filesLoaded: number;
  candidatesFromShortlist: number;
  candidatesFromWallets: number;
  candidatesFromEvidence: number;
  candidatesFromSignals: number;
  candidatesFromWatchlistQuality: number;
  candidatesFromOverlap: number;
  candidatesFromManual: number;
  skippedFiles: string[];
  warnings: string[];
}

interface DiscoverySummary {
  runAt: string;
  dryRun: boolean;
  sourcesUsed: string[];
  candidatesLoaded: number;
  candidatesAfterDedupe: number;
  highConfidenceCount: number;
  watchCandidateCount: number;
  needsReviewCount: number;
  rejectedCount: number;
  autoAddEnabled: boolean;
  autoAddedCount: number;
  reviewQueueCount: number;
  monitoredWalletCount: number;
  warnings: string[];
  outputDir: string;
  sourceScan?: DiscoverySourceScanSummary;
}

interface AggregateCandidate {
  chain: string;
  walletAddress: string;
  tokenSet: Set<string>;
  narratives: Set<string>;
  overlapPairs: Set<string>;
  sourceFiles: Set<string>;
  riskFlags: Set<string>;
  warningCount: number;
  firstBuyRanks: number[];
  evidenceRows: number;
  totalBuyCountAcrossSeeds: number;
  knownProfitableSeedCount: number;
  lastSeenAt: string;
  firstSeenAt: string;
  manualSubmitted: boolean;
  existingMonitorStatus?: string;
  existingReviewStatus?: string;
  activityEvents: number;
  activitySignals: number;
  sourceKinds: Set<CandidateSourceKind>;
  qualityStatus?: 'active_alpha' | 'active_watch' | 'stale' | 'noisy' | 'unknown';
}

function normalizeChain(chain: string | undefined): string {
  return (chain ?? 'ethereum').toLowerCase();
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function median(numbers: number[]): number | undefined {
  if (!numbers.length) return undefined;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

async function readJsonIfSafe(filePath: string, maxBytes: number): Promise<JsonValue[] | undefined> {
  const fileStats = await stat(filePath);
  if (!fileStats.isFile()) return undefined;
  if (fileStats.size > maxBytes) return undefined;
  const raw = await readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed as JsonValue[];
  return undefined;
}

async function collectFiles(root: string, targetNames: Set<string>): Promise<Array<{ path: string; mtimeMs: number }>> {
  const out: Array<{ path: string; mtimeMs: number }> = [];
  async function walk(dirPath: string) {
    let items;
    try {
      items = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(dirPath, item.name);
      if (item.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!item.isFile() || !targetNames.has(item.name)) continue;
      try {
        const s = await stat(full);
        out.push({ path: full, mtimeMs: s.mtimeMs || 0 });
      } catch {
        continue;
      }
    }
  }
  await walk(root);
  return out;
}

function ensureAggregate(map: Map<string, AggregateCandidate>, chain: string, walletAddress: string, nowIso: string): AggregateCandidate {
  const key = `${chain}:${walletAddress}`;
  const existing = map.get(key);
  if (existing) return existing;
  const created: AggregateCandidate = {
    chain,
    walletAddress,
    tokenSet: new Set<string>(),
    narratives: new Set<string>(),
    overlapPairs: new Set<string>(),
    sourceFiles: new Set<string>(),
    riskFlags: new Set<string>(),
    warningCount: 0,
    firstBuyRanks: [],
    evidenceRows: 0,
    totalBuyCountAcrossSeeds: 0,
    knownProfitableSeedCount: 0,
    lastSeenAt: nowIso,
    firstSeenAt: nowIso,
    manualSubmitted: false,
    activityEvents: 0,
    activitySignals: 0,
    sourceKinds: new Set<CandidateSourceKind>(),
  };
  map.set(key, created);
  return created;
}

function isBadWallet(walletAddress: string): boolean {
  const w = walletAddress.toLowerCase();
  return w === '0x0000000000000000000000000000000000000000'
    || w === '0x000000000000000000000000000000000000dead';
}

function scoreCandidate(input: {
  c: AggregateCandidate;
  monitorSet: Set<string>;
  rejectedSet: Set<string>;
}): DiscoveryCandidate {
  const { c, monitorSet, rejectedSet } = input;
  const key = `${c.chain}:${c.walletAddress}`;
  const tokenAppearances = c.tokenSet.size;
  const evidenceCount = c.evidenceRows;
  const bestFirstBuyRank = c.firstBuyRanks.length ? Math.min(...c.firstBuyRanks) : undefined;
  const averageFirstBuyRank = c.firstBuyRanks.length
    ? c.firstBuyRanks.reduce((a, b) => a + b, 0) / c.firstBuyRanks.length
    : undefined;
  const medianFirstBuyRank = median(c.firstBuyRanks);

  const positiveReasons: string[] = [];
  const negativeReasons: string[] = [];
  const promotionBlockers: string[] = [];
  const qualityNotes: string[] = [];
  const sourceDiversityScore = Math.min(15, c.sourceKinds.size * 3);
  const recentActivityScore = Math.min(20, c.activityEvents * 2 + c.activitySignals * 3);
  const activeEvidenceCount = evidenceCount + c.activityEvents + c.activitySignals;
  let score = 25;

  if (tokenAppearances >= 4) {
    score += 20;
    positiveReasons.push('repeated_token_appearances');
  } else if (tokenAppearances >= 2) {
    score += 10;
    positiveReasons.push('multi_token_presence');
  } else {
    score -= 12;
    negativeReasons.push('single_token_presence');
  }

  if (bestFirstBuyRank !== undefined && bestFirstBuyRank <= 10) {
    score += 18;
    positiveReasons.push('very_early_first_buy_rank');
  } else if (bestFirstBuyRank !== undefined && bestFirstBuyRank <= 50) {
    score += 10;
    positiveReasons.push('early_first_buy_rank');
  }

  if (averageFirstBuyRank !== undefined && averageFirstBuyRank <= 50) {
    score += 12;
    positiveReasons.push('good_average_first_buy_rank');
  }

  if (c.knownProfitableSeedCount >= 2) {
    score += 8;
    positiveReasons.push('overlap_with_useful_seeds');
  }

  if (evidenceCount > 0) {
    score += Math.min(10, evidenceCount);
    positiveReasons.push('evidence_rows_present');
  } else {
    score -= 10;
    negativeReasons.push('missing_evidence_rows');
    promotionBlockers.push('missing_evidence');
  }

  if (recentActivityScore > 0) {
    score += recentActivityScore;
    positiveReasons.push('recent_activity_present');
  } else {
    negativeReasons.push('recent_activity_missing');
  }

  score += sourceDiversityScore;
  if (sourceDiversityScore >= 6) {
    positiveReasons.push('source_diversity');
  }

  if (c.warningCount > 0) {
    score -= Math.min(30, c.warningCount * 5);
    negativeReasons.push('warning_count_high');
  } else {
    score += 5;
    positiveReasons.push('low_warning_count');
  }

  if (c.manualSubmitted) {
    score += 6;
    qualityNotes.push('manual_submission_present_not_sufficient_alone');
    positiveReasons.push('manual_submission');
  }

  if (c.qualityStatus === 'stale') {
    score -= 15;
    negativeReasons.push('watchlist_quality_stale');
    promotionBlockers.push('stale_inactive');
  }
  if (c.qualityStatus === 'noisy') {
    score -= 10;
    negativeReasons.push('watchlist_quality_noisy');
    promotionBlockers.push('noisy_wallet');
  }
  if (c.qualityStatus === 'active_alpha') {
    score += 8;
    positiveReasons.push('watchlist_quality_active_alpha');
  } else if (c.qualityStatus === 'active_watch') {
    score += 4;
    positiveReasons.push('watchlist_quality_active_watch');
  }

  if (monitorSet.has(key)) {
    score -= 10;
    negativeReasons.push('already_monitored');
    promotionBlockers.push('already_monitored');
  }
  if (rejectedSet.has(key) || c.existingReviewStatus === 'rejected') {
    score = Math.min(score, 5);
    negativeReasons.push('rejected_status');
    promotionBlockers.push('rejected_status');
  }

  if (c.manualSubmitted && evidenceCount <= 0 && tokenAppearances <= 1 && recentActivityScore <= 0) {
    score = Math.min(score, 54);
    negativeReasons.push('manual_only_insufficient');
    promotionBlockers.push('manual_only_candidate');
  }
  if (isBadWallet(c.walletAddress)) {
    score = 0;
    negativeReasons.push('invalid_or_burn_wallet');
    promotionBlockers.push('invalid_wallet');
  }

  if (c.riskFlags.size > 0) {
    score -= Math.min(25, c.riskFlags.size * 5);
    negativeReasons.push('risk_flags_present');
    promotionBlockers.push('risk_flags');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let category: AlphaWalletCategory = 'needs_review';
  if (promotionBlockers.includes('invalid_wallet') || promotionBlockers.includes('rejected_status')) {
    category = 'rejected';
  } else if (score >= 80 && activeEvidenceCount > 0 && tokenAppearances >= 2 && !promotionBlockers.includes('manual_only_candidate')) {
    category = 'high_confidence';
  } else if (score >= 55) {
    category = 'watch_candidate';
  } else if (score < 20) {
    category = 'rejected';
  }

  let promotionReadiness: DiscoveryCandidate['promotionReadiness'] = 'needs_more_evidence';
  if (promotionBlockers.length > 0) promotionReadiness = 'blocked';
  else if (category === 'high_confidence') promotionReadiness = 'eligible';
  else if (category === 'watch_candidate') promotionReadiness = 'watch_only';

  return {
    chain: c.chain,
    walletAddress: c.walletAddress,
    source: c.manualSubmitted ? 'manual+discovery' : 'discovery',
    evidenceCount,
    tokenAppearances,
    evidenceRows: c.evidenceRows,
    firstBuyRanks: [...c.firstBuyRanks],
    bestFirstBuyRank,
    averageFirstBuyRank,
    medianFirstBuyRank,
    totalBuyCountAcrossSeeds: c.totalBuyCountAcrossSeeds,
    tokensAppearedIn: [...c.tokenSet],
    narratives: [...c.narratives],
    overlapPairs: [...c.overlapPairs],
    sourceFiles: [...c.sourceFiles],
    warningCount: c.warningCount,
    riskFlags: [...c.riskFlags],
    existingMonitorStatus: c.existingMonitorStatus,
    existingReviewStatus: c.existingReviewStatus,
    manualSubmitted: c.manualSubmitted,
    firstSeenAt: c.firstSeenAt,
    lastSeenAt: c.lastSeenAt,
    knownProfitableSeedCount: c.knownProfitableSeedCount,
    score,
    category,
    reasons: [...positiveReasons, ...negativeReasons],
    positiveReasons,
    negativeReasons,
    promotionBlockers,
    qualityNotes,
    activeEvidenceCount,
    recentActivityScore,
    sourceDiversityScore,
    qualityStatus: c.qualityStatus,
    promotionReadiness,
  };
}

function addFromRow(
  aggregate: Map<string, AggregateCandidate>,
  row: JsonValue,
  sourceFile: string,
  sourceKind: CandidateSourceKind,
  nowIso: string,
): boolean {
  const walletAddress = String(row.walletAddress ?? row.wallet ?? '').toLowerCase();
  if (!walletAddress || !walletAddress.startsWith('0x')) return false;
  const chain = normalizeChain(typeof row.chain === 'string' ? row.chain : undefined);
  const c = ensureAggregate(aggregate, chain, walletAddress, nowIso);
  c.sourceFiles.add(sourceFile);
  c.sourceKinds.add(sourceKind);
  c.lastSeenAt = nowIso;
  if (sourceKind === 'manual') c.manualSubmitted = true;

  const token = typeof row.tokenAddress === 'string'
    ? row.tokenAddress.toLowerCase()
    : typeof row.token === 'string'
      ? row.token.toLowerCase()
      : undefined;
  if (token) c.tokenSet.add(token);

  const buyCount = toNum(row.buyCount ?? row.totalBuyCount ?? row.totalBuyCountAcrossSeeds);
  if (buyCount !== undefined) c.totalBuyCountAcrossSeeds += Math.max(0, buyCount);

  const knownSeedCount = toNum(row.knownProfitableSeedCount);
  if (knownSeedCount !== undefined) c.knownProfitableSeedCount = Math.max(c.knownProfitableSeedCount, knownSeedCount);

  const rankDirect = toNum(row.firstBuyRank ?? row.bestFirstBuyRank);
  if (rankDirect !== undefined) c.firstBuyRanks.push(rankDirect);
  for (const v of asArray(row.firstBuyRanks)) {
    const rank = toNum(v);
    if (rank !== undefined) c.firstBuyRanks.push(rank);
  }

  for (const n of asArray(row.narratives)) {
    if (typeof n === 'string' && n.trim()) c.narratives.add(n.trim());
  }
  for (const o of asArray(row.overlapPairs ?? row.overlaps)) {
    if (typeof o === 'string' && o.trim()) c.overlapPairs.add(o.trim());
  }
  for (const rf of asArray(row.riskFlags)) {
    if (typeof rf === 'string' && rf.trim()) c.riskFlags.add(rf.trim());
  }

  const warningCount = toNum(row.warningCount);
  if (warningCount !== undefined) c.warningCount += Math.max(0, warningCount);

  if (sourceKind === 'evidence') {
    c.evidenceRows += 1;
  } else if (toNum(row.evidenceCount) !== undefined) {
    c.evidenceRows += Math.max(0, toNum(row.evidenceCount) ?? 0);
  }
  return true;
}

export async function loadDiscoveryCandidates(params: {
  now: Date;
  monitorWalletPath: string;
  reviewEntries: AlphaWalletReviewEntry[];
}): Promise<{ candidates: DiscoveryCandidate[]; sourcesUsed: string[]; warnings: string[]; loaded: number; sourceScan: DiscoverySourceScanSummary }> {
  const nowIso = params.now.toISOString();
  const warnings: string[] = [];

  const targetNames = new Set([
    'candidate-shortlist.json',
    'candidate-wallets.json',
    'candidate-evidence.json',
    'token-buyer-summary.json',
    'wallet-overlap-matrix.json',
    'token-overlap-summary.json',
    'signals.json',
    'events.json',
    'latest-report.json',
  ]);

  const scanSummary: DiscoverySourceScanSummary = {
    filesScanned: 0,
    filesLoaded: 0,
    candidatesFromShortlist: 0,
    candidatesFromWallets: 0,
    candidatesFromEvidence: 0,
    candidatesFromSignals: 0,
    candidatesFromWatchlistQuality: 0,
    candidatesFromOverlap: 0,
    candidatesFromManual: 0,
    skippedFiles: [],
    warnings,
  };

  const aggregate = new Map<string, AggregateCandidate>();

  let monitorWallets: Array<{ chain?: string; walletAddress?: string; enabled?: boolean }> = [];
  try {
    monitorWallets = JSON.parse(await readFile(params.monitorWalletPath, 'utf8')) as Array<{ chain?: string; walletAddress?: string; enabled?: boolean }>;
  } catch {
    warnings.push('monitor_wallet_file_unreadable');
  }
  const monitorSet = new Set(
    monitorWallets
      .filter((w) => (w.enabled ?? true) && w.walletAddress)
      .map((w) => `${normalizeChain(w.chain)}:${String(w.walletAddress).toLowerCase()}`),
  );

  const rejectedSet = new Set(
    params.reviewEntries
      .filter((x) => x.status === 'rejected')
      .map((x) => `${normalizeChain(x.chain)}:${x.walletAddress.toLowerCase()}`),
  );

  const outputFiles = await collectFiles('output', targetNames);
  outputFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const selectedOutputFiles = outputFiles.slice(0, env.DISCOVERY_MAX_OUTPUT_FILES);
  scanSummary.filesScanned = selectedOutputFiles.length;

  const sourceLabels = new Set<string>();

  for (const file of selectedOutputFiles) {
    let rows: JsonValue[] | undefined;
    try {
      rows = await readJsonIfSafe(file.path, env.DISCOVERY_MAX_FILE_BYTES);
    } catch {
      rows = undefined;
    }
    if (!rows) {
      scanSummary.skippedFiles.push(file.path);
      continue;
    }
    scanSummary.filesLoaded += 1;

    const base = path.basename(file.path);
    const sourceKind: CandidateSourceKind = base === 'candidate-shortlist.json'
      ? 'shortlist'
      : base === 'candidate-wallets.json'
        ? 'wallets'
        : base === 'candidate-evidence.json' || base === 'token-buyer-summary.json'
          ? 'evidence'
          : base === 'signals.json' || base === 'events.json'
            ? 'signals'
            : base === 'latest-report.json'
              ? 'watchlist_quality'
          : 'overlap';

    sourceLabels.add(base);
    for (const row of rows) {
      if (sourceKind === 'watchlist_quality') {
        const walletAddress = String(row.walletAddress ?? '').toLowerCase();
        if (!walletAddress || !walletAddress.startsWith('0x')) continue;
        const chain = normalizeChain(typeof row.chain === 'string' ? row.chain : undefined);
        const c = ensureAggregate(aggregate, chain, walletAddress, nowIso);
        c.sourceFiles.add(file.path);
        c.sourceKinds.add(sourceKind);
        const status = typeof row.qualityStatus === 'string' ? row.qualityStatus as AggregateCandidate['qualityStatus'] : undefined;
        c.qualityStatus = status ?? c.qualityStatus;
        const recentEventsFound = toNum(row.recentEventsFound) ?? 0;
        const latestSignalCount = toNum(row.latestSignalCount) ?? 0;
        if (status === 'active_alpha' || status === 'active_watch') {
          c.activityEvents += Math.max(0, recentEventsFound);
          c.activitySignals += Math.max(0, latestSignalCount);
        }
        scanSummary.candidatesFromWatchlistQuality += 1;
        continue;
      }
      if (!addFromRow(aggregate, row, file.path, sourceKind, nowIso)) continue;
      if (sourceKind === 'shortlist') scanSummary.candidatesFromShortlist += 1;
      else if (sourceKind === 'wallets') scanSummary.candidatesFromWallets += 1;
      else if (sourceKind === 'evidence') scanSummary.candidatesFromEvidence += 1;
      else if (sourceKind === 'signals') scanSummary.candidatesFromSignals += 1;
      else scanSummary.candidatesFromOverlap += 1;
    }
  }

  for (const row of params.reviewEntries) {
    if (row.source !== 'telegram_manual') continue;
    const r: JsonValue = {
      chain: row.chain,
      walletAddress: row.walletAddress,
      riskFlags: row.riskFlags ?? [],
      warningCount: row.warningCount ?? 0,
      tokenAppearances: row.tokenAppearances,
      bestFirstBuyRank: row.bestFirstBuyRank,
      averageFirstBuyRank: row.averageFirstBuyRank,
      knownProfitableSeedCount: row.knownProfitableSeedCount,
      narratives: row.reasons ?? [],
    };
    if (addFromRow(aggregate, r, 'data/alpha-wallet-review.local.json', 'manual', nowIso)) {
      scanSummary.candidatesFromManual += 1;
    }
  }

  for (const m of monitorWallets) {
    const chain = normalizeChain(m.chain);
    const wallet = String(m.walletAddress ?? '').toLowerCase();
    if (!wallet) continue;
    const key = `${chain}:${wallet}`;
    const c = aggregate.get(key);
    if (c) c.existingMonitorStatus = (m.enabled ?? true) ? 'monitoring' : 'disabled';
  }

  for (const r of params.reviewEntries) {
    const key = `${normalizeChain(r.chain)}:${r.walletAddress.toLowerCase()}`;
    const c = aggregate.get(key);
    if (c) {
      c.existingReviewStatus = r.status;
      c.firstSeenAt = r.firstSeenAt ?? r.addedAt ?? c.firstSeenAt;
    }
  }

  if (!aggregate.size) warnings.push('no_candidate_sources_found');

  const candidates = [...aggregate.values()]
    .map((c) => scoreCandidate({ c, monitorSet, rejectedSet }))
    .sort((a, b) => b.score - a.score);

  return {
    candidates,
    sourcesUsed: [...sourceLabels],
    warnings,
    loaded: scanSummary.candidatesFromShortlist
      + scanSummary.candidatesFromWallets
      + scanSummary.candidatesFromEvidence
      + scanSummary.candidatesFromSignals
      + scanSummary.candidatesFromWatchlistQuality
      + scanSummary.candidatesFromOverlap
      + scanSummary.candidatesFromManual,
    sourceScan: scanSummary,
  };
}

export function mapCategoryToStatus(category: AlphaWalletCategory): AlphaWalletStatus {
  if (category === 'high_confidence') return 'high_confidence';
  if (category === 'watch_candidate') return 'needs_review';
  if (category === 'rejected') return 'rejected';
  return 'needs_review';
}

export async function writeDiscoveryOutputs(params: {
  runDir: string;
  outputDir: string;
  summary: DiscoverySummary;
  candidates: DiscoveryCandidate[];
}) {
  await mkdir(params.runDir, { recursive: true });
  await mkdir(params.outputDir, { recursive: true });
  await writeFile(path.join(params.runDir, 'discovery-summary.json'), JSON.stringify(params.summary, null, 2), 'utf8');
  await writeFile(path.join(params.runDir, 'candidate-review.json'), JSON.stringify(params.candidates, null, 2), 'utf8');
  await writeFile(path.join(params.outputDir, 'latest-summary.json'), JSON.stringify(params.summary, null, 2), 'utf8');
  await writeFile(path.join(params.outputDir, 'latest-candidates.json'), JSON.stringify(params.candidates, null, 2), 'utf8');
}
