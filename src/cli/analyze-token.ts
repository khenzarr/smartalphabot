import { z } from 'zod';
import { extractEarlyBuyers } from '../discovery/extract-early-buyers.js';
import { shortAddress } from '../utils/format.js';
import { safeJsonStringify } from '../utils/json.js';

const schema = z.object({
  chain: z.enum(['ethereum', 'base', 'bsc', 'solana']),
  token: z.string().min(1),
  'max-buyers': z.coerce.number().int().positive().default(100),
  'max-hours': z.coerce.number().positive().default(6),
  'max-blocks': z.coerce.number().int().positive().default(20000),
  persist: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  json: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  'force-parser': z.enum(['uniswap_v2_compatible', 'uniswap_v3_compatible']).optional(),
});

function parseArgs() {
  const args = process.argv.slice(2);
  const map: Record<string, string | undefined> = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith('--')) map[args[i].slice(2)] = args[i + 1];
  }
  return schema.parse(map);
}

function printDiagnosticsSummary(classification: Record<string, unknown>) {
  const diagnostics = (classification.diagnostics ?? {}) as Record<string, unknown>;
  const methods = Array.isArray(diagnostics.poolMethodsDetected) ? diagnostics.poolMethodsDetected.join(', ') : 'none';
  const topicSummary = Array.isArray(diagnostics.recentLogTopics)
    ? diagnostics.recentLogTopics
        .map((item) => {
          const row = item as Record<string, unknown>;
          return `${String(row.topic0 ?? '0x')}:${String(row.count ?? 0)}`;
        })
        .join(', ')
    : 'none';
  const sigMatches = Array.isArray(diagnostics.knownSwapSignatureMatches)
    ? diagnostics.knownSwapSignatureMatches.join(', ')
    : 'none';

  console.log('\n=== Unsupported Pool Diagnostics ===');
  console.log(`Likely Pool Type: ${classification.likelyPoolType ?? 'unsupported_unknown'}`);
  console.log(`Bytecode Exists: ${diagnostics.bytecodeExists ?? 'N/A'}`);
  console.log(`token0(): ${diagnostics.token0CallResult ?? 'N/A'}`);
  console.log(`token1(): ${diagnostics.token1CallResult ?? 'N/A'}`);
  console.log(`factory(): ${diagnostics.factoryCallResult ?? 'N/A'}`);
  console.log(`getReserves(): ${diagnostics.getReservesCallResult ?? 'N/A'}`);
  console.log(`liquidity(): ${diagnostics.liquidityCallResult ?? 'N/A'}`);
  console.log(`slot0(): ${diagnostics.slot0CallResult ?? 'N/A'}`);
  console.log(`Detected Methods: ${methods}`);
  console.log(`Recent Log Topics: ${topicSummary || 'none'}`);
  console.log(`Known Swap Signature Matches: ${sigMatches || 'none'}`);

  console.log('\n=== Suggested Next Action ===');
  console.log('- Try another token if this pool has no bytecode/log activity in the bounded window.');
  console.log('- Use a more stable RPC if you see rpc_rate_limited / rpc_provider_unstable warnings.');
  console.log('- Parser coverage may be missing for this DEX/pool type (e.g. Solidly/Aerodrome/Algebra variants).');
  console.log('- If RPC is unstable, reduce scan window or use a higher-quality RPC provider.');
}

async function main() {
  const input = parseArgs();
  const result = await extractEarlyBuyers({
    chain: input.chain,
    tokenAddress: input.token,
    maxBuyers: input['max-buyers'],
    maxHoursAfterCreation: input['max-hours'],
    maxBlocksAfterCreation: input['max-blocks'],
    persist: input.persist,
    forceParserType: input['force-parser'],
  });

  if (input.json) {
    console.log(safeJsonStringify(result, 2));
    return;
  }

  const profile = result.tokenProfile as Record<string, unknown> | null;
  const cls = (result.poolClassification ?? {}) as Record<string, unknown>;
  const scan = (result.scanMetadata ?? {}) as Record<string, unknown>;

  console.log('=== Token Profile ===');
  console.log(`Chain: ${result.chain}`);
  console.log(`Token: ${(profile?.symbol as string | undefined) ?? 'N/A'} / ${(profile?.name as string | undefined) ?? 'N/A'}`);
  console.log(`Address: ${result.tokenAddress}`);
  console.log(`Market Cap: ${profile?.marketCap ?? 'N/A'}`);
  console.log(`FDV: ${profile?.fdv ?? 'N/A'}`);
  console.log(`Liquidity: ${profile?.liquidityUsd ?? 'N/A'}`);
  console.log(`Price USD: ${profile?.priceUsd ?? 'N/A'}`);
  console.log(`Token Age Seconds: ${profile?.tokenAgeSeconds ?? 'N/A'}`);
  console.log(`DexScreener URL: ${profile?.dexUrl ?? 'N/A'}`);

  console.log('\n=== Pool Classification ===');
  console.log(`Pool Address: ${profile?.poolAddress ?? profile?.pairAddress ?? 'N/A'}`);
  console.log(`DEX ID: ${profile?.dexId ?? 'N/A'}`);
  console.log(`Parser Type: ${cls?.parserType ?? 'N/A'}`);
  console.log(`Reason: ${cls?.reason ?? 'N/A'}`);
  console.log(`Warnings: ${Array.isArray(cls?.warnings) ? cls.warnings.join(', ') : 'none'}`);

  if (cls?.parserType === 'unsupported') {
    printDiagnosticsSummary(cls);
  }

  console.log('\n=== Scan Metadata ===');
  console.log(`From Block: ${scan?.fromBlock ?? 'N/A'}`);
  console.log(`To Block: ${scan?.toBlock ?? 'N/A'}`);
  console.log(`Latest Block: ${scan?.latestBlock ?? 'N/A'}`);
  console.log(`Logs Scanned: ${scan?.logsScanned ?? 'N/A'}`);
  console.log(`Trades Extracted: ${scan?.tradesExtracted ?? 'N/A'}`);
  console.log(`Truncated: ${scan?.truncated ?? 'N/A'}`);

  const denseGuardrailHit = result.warnings.includes('dense_pool_scan_guardrail_hit');
  if (denseGuardrailHit) {
    console.log('\n=== Dense / Unproductive Pool Warning ===');
    console.log('- Scan guardrail reached for this window (dense pool or RPC constraints).');
    console.log('- Recommended next action: reduce max-hours, use a better RPC, or drop this seed if non-essential.');
  }

  console.log('\n=== Earliest Buyers ===');
  if (!result.earliestBuyers.length) {
    console.log('No early buyers found in scanned window.');
  } else {
    for (let i = 0; i < result.earliestBuyers.length; i += 1) {
      const b = result.earliestBuyers[i];
      console.log(
        `${i + 1}. ${shortAddress(b.walletAddress)} | block=${b.firstBuyBlockNumber ?? 'N/A'} | time=${b.firstBuyTimestamp.toISOString()} | buys=${b.buyCount} | totalToken=${b.totalBuyAmountToken} | tx=${b.firstBuyTxHash}`,
      );
    }
  }

  if (result.warnings.length) {
    console.log('\n=== Warnings ===');
    for (const warning of result.warnings) console.log(`- ${warning}`);
  }

  if (result.seedRecommendation) {
    console.log('\n=== Seed Recommendation ===');
    console.log(`- ${result.seedRecommendation}`);
  }

  if (result.persistenceSummary) {
    console.log('\n=== Persistence ===');
    console.log(safeJsonStringify(result.persistenceSummary, 2));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
