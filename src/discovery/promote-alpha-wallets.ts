import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { env } from '../config/env.js';
import { getAlphaWalletReviewEntries, updateAlphaWalletReviewStatus } from './alpha-wallet-review-store.js';

interface PromoteArgs {
  dryRun: boolean;
  minScore: number;
  maxAdd: number;
  includeWatchCandidates: boolean;
  force?: boolean;
  walletAddress?: string;
  chain?: string;
}

function parseArgs(argv: string[]): PromoteArgs {
  const read = (key: string, fallback: string) => {
    const i = argv.indexOf(`--${key}`);
    return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
  };
  return {
    dryRun: read('dry-run', 'true') === 'true',
    minScore: Number(read('min-score', String(env.DISCOVERY_AUTO_ADD_MIN_SCORE))),
    maxAdd: Number(read('max-add', String(env.DISCOVERY_MAX_NEW_WALLETS_PER_RUN))),
    includeWatchCandidates: read('include-watch-candidates', 'false') === 'true',
    force: read('force', 'false') === 'true',
    walletAddress: read('wallet-address', '').trim() || undefined,
    chain: read('chain', '').trim() || undefined,
  };
}

async function readWatchlist() {
  try {
    const parsed = JSON.parse(await readFile(env.MONITOR_WATCHLIST_PATH, 'utf8')) as Array<Record<string, unknown>>;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function promoteAlphaWallets(args: PromoteArgs) {
  const review = await getAlphaWalletReviewEntries();
  const watchlist = await readWatchlist();
  const watchSet = new Set(watchlist.map((w) => `${String(w.chain ?? '').toLowerCase()}:${String(w.walletAddress ?? '').toLowerCase()}`));

  const skip = {
    skippedLowScore: 0,
    skippedNotHighConfidence: 0,
    skippedAlreadyMonitored: 0,
    skippedRejected: 0,
    skippedMissingEvidence: 0,
  };

  const filtered = review.filter((x) => {
    if (args.walletAddress) {
      const walletMatch = x.walletAddress.toLowerCase() === args.walletAddress!.toLowerCase();
      const chainMatch = args.chain ? x.chain.toLowerCase() === args.chain.toLowerCase() : true;
      if (!walletMatch || !chainMatch) return false;
    }

    if (!args.force) {
      const score = x.score ?? 0;
      if (score < args.minScore) {
        skip.skippedLowScore += 1;
        return false;
      }

      const isHigh = x.category === 'high_confidence';
      const isWatch = x.category === 'watch_candidate';
      if (!(isHigh || (args.includeWatchCandidates && isWatch))) {
        skip.skippedNotHighConfidence += 1;
        return false;
      }
    }

    const key = `${x.chain.toLowerCase()}:${x.walletAddress.toLowerCase()}`;
    if (watchSet.has(key) || x.status === 'monitoring') {
      skip.skippedAlreadyMonitored += 1;
      return false;
    }

    if (!args.force && x.status === 'rejected') {
      skip.skippedRejected += 1;
      return false;
    }

    if (!args.force && (x.evidenceCount ?? 0) <= 0 && (x.tokenAppearances ?? 0) <= 0) {
      skip.skippedMissingEvidence += 1;
      return false;
    }

    return true;
  });

  const candidates = filtered.slice(0, Math.max(1, args.maxAdd));

  let added = 0;
  for (const c of candidates) {
    const record = {
      chain: c.chain,
      walletAddress: c.walletAddress,
      score: c.score ?? 0,
      category: c.category ?? 'watch_candidate',
      tokenAppearances: c.tokenAppearances ?? 0,
      tokensAppearedIn: [],
      narratives: [],
      averageFirstBuyRank: c.averageFirstBuyRank ?? 0,
      bestFirstBuyRank: c.bestFirstBuyRank ?? 0,
      monitorRecommendation: 'monitor',
      reasons: c.reasons ?? [],
      riskFlags: c.riskFlags ?? [],
      source: 'candidate_shortlist',
      importedAt: new Date().toISOString(),
      enabled: true,
      tags: [...new Set([...(c.tags ?? []), 'discovery_worker', 'promoted'])],
    };

    if (!args.dryRun) {
      watchlist.push(record);
      await updateAlphaWalletReviewStatus({
        chain: c.chain,
        walletAddress: c.walletAddress,
        status: 'monitoring',
        promotedAt: new Date().toISOString(),
        notes: 'Promoted via alpha:promote',
      });
      added += 1;
    }
  }

  if (!args.dryRun && added > 0) {
    await writeFile(env.MONITOR_WATCHLIST_PATH, JSON.stringify(watchlist, null, 2), 'utf8');
  }

  const result = {
    dryRun: args.dryRun,
    minScore: args.minScore,
    maxAdd: args.maxAdd,
    includeWatchCandidates: args.includeWatchCandidates,
    force: Boolean(args.force),
    walletAddress: args.walletAddress,
    chain: args.chain,
    eligible: candidates.length,
    eligibleHighConfidence: candidates.filter((x) => x.category === 'high_confidence').length,
    eligibleWatchCandidates: candidates.filter((x) => x.category === 'watch_candidate').length,
    ...skip,
    topCandidates: filtered.slice(0, 5).map((x) => ({
      chain: x.chain,
      walletAddress: x.walletAddress,
      score: x.score ?? 0,
      category: x.category ?? 'needs_review',
      reasons: (x.reasons ?? []).slice(0, 3),
      status: x.status,
      alreadyMonitored: watchSet.has(`${x.chain.toLowerCase()}:${x.walletAddress.toLowerCase()}`),
      rejected: x.status === 'rejected',
    })),
    added,
  };
  console.log('Alpha promotion summary:', result);
  return result;
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  await promoteAlphaWallets(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
