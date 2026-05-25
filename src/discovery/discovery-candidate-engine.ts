import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AlphaWalletCategory, AlphaWalletReviewEntry, AlphaWalletStatus } from './alpha-wallet-review-store.js';

export interface DiscoveryCandidate {
  chain: string;
  walletAddress: string;
  source: string;
  evidenceCount: number;
  tokenAppearances: number;
  bestFirstBuyRank?: number;
  averageFirstBuyRank?: number;
  knownProfitableSeedCount?: number;
  warningCount: number;
  riskFlags: string[];
  reasons: string[];
  score: number;
  category: AlphaWalletCategory;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface DiscoverySummary {
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
}

interface RawCandidateRow {
  chain?: string;
  walletAddress?: string;
  score?: number;
  tokenAppearances?: number;
  bestFirstBuyRank?: number;
  averageFirstBuyRank?: number;
  knownProfitableSeedCount?: number;
  riskFlags?: string[];
  reasons?: string[];
  category?: string;
}

async function readJsonSafe<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function normalizeChain(chain: string | undefined): string {
  return (chain ?? 'ethereum').toLowerCase();
}

function scoreCandidate(input: {
  row: RawCandidateRow;
  source: string;
  evidenceCount?: number;
  monitorSet: Set<string>;
  rejectedSet: Set<string>;
  nowIso: string;
}): DiscoveryCandidate | undefined {
  const walletAddress = input.row.walletAddress?.toLowerCase();
  if (!walletAddress) return undefined;
  const chain = normalizeChain(input.row.chain);
  const key = `${chain}:${walletAddress}`;

  const tokenAppearances = input.row.tokenAppearances ?? 0;
  const bestFirstBuyRank = input.row.bestFirstBuyRank;
  const averageFirstBuyRank = input.row.averageFirstBuyRank;
  const knownProfitableSeedCount = input.row.knownProfitableSeedCount ?? 0;
  const warningCount = (input.row.riskFlags ?? []).length;
  const evidenceCount = input.evidenceCount ?? 0;
  const riskFlags = [...(input.row.riskFlags ?? [])];
  const reasons = [...(input.row.reasons ?? [])];

  let score = 20;
  if (tokenAppearances >= 4) score += 20;
  else if (tokenAppearances >= 2) score += 10;
  else score -= 10;

  if (bestFirstBuyRank !== undefined && bestFirstBuyRank <= 10) score += 15;
  else if (bestFirstBuyRank !== undefined && bestFirstBuyRank <= 50) score += 8;

  if (averageFirstBuyRank !== undefined && averageFirstBuyRank <= 40) score += 10;
  if (knownProfitableSeedCount >= 2) score += 10;
  if (evidenceCount > 0) score += Math.min(10, evidenceCount);
  if (warningCount > 0) score -= Math.min(20, warningCount * 5);

  if (input.monitorSet.has(key)) {
    score -= 20;
    reasons.push('already_monitored');
  }
  if (input.rejectedSet.has(key)) {
    score -= 30;
    reasons.push('already_rejected');
  }

  if (score < 0) score = 0;
  if (score > 100) score = 100;

  let category: AlphaWalletCategory = 'needs_review';
  if (input.rejectedSet.has(key) || score < 25) category = 'rejected';
  else if (score >= 70) category = 'high_confidence';
  else if (score >= 50) category = 'watch_candidate';

  return {
    chain,
    walletAddress,
    source: input.source,
    evidenceCount,
    tokenAppearances,
    bestFirstBuyRank,
    averageFirstBuyRank,
    knownProfitableSeedCount,
    warningCount,
    riskFlags,
    reasons,
    score,
    category,
    firstSeenAt: input.nowIso,
    lastSeenAt: input.nowIso,
  };
}

export async function loadDiscoveryCandidates(params: {
  now: Date;
  monitorWalletPath: string;
  reviewEntries: AlphaWalletReviewEntry[];
}): Promise<{ candidates: DiscoveryCandidate[]; sourcesUsed: string[]; warnings: string[]; loaded: number }> {
  const nowIso = params.now.toISOString();
  const warnings: string[] = [];
  const sourcesUsed: string[] = [];

  const monitorWallets = await readJsonSafe<Array<{ chain?: string; walletAddress?: string }>>(params.monitorWalletPath, []);
  const monitorSet = new Set(monitorWallets.map((w) => `${normalizeChain(w.chain)}:${(w.walletAddress ?? '').toLowerCase()}`));
  const rejectedSet = new Set(
    params.reviewEntries
      .filter((x) => x.status === 'rejected')
      .map((x) => `${normalizeChain(x.chain)}:${x.walletAddress.toLowerCase()}`),
  );

  const candidateFiles = [
    { file: 'output/discovery-auto-v1/candidate-shortlist.json', source: 'candidate_shortlist' },
    { file: 'output/discovery-auto-v1-small/candidate-shortlist.json', source: 'candidate_shortlist_small' },
    { file: 'output/discovery-auto-v1/candidate-wallets.json', source: 'candidate_wallets' },
    { file: 'output/discovery-auto-v1-small/candidate-wallets.json', source: 'candidate_wallets_small' },
  ];

  const evidenceRows = await readJsonSafe<Array<{ chain?: string; walletAddress?: string }>>('output/discovery-auto-v1/candidate-evidence.json', []);
  const evidenceMap = new Map<string, number>();
  for (const row of evidenceRows) {
    const key = `${normalizeChain(row.chain)}:${(row.walletAddress ?? '').toLowerCase()}`;
    evidenceMap.set(key, (evidenceMap.get(key) ?? 0) + 1);
  }

  const loadedCandidates: DiscoveryCandidate[] = [];
  let loaded = 0;
  for (const spec of candidateFiles) {
    const rows = await readJsonSafe<RawCandidateRow[]>(spec.file, []);
    if (!rows.length) continue;
    sourcesUsed.push(spec.source);
    for (const row of rows) {
      loaded += 1;
      const key = `${normalizeChain(row.chain)}:${(row.walletAddress ?? '').toLowerCase()}`;
      const scored = scoreCandidate({
        row,
        source: spec.source,
        evidenceCount: evidenceMap.get(key) ?? 0,
        monitorSet,
        rejectedSet,
        nowIso,
      });
      if (scored) loadedCandidates.push(scored);
    }
  }

  const manualCandidates = params.reviewEntries.filter((x) => x.source === 'telegram_manual');
  if (manualCandidates.length) {
    sourcesUsed.push('telegram_manual_queue');
    for (const row of manualCandidates) {
      loaded += 1;
      loadedCandidates.push({
        chain: normalizeChain(row.chain),
        walletAddress: row.walletAddress.toLowerCase(),
        source: 'telegram_manual_queue',
        evidenceCount: row.evidenceCount ?? 0,
        tokenAppearances: row.tokenAppearances ?? 1,
        bestFirstBuyRank: row.bestFirstBuyRank,
        averageFirstBuyRank: row.averageFirstBuyRank,
        knownProfitableSeedCount: row.knownProfitableSeedCount ?? 0,
        warningCount: row.warningCount ?? 0,
        riskFlags: row.riskFlags ?? [],
        reasons: [...(row.reasons ?? []), 'manual_wallet_submission'],
        score: Math.max(row.score ?? 55, 55),
        category: row.category ?? 'watch_candidate',
        firstSeenAt: row.firstSeenAt ?? row.addedAt,
        lastSeenAt: nowIso,
      });
    }
  }

  if (!sourcesUsed.length) warnings.push('no_candidate_sources_found');

  const deduped = new Map<string, DiscoveryCandidate>();
  for (const c of loadedCandidates) {
    const key = `${c.chain}:${c.walletAddress}`;
    const existing = deduped.get(key);
    if (!existing || c.score > existing.score) deduped.set(key, c);
  }

  return {
    candidates: [...deduped.values()].sort((a, b) => b.score - a.score),
    sourcesUsed,
    warnings,
    loaded,
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
