import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';

export type AlphaWalletSource = 'telegram_manual' | 'discovery_worker' | 'imported_shortlist';
export type AlphaWalletStatus = 'pending_review' | 'needs_review' | 'high_confidence' | 'accepted' | 'rejected' | 'monitoring';
export type AlphaWalletCategory = 'high_confidence' | 'watch_candidate' | 'needs_review' | 'rejected';

export interface AlphaWalletReviewEntry {
  chain: string;
  walletAddress: string;
  source: AlphaWalletSource;
  addedByChatId?: string;
  addedAt: string;
  lastSeenAt?: string;
  status: AlphaWalletStatus;
  category?: AlphaWalletCategory;
  notes?: string;
  score?: number;
  evidenceCount?: number;
  evidenceRows?: number;
  tokenAppearances?: number;
  bestFirstBuyRank?: number;
  averageFirstBuyRank?: number;
  knownProfitableSeedCount?: number;
  warningCount?: number;
  riskFlags?: string[];
  reasons?: string[];
  positiveReasons?: string[];
  negativeReasons?: string[];
  promotionBlockers?: string[];
  qualityNotes?: string[];
  sourceFiles?: string[];
  manualSubmitted?: boolean;
  firstSeenAt?: string;
  promotedAt?: string;
  promotedBy?: string;
  promotionReason?: string;
  promotionSource?: string;
  rejectedAt?: string;
  tags: string[];
}

async function readEntries(filePath = env.ALPHA_WALLET_REVIEW_PATH): Promise<AlphaWalletReviewEntry[]> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as AlphaWalletReviewEntry[] : [];
  } catch {
    return [];
  }
}

async function writeEntries(entries: AlphaWalletReviewEntry[], filePath = env.ALPHA_WALLET_REVIEW_PATH) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(entries, null, 2), 'utf8');
}

export async function getAlphaWalletReviewEntries(filePath?: string): Promise<AlphaWalletReviewEntry[]> {
  return readEntries(filePath);
}

export async function upsertAlphaWalletReviewEntry(input: {
  chain: string;
  walletAddress: string;
  source: AlphaWalletSource;
  addedByChatId?: string;
  notes?: string;
  score?: number;
  category?: AlphaWalletCategory;
  evidenceCount?: number;
  evidenceRows?: number;
  tokenAppearances?: number;
  bestFirstBuyRank?: number;
  averageFirstBuyRank?: number;
  knownProfitableSeedCount?: number;
  warningCount?: number;
  riskFlags?: string[];
  reasons?: string[];
  positiveReasons?: string[];
  negativeReasons?: string[];
  promotionBlockers?: string[];
  qualityNotes?: string[];
  sourceFiles?: string[];
  manualSubmitted?: boolean;
  firstSeenAt?: string;
  promotedAt?: string;
  promotedBy?: string;
  promotionReason?: string;
  promotionSource?: string;
  rejectedAt?: string;
  tags?: string[];
  status?: AlphaWalletStatus;
  filePath?: string;
}) {
  const now = new Date().toISOString();
  const chain = input.chain.toLowerCase();
  const walletAddress = input.walletAddress.toLowerCase();
  const entries = await readEntries(input.filePath);
  const idx = entries.findIndex((x) => x.chain.toLowerCase() === chain && x.walletAddress.toLowerCase() === walletAddress);

  if (idx >= 0) {
    const existing = entries[idx]!;
    entries[idx] = {
      ...existing,
      lastSeenAt: now,
      source: input.source ?? existing.source,
      category: input.category ?? existing.category,
      notes: input.notes ?? existing.notes,
      score: input.score ?? existing.score,
      evidenceCount: input.evidenceCount ?? existing.evidenceCount,
      evidenceRows: input.evidenceRows ?? existing.evidenceRows,
      tokenAppearances: input.tokenAppearances ?? existing.tokenAppearances,
      bestFirstBuyRank: input.bestFirstBuyRank ?? existing.bestFirstBuyRank,
      averageFirstBuyRank: input.averageFirstBuyRank ?? existing.averageFirstBuyRank,
      knownProfitableSeedCount: input.knownProfitableSeedCount ?? existing.knownProfitableSeedCount,
      warningCount: input.warningCount ?? existing.warningCount,
      riskFlags: input.riskFlags ?? existing.riskFlags,
      reasons: input.reasons ?? existing.reasons,
      positiveReasons: input.positiveReasons ?? existing.positiveReasons,
      negativeReasons: input.negativeReasons ?? existing.negativeReasons,
      promotionBlockers: input.promotionBlockers ?? existing.promotionBlockers,
      qualityNotes: input.qualityNotes ?? existing.qualityNotes,
      sourceFiles: input.sourceFiles ?? existing.sourceFiles,
      manualSubmitted: input.manualSubmitted ?? existing.manualSubmitted,
      firstSeenAt: existing.firstSeenAt ?? input.firstSeenAt ?? existing.addedAt,
      promotedAt: input.promotedAt ?? existing.promotedAt,
      promotedBy: input.promotedBy ?? existing.promotedBy,
      promotionReason: input.promotionReason ?? existing.promotionReason,
      promotionSource: input.promotionSource ?? existing.promotionSource,
      rejectedAt: input.rejectedAt ?? existing.rejectedAt,
      status: input.status ?? existing.status,
      tags: input.tags ? [...new Set([...(existing.tags ?? []), ...input.tags])] : existing.tags ?? [],
    };
    await writeEntries(entries, input.filePath);
    return { entry: entries[idx], created: false };
  }

  const created: AlphaWalletReviewEntry = {
    chain,
    walletAddress,
    source: input.source,
    addedByChatId: input.addedByChatId,
    addedAt: now,
    lastSeenAt: now,
    status: input.status ?? 'pending_review',
    category: input.category,
    notes: input.notes,
    score: input.score,
    evidenceCount: input.evidenceCount,
    evidenceRows: input.evidenceRows,
    tokenAppearances: input.tokenAppearances,
    bestFirstBuyRank: input.bestFirstBuyRank,
    averageFirstBuyRank: input.averageFirstBuyRank,
    knownProfitableSeedCount: input.knownProfitableSeedCount,
    warningCount: input.warningCount,
    riskFlags: input.riskFlags,
    reasons: input.reasons,
    positiveReasons: input.positiveReasons,
    negativeReasons: input.negativeReasons,
    promotionBlockers: input.promotionBlockers,
    qualityNotes: input.qualityNotes,
    sourceFiles: input.sourceFiles,
    manualSubmitted: input.manualSubmitted,
    firstSeenAt: input.firstSeenAt ?? now,
    promotedAt: input.promotedAt,
    promotedBy: input.promotedBy,
    promotionReason: input.promotionReason,
    promotionSource: input.promotionSource,
    rejectedAt: input.rejectedAt,
    tags: input.tags ?? [],
  };
  entries.push(created);
  await writeEntries(entries, input.filePath);
  return { entry: created, created: true };
}

export async function updateAlphaWalletReviewStatus(input: {
  chain: string;
  walletAddress: string;
  status: AlphaWalletStatus;
  notes?: string;
  promotedAt?: string;
  promotedBy?: string;
  promotionReason?: string;
  promotionSource?: string;
  rejectedAt?: string;
  filePath?: string;
}) {
  return upsertAlphaWalletReviewEntry({
    chain: input.chain,
    walletAddress: input.walletAddress,
    source: 'discovery_worker',
    status: input.status,
    notes: input.notes,
    promotedAt: input.promotedAt,
    promotedBy: input.promotedBy,
    promotionReason: input.promotionReason,
    promotionSource: input.promotionSource,
    rejectedAt: input.rejectedAt,
    filePath: input.filePath,
  });
}

export async function bulkMergeAlphaWalletReviewEntries(input: {
  candidates: Array<{
    chain: string;
    walletAddress: string;
    source: AlphaWalletSource;
    status: AlphaWalletStatus;
    category?: AlphaWalletCategory;
    score?: number;
    evidenceCount?: number;
    evidenceRows?: number;
    tokenAppearances?: number;
    bestFirstBuyRank?: number;
    averageFirstBuyRank?: number;
    knownProfitableSeedCount?: number;
    warningCount?: number;
    riskFlags?: string[];
    reasons?: string[];
    positiveReasons?: string[];
    negativeReasons?: string[];
    promotionBlockers?: string[];
    qualityNotes?: string[];
    sourceFiles?: string[];
    manualSubmitted?: boolean;
    firstSeenAt?: string;
    tags?: string[];
  }>;
  filePath?: string;
}) {
  const now = new Date().toISOString();
  const entries = await readEntries(input.filePath);
  const index = new Map(entries.map((e, i) => [`${e.chain.toLowerCase()}:${e.walletAddress.toLowerCase()}`, i]));

  for (const c of input.candidates) {
    const chain = c.chain.toLowerCase();
    const walletAddress = c.walletAddress.toLowerCase();
    const key = `${chain}:${walletAddress}`;
    const idx = index.get(key);
    if (idx === undefined) {
      entries.push({
        chain,
        walletAddress,
        source: c.source,
        addedAt: now,
        lastSeenAt: now,
        status: c.status,
        category: c.category,
        score: c.score,
        evidenceCount: c.evidenceCount,
        evidenceRows: c.evidenceRows,
        tokenAppearances: c.tokenAppearances,
        bestFirstBuyRank: c.bestFirstBuyRank,
        averageFirstBuyRank: c.averageFirstBuyRank,
        knownProfitableSeedCount: c.knownProfitableSeedCount,
        warningCount: c.warningCount,
        riskFlags: c.riskFlags,
        reasons: c.reasons,
        positiveReasons: c.positiveReasons,
        negativeReasons: c.negativeReasons,
        promotionBlockers: c.promotionBlockers,
        qualityNotes: c.qualityNotes,
        sourceFiles: c.sourceFiles,
        manualSubmitted: c.manualSubmitted,
        firstSeenAt: c.firstSeenAt ?? now,
        tags: c.tags ?? [],
      });
      index.set(key, entries.length - 1);
      continue;
    }

    const existing = entries[idx]!;
    const nextStatus = existing.status === 'monitoring' || existing.status === 'rejected'
      ? existing.status
      : c.status;

    entries[idx] = {
      ...existing,
      source: c.source ?? existing.source,
      status: nextStatus,
      category: c.category ?? existing.category,
      score: c.score ?? existing.score,
      evidenceCount: c.evidenceCount ?? existing.evidenceCount,
      evidenceRows: c.evidenceRows ?? existing.evidenceRows,
      tokenAppearances: c.tokenAppearances ?? existing.tokenAppearances,
      bestFirstBuyRank: c.bestFirstBuyRank ?? existing.bestFirstBuyRank,
      averageFirstBuyRank: c.averageFirstBuyRank ?? existing.averageFirstBuyRank,
      knownProfitableSeedCount: c.knownProfitableSeedCount ?? existing.knownProfitableSeedCount,
      warningCount: c.warningCount ?? existing.warningCount,
      riskFlags: c.riskFlags ?? existing.riskFlags,
      reasons: c.reasons ?? existing.reasons,
      positiveReasons: c.positiveReasons ?? existing.positiveReasons,
      negativeReasons: c.negativeReasons ?? existing.negativeReasons,
      promotionBlockers: c.promotionBlockers ?? existing.promotionBlockers,
      qualityNotes: c.qualityNotes ?? existing.qualityNotes,
      sourceFiles: c.sourceFiles ?? existing.sourceFiles,
      manualSubmitted: c.manualSubmitted ?? existing.manualSubmitted,
      firstSeenAt: existing.firstSeenAt ?? c.firstSeenAt ?? existing.addedAt,
      lastSeenAt: now,
      notes: existing.notes,
      tags: [...new Set([...(existing.tags ?? []), ...(c.tags ?? [])])],
    };
  }

  await writeEntries(entries, input.filePath);
  return entries;
}