import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { env } from '../config/env.js';
import { bulkMergeAlphaWalletReviewEntries, getAlphaWalletReviewEntries, upsertAlphaWalletReviewEntry } from '../discovery/alpha-wallet-review-store.js';
import { loadDiscoveryCandidates, mapCategoryToStatus, writeDiscoveryOutputs } from '../discovery/discovery-candidate-engine.js';

function parseFlag(name: string, fallback = false): boolean {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  return (process.argv[i + 1] ?? 'true') === 'true';
}

function runOutputDir(baseDir: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return path.join(baseDir, 'runs', stamp);
}

async function readJsonSafe<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export async function executeDiscoveryWorkerRun(options: { now?: Date; dryRun?: boolean } = {}) {
  const now = options.now ?? new Date();
  const runDir = runOutputDir(env.DISCOVERY_OUTPUT_DIR, now);
  const dryRun = options.dryRun ?? env.DISCOVERY_DRY_RUN;
  const watchlist = await readJsonSafe<Array<{ chain?: string; walletAddress?: string; score?: number }>>(env.MONITOR_WATCHLIST_PATH, []);
  const reviewQueue = await getAlphaWalletReviewEntries();

  const loaded = await loadDiscoveryCandidates({ now, monitorWalletPath: env.MONITOR_WATCHLIST_PATH, reviewEntries: reviewQueue });

  await bulkMergeAlphaWalletReviewEntries({
    candidates: loaded.candidates.map((c) => ({
      chain: c.chain,
      walletAddress: c.walletAddress,
      source: 'discovery_worker',
      status: mapCategoryToStatus(c.category),
      category: c.category,
      score: c.score,
      evidenceCount: c.evidenceCount,
      tokenAppearances: c.tokenAppearances,
      bestFirstBuyRank: c.bestFirstBuyRank,
      averageFirstBuyRank: c.averageFirstBuyRank,
      knownProfitableSeedCount: c.knownProfitableSeedCount,
      warningCount: c.warningCount,
      riskFlags: c.riskFlags,
      reasons: c.reasons,
      firstSeenAt: c.firstSeenAt,
      tags: ['discovery-worker', c.source],
    })),
  });

  const mergedReviewQueue = await getAlphaWalletReviewEntries();

  const highConfidence = mergedReviewQueue
    .filter((x) => (x.score ?? 0) >= env.DISCOVERY_AUTO_ADD_MIN_SCORE && x.status !== 'rejected' && x.status !== 'monitoring')
    .slice(0, env.DISCOVERY_MAX_NEW_WALLETS_PER_RUN);

  const autoAddEnabled = env.DISCOVERY_AUTO_ADD && !dryRun;
  let autoAddedCount = 0;
  if (autoAddEnabled) {
    for (const c of highConfidence) {
      await upsertAlphaWalletReviewEntry({
        chain: c.chain,
        walletAddress: c.walletAddress,
        source: 'discovery_worker',
        status: 'monitoring',
        notes: 'Auto-promoted by discovery worker',
        tags: [...new Set([...(c.tags ?? []), 'auto-promoted'])],
      });
      autoAddedCount += 1;
    }
  }

  const summary = {
    runAt: now.toISOString(),
    dryRun,
    sourcesUsed: loaded.sourcesUsed,
    candidatesLoaded: loaded.loaded,
    candidatesAfterDedupe: loaded.candidates.length,
    highConfidenceCount: loaded.candidates.filter((c) => c.category === 'high_confidence').length,
    watchCandidateCount: loaded.candidates.filter((c) => c.category === 'watch_candidate').length,
    needsReviewCount: loaded.candidates.filter((c) => c.category === 'needs_review').length,
    rejectedCount: loaded.candidates.filter((c) => c.category === 'rejected').length,
    autoAddEnabled,
    autoAddedCount,
    reviewQueueCount: mergedReviewQueue.length,
    monitoredWalletCount: watchlist.length,
    warnings: loaded.warnings,
    outputDir: runDir,
    maxNewWalletsPerRun: env.DISCOVERY_MAX_NEW_WALLETS_PER_RUN,
    autoAddMinScore: env.DISCOVERY_AUTO_ADD_MIN_SCORE,
    thresholdUsed: env.DISCOVERY_AUTO_ADD_MIN_SCORE,
    topCandidates: loaded.candidates.slice(0, 5).map((c) => ({
      chain: c.chain,
      walletAddress: c.walletAddress,
      score: c.score,
      category: c.category,
      reasons: c.reasons.slice(0, 3),
      alreadyMonitored: watchlist.some((w) => `${(w.chain ?? '').toLowerCase()}:${(w.walletAddress ?? '').toLowerCase()}` === `${c.chain}:${c.walletAddress}`),
      rejected: mergedReviewQueue.some((x) => x.chain.toLowerCase() === c.chain && x.walletAddress.toLowerCase() === c.walletAddress && x.status === 'rejected'),
      missingEvidence: (c.evidenceCount ?? 0) <= 0 && (c.tokenAppearances ?? 0) <= 0,
    })),
  };

  await writeDiscoveryOutputs({
    runDir,
    outputDir: env.DISCOVERY_OUTPUT_DIR,
    summary,
    candidates: loaded.candidates,
  });
  return summary;
}

export async function startDiscoveryWorker() {
  if (!env.DISCOVERY_WORKER_ENABLED) {
    console.log('[discovery-worker] disabled via DISCOVERY_WORKER_ENABLED=false');
    return;
  }

  const once = parseFlag('once', false);
  const dryRun = parseFlag('dry-run', env.DISCOVERY_DRY_RUN);
  let stopped = false;

  const shutdown = (signal: string) => {
    stopped = true;
    console.log(`[discovery-worker] received ${signal}; shutting down gracefully`);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  do {
    const summary = await executeDiscoveryWorkerRun({ dryRun });
    console.log(`[discovery-worker] queue=${summary.reviewQueueCount} highConfidence=${summary.highConfidenceCount} autoAdded=${summary.autoAddedCount}`);
    if (once || stopped) break;
    await new Promise((resolve) => setTimeout(resolve, env.DISCOVERY_INTERVAL_SECONDS * 1000));
  } while (!stopped);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startDiscoveryWorker().catch((error) => {
    console.error('[discovery-worker] fatal', error);
    process.exit(1);
  });
}
