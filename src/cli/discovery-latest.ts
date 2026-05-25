import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { env } from '../config/env.js';

async function readJsonSafe<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export async function main() {
  const summary = await readJsonSafe<Record<string, unknown>>(path.join(env.DISCOVERY_OUTPUT_DIR, 'latest-summary.json'), {});
  console.log('Latest discovery snapshot');
  console.log(`- run time: ${String(summary.runAt ?? 'n/a')}`);
  console.log(`- dry run: ${String(summary.dryRun ?? 'n/a')}`);
  console.log(`- auto add enabled: ${String(summary.autoAddEnabled ?? 'n/a')}`);
  console.log(`- monitored wallets: ${String(summary.monitoredWalletCount ?? summary.watchlistWalletCount ?? 'n/a')}`);
  console.log(`- review queue: ${String(summary.reviewQueueCount ?? summary.alphaReviewQueueCount ?? 'n/a')}`);
  console.log(`- high confidence candidates: ${String(summary.highConfidenceCount ?? summary.highConfidenceCandidates ?? 'n/a')}`);
  console.log(`- watch candidates: ${String(summary.watchCandidateCount ?? 'n/a')}`);
  console.log(`- needs review: ${String(summary.needsReviewCount ?? 'n/a')}`);
  console.log(`- rejected: ${String(summary.rejectedCount ?? 'n/a')}`);
  console.log(`- auto added this run: ${String(summary.autoAddedCount ?? 'n/a')}`);
  console.log(`- output folder: ${String(summary.outputDir ?? summary.runDir ?? env.DISCOVERY_OUTPUT_DIR)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
