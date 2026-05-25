import { z } from 'zod';
import { autoExpandSeeds } from '../discovery/auto-discovery.js';
import { formatDateTime, formatNumber } from '../utils/report-format.js';
import { safeJsonStringify } from '../utils/json.js';

type AutoExpandChain = 'ethereum' | 'base' | 'bsc';

const schema = z.object({
  base: z.string().min(1).default('data/seed-tokens.keep.json'),
  out: z.string().min(1).default('data/seed-tokens.auto-next.json'),
  workdir: z.string().min(1).default('output/auto-seed-expansion'),
  chains: z.string().default('ethereum,base,bsc'),
  'target-count': z.coerce.number().int().positive().default(30),
  'include-query-discovery': z.string().optional().transform((v) => (v === undefined ? true : v === 'true')),
  'max-per-query': z.coerce.number().int().positive().default(10),
  'max-query-seconds': z.coerce.number().int().positive().default(20),
  'max-total-seconds': z.coerce.number().int().positive().default(1800),
  queries: z.string().optional(),
  'min-liquidity': z.coerce.number().positive().optional(),
  'min-market-cap': z.coerce.number().positive().optional(),
  'min-volume-h24': z.coerce.number().positive().optional(),
  'default-narrative': z.string().default('ethereum_meme'),
  'dry-run': z.string().optional().transform((v) => (v === undefined ? false : v === 'true')),
  json: z.string().optional().transform((v) => v === 'true'),
});

function parseArgs() {
  const args = process.argv.slice(2);
  const map: Record<string, string | undefined> = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i]?.startsWith('--')) map[args[i].slice(2)] = args[i + 1];
  }
  return schema.parse(map);
}

function parseQueries(raw?: string): string[] | undefined {
  if (!raw) return undefined;
  const queries = raw
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  return queries.length ? queries : undefined;
}

function parseChains(raw: string): AutoExpandChain[] {
  const chains = raw
    .split(',')
    .map((x) => x.trim())
    .filter((x): x is AutoExpandChain => x === 'ethereum' || x === 'base' || x === 'bsc');
  return Array.from(new Set(chains));
}

async function main() {
  const input = parseArgs();
  const log = (message: string) => console.log(`[seeds:auto-expand] ${message}`);
  log('starting auto expansion');
  const chains = parseChains(input.chains);
  const result = await autoExpandSeeds({
    basePath: input.base,
    outPath: input.out,
    workdir: input.workdir,
    chains,
    targetCount: input['target-count'],
    includeQueryDiscovery: input['include-query-discovery'],
    maxPerQuery: input['max-per-query'],
    maxQuerySeconds: input['max-query-seconds'],
    maxTotalSeconds: input['max-total-seconds'],
    queries: parseQueries(input.queries),
    minLiquidity: input['min-liquidity'],
    minMarketCap: input['min-market-cap'],
    minVolumeH24: input['min-volume-h24'],
    defaultNarrative: input['default-narrative'],
    dryRun: input['dry-run'],
    discoveredOutPath: 'data/seed-tokens.auto-discovered.json',
    metaOutPath: 'data/seed-tokens.auto-next.meta.json',
    log: (message) => console.log(message),
  });

  if (input.json) {
    console.log(safeJsonStringify(result, 2));
    return;
  }

  console.log('=== Auto Seed Expansion Report ===');
  console.log(`Generated At: ${formatDateTime(result.generatedAt)}`);
  console.log(`Base Seeds: ${formatNumber(result.baseSeedCount)}`);
  console.log(`Auto Discovered Seeds: ${formatNumber(result.autoDiscoveredCount)}`);
  console.log(`From Profiles: ${formatNumber(result.discoveredFromProfilesCount)}`);
  console.log(`From Search Queries: ${formatNumber(result.discoveredFromSearchQueriesCount)}`);
  console.log(`Final Seeds: ${formatNumber(result.finalSeedCount)}`);
  console.log(`Target: ${formatNumber(result.targetCount)}`);
  console.log(`Seed Growth: ${formatNumber(result.seedGrowth)}`);
  console.log(`Query Count: ${formatNumber(result.queryCount)}`);
  console.log(`Queries Used (${result.queriesUsed.length}): ${result.queriesUsed.join(', ')}`);
  console.log(`Accepted By Chain: ${safeJsonStringify(result.acceptedByChain)}`);
  console.log(`Accepted By Profile: ${safeJsonStringify(result.acceptedByProfile)}`);
  console.log(`Skipped Reason Counts: ${safeJsonStringify(result.skippedReasonCounts)}`);

  if (result.warnings.length) {
    console.log('\nWarnings:');
    for (const warning of result.warnings) {
      console.log(`- ${warning}`);
    }
  }

  console.log('\nOutput Files:');
  console.log(`- autoDiscoveredJson: ${result.outputFiles.autoDiscoveredJson}`);
  console.log(`- mergedNextJson: ${result.outputFiles.mergedNextJson}`);
  console.log(`- mergedNextMetaJson: ${result.outputFiles.mergedNextMetaJson}`);
  console.log(`- reportJson: ${result.outputFiles.reportJson}`);
  console.log('\nNext command: npm run discovery:auto -- --target-count 30 --include-query-discovery true --batch-max-buyers 50 --batch-max-hours 6 --max-per-query 10');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
