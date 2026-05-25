import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { IGNORED_TOKEN_SYMBOLS } from '../monitoring/constants.js';
import type { EvmSupportedChain, MonitorKnownToken } from '../monitoring/monitoring.types.js';
import { safeJsonStringify } from '../utils/json.js';

interface Args {
  out: string;
  outputDir: string;
  maxTokens: number;
  chains: EvmSupportedChain[];
  chunkBudget: number;
  walletCount: number;
  getLogsMaxBlockRange: number;
  ethereumBlocks: number;
  baseBlocks: number;
  bscBlocks: number;
}

interface ScoredTokenRow {
  chain: EvmSupportedChain;
  tokenAddress: string;
  symbol?: string;
  score: number;
  freshness: number;
}

interface BuildMeta {
  out: string;
  outputDir: string;
  requestedMaxTokens: number;
  finalTokenCount: number;
  estimatedChunks: number;
  chunkBudget: number;
  reducedToFitBudget: boolean;
  droppedDueToBudget: number;
  byChain: Record<string, number>;
  sourcesUsed: string[];
  filesConsidered: number;
  filesScanned: number;
  skippedFiles: number;
  warnings: string[];
  generatedAt: string;
}

export interface KnownTokensBudgetResult {
  tokens: MonitorKnownToken[];
  requestedMaxTokens: number;
  finalTokenCount: number;
  estimatedChunks: number;
  chunkBudget: number;
  reducedToFitBudget: boolean;
  droppedDueToBudget: number;
  byChain: Record<string, number>;
}

const CHAIN_PRIORITY: EvmSupportedChain[] = ['ethereum', 'base', 'bsc'];
const TARGET_FILES = new Set(['token-buyer-summary.json', 'token-results.json', 'candidate-evidence.json']);
const MAX_OUTPUT_FILES = 50;
const MAX_FILE_BYTES = 10_000_000;

function parseInteger(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function normalizeChain(raw: unknown): EvmSupportedChain | undefined {
  const chain = String(raw ?? '').trim().toLowerCase();
  if (chain === 'eth') return 'ethereum';
  if (chain === 'ethereum' || chain === 'base' || chain === 'bsc') return chain;
  return undefined;
}

function normalizeTokenAddress(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function looksIgnoredToken(symbol?: string): boolean {
  return symbol ? IGNORED_TOKEN_SYMBOLS.has(symbol.trim().toLowerCase()) : false;
}

function parseArgs(argv: string[]): Args {
  const read = (key: string, fallback: string) => {
    const i = argv.indexOf(`--${key}`);
    return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
  };

  const parseChains = (raw: string): EvmSupportedChain[] => {
    const set = new Set<EvmSupportedChain>();
    for (const entry of raw.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) {
      const chain = normalizeChain(entry);
      if (chain) set.add(chain);
    }
    return set.size ? [...set] : ['ethereum', 'base'];
  };

  return {
    out: read('out', env.MONITOR_KNOWN_TOKENS_PATH),
    outputDir: read('output-dir', 'output'),
    maxTokens: Math.max(1, Math.min(100, parseInteger(read('max-tokens', String(env.MONITOR_KNOWN_TOKENS_MAX)), env.MONITOR_KNOWN_TOKENS_MAX))),
    chains: parseChains(read('chain', 'ethereum,base')),
    chunkBudget: Math.max(1, parseInteger(read('chunk-budget', '1000'), 1000)),
    walletCount: Math.max(1, parseInteger(read('wallet-count', '20'), 20)),
    getLogsMaxBlockRange: Math.max(1, parseInteger(read('getlogs-max-block-range', '10'), 10)),
    ethereumBlocks: Math.max(1, parseInteger(read('ethereum-blocks', '100'), 100)),
    baseBlocks: Math.max(1, parseInteger(read('base-blocks', '300'), 300)),
    bscBlocks: Math.max(1, parseInteger(read('bsc-blocks', String(env.MONITOR_BSC_BLOCKS)), env.MONITOR_BSC_BLOCKS)),
  };
}

async function walkFiles(dirPath: string, collected: string[] = []): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
  try {
    entries = await readdir(dirPath, { withFileTypes: true }) as never;
  } catch {
    return collected;
  }
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(full, collected);
      continue;
    }
    if (entry.isFile()) collected.push(full);
  }
  return collected;
}

function extractTokenRows(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null);
  if (payload && typeof payload === 'object') {
    const rec = payload as Record<string, unknown>;
    if (Array.isArray(rec.rows)) return extractTokenRows(rec.rows);
    if (Array.isArray(rec.tokens)) return extractTokenRows(rec.tokens);
    if (Array.isArray(rec.items)) return extractTokenRows(rec.items);
  }
  return [];
}

function toEpoch(input: unknown): number {
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (typeof input === 'string') {
    const d = Date.parse(input);
    return Number.isFinite(d) ? d : 0;
  }
  return 0;
}

function scoreTokenRow(row: Record<string, unknown>, chain: EvmSupportedChain, tokenAddress: string, symbol?: string): ScoredTokenRow {
  const status = String(row.status ?? '').toLowerCase();
  const triage = String(row.seedTriageStatus ?? row.triageStatus ?? '').toLowerCase();
  const source = String(row.source ?? row.evidenceSource ?? '').toLowerCase();
  const overlap = Number(row.overlapScore ?? row.usefulnessScore ?? row.sharedWalletCount ?? 0);
  let score = 0;
  if ((status === 'success' && triage === 'keep') || source.includes('seed') || source.includes('keep')) score += 1000;
  if (source.includes('candidate') || String(row.category ?? '').toLowerCase().includes('candidate')) score += 500;
  if (overlap > 0 || source.includes('overlap') || source.includes('useful')) score += 250;
  score += CHAIN_PRIORITY.length - Math.max(0, CHAIN_PRIORITY.indexOf(chain));
  const freshness = Math.max(toEpoch(row.updatedAt), toEpoch(row.discoveredAt), toEpoch(row.lastSeenAt), toEpoch(row.createdAt));
  return { chain, tokenAddress, symbol, score, freshness };
}

function estimateGetLogsChunks(args: Pick<Args, 'chains' | 'walletCount' | 'getLogsMaxBlockRange' | 'ethereumBlocks' | 'baseBlocks' | 'bscBlocks'>, tokens: MonitorKnownToken[]): number {
  const windowsByChain: Record<EvmSupportedChain, number> = {
    ethereum: args.ethereumBlocks,
    base: args.baseBlocks,
    bsc: args.bscBlocks,
  };
  let total = 0;
  for (const chain of args.chains) {
    const chainTokenCount = tokens.filter((t) => t.chain === chain).length;
    if (!chainTokenCount) continue;
    const chunksPerPair = Math.ceil(Math.max(1, windowsByChain[chain] ?? 1) / Math.max(1, args.getLogsMaxBlockRange));
    total += args.walletCount * chainTokenCount * chunksPerPair;
  }
  return total;
}

export function buildKnownTokens(
  rows: Array<Record<string, unknown>>,
  maxOrLegacyOptions?: number | { onlyKeep?: boolean; [key: string]: unknown },
): MonitorKnownToken[] {
  const legacyOnlyKeep = typeof maxOrLegacyOptions === 'object' && !!maxOrLegacyOptions?.onlyKeep;
  const max = typeof maxOrLegacyOptions === 'number' && Number.isFinite(maxOrLegacyOptions)
    ? maxOrLegacyOptions
    : env.MONITOR_KNOWN_TOKENS_MAX;
  const out = new Map<string, ScoredTokenRow>();

  for (const row of rows) {
    if (legacyOnlyKeep) {
      const status = String(row.status ?? '').trim().toLowerCase();
      const triage = String(row.seedTriageStatus ?? '').trim().toLowerCase();
      if (status !== 'success' || triage !== 'keep') continue;
    }
    const chain = normalizeChain(row.chain ?? row.network ?? row.chainId);
    const tokenAddress = normalizeTokenAddress(row.tokenAddress ?? row.address ?? row.contractAddress ?? row.token);
    const symbol = String(row.symbol ?? row.tokenSymbol ?? '').trim() || undefined;
    if (!chain || !tokenAddress || !tokenAddress.startsWith('0x')) continue;
    if (looksIgnoredToken(symbol)) continue;
    const key = `${chain}:${tokenAddress}`;
    const scored = scoreTokenRow(row, chain, tokenAddress, symbol);
    const current = out.get(key);
    if (!current || scored.score > current.score || (scored.score === current.score && scored.freshness > current.freshness)) {
      out.set(key, scored);
    }
  }

  return [...out.values()]
    .sort((a, b) =>
      b.score - a.score ||
      b.freshness - a.freshness ||
      CHAIN_PRIORITY.indexOf(a.chain) - CHAIN_PRIORITY.indexOf(b.chain) ||
      a.tokenAddress.localeCompare(b.tokenAddress))
    .slice(0, Math.max(1, Math.min(100, max)))
    .map((t) => ({ chain: t.chain, tokenAddress: t.tokenAddress, symbol: t.symbol }));
}

function reduceTokensToBudget(args: Args, tokens: MonitorKnownToken[]) {
  let selected = tokens.slice(0, args.maxTokens);
  let estimatedChunks = estimateGetLogsChunks(args, selected);
  while (selected.length > 1 && estimatedChunks > args.chunkBudget) {
    selected = selected.slice(0, selected.length - 1);
    estimatedChunks = estimateGetLogsChunks(args, selected);
  }
  return {
    selected,
    estimatedChunks,
    reducedToFitBudget: selected.length < Math.min(tokens.length, args.maxTokens),
    droppedDueToBudget: Math.max(0, Math.min(tokens.length, args.maxTokens) - selected.length),
  };
}

export function buildKnownTokensWithinBudget(rows: Array<Record<string, unknown>>, args: {
  maxTokens?: number;
  chains?: EvmSupportedChain[];
  chunkBudget?: number;
  walletCount?: number;
  getLogsMaxBlockRange?: number;
  ethereumBlocks?: number;
  baseBlocks?: number;
  bscBlocks?: number;
} = {}): KnownTokensBudgetResult {
  const requestedMaxTokens = Math.max(1, Math.min(100, Math.floor(args.maxTokens ?? env.MONITOR_KNOWN_TOKENS_MAX)));
  const chains: EvmSupportedChain[] = args.chains && args.chains.length ? args.chains : ['ethereum', 'base'];
  const runtimeArgs: Args = {
    out: env.MONITOR_KNOWN_TOKENS_PATH,
    outputDir: 'output',
    maxTokens: requestedMaxTokens,
    chains,
    chunkBudget: Math.max(1, Math.floor(args.chunkBudget ?? 1000)),
    walletCount: Math.max(1, Math.floor(args.walletCount ?? 20)),
    getLogsMaxBlockRange: Math.max(1, Math.floor(args.getLogsMaxBlockRange ?? 10)),
    ethereumBlocks: Math.max(1, Math.floor(args.ethereumBlocks ?? 100)),
    baseBlocks: Math.max(1, Math.floor(args.baseBlocks ?? 300)),
    bscBlocks: Math.max(1, Math.floor(args.bscBlocks ?? env.MONITOR_BSC_BLOCKS)),
  };
  const prioritizedTokens = buildKnownTokens(rows, requestedMaxTokens).filter((t) => runtimeArgs.chains.includes(t.chain));
  const budgeted = reduceTokensToBudget(runtimeArgs, prioritizedTokens);
  const byChain = budgeted.selected.reduce<Record<string, number>>((acc, t) => {
    acc[t.chain] = (acc[t.chain] ?? 0) + 1;
    return acc;
  }, {});
  return {
    tokens: budgeted.selected,
    requestedMaxTokens,
    finalTokenCount: budgeted.selected.length,
    estimatedChunks: budgeted.estimatedChunks,
    chunkBudget: runtimeArgs.chunkBudget,
    reducedToFitBudget: budgeted.reducedToFitBudget,
    droppedDueToBudget: budgeted.droppedDueToBudget,
    byChain,
  };
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = await walkFiles(args.outputDir);
  const candidates: Array<{ filePath: string; mtimeMs: number; size: number }> = [];
  for (const filePath of files) {
    const base = path.basename(filePath);
    if (!TARGET_FILES.has(base)) continue;
    try {
      const st = await stat(filePath);
      candidates.push({ filePath, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      // ignore
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const selected = candidates.slice(0, MAX_OUTPUT_FILES);
  const sourceCounts: Record<string, number> = {};
  const allRows: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];
  let skippedFiles = 0;

  const manualFiles = [
    'data/seed-tokens.generated.json',
    'data/seed-tokens.auto-discovered.json',
    'data/monitor-known-tokens.json',
  ];

  for (const file of selected.map((x) => x.filePath).concat(manualFiles)) {
    try {
      const st = await stat(file);
      if (st.size > MAX_FILE_BYTES) {
        skippedFiles += 1;
        warnings.push(`Skipped large file: ${file}`);
        continue;
      }
      const raw = await readFile(file, 'utf8');
      const rows = extractTokenRows(JSON.parse(raw) as unknown);
      allRows.push(...rows);
      sourceCounts[path.basename(file)] = (sourceCounts[path.basename(file)] ?? 0) + 1;
    } catch {
      // optional file
    }
  }

  const budgetResult = buildKnownTokensWithinBudget(allRows, {
    maxTokens: args.maxTokens,
    chains: args.chains,
    chunkBudget: args.chunkBudget,
    walletCount: args.walletCount,
    getLogsMaxBlockRange: args.getLogsMaxBlockRange,
    ethereumBlocks: args.ethereumBlocks,
    baseBlocks: args.baseBlocks,
    bscBlocks: args.bscBlocks,
  });

  if (budgetResult.reducedToFitBudget) {
    warnings.push('known_token_list_reduced_to_fit_chunk_budget');
  }

  await mkdir(path.dirname(args.out), { recursive: true });
  await writeFile(args.out, safeJsonStringify(budgetResult.tokens, 2), 'utf8');
  const meta: BuildMeta = {
    out: args.out,
    outputDir: args.outputDir,
    requestedMaxTokens: args.maxTokens,
    finalTokenCount: budgetResult.finalTokenCount,
    estimatedChunks: budgetResult.estimatedChunks,
    chunkBudget: args.chunkBudget,
    reducedToFitBudget: budgetResult.reducedToFitBudget,
    droppedDueToBudget: budgetResult.droppedDueToBudget,
    byChain: budgetResult.byChain,
    sourcesUsed: Object.keys(sourceCounts),
    filesConsidered: candidates.length,
    filesScanned: selected.length,
    skippedFiles,
    warnings,
    generatedAt: new Date().toISOString(),
  };
  await writeFile(args.out.replace(/\.json$/i, '.meta.json'), safeJsonStringify(meta, 2), 'utf8');

  console.log(`Wrote known tokens: ${args.out} (count=${budgetResult.finalTokenCount})`);
  console.log(`Estimated chunks: ${budgetResult.estimatedChunks}/${args.chunkBudget}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});