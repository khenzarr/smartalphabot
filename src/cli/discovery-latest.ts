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
  console.log(`- watchlist wallets: ${String(summary.watchlistWalletCount ?? 'n/a')}`);
  console.log(`- alpha review queue: ${String(summary.alphaReviewQueueCount ?? 'n/a')}`);
  console.log(`- high confidence candidates: ${String(summary.highConfidenceCandidates ?? 'n/a')}`);
  console.log(`- auto added this run: ${String(summary.autoAddedCount ?? 'n/a')}`);
  console.log(`- output folder: ${String(summary.runDir ?? env.DISCOVERY_OUTPUT_DIR)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
