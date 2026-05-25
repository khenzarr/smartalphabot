import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseCsv } from '../utils/csv.js';
import { safeJsonStringify } from '../utils/json.js';
import type { MonitorWalletImportMeta, MonitorWalletRecord } from '../monitoring/monitoring.types.js';
import { isEvmAddress } from '../utils/address.js';

interface CliArgs {
  input: string;
  out: string;
  minAppearances: number;
  minScore: number;
  includeRejected: boolean;
}

type ExcludedReason =
  | 'below_min_appearances'
  | 'below_min_score'
  | 'rejected_excluded'
  | 'invalid_wallet'
  | 'unsupported_chain'
  | 'missing_required_field';

interface BuildResult {
  wallets: MonitorWalletRecord[];
  skippedCount: number;
  excludedReasons: Record<ExcludedReason, number>;
}

const SUPPORTED_CHAINS = new Set(['ethereum', 'base', 'bsc']);

function parseArgs(argv: string[]): CliArgs {
  const read = (key: string, fallback: string) => {
    const idx = argv.indexOf(`--${key}`);
    return idx >= 0 ? (argv[idx + 1] ?? fallback) : fallback;
  };

  const includeRejectedRaw = read('include-rejected', read('includeRejected', 'true')).toLowerCase();
  if (!['true', 'false'].includes(includeRejectedRaw)) {
    throw new Error(`Invalid --include-rejected value: ${includeRejectedRaw}. Expected true or false.`);
  }

  return {
    input: read('input', 'output/seed-batch-auto-keep-wide-v1/candidate-shortlist.csv'),
    out: read('out', 'data/monitor-wallets.json'),
    minAppearances: Number(read('min-appearances', '2')),
    minScore: Number(read('min-score', '40')),
    includeRejected: includeRejectedRaw === 'true',
  };
}

function splitPipe(value: string): string[] {
  return value.split('|').map((x) => x.trim()).filter(Boolean);
}

function initExcludedReasonCounts(): Record<ExcludedReason, number> {
  return {
    below_min_appearances: 0,
    below_min_score: 0,
    rejected_excluded: 0,
    invalid_wallet: 0,
    unsupported_chain: 0,
    missing_required_field: 0,
  };
}

export function buildMonitorWallets(rows: Array<Record<string, string>>, importedAt: string, args: CliArgs): BuildResult {
  const out = new Map<string, MonitorWalletRecord>();
  const excludedReasons = initExcludedReasonCounts();

  for (const row of rows) {
    const chain = (row.chain ?? '').trim();
    const walletAddress = (row.walletAddress ?? '').trim().toLowerCase();
    const category = (row.category ?? '').trim();
    const score = Number(row.score ?? '0');
    const tokenAppearances = Number(row.tokenAppearances ?? '0');

    if (!chain || !walletAddress || !category || !Number.isFinite(score) || !Number.isFinite(tokenAppearances)) {
      excludedReasons.missing_required_field += 1;
      continue;
    }

    if (!SUPPORTED_CHAINS.has(chain)) {
      excludedReasons.unsupported_chain += 1;
      continue;
    }
    if (!isEvmAddress(walletAddress)) {
      excludedReasons.invalid_wallet += 1;
      continue;
    }
    if (!args.includeRejected && category === 'rejected') {
      excludedReasons.rejected_excluded += 1;
      continue;
    }
    if (score < args.minScore) {
      excludedReasons.below_min_score += 1;
      continue;
    }
    if (tokenAppearances < args.minAppearances) {
      excludedReasons.below_min_appearances += 1;
      continue;
    }

    const record: MonitorWalletRecord = {
      chain: chain as MonitorWalletRecord['chain'],
      walletAddress,
      score,
      category,
      tokenAppearances,
      tokensAppearedIn: splitPipe(row.tokensAppearedIn ?? ''),
      narratives: splitPipe(row.narratives ?? ''),
      averageFirstBuyRank: Number(row.averageFirstBuyRank ?? '0'),
      bestFirstBuyRank: Number(row.bestFirstBuyRank ?? '0'),
      monitorRecommendation: row.monitorRecommendation ?? '',
      reasons: splitPipe(row.reasons ?? ''),
      riskFlags: splitPipe(row.riskFlags ?? ''),
      source: 'candidate_shortlist',
      importedAt,
      enabled: true,
      tags: ['seed_batch_candidate', category || 'unknown'],
    };
    out.set(`${record.chain}:${record.walletAddress}`, record);
  }

  const wallets = [...out.values()];
  const skippedCount = rows.length - wallets.length;
  return { wallets, skippedCount, excludedReasons };
}

function printSummary(args: CliArgs, inputRowsRead: number, filteredRows: number, importedWalletCount: number, skippedRowCount: number) {
  console.log('Monitor candidate import summary');
  console.log(`- input: ${args.input}`);
  console.log(`- output: ${args.out}`);
  console.log(`- input rows read: ${inputRowsRead}`);
  console.log(`- rows after filtering: ${filteredRows}`);
  console.log(`- imported wallet count: ${importedWalletCount}`);
  console.log(`- skipped row count: ${skippedRowCount}`);
  console.log(`- min appearances: ${args.minAppearances}`);
  console.log(`- min score: ${args.minScore}`);
  console.log(`- include rejected: ${args.includeRejected}`);
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(args.minAppearances) || args.minAppearances < 0) {
    throw new Error(`Invalid --min-appearances value: ${args.minAppearances}`);
  }
  if (!Number.isFinite(args.minScore) || args.minScore < 0) {
    throw new Error(`Invalid --min-score value: ${args.minScore}`);
  }

  if (!existsSync(args.input)) {
    throw new Error(`Input CSV not found: ${args.input}`);
  }

  const importedAt = new Date().toISOString();
  const csvText = await readFile(args.input, 'utf8');
  const rows = parseCsv(csvText);
  if (!rows.length) {
    throw new Error(`Input CSV has zero rows: ${args.input}`);
  }

  const { wallets, skippedCount, excludedReasons } = buildMonitorWallets(rows, importedAt, args);
  printSummary(args, rows.length, wallets.length, wallets.length, skippedCount);

  if (!wallets.length) {
    console.error('Zero candidates passed filters.');
    console.error(`- input row count: ${rows.length}`);
    console.error(`- min appearances: ${args.minAppearances}`);
    console.error(`- min score: ${args.minScore}`);
    console.error(`- include rejected: ${args.includeRejected}`);
    console.error(`- excluded reason counts: ${safeJsonStringify(excludedReasons, 2)}`);
    throw new Error('No monitor wallets imported due to filters.');
  }

  await mkdir(path.dirname(args.out), { recursive: true });
  await writeFile(args.out, safeJsonStringify(wallets, 2), 'utf8');

  const meta: MonitorWalletImportMeta = {
    input: args.input,
    out: args.out,
    importedAt,
    importedCount: wallets.length,
    dedupedCount: wallets.length,
    filters: {
      minAppearances: args.minAppearances,
      minScore: args.minScore,
      includeRejected: args.includeRejected,
    },
  };
  await writeFile(args.out.replace(/\.json$/i, '.meta.json'), safeJsonStringify(meta, 2), 'utf8');

  console.log(`Wrote monitor watchlist: ${args.out}`);
}

function isDirectExecution(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const normalizedArgv1 = path.resolve(argv1).replace(/\\/g, '/').toLowerCase();
  const thisFilePath = new URL(import.meta.url).pathname.replace(/\\/g, '/').toLowerCase();
  return thisFilePath.endsWith(normalizedArgv1) || normalizedArgv1.endsWith('/import-monitor-candidates.ts');
}

if (isDirectExecution()) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
