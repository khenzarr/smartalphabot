import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseCsv } from '../utils/csv.js';
import { safeJsonStringify } from '../utils/json.js';
import type { MonitorKnownToken } from '../monitoring/monitoring.types.js';

interface Args {
  seedSummary: string;
  out: string;
  onlyKeep: boolean;
}

function parseArgs(argv: string[]): Args {
  const read = (key: string, fallback: string) => {
    const i = argv.indexOf(`--${key}`);
    return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
  };
  return {
    seedSummary: read('seed-summary', 'output/seed-batch-auto-keep-wide-v1/token-buyer-summary.csv'),
    out: read('out', 'data/monitor-known-tokens.json'),
    onlyKeep: read('only-keep', 'true').toLowerCase() === 'true',
  };
}

export function buildKnownTokens(rows: Array<Record<string, string>>, args: Args): MonitorKnownToken[] {
  const out = new Map<string, MonitorKnownToken>();
  for (const row of rows) {
    const status = (row.status ?? '').trim().toLowerCase();
    const triage = (row.seedTriageStatus ?? '').trim().toLowerCase();
    const chain = (row.chain ?? '').trim().toLowerCase();
    const tokenAddress = (row.tokenAddress ?? '').trim().toLowerCase();
    const symbol = (row.symbol ?? '').trim();
    if (!tokenAddress || !chain) continue;
    if (status !== 'success') continue;
    if (args.onlyKeep && triage !== 'keep') continue;
    if (!['ethereum', 'base', 'bsc'].includes(chain)) continue;
    out.set(`${chain}:${tokenAddress}`, { chain: chain as MonitorKnownToken['chain'], tokenAddress, symbol });
  }
  return [...out.values()];
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  const csv = await readFile(args.seedSummary, 'utf8');
  const rows = parseCsv(csv);
  const tokens = buildKnownTokens(rows, args);
  await mkdir(path.dirname(args.out), { recursive: true });
  await writeFile(args.out, safeJsonStringify(tokens, 2), 'utf8');
  await writeFile(args.out.replace(/\.json$/i, '.meta.json'), safeJsonStringify({
    seedSummary: args.seedSummary,
    out: args.out,
    onlyKeep: args.onlyKeep,
    tokenCount: tokens.length,
    generatedAt: new Date().toISOString(),
  }, 2), 'utf8');
  console.log(`Wrote known tokens: ${args.out} (count=${tokens.length})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
