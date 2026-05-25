import { z } from 'zod';
import { autoExpandSeeds, autoRunDiscovery } from '../discovery/auto-discovery.js';
import { formatDateTime } from '../utils/report-format.js';
import { safeJsonStringify } from '../utils/json.js';

const schema = z.object({
  base: z.string().min(1).default('data/seed-tokens.keep.json'),
  expanded: z.string().min(1).default('data/seed-tokens.auto-next.json'),
  expansionWorkdir: z.string().min(1).default('output/auto-seed-expansion'),
  discoveryOut: z.string().min(1).default('output/discovery-auto-v1'),
  chains: z.string().default('ethereum,base,bsc'),
  'target-count': z.coerce.number().int().positive().default(30),
  'include-query-discovery': z.string().optional().transform((v) => (v === undefined ? true : v === 'true')),
  'max-per-query': z.coerce.number().int().positive().default(10),
  'max-query-seconds': z.coerce.number().int().positive().default(20),
  'max-total-seconds': z.coerce.number().int().positive().default(1800),
  queries: z.string().optional(),
  'default-narrative': z.string().default('ethereum_meme'),
  'skip-batch': z.string().optional().transform((v) => (v === undefined ? false : v === 'true')),
  'batch-max-buyers': z.coerce.number().int().positive().default(50),
  'batch-max-hours': z.coerce.number().int().positive().default(6),
  'batch-min-appearances': z.coerce.number().int().positive().default(2),
  'only-useful-seeds': z.string().optional().transform((v) => (v === undefined ? true : v === 'true')),
  'min-liquidity': z.coerce.number().positive().optional(),
  'min-market-cap': z.coerce.number().positive().optional(),
  'min-volume-h24': z.coerce.number().positive().optional(),
  persist: z.string().optional().transform((v) => (v === undefined ? false : v === 'true')),
  csv: z.string().optional().transform((v) => (v === undefined ? true : v === 'true')),
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

function parseChains(raw: string): Array<'ethereum' | 'base' | 'bsc'> {
  return raw
    .split(',')
    .map((x) => x.trim())
    .filter((x): x is 'ethereum' | 'base' | 'bsc' => x === 'ethereum' || x === 'base' || x === 'bsc');
}

async function main() {
  const input = parseArgs();
  const log = (message: string) => console.log(`[discovery:auto] ${message}`);
  log('starting auto discovery');
  log('loading base seeds');
  log('starting auto expansion');
  const autoExpandResult = await autoExpandSeeds({
    basePath: input.base,
    outPath: input.expanded,
    workdir: input.expansionWorkdir,
    chains: parseChains(input.chains),
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

  log('auto expansion finished');
  log(`writing auto seed files -> ${autoExpandResult.outputFiles.mergedNextJson}`);

  let runResult: Awaited<ReturnType<typeof autoRunDiscovery>> | null = null;
  if (!input['skip-batch']) {
    log('starting seed batch');
    log(`seed count passed into batch: ${autoExpandResult.finalSeedCount}`);
    log(
      `batch params: maxBuyers=${input['batch-max-buyers']}, maxHours=${input['batch-max-hours']}, minAppearances=${input['batch-min-appearances']}, onlyUsefulSeeds=${input['only-useful-seeds']}`,
    );
    runResult = await autoRunDiscovery({
      inputPath: autoExpandResult.outputFiles.mergedNextJson,
      outDir: input.discoveryOut,
      maxBuyers: input['batch-max-buyers'],
      maxHours: input['batch-max-hours'],
      minTokenAppearances: input['batch-min-appearances'],
      persist: input.persist,
      csv: input.csv,
      onlyUsefulSeeds: input['only-useful-seeds'],
      log: (message) => console.log(message),
    });
    log('batch finished');
    log(`output directory: ${input.discoveryOut}`);
  } else {
    log('batch stage skipped by --skip-batch true');
  }

  if (input.json) {
    console.log(
      safeJsonStringify(
        {
          generatedAt: formatDateTime(new Date().toISOString()),
          autoExpandResult,
          autoRunResult: runResult,
        },
        2,
      ),
    );
    return;
  }

  console.log('=== Auto Discovery Pipeline Complete ===');
  console.log(`Auto expansion report: ${autoExpandResult.outputFiles.reportJson}`);
  console.log(`Seed expansion output: ${autoExpandResult.outputFiles.mergedNextJson}`);
  console.log(`Discovery output directory: ${input.discoveryOut}`);
  console.log(`Generated At: ${autoExpandResult.generatedAt}`);
  console.log(`Discovered From Profiles: ${autoExpandResult.discoveredFromProfilesCount}`);
  console.log(`Discovered From Search Queries: ${autoExpandResult.discoveredFromSearchQueriesCount}`);
  console.log(`Query Count: ${autoExpandResult.queryCount}`);
  console.log(`Queries Used (${autoExpandResult.queriesUsed.length}): ${autoExpandResult.queriesUsed.join(', ')}`);
  console.log(`Accepted By Chain: ${safeJsonStringify(autoExpandResult.acceptedByChain)}`);
  console.log(`Accepted By Profile: ${safeJsonStringify(autoExpandResult.acceptedByProfile)}`);
  console.log(`Skipped Reason Counts: ${safeJsonStringify(autoExpandResult.skippedReasonCounts)}`);
  if (runResult) {
    console.log(`Batch Total Seeds: ${runResult.runResult.inputSummary.totalSeedTokens}`);
    console.log(`Batch Keep/Drop/Investigate: ${runResult.runResult.seedCuration.keep.length}/${runResult.runResult.seedCuration.drop.length}/${runResult.runResult.seedCuration.investigate.length}`);
    console.log(`Unique Early Buyers: ${runResult.runResult.summary.totalUniqueEarlyBuyers}`);
    console.log(`Candidate Count: ${runResult.runResult.summary.candidateWalletsFound}`);
    console.log(`Shortlist Count: ${runResult.runResult.candidateShortlist.length}`);
    const top = runResult.runResult.candidateShortlist.slice(0, 5);
    console.log(`Top Candidate Wallets: ${top.length ? top.map((x) => x.walletAddress).join(', ') : 'none'}`);
  }

  if (autoExpandResult.warnings.length || (runResult?.warnings.length ?? 0)) {
    console.log('\nWarnings:');
    for (const warning of [...autoExpandResult.warnings, ...(runResult?.warnings ?? [])]) console.log(`- ${warning}`);
  }

  const nextCommand =
    runResult?.nextRecommendedCommand ??
    'npm run discovery:auto -- --target-count 30 --include-query-discovery true --batch-max-buyers 50 --batch-max-hours 6 --max-per-query 10';
  console.log(`Next recommended command: ${nextCommand}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
