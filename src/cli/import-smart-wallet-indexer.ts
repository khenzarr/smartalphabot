import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { env, parseBooleanEnvValue } from '../config/env.js';
import { parseCsv } from '../utils/csv.js';
import { isEvmAddress } from '../utils/address.js';
import { getAlphaWalletReviewEntries, upsertAlphaWalletReviewEntry } from '../discovery/alpha-wallet-review-store.js';

interface CliArgs {
  input: string;
  dryRun: boolean;
  maxAdd: number;
  includeContractReview: boolean;
}

interface ImportSummary {
  inputRows: number;
  eligibleRows: number;
  skippedInfra: number;
  skippedContractReview: number;
  skippedAlreadyReviewed: number;
  skippedAlreadyMonitored: number;
  wouldAdd: number;
  added: number;
}

type MappedCategory = 'high_confidence' | 'watch_candidate' | 'needs_review';

interface MappedRow {
  chain: string;
  walletAddress: string;
  category: MappedCategory;
  status: 'pending_review';
  score?: number;
  tokenAppearances?: number;
  averageFirstBuyRank?: number;
  bestFirstBuyRank?: number;
  reasons: string[];
  riskFlags: string[];
  tags: string[];
  notes: string;
  sourceFiles: string[];
}

function readArg(argv: string[], key: string, fallback: string): string {
  const i = argv.indexOf(`--${key}`);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
}

function parseArgs(argv: string[]): CliArgs {
  const dryRunRaw = readArg(argv, 'dry-run', 'true');
  const includeContractReviewRaw = readArg(argv, 'include-contract-review', 'false');
  return {
    input: readArg(argv, 'input', 'final-smart-money-list.csv'),
    dryRun: parseBooleanEnvValue(dryRunRaw, true),
    maxAdd: Number(readArg(argv, 'max-add', '25')),
    includeContractReview: parseBooleanEnvValue(includeContractReviewRaw, false),
  };
}

function num(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function splitPipe(value: string | undefined): string[] {
  if (!value) return [];
  return value.split('|').map((x) => x.trim()).filter(Boolean);
}

function isInfraRow(row: Record<string, string>): boolean {
  const haystack = [
    row.actorCategory,
    row.actorType,
    row.riskLabel,
    row.recommendedAction,
  ].join(' ').toLowerCase();
  return ['infra_contract', 'router', 'settler', 'pool', 'proxy', 'bridge'].some((x) => haystack.includes(x));
}

function mapRow(row: Record<string, string>, sourceFile: string, includeContractReview: boolean): MappedRow | 'skip_contract' | 'skip_infra' | null {
  if (isInfraRow(row)) return 'skip_infra';

  const reviewStatus = (row.reviewStatus ?? '').trim();
  const actorType = (row.actorType ?? '').trim();
  const walletAddress = (row.walletAddress ?? row.address ?? '').trim().toLowerCase();
  const chain = (row.chain ?? 'base').trim().toLowerCase();
  if (!isEvmAddress(walletAddress)) return null;

  const tags: string[] = ['smart_wallet_indexer'];
  let category: MappedCategory | null = null;
  if (reviewStatus === 'READY_FOR_WATCHLIST') {
    category = 'high_confidence';
  } else if (reviewStatus === 'WATCHLIST_CANDIDATE') {
    category = 'watch_candidate';
  } else if (reviewStatus === 'OBSERVE_ONLY' && actorType === 'EOA') {
    category = 'watch_candidate';
    tags.push('observe_only');
  } else if (reviewStatus === 'NEEDS_CONTRACT_MANUAL_REVIEW') {
    if (!includeContractReview) return 'skip_contract';
    category = 'needs_review';
    tags.push('contract_review');
  }

  if (!category) return null;

  const reasons = [
    `reviewStatus:${reviewStatus}`,
    `actorCategory:${row.actorCategory ?? ''}`,
    `actorType:${row.actorType ?? ''}`,
    `rankTier:${row.rankTier ?? ''}`,
    `auditTier:${row.auditTier ?? ''}`,
    `recommendedAction:${row.recommendedAction ?? ''}`,
  ].filter((x) => !x.endsWith(':'));

  const notes = [
    `source=smart_wallet_indexer`,
    `sourceFile=${sourceFile}`,
    `actorCategory=${row.actorCategory ?? ''}`,
    `actorType=${row.actorType ?? ''}`,
    `rankTier=${row.rankTier ?? ''}`,
    `auditTier=${row.auditTier ?? ''}`,
    `auditScore=${row.auditScore ?? ''}`,
    `originalScore=${row.originalScore ?? ''}`,
    `uniqueTokenCount=${row.uniqueTokenCount ?? ''}`,
    `avgEarlyIndex=${row.avgEarlyIndex ?? ''}`,
    `bestEarlyIndex=${row.bestEarlyIndex ?? ''}`,
    `tokenSymbols=${row.tokenSymbols ?? row.tokens ?? ''}`,
    `riskLabel=${row.riskLabel ?? ''}`,
    `reviewStatus=${reviewStatus}`,
    `recommendedAction=${row.recommendedAction ?? ''}`,
    row.examples ? `examples=${row.examples}` : '',
  ].filter(Boolean).join('; ');

  return {
    chain,
    walletAddress,
    category,
    status: 'pending_review',
    score: num(row.auditScore) ?? num(row.originalScore),
    tokenAppearances: num(row.uniqueTokenCount),
    averageFirstBuyRank: num(row.avgEarlyIndex),
    bestFirstBuyRank: num(row.bestEarlyIndex),
    reasons,
    riskFlags: splitPipe(row.riskLabel),
    tags,
    notes,
    sourceFiles: [sourceFile],
  };
}

async function readMonitorSet(): Promise<Set<string>> {
  try {
    const raw = await readFile(env.MONITOR_WATCHLIST_PATH, 'utf8');
    const rows = JSON.parse(raw) as Array<Record<string, unknown>>;
    const keys = rows.map((x) => `${String(x.chain ?? '').toLowerCase()}:${String(x.walletAddress ?? '').toLowerCase()}`);
    return new Set(keys);
  } catch {
    return new Set();
  }
}

export async function runIndexerImport(args: CliArgs): Promise<ImportSummary> {
  if (!Number.isFinite(args.maxAdd) || args.maxAdd <= 0) {
    throw new Error(`Invalid --max-add value: ${args.maxAdd}`);
  }
  if (!existsSync(args.input)) {
    throw new Error(`Input CSV not found: ${args.input}`);
  }

  const csvText = await readFile(args.input, 'utf8');
  const rows = parseCsv(csvText);
  if (!rows.length) throw new Error(`Input CSV has zero rows: ${args.input}`);

  const reviewEntries = await getAlphaWalletReviewEntries();
  const reviewSet = new Set(reviewEntries.map((x) => `${x.chain.toLowerCase()}:${x.walletAddress.toLowerCase()}`));
  const monitorSet = await readMonitorSet();

  const summary: ImportSummary = {
    inputRows: rows.length,
    eligibleRows: 0,
    skippedInfra: 0,
    skippedContractReview: 0,
    skippedAlreadyReviewed: 0,
    skippedAlreadyMonitored: 0,
    wouldAdd: 0,
    added: 0,
  };

  const sourceFile = path.resolve(args.input);
  const toImport: MappedRow[] = [];

  for (const row of rows) {
    const mapped = mapRow(row, sourceFile, args.includeContractReview);
    if (mapped === 'skip_infra') {
      summary.skippedInfra += 1;
      continue;
    }
    if (mapped === 'skip_contract') {
      summary.skippedContractReview += 1;
      continue;
    }
    if (!mapped) continue;

    summary.eligibleRows += 1;
    const key = `${mapped.chain}:${mapped.walletAddress}`;
    if (reviewSet.has(key)) {
      summary.skippedAlreadyReviewed += 1;
      continue;
    }
    if (monitorSet.has(key)) {
      summary.skippedAlreadyMonitored += 1;
      continue;
    }
    toImport.push(mapped);
  }

  const capped = toImport.slice(0, args.maxAdd);
  summary.wouldAdd = capped.length;

  if (!args.dryRun) {
    for (const c of capped) {
      await upsertAlphaWalletReviewEntry({
        chain: c.chain,
        walletAddress: c.walletAddress,
        source: 'smart_wallet_indexer',
        category: c.category,
        status: c.status,
        score: c.score,
        tokenAppearances: c.tokenAppearances,
        averageFirstBuyRank: c.averageFirstBuyRank,
        bestFirstBuyRank: c.bestFirstBuyRank,
        reasons: c.reasons,
        riskFlags: c.riskFlags,
        sourceFiles: c.sourceFiles,
        tags: c.tags,
        notes: c.notes,
      });
      summary.added += 1;
    }
  }

  return summary;
}

function printSummary(summary: ImportSummary, args: CliArgs) {
  console.log('Smart wallet indexer import summary');
  console.log(`- input: ${args.input}`);
  console.log(`- dryRun: ${args.dryRun}`);
  console.log(`- maxAdd: ${args.maxAdd}`);
  console.log(`- includeContractReview: ${args.includeContractReview}`);
  console.log(`- inputRows: ${summary.inputRows}`);
  console.log(`- eligibleRows: ${summary.eligibleRows}`);
  console.log(`- skippedInfra: ${summary.skippedInfra}`);
  console.log(`- skippedContractReview: ${summary.skippedContractReview}`);
  console.log(`- skippedAlreadyReviewed: ${summary.skippedAlreadyReviewed}`);
  console.log(`- skippedAlreadyMonitored: ${summary.skippedAlreadyMonitored}`);
  console.log(`- wouldAdd: ${summary.wouldAdd}`);
  console.log(`- added: ${summary.added}`);
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summary = await runIndexerImport(args);
  printSummary(summary, args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
