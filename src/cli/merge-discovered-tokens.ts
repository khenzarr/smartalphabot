import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { env } from '../config/env.js';
import { parseBooleanEnvValue } from '../config/env.js';
import type { DiscoveredTokenCandidate, MonitorKnownToken } from '../monitoring/monitoring.types.js';

interface Args {
  discovered: string;
  knownTokens: string;
  dryRun: boolean;
  maxAdd: number;
  minWalletsSeen: number;
  minTxCount: number;
  chunkBudget: number;
}

function parseArgs(argv: string[]): Args {
  const read = (key: string, fallback: string): string => {
    const i = argv.indexOf(`--${key}`);
    return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
  };
  return {
    discovered: read('discovered', `${env.MONITOR_OUTPUT_DIR}/latest-discovered-tokens.json`),
    knownTokens: read('known-tokens', env.MONITOR_KNOWN_TOKENS_PATH),
    dryRun: parseBooleanEnvValue(read('dry-run', 'true'), true),
    maxAdd: Math.max(0, Number(read('max-add', '20'))),
    minWalletsSeen: Math.max(1, Number(read('min-wallets-seen', '2'))),
    minTxCount: Math.max(1, Number(read('min-tx-count', '2'))),
    chunkBudget: Math.max(1, Number(read('chunk-budget', String(env.MONITOR_MAX_GETLOGS_CHUNKS_PER_RUN)))),
  };
}

async function readJsonSafe<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function looksStableOrWrapped(symbol?: string, name?: string): boolean {
  const hay = `${symbol ?? ''} ${name ?? ''}`.toLowerCase();
  return ['usdc', 'usdt', 'dai', 'weth', 'wbtc', 'wbnb', 'stable'].some((x) => hay.includes(x));
}

function dedupeDiscovered(input: DiscoveredTokenCandidate[]): DiscoveredTokenCandidate[] {
  const map = new Map<string, DiscoveredTokenCandidate>();
  for (const row of input) {
    const key = `${row.chain}:${row.tokenAddress.toLowerCase()}`;
    if (!map.has(key)) {
      map.set(key, { ...row, tokenAddress: row.tokenAddress.toLowerCase() });
      continue;
    }
    const cur = map.get(key)!;
    cur.txCount = Math.max(cur.txCount, row.txCount);
    for (const w of row.walletsSeen ?? []) {
      if (!cur.walletsSeen.includes(w.toLowerCase())) cur.walletsSeen.push(w.toLowerCase());
    }
    for (const t of row.likelyActivityTypes ?? []) {
      if (!cur.likelyActivityTypes.includes(t)) cur.likelyActivityTypes.push(t);
    }
    for (const tx of row.sampleTxHashes ?? []) {
      if (cur.sampleTxHashes.length >= 5) break;
      if (!cur.sampleTxHashes.includes(tx)) cur.sampleTxHashes.push(tx);
    }
    if (new Date(row.firstSeenAt).getTime() < new Date(cur.firstSeenAt).getTime()) cur.firstSeenAt = row.firstSeenAt;
  }
  return [...map.values()];
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  const discovered = dedupeDiscovered(await readJsonSafe<DiscoveredTokenCandidate[]>(args.discovered, []));
  const knownTokens = await readJsonSafe<MonitorKnownToken[]>(args.knownTokens, []);
  const knownSet = new Set(knownTokens.map((x) => `${x.chain}:${x.tokenAddress.toLowerCase()}`));

  const skippedReasons: Record<string, number> = {};
  const inc = (k: string) => { skippedReasons[k] = (skippedReasons[k] ?? 0) + 1; };

  const eligible = discovered.filter((row) => {
    const key = `${row.chain}:${row.tokenAddress.toLowerCase()}`;
    if (knownSet.has(key)) {
      inc('already_known');
      return false;
    }
    if (row.walletsSeen.length < args.minWalletsSeen) {
      inc('below_min_wallets_seen');
      return false;
    }
    if (row.txCount < args.minTxCount) {
      inc('below_min_tx_count');
      return false;
    }
    if (looksStableOrWrapped(undefined, undefined)) {
      // schema does not carry symbol/name, keep detector for future extension
    }
    return true;
  });

  const wouldAdd = eligible.slice(0, args.maxAdd).map((x) => ({ chain: x.chain, tokenAddress: x.tokenAddress.toLowerCase() }));
  const next = args.dryRun ? knownTokens : [...knownTokens, ...wouldAdd];
  if (!args.dryRun) {
    await writeFile(args.knownTokens, JSON.stringify(next, null, 2), 'utf8');
  }

  const report = {
    dryRun: args.dryRun,
    discoveredInputFile: args.discovered,
    knownTokensFile: args.knownTokens,
    currentKnownTokens: knownTokens.length,
    discoveredInputCount: discovered.length,
    eligibleDiscoveredTokens: eligible.length,
    wouldAdd: wouldAdd.length,
    added: args.dryRun ? 0 : wouldAdd.length,
    skippedReasons,
    finalEstimatedChunks: next.length,
    chunkBudget: args.chunkBudget,
    chunkBudgetExceeded: next.length > args.chunkBudget,
  };

  console.log('Merge discovered tokens report');
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}