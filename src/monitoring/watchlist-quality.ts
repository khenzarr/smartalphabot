import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { toCsv } from '../utils/csv.js';

export type WatchlistQualityStatus = 'active_alpha' | 'active_watch' | 'stale' | 'noisy' | 'unknown';
export type WatchlistRecommendedAction = 'keep' | 'keep_watch' | 'investigate' | 'stale_review' | 'candidate_for_removal_later';

export interface WatchlistQualityRow {
  chain: string;
  walletAddress: string;
  source?: string;
  score?: number;
  category?: string;
  promotedAt?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  recentEventsFound: number;
  latestActivityAt?: string;
  latestSignalCount: number;
  tokensTouched: number;
  failures: number;
  stale: boolean;
  qualityStatus: WatchlistQualityStatus;
  reasons: string[];
  recommendedAction: WatchlistRecommendedAction;
}

export interface WatchlistQualityReport {
  runAt: string;
  totalWatchedWallets: number;
  counts: Record<WatchlistQualityStatus, number>;
  rows: WatchlistQualityRow[];
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? v as T[] : [];
}

function normalizeChain(v: unknown): string {
  return typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : 'ethereum';
}

function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

async function readJsonSafe<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function latestRunFiles(root: string): Promise<string[]> {
  const runsDir = path.join(root, 'runs');
  let dirs;
  try {
    dirs = await readdir(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const stamped: Array<{ full: string; mtimeMs: number }> = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const full = path.join(runsDir, d.name);
    try {
      const s = await stat(full);
      stamped.push({ full, mtimeMs: s.mtimeMs || 0 });
    } catch {
      continue;
    }
  }
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return stamped.slice(0, 3).map((x) => x.full);
}

function classify(row: Omit<WatchlistQualityRow, 'qualityStatus' | 'reasons' | 'recommendedAction'>): Pick<WatchlistQualityRow, 'qualityStatus' | 'reasons' | 'recommendedAction'> {
  const reasons: string[] = [];
  if (row.recentEventsFound > 0) reasons.push('recent_events_found');
  if (row.latestSignalCount > 0) reasons.push('recent_signals_found');
  if (row.tokensTouched > 1) reasons.push('multi_token_touch');
  if (row.failures > 0) reasons.push('scan_failures_present');
  if (row.stale) reasons.push('stale_window_no_recent_activity');
  const score = row.score ?? 0;
  const category = (row.category ?? '').toLowerCase();

  if (row.failures >= 5 && row.recentEventsFound === 0 && row.latestSignalCount === 0) {
    return { qualityStatus: 'noisy', reasons, recommendedAction: 'investigate' };
  }
  if (row.stale && row.recentEventsFound === 0 && row.latestSignalCount === 0) {
    return { qualityStatus: 'stale', reasons, recommendedAction: 'stale_review' };
  }
  if ((category === 'high_confidence' || score >= 75) && (row.recentEventsFound > 0 || row.latestSignalCount > 0)) {
    return { qualityStatus: 'active_alpha', reasons, recommendedAction: 'keep' };
  }
  if (row.recentEventsFound > 0 || row.latestSignalCount > 0) {
    return { qualityStatus: 'active_watch', reasons, recommendedAction: 'keep_watch' };
  }
  if (row.failures > 0 || row.tokensTouched > 0) {
    return { qualityStatus: 'unknown', reasons, recommendedAction: 'investigate' };
  }
  return { qualityStatus: 'unknown', reasons, recommendedAction: 'candidate_for_removal_later' };
}

export async function buildWatchlistQualityReport(input: {
  watchlistPath?: string;
  reviewPath?: string;
  monitorOutputDir?: string;
} = {}): Promise<WatchlistQualityReport> {
  const watchlistPath = input.watchlistPath ?? env.MONITOR_WATCHLIST_PATH;
  const reviewPath = input.reviewPath ?? env.ALPHA_WALLET_REVIEW_PATH;
  const monitorOut = input.monitorOutputDir ?? env.MONITOR_OUTPUT_DIR;
  const watchlist = await readJsonSafe<Array<Record<string, unknown>>>(watchlistPath, []);
  const review = await readJsonSafe<Array<Record<string, unknown>>>(reviewPath, []);
  const reviewMap = new Map(review.map((x) => [`${normalizeChain(x.chain)}:${String(x.walletAddress ?? '').toLowerCase()}`, x]));

  const runDirs = await latestRunFiles(monitorOut);
  const eventsByWallet = new Map<string, { count: number; latestAt?: string; tokens: Set<string> }>();
  const signalsByWallet = new Map<string, number>();
  const failuresByWallet = new Map<string, number>();

  for (const runDir of runDirs) {
    const events = await readJsonSafe<Array<Record<string, unknown>>>(path.join(runDir, 'events.json'), []);
    for (const ev of events) {
      const chain = normalizeChain(ev.chain);
      const wallet = String(ev.walletAddress ?? '').toLowerCase();
      if (!wallet) continue;
      const key = `${chain}:${wallet}`;
      const current = eventsByWallet.get(key) ?? { count: 0, latestAt: undefined, tokens: new Set<string>() };
      current.count += 1;
      const token = String(ev.tokenAddress ?? '').toLowerCase();
      if (token) current.tokens.add(token);
      const observedAt = typeof ev.observedAt === 'string' ? ev.observedAt : undefined;
      if (observedAt && (!current.latestAt || new Date(observedAt).getTime() > new Date(current.latestAt).getTime())) {
        current.latestAt = observedAt;
      }
      eventsByWallet.set(key, current);
    }

    const signals = await readJsonSafe<Array<Record<string, unknown>>>(path.join(runDir, 'signals.json'), []);
    for (const s of signals) {
      const chain = normalizeChain(s.chain);
      const walletsSeen = asArray<string>(s.watchedWallets);
      for (const w of walletsSeen) {
        const key = `${chain}:${String(w).toLowerCase()}`;
        signalsByWallet.set(key, (signalsByWallet.get(key) ?? 0) + 1);
      }
    }

    const failures = await readJsonSafe<Array<Record<string, unknown>>>(path.join(runDir, 'wallet-scan-failures.json'), []);
    for (const f of failures) {
      const chain = normalizeChain(f.chain);
      const wallet = String(f.walletAddress ?? '').toLowerCase();
      if (!wallet) continue;
      const key = `${chain}:${wallet}`;
      failuresByWallet.set(key, (failuresByWallet.get(key) ?? 0) + 1);
    }
  }

  const nowMs = Date.now();
  const staleMs = 24 * 60 * 60 * 1000;
  const rows: WatchlistQualityRow[] = watchlist.map((w) => {
    const chain = normalizeChain(w.chain);
    const walletAddress = String(w.walletAddress ?? '').toLowerCase();
    const key = `${chain}:${walletAddress}`;
    const r = reviewMap.get(key);
    const ev = eventsByWallet.get(key);
    const latestSignalCount = signalsByWallet.get(key) ?? 0;
    const failures = failuresByWallet.get(key) ?? 0;
    const latestActivityAt = ev?.latestAt;
    const stale = !latestActivityAt || nowMs - new Date(latestActivityAt).getTime() > staleMs;
    const base = {
      chain,
      walletAddress,
      source: typeof w.source === 'string' ? w.source : typeof r?.source === 'string' ? r.source : undefined,
      score: toNum(w.score ?? r?.score) || undefined,
      category: typeof w.category === 'string' ? w.category : typeof r?.category === 'string' ? r.category : undefined,
      promotedAt: typeof w.promotedAt === 'string' ? w.promotedAt : typeof r?.promotedAt === 'string' ? r.promotedAt : undefined,
      firstSeenAt: typeof w.firstSeenAt === 'string' ? w.firstSeenAt : typeof r?.firstSeenAt === 'string' ? r.firstSeenAt : undefined,
      lastSeenAt: typeof w.lastSeenAt === 'string' ? w.lastSeenAt : typeof r?.lastSeenAt === 'string' ? r.lastSeenAt : undefined,
      recentEventsFound: ev?.count ?? 0,
      latestActivityAt,
      latestSignalCount,
      tokensTouched: ev?.tokens.size ?? 0,
      failures,
      stale,
    };
    return { ...base, ...classify(base) };
  });

  const counts: Record<WatchlistQualityStatus, number> = {
    active_alpha: rows.filter((x) => x.qualityStatus === 'active_alpha').length,
    active_watch: rows.filter((x) => x.qualityStatus === 'active_watch').length,
    stale: rows.filter((x) => x.qualityStatus === 'stale').length,
    noisy: rows.filter((x) => x.qualityStatus === 'noisy').length,
    unknown: rows.filter((x) => x.qualityStatus === 'unknown').length,
  };
  return {
    runAt: new Date().toISOString(),
    totalWatchedWallets: rows.length,
    counts,
    rows: rows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)),
  };
}

export async function writeWatchlistQualityArtifacts(report: WatchlistQualityReport, outDir = 'output/watchlist-quality') {
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'latest-report.json'), JSON.stringify(report, null, 2), 'utf8');
  const csv = toCsv(
    report.rows.map((r) => ({ ...r, reasons: r.reasons.join('|') })),
    [
      'chain', 'walletAddress', 'source', 'score', 'category', 'promotedAt', 'firstSeenAt', 'lastSeenAt', 'recentEventsFound',
      'latestActivityAt', 'latestSignalCount', 'tokensTouched', 'failures', 'stale', 'qualityStatus', 'recommendedAction', 'reasons',
    ],
  );
  await writeFile(path.join(outDir, 'latest-report.csv'), csv, 'utf8');
}

export async function writeWatchlistMetadata(input: { watchlistPath?: string; report: WatchlistQualityReport }) {
  const watchlistPath = input.watchlistPath ?? env.MONITOR_WATCHLIST_PATH;
  const watchlist = await readJsonSafe<Array<Record<string, unknown>>>(watchlistPath, []);
  const rowMap = new Map(input.report.rows.map((r) => [`${r.chain}:${r.walletAddress.toLowerCase()}`, r]));
  const now = new Date().toISOString();
  const updated = watchlist.map((w) => {
    const key = `${normalizeChain(w.chain)}:${String(w.walletAddress ?? '').toLowerCase()}`;
    const row = rowMap.get(key);
    if (!row) return w;
    return {
      ...w,
      lastQualityCheckAt: now,
      qualityStatus: row.qualityStatus,
      staleReason: row.stale ? 'no_recent_activity' : undefined,
      recentEventsFound: row.recentEventsFound,
      recommendedAction: row.recommendedAction,
    };
  });
  await writeFile(watchlistPath, JSON.stringify(updated, null, 2), 'utf8');
}
