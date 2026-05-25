import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isEvmAddress } from '../utils/address.js';
import { safeJsonStringify } from '../utils/json.js';
import type { SeedTokenInput } from './seed-token-input.js';

type SupportedSeedChain = 'ethereum' | 'base' | 'bsc';

export interface NormalizeSeedsResult {
  seeds: SeedTokenInput[];
  warnings: string[];
  summary: {
    inputCount: number;
    invalidCount: number;
    duplicateCount: number;
    outputCount: number;
  };
}

export interface MergeSeedsResult {
  seeds: SeedTokenInput[];
  summary: {
    baseCount: number;
    addCount: number;
    duplicateCount: number;
    finalCount: number;
  };
}

function normalizeChain(value?: string): SupportedSeedChain | null {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'eth' || v === 'ethereum') return 'ethereum';
  if (v === 'base') return 'base';
  if (v === 'bsc' || v === 'binance') return 'bsc';
  return null;
}

function dedupeSeeds(seeds: SeedTokenInput[]): { seeds: SeedTokenInput[]; duplicateCount: number } {
  const map = new Map<string, SeedTokenInput>();
  let duplicateCount = 0;
  for (const seed of seeds) {
    const key = `${seed.chain}:${seed.tokenAddress.toLowerCase()}`;
    if (map.has(key)) {
      duplicateCount += 1;
      continue;
    }
    map.set(key, { ...seed, tokenAddress: seed.tokenAddress.toLowerCase() });
  }
  return { seeds: [...map.values()], duplicateCount };
}

function parseCsvLine(line: string): string[] {
  return line.split(',').map((x) => x.trim());
}

function fromRows(rows: Array<Partial<SeedTokenInput>>, defaultNarrative?: string): NormalizeSeedsResult {
  const warnings: string[] = [];
  const parsed: SeedTokenInput[] = [];
  const chainCounters = new Map<string, number>();
  let invalidCount = 0;

  for (const row of rows) {
    const chain = normalizeChain(row.chain);
    const tokenAddress = String(row.tokenAddress ?? '').trim();
    if (!chain || !isEvmAddress(tokenAddress)) {
      invalidCount += 1;
      warnings.push(`invalid_seed_row: chain=${row.chain ?? 'n/a'} token=${row.tokenAddress ?? 'n/a'}`);
      continue;
    }

    const nextIndex = (chainCounters.get(chain) ?? 0) + 1;
    chainCounters.set(chain, nextIndex);
    const label = row.label?.trim() || `${chain.toUpperCase()}_SEED_${String(nextIndex).padStart(3, '0')}`;
    parsed.push({
      chain,
      tokenAddress,
      label,
      narrative: row.narrative?.trim() || defaultNarrative,
      notes: row.notes?.trim() || undefined,
    });
  }

  const deduped = dedupeSeeds(parsed);
  return {
    seeds: deduped.seeds,
    warnings,
    summary: {
      inputCount: rows.length,
      invalidCount,
      duplicateCount: deduped.duplicateCount,
      outputCount: deduped.seeds.length,
    },
  };
}

export async function normalizeSeedFile(inputPath: string, defaultNarrative?: string): Promise<NormalizeSeedsResult> {
  const raw = await readFile(inputPath, 'utf8');
  const ext = path.extname(inputPath).toLowerCase();

  if (ext === '.json') {
    const rows = JSON.parse(raw) as Array<Partial<SeedTokenInput>>;
    return fromRows(rows, defaultNarrative);
  }

  if (ext === '.csv') {
    const lines = raw.split(/\r?\n/).filter((x) => x.trim().length > 0);
    const header = parseCsvLine(lines[0] ?? '');
    const rows: Array<Partial<SeedTokenInput>> = [];
    for (const line of lines.slice(1)) {
      const cols = parseCsvLine(line);
      const get = (name: string) => {
        const idx = header.indexOf(name);
        return idx >= 0 ? cols[idx] : undefined;
      };
      rows.push({
        chain: get('chain') as SeedTokenInput['chain'],
        tokenAddress: get('tokenAddress') as string,
        label: get('label'),
        narrative: get('narrative'),
        notes: get('notes'),
      });
    }
    return fromRows(rows, defaultNarrative);
  }

  const lines = raw.split(/\r?\n/);
  const rows: Array<Partial<SeedTokenInput>> = [];
  let currentChain: SupportedSeedChain | null = null;
  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line) continue;
    if (line.endsWith(':')) {
      currentChain = normalizeChain(line.slice(0, -1));
      continue;
    }
    rows.push({ chain: (currentChain ?? undefined) as SeedTokenInput['chain'], tokenAddress: line });
  }

  return fromRows(rows, defaultNarrative);
}

export async function writeNormalizedSeeds(outPath: string, result: NormalizeSeedsResult) {
  await writeFile(outPath, safeJsonStringify(result.seeds, 2), 'utf8');
}

export async function mergeSeedFiles(basePath: string, addPath: string): Promise<MergeSeedsResult> {
  const base = (JSON.parse(await readFile(basePath, 'utf8')) as SeedTokenInput[]).map((x) => ({ ...x, tokenAddress: x.tokenAddress.toLowerCase() }));
  const add = (JSON.parse(await readFile(addPath, 'utf8')) as SeedTokenInput[]).map((x) => ({ ...x, tokenAddress: x.tokenAddress.toLowerCase() }));

  const map = new Map<string, SeedTokenInput>();
  for (const seed of base) map.set(`${seed.chain}:${seed.tokenAddress}`, seed);
  let duplicateCount = 0;
  for (const seed of add) {
    const key = `${seed.chain}:${seed.tokenAddress}`;
    if (map.has(key)) {
      duplicateCount += 1;
      continue;
    }
    map.set(key, seed);
  }

  const seeds = [...map.values()].sort((a, b) => {
    if (a.chain !== b.chain) return a.chain.localeCompare(b.chain);
    return (a.label ?? a.tokenAddress).localeCompare(b.label ?? b.tokenAddress);
  });

  return {
    seeds,
    summary: {
      baseCount: base.length,
      addCount: add.length,
      duplicateCount,
      finalCount: seeds.length,
    },
  };
}
