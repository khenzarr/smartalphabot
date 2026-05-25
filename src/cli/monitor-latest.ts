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
  const summary = await readJsonSafe<Record<string, unknown>>(path.join(env.MONITOR_OUTPUT_DIR, 'latest-summary.json'), {});
  const signals = await readJsonSafe<Array<Record<string, unknown>>>(path.join(env.MONITOR_OUTPUT_DIR, 'latest-signals.json'), []);

  console.log('Latest monitor snapshot');
  console.log(`- run time: ${String(summary.runAt ?? 'n/a')}`);
  console.log(`- events found: ${String(summary.eventsFound ?? 'n/a')}`);
  console.log(`- signals found: ${String(summary.signalsBuilt ?? 'n/a')}`);
  console.log(`- alerts sent: ${String(summary.alertsSent ?? summary.dedupedSignalsForDelivery ?? 'n/a')}`);
  console.log(`- output folder: ${String(summary.runDir ?? env.MONITOR_OUTPUT_DIR)}`);
  console.log('- top signals:');
  for (const s of signals.slice(0, 5)) {
    const positives = Array.isArray(s.positiveReasons) ? s.positiveReasons.slice(0, 2).join('|') : 'n/a';
    const negatives = Array.isArray(s.negativeReasons) ? s.negativeReasons.slice(0, 2).join('|') : 'n/a';
    const blockers = Array.isArray(s.promotionBlockers) ? s.promotionBlockers.slice(0, 2).join('|') : 'none';
    console.log(
      `  [${String(s.category ?? 'n/a')}] ${String(s.chain ?? 'n/a')} ${String(s.symbol ?? s.name ?? 'unknown')} score=${String(s.score ?? 'n/a')} +${positives} -${negatives} blockers=${blockers}`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
