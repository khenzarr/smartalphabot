import { z } from 'zod';
import { autoRunDiscovery } from '../discovery/auto-discovery.js';
import { formatDateTime, formatNumber } from '../utils/report-format.js';
import { safeJsonStringify } from '../utils/json.js';

const schema = z.object({
  input: z.string().min(1).default('data/seed-tokens.auto-next.json'),
  out: z.string().min(1).default('output/discovery-auto-run-v1'),
  'max-buyers': z.coerce.number().int().positive().default(200),
  'max-hours': z.coerce.number().int().positive().default(24),
  'min-token-appearances': z.coerce.number().int().positive().default(2),
  'only-useful-seeds': z.string().optional().transform((v) => (v === undefined ? true : v === 'true')),
  persist: z.string().optional().transform((v) => (v === undefined ? false : v === 'true')),
  csv: z.string().optional().transform((v) => (v === undefined ? true : v === 'true')),
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

function printReport(result: Awaited<ReturnType<typeof autoRunDiscovery>>, outDir: string) {
  const { runResult } = result;
  const topCandidates = [...runResult.candidateShortlist].slice(0, 10);
  console.log('=== Auto Discovery Report ===');
  console.log(`Generated At: ${formatDateTime(runResult.generatedAt)}`);
  console.log(`Input File: ${runResult.inputSummary.inputPath}`);
  console.log(`Output Directory: ${outDir}`);
  console.log(`Total Seeds: ${formatNumber(runResult.inputSummary.totalSeedTokens)}`);
  console.log(`Keep Seeds: ${formatNumber(runResult.seedCuration.keep.length)}`);
  console.log(`Drop Seeds: ${formatNumber(runResult.seedCuration.drop.length)}`);
  console.log(`Investigate Seeds: ${formatNumber(runResult.seedCuration.investigate.length)}`);
  console.log(`Unique Early Buyers: ${formatNumber(runResult.summary.totalUniqueEarlyBuyers)}`);
  console.log(`Candidate Count: ${formatNumber(runResult.summary.candidateWalletsFound)}`);
  console.log(`Shortlist Count: ${formatNumber(runResult.candidateShortlist.length)}`);

  if (result.warnings.length) {
    console.log('\nWarnings:');
    for (const warning of result.warnings) console.log(`- ${warning}`);
  }

  console.log('\nTop 10 Candidate Wallets:');
  if (!topCandidates.length) {
    console.log('- none');
  } else {
    for (const candidate of topCandidates) {
      console.log(
        `- #${candidate.rank} | chain=${candidate.chain} | wallet=${candidate.walletAddress} | score=${candidate.score} | appearances=${candidate.tokenAppearances} | avgRank=${candidate.averageFirstBuyRank} | category=${candidate.category}`,
      );
    }
  }

  console.log('\nOutput Files:');
  for (const [key, value] of Object.entries(runResult.outputFiles)) {
    console.log(`- ${key}: ${value}`);
  }
}

async function main() {
  const input = parseArgs();
  console.log('[discovery:auto-run] starting seed batch');
  const result = await autoRunDiscovery({
    inputPath: input.input,
    outDir: input.out,
    maxBuyers: input['max-buyers'],
    maxHours: input['max-hours'],
    minTokenAppearances: input['min-token-appearances'],
    persist: input.persist,
    csv: input.csv,
    onlyUsefulSeeds: input['only-useful-seeds'],
    log: (message) => console.log(message),
  });

  if (input.json) {
    console.log(safeJsonStringify(result, 2));
    return;
  }

  printReport(result, input.out);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
