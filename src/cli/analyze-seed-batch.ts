import { z } from 'zod';
import { runSeedBatch } from '../discovery/run-seed-batch.js';
import path from 'node:path';
import { formatAddress, formatDateTime, formatNumber, formatUsd } from '../utils/report-format.js';
import { safeJsonStringify } from '../utils/json.js';

const schema = z.object({
  input: z.string().min(1),
  'max-buyers': z.coerce.number().int().positive().default(100),
  'max-hours': z.coerce.number().positive().default(6),
  'max-blocks': z.coerce.number().int().positive().default(20_000),
  'min-token-appearances': z.coerce.number().int().positive().default(2),
  persist: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  json: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  csv: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? true : v === 'true')),
  out: z.string().optional().default('output/seed-batch'),
  'enrich-wallets': z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  'wallet-source': z.enum(['persisted', 'mock', 'provider']).optional().default('persisted'),
  'max-wallets-to-enrich': z.coerce.number().int().positive().optional().default(50),
  'max-wallet-trades': z.coerce.number().int().positive().optional().default(1000),
  'include-cross-chain-overlap': z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  'only-useful-seeds': z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  'shortlist-min-appearances': z.coerce.number().int().positive().optional().default(2),
  'shortlist-min-score': z.coerce.number().optional().default(40),
  'shortlist-max-average-rank': z.coerce.number().positive().optional().default(150),
  'shortlist-include-rejected': z
    .string()
    .optional()
    .transform((v) => (v === undefined ? true : v === 'true')),
});

function parseArgs() {
  const args = process.argv.slice(2);
  const map: Record<string, string | undefined> = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i]?.startsWith('--')) map[args[i].slice(2)] = args[i + 1];
  }
  return schema.parse(map);
}

function printSeedBatchReport(result: Awaited<ReturnType<typeof runSeedBatch>>) {
  const groupedWarnings = [...new Set(result.warnings)].sort();
  const tokenBuyerSummary = result.tokenResults.map((item) => ({
    chain: item.seed.chain,
    label: 'label' in item.seed && item.seed.label ? item.seed.label : item.result?.tokenProfile?.symbol ?? item.seed.tokenAddress,
    symbol: item.result?.tokenProfile?.symbol,
    tokenAddress: item.seed.tokenAddress,
    buyersFound: item.result?.earliestBuyers.length ?? 0,
    seedTriageStatus: item.seedTriageStatus,
    seedTriageReason: item.seedTriageReason,
  }));
  const tokensWithBuyers = tokenBuyerSummary.filter((x) => x.buyersFound > 0).length;
  const tokensWithZeroBuyers = tokenBuyerSummary.length - tokensWithBuyers;
  const keepSeeds = tokenBuyerSummary.filter((x) => x.seedTriageStatus === 'keep');
  const zeroOrWeakSeeds = tokenBuyerSummary.filter(
    (x) => x.seedTriageStatus === 'zero_buyers' || x.seedTriageStatus === 'weak_seed',
  );
  const denseSeeds = tokenBuyerSummary.filter((x) => x.seedTriageStatus === 'dense_pool');
  const unsupportedSeeds = tokenBuyerSummary.filter((x) => x.seedTriageStatus === 'unsupported_pool');
  const failedSeeds = tokenBuyerSummary.filter((x) => x.seedTriageStatus === 'failed');
  const droppedSeeds = tokenBuyerSummary.filter((x) => x.seedTriageStatus !== 'keep').map((x) => x.label);

  const topUsefulSeeds = [...tokenBuyerSummary]
    .map((x) => ({
      label: x.label,
      buyersFound: x.buyersFound,
      score: x.buyersFound - (x.seedTriageStatus === 'keep' ? 0 : 1000),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const candidateEvidenceRowsCount = result.candidates.reduce((sum, candidate) => sum + candidate.evidence.length, 0);

  const matrixFromCandidates = (() => {
    const tokenWalletMap = new Map<string, { chain: string; tokenLabel: string; tokenSymbol?: string; tokenAddress: string; wallets: Set<string> }>();
    for (const candidate of result.candidates) {
      for (const evidence of candidate.evidence) {
        const key = `${candidate.chain}:${evidence.tokenAddress.toLowerCase()}`;
        const existing = tokenWalletMap.get(key) ?? {
          chain: candidate.chain,
          tokenLabel: evidence.tokenLabel ?? evidence.tokenAddress,
          tokenSymbol: evidence.tokenSymbol,
          tokenAddress: evidence.tokenAddress,
          wallets: new Set<string>(),
        };
        existing.wallets.add(candidate.walletAddress.toLowerCase());
        tokenWalletMap.set(key, existing);
      }
    }

    const tokens = [...tokenWalletMap.values()];
    let strongest:
      | {
          chainA: string;
          tokenLabelA: string;
          tokenLabelB: string;
          overlapWalletCount: number;
        }
      | undefined;

    for (let i = 0; i < tokens.length; i += 1) {
      for (let j = i + 1; j < tokens.length; j += 1) {
        const a = tokens[i];
        const b = tokens[j];
        if (!a || !b || a.chain !== b.chain) continue;
        const overlapCount = [...a.wallets].filter((x) => b.wallets.has(x)).length;
        if (!strongest || overlapCount > strongest.overlapWalletCount) {
          strongest = {
            chainA: a.chain,
            tokenLabelA: a.tokenLabel,
            tokenLabelB: b.tokenLabel,
            overlapWalletCount: overlapCount,
          };
        }
      }
    }

    return strongest;
  })();

  console.log('=== Seed Batch Analysis Report ===');
  console.log(`Input File: ${result.inputSummary.inputPath}`);
  console.log(`Output Directory: ${result.outputFiles.batchSummaryJson ? path.dirname(result.outputFiles.batchSummaryJson) : 'n/a'}`);
  console.log(`Generated At: ${formatDateTime(result.generatedAt)}`);
  console.log(
    `Params: maxBuyers=${result.inputSummary.maxBuyers} | maxHours=${result.inputSummary.maxHoursAfterCreation} | minAppearances=${result.inputSummary.minTokenAppearances}`,
  );
  console.log(`Only Useful Seeds Mode: ${result.inputSummary.onlyUsefulSeeds ? 'enabled' : 'disabled'}`);
  console.log(`Enrichment: ${result.inputSummary.enrichWallets ? 'enabled' : 'disabled'}`);

  console.log('\n=== Batch Summary ===');
  console.log(`Total Tokens: ${formatNumber(result.inputSummary.totalSeedTokens)}`);
  console.log(`Analyzed: ${formatNumber(result.summary.analyzed)}`);
  console.log(`Failed: ${formatNumber(result.summary.failed)}`);
  console.log(`Skipped: ${formatNumber(result.summary.skipped)}`);
  console.log(`Unique Early Buyers: ${formatNumber(result.summary.totalUniqueEarlyBuyers)}`);
  console.log(`Candidates Found: ${formatNumber(result.summary.candidateWalletsFound)}`);
  console.log(
    `Candidates Enriched: ${result.inputSummary.enrichWallets ? formatNumber(result.candidates.filter((x) => Boolean(x.walletEnrichment)).length) : 'n/a'}`,
  );

  console.log('\n=== Token Results ===');
  for (const item of result.tokenResults) {
    const label = 'label' in item.seed && item.seed.label ? item.seed.label : 'n/a';
    const symbol = item.result?.tokenProfile?.symbol ?? 'n/a';
    const buyersFound = item.result?.earliestBuyers?.length ?? 0;
    const failureReason = item.error ?? (item.status === 'skipped' ? item.warnings[0] : undefined);
    console.log(
      `- chain=${item.seed.chain} | token=${symbol} (${label}) ${formatAddress(item.seed.tokenAddress)} | status=${item.status} | buyers=${buyersFound} | warnings=${item.warnings.length}${failureReason ? ` | reason=${failureReason}` : ''}`,
    );
    console.log(`  triage=${item.seedTriageStatus} | triageReason=${item.seedTriageReason}`);
  }

  console.log('\n=== Top Candidate Wallets ===');
  if (!result.candidates.length) {
    console.log('- No candidates found with current filters.');
  } else {
    for (const candidate of result.candidates.slice(0, 25)) {
      const enrichmentStatus = candidate.walletEnrichment ? 'enriched' : 'not_enriched';
      console.log(
        `- #${candidate.rank} | chain=${candidate.chain} | wallet=${formatAddress(candidate.walletAddress)} | score=${candidate.scoreResult.score} (${candidate.scoreResult.category}) | appearances=${candidate.tokenAppearances} | avgFirstBuyRank=${candidate.averageFirstBuyRank} | bestRank=${candidate.bestFirstBuyRank} | enrichment=${enrichmentStatus} | enrichedPnl=${formatUsd(candidate.walletEnrichment?.approximateTotalPnlUsd)}`,
      );
    }
  }

  console.log('\n=== Warnings ===');
  if (!groupedWarnings.length) console.log('- none');
  for (const warning of groupedWarnings) console.log(`- ${warning}`);

  console.log('\n=== Seed Quality Summary ===');
  console.log(`Keep seeds: ${formatNumber(keepSeeds.length)}`);
  console.log(`Weak/zero-buyer seeds: ${formatNumber(zeroOrWeakSeeds.length)}`);
  console.log(`Dense pool seeds: ${formatNumber(denseSeeds.length)}`);
  console.log(`Unsupported seeds: ${formatNumber(unsupportedSeeds.length)}`);
  console.log(`Failed seeds: ${formatNumber(failedSeeds.length)}`);
  console.log(`Tokens with buyers: ${formatNumber(tokensWithBuyers)}`);
  console.log(`Tokens with zero buyers: ${formatNumber(tokensWithZeroBuyers)}`);
  if (matrixFromCandidates) {
    console.log(
      `Strongest overlap pair: ${matrixFromCandidates.chainA} | ${matrixFromCandidates.tokenLabelA} ↔ ${matrixFromCandidates.tokenLabelB} | overlap=${formatNumber(matrixFromCandidates.overlapWalletCount)}`,
    );
  } else {
    console.log('Strongest overlap pair: n/a');
  }
  console.log(`Candidate evidence rows: ${formatNumber(candidateEvidenceRowsCount)}`);
  console.log(
    `Top useful seeds: ${topUsefulSeeds.length ? topUsefulSeeds.map((x) => `${x.label}(${x.buyersFound})`).join(', ') : 'n/a'}`,
  );
  console.log(`Recommended dropped seeds: ${droppedSeeds.length ? droppedSeeds.join(', ') : 'none'}`);

  console.log('\n=== Seed Curation Summary ===');
  console.log(`Next keep count: ${formatNumber(result.seedCuration.keep.length)}`);
  console.log(`Next drop count: ${formatNumber(result.seedCuration.drop.length)}`);
  console.log(`Next investigate count: ${formatNumber(result.seedCuration.investigate.length)}`);
  console.log(`Candidate shortlist count: ${formatNumber(result.candidateShortlist.length)}`);
  const topMonitor = result.candidateShortlist.filter((x) => x.monitorRecommendation === 'monitor_candidate').slice(0, 5);
  console.log(`Top 5 monitor candidates: ${topMonitor.length ? topMonitor.map((x) => `${x.walletAddress}(${x.score})`).join(', ') : 'none'}`);
  const topDropped = result.seedCuration.drop.slice(0, 5);
  console.log(
    `Top 5 dropped seeds with reason: ${topDropped.length ? topDropped.map((x) => `${x.label ?? x.tokenAddress}(${x.seedTriageReason})`).join(', ') : 'none'}`,
  );

  console.log('\n=== Output Files ===');
  const orderedOutputKeys = [
    'batchSummaryJson',
    'candidateWalletsJson',
    'candidateWalletsCsv',
    'tokenResultsJson',
    'errorsJson',
    'tokenBuyerSummaryCsv',
    'tokenBuyerSummaryJson',
    'candidateEvidenceCsv',
    'candidateEvidenceJson',
    'walletOverlapMatrixCsv',
    'walletOverlapMatrixJson',
    'tokenOverlapSummaryCsv',
    'tokenOverlapSummaryJson',
    'nextSeedsKeepJson',
    'nextSeedsDropJson',
    'nextSeedsInvestigateJson',
    'candidateShortlistCsv',
    'candidateShortlistJson',
    'outputIndexJson',
  ] as const;
  for (const key of orderedOutputKeys) {
    const file = result.outputFiles[key];
    if (file) console.log(`- ${key}: ${file}`);
  }

  console.log('\n=== Limitations Legend ===');
  console.log('- Candidate score is seed-evidence-based unless enriched.');
  console.log('- PnL is approximate when enrichment is enabled.');
  console.log('- Solana is skipped for this phase.');
  console.log('- Seed quality strongly affects candidate quality.');
}

async function main() {
  const input = parseArgs();
  const result = await runSeedBatch({
    inputPath: input.input,
    maxBuyers: input['max-buyers'],
    maxHoursAfterCreation: input['max-hours'],
    maxBlocksAfterCreation: input['max-blocks'],
    minTokenAppearances: input['min-token-appearances'],
    persist: input.persist,
    json: input.json,
    csv: input.csv,
    outDir: input.out,
    enrichWallets: input['enrich-wallets'],
    walletSource: input['wallet-source'],
    maxWalletsToEnrich: input['max-wallets-to-enrich'],
    maxWalletTrades: input['max-wallet-trades'],
    includeCrossChainOverlap: input['include-cross-chain-overlap'],
    onlyUsefulSeeds: input['only-useful-seeds'],
    shortlistMinAppearances: input['shortlist-min-appearances'],
    shortlistMinScore: input['shortlist-min-score'],
    shortlistMaxAverageRank: input['shortlist-max-average-rank'],
    shortlistIncludeRejected: input['shortlist-include-rejected'],
  });

  if (input.json) {
    console.log(safeJsonStringify(result, 2));
    return;
  }

  printSeedBatchReport(result);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
