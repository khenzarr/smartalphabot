import { z } from 'zod';
import { discoverSeedTokens, writeSeedDiscoveryOutputs } from '../discovery/discover-seed-tokens.js';
import type { SupportedChain } from '../chains/chain.types.js';
import { formatDateTime, formatNumber, formatUsd } from '../utils/report-format.js';
import { safeJsonStringify } from '../utils/json.js';

const schema = z.object({
  chains: z.string().optional().default('ethereum,base,bsc'),
  limit: z.coerce.number().int().positive().default(30),
  'min-market-cap': z.coerce.number().nonnegative().optional(),
  'min-liquidity': z.coerce.number().nonnegative().optional(),
  'min-volume-h24': z.coerce.number().nonnegative().optional(),
  'min-price-change-h24': z.coerce.number().optional(),
  'max-age-days': z.coerce.number().positive().optional(),
  'include-latest-profiles': z.string().optional().transform((v) => (v === undefined ? true : v === 'true')),
  'include-latest-boosts': z.string().optional().transform((v) => (v === undefined ? true : v === 'true')),
  'include-top-boosts': z.string().optional().transform((v) => (v === undefined ? true : v === 'true')),
  json: z.string().optional().transform((v) => v === 'true'),
  out: z.string().optional().default('data/seed-tokens.generated.json'),
});

function parseArgs() {
  const args = process.argv.slice(2);
  const map: Record<string, string | undefined> = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i]?.startsWith('--')) map[args[i].slice(2)] = args[i + 1];
  }
  return schema.parse(map);
}

function parseChains(chainsRaw: string): SupportedChain[] {
  return chainsRaw
    .split(',')
    .map((x) => x.trim())
    .filter((x): x is SupportedChain => x === 'ethereum' || x === 'base' || x === 'bsc');
}

function printReport(result: Awaited<ReturnType<typeof discoverSeedTokens>>, outPath: string, metaPath: string) {
  const diagnostics = result.diagnostics;
  console.log('=== DexScreener Seed Discovery Report ===');
  console.log(`Generated At: ${formatDateTime(result.generatedAt)}`);
  console.log(`Chains: ${result.inputSummary.chains.join(',')}`);
  console.log(`Candidates: ${formatNumber(result.candidates.length)}`);
  console.log(`Warnings: ${formatNumber(result.warnings.length)}`);

  if (diagnostics) {
    console.log('\n=== Discovery Diagnostics ===');
    console.log(
      `Source Fetch Counts: latest_profiles=${formatNumber(diagnostics.sourceFetchCounts.latest_profiles ?? 0)} | latest_boosts=${formatNumber(
        diagnostics.sourceFetchCounts.latest_boosts ?? 0,
      )} | top_boosts=${formatNumber(diagnostics.sourceFetchCounts.top_boosts ?? 0)}`,
    );
    console.log(`After Chain Filter: ${formatNumber(diagnostics.candidatesAfterChainFilter)}`);
    console.log(`After Dedupe: ${formatNumber(diagnostics.candidatesAfterDedupe)}`);
    console.log(`Pair Data Unavailable: ${formatNumber(diagnostics.pairDataUnavailable)}`);
    console.log(
      `Skipped by Filter: minMarketCap=${formatNumber(diagnostics.skippedByFilter.minMarketCap)} | minLiquidity=${formatNumber(
        diagnostics.skippedByFilter.minLiquidityUsd,
      )} | minVolumeH24=${formatNumber(diagnostics.skippedByFilter.minVolumeH24)} | minPriceChangeH24=${formatNumber(
        diagnostics.skippedByFilter.minPriceChangeH24,
      )} | maxAgeDays=${formatNumber(diagnostics.skippedByFilter.maxAgeDays)}`,
    );

    if (diagnostics.skippedExamples.length) {
      console.log('\nTop Skipped Examples:');
      for (const example of diagnostics.skippedExamples.slice(0, 8)) {
        console.log(`- ${example.key} => ${example.reason}`);
      }
    }

    if (diagnostics.suggestion) {
      console.log(`\nSuggestion: ${diagnostics.suggestion}`);
    }
  }

  console.log('\n=== Top Candidates ===');
  if (!result.candidates.length) {
    console.log('- none');
  } else {
    for (const candidate of result.candidates.slice(0, 20)) {
      console.log(
        `- chain=${candidate.chain} token=${candidate.symbol ?? 'n/a'} ${candidate.tokenAddress} score=${candidate.score.toFixed(2)} marketCap=${formatUsd(candidate.marketCap)} h24=${candidate.priceChangeH24 ?? 'n/a'} liquidity=${formatUsd(candidate.liquidityUsd)} volume=${formatUsd(candidate.volumeH24)} source=${candidate.source.join('|')} warnings=${candidate.warnings.length}`,
      );
    }
  }

  console.log('\n=== Output Files ===');
  console.log(`- seedTokensJson: ${outPath}`);
  console.log(`- seedTokensMetaJson: ${metaPath}`);
}

async function main() {
  const input = parseArgs();
  const result = await discoverSeedTokens({
    chains: parseChains(input.chains),
    limit: input.limit,
    minMarketCap: input['min-market-cap'],
    minLiquidityUsd: input['min-liquidity'],
    minVolumeH24: input['min-volume-h24'],
    minPriceChangeH24: input['min-price-change-h24'],
    maxAgeDays: input['max-age-days'],
    includeLatestProfiles: input['include-latest-profiles'],
    includeLatestBoosts: input['include-latest-boosts'],
    includeTopBoosts: input['include-top-boosts'],
  });

  const outputs = await writeSeedDiscoveryOutputs(result, input.out);

  if (input.json) {
    console.log(
      safeJsonStringify(
        {
          ...result,
          outputFiles: {
            seedTokensJson: input.out,
            seedTokensMetaJson: outputs.metaPath,
            outputIndexJson: outputs.outputIndexPath,
          },
        },
        2,
      ),
    );
    return;
  }

  printReport(result, input.out, outputs.metaPath);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
