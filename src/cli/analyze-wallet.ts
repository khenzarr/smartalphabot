import { z } from 'zod';
import { analyzeWallet } from '../analysis/wallet-analyzer.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { toCsv } from '../utils/csv.js';
import { env } from '../config/env.js';
import { upsertSeedBatchCandidateWallet } from '../db/repositories/wallet.repository.js';
import { createWalletScoreSnapshot } from '../db/repositories/wallet-score-snapshot.repository.js';
import { upsertTokenProfile } from '../db/repositories/token.repository.js';
import { upsertWalletTokenPerformance } from '../db/repositories/wallet-token-performance.repository.js';
import { createAnalysisJob, updateAnalysisJobResult } from '../db/repositories/analysis-job.repository.js';
import {
  formatAddress,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
  formatUsd,
} from '../utils/report-format.js';
import { safeJsonStringify } from '../utils/json.js';

const schema = z.object({
  chain: z.enum(['ethereum', 'base', 'bsc', 'solana']),
  wallet: z.string().min(1),
  source: z.enum(['persisted', 'mock', 'provider']).optional().default('persisted'),
  from: z.string().optional(),
  to: z.string().optional(),
  'max-trades': z.coerce.number().int().positive().optional(),
  token: z.string().optional(),
  'enrich-prices': z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  persist: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  json: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  out: z.string().optional(),
});

function parseArgs() {
  const args = process.argv.slice(2);
  const map: Record<string, string | undefined> = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith('--')) map[args[i].slice(2)] = args[i + 1];
  }
  return schema.parse(map);
}

function printWalletReport(input: ReturnType<typeof parseArgs>, result: Awaited<ReturnType<typeof analyzeWallet>>) {
  const generatedAt = new Date().toISOString();
  const sortedPerformances = [...result.tokenPerformances].sort((a, b) => {
    const aScore = a.totalPnlUsd ?? Number.NEGATIVE_INFINITY;
    const bScore = b.totalPnlUsd ?? Number.NEGATIVE_INFINITY;
    if (aScore === bScore) return b.tradeCount - a.tradeCount;
    return bScore - aScore;
  });

  const warningSet = new Set<string>([...result.warnings, ...result.tokenPerformances.flatMap((x) => x.warnings)]);
  const groupedWarnings = [...warningSet].sort();

  console.log('=== Wallet Analysis Report ===');
  console.log(`Chain: ${result.summary.chain}`);
  console.log(`Wallet: ${result.summary.walletAddress}`);
  console.log(`Wallet (short): ${formatAddress(result.summary.walletAddress)}`);
  console.log(`Source: ${result.providerMetadata.source}`);
  console.log(`Generated At: ${formatDateTime(generatedAt)}`);

  console.log('\n=== Wallet Summary ===');
  console.log(`Analyzed Tokens: ${formatNumber(result.summary.analyzedTokenCount)}`);
  console.log(`Closed Positions: ${formatNumber(result.summary.closedPositionCount)}`);
  console.log(`Open Positions: ${formatNumber(result.summary.openPositionCount)}`);
  console.log(`Total Trades: ${formatNumber(result.summary.totalTrades)}`);
  console.log(`Total Buys: ${formatNumber(result.summary.totalBuys)}`);
  console.log(`Total Sells: ${formatNumber(result.summary.totalSells)}`);
  console.log(`Realized PnL (approx): ${formatUsd(result.summary.totalRealizedPnlUsd)}`);
  console.log(`Unrealized PnL (approx): ${formatUsd(result.summary.totalUnrealizedPnlUsd)}`);
  console.log(`Total PnL (approx): ${formatUsd(result.summary.totalPnlUsd)}`);
  console.log(`Win Rate: ${formatPercent(result.summary.winRate)}`);
  console.log(`Median ROI: ${formatPercent(result.summary.medianRoi)}`);
  console.log(`Average ROI: ${formatPercent(result.summary.averageRoi)}`);
  console.log(`Average Hold Duration: ${formatDuration(result.summary.averageHoldSeconds)}`);
  console.log(`Median Hold Duration: ${formatDuration(result.summary.medianHoldSeconds)}`);
  console.log(`Score/Category: ${result.scoreResult.score} (${result.scoreResult.category})`);

  console.log('\n=== Top Token Performances ===');
  if (!sortedPerformances.length) {
    console.log('- No token performances available.');
  } else {
    for (const item of sortedPerformances.slice(0, 15)) {
      const status = item.isOpenPosition ? 'open' : 'closed';
      console.log(
        `- token=${item.tokenSymbol ?? '?'} (${formatAddress(item.tokenAddress)}) | status=${status} | buys=${item.buyCount} | sells=${item.sellCount} | realized=${formatUsd(item.realizedPnlUsd)} | unrealized=${formatUsd(item.unrealizedPnlUsd)} | total=${formatUsd(item.totalPnlUsd)} | roi=${formatPercent(item.roi)} | hold=${formatDuration(item.holdDurationSeconds)} | warnings=${item.warnings.length}`,
      );
    }
  }

  console.log('\n=== Warnings ===');
  if (!groupedWarnings.length) console.log('- none');
  for (const warning of groupedWarnings) console.log(`- ${warning}`);

  console.log('\n=== Limitations Legend ===');
  console.log('- PnL is approximate.');
  console.log('- Missing USD fields can make PnL incomplete.');
  console.log('- Unrealized PnL depends on current market data availability.');
  console.log('- Persisted source only analyzes trades already stored by this system.');
  console.log('- This is analytics only, not financial advice.');

  console.log('\n=== Next Suggested Commands ===');
  if (input.source === 'mock') {
    console.log(
      `- Try persisted data: npm run analyze:wallet -- --chain ${input.chain} --wallet ${result.summary.walletAddress} --source persisted --json false --out output/persisted-wallet-analysis`,
    );
  }
  if (input.source === 'persisted' && result.summary.totalTrades === 0) {
    console.log(
      '- No persisted trades found. First run seed batch to populate candidate/trade context, then re-run wallet analysis.',
    );
    console.log(
      '- Example: npm run analyze:seed-batch -- --input data/seed-tokens.local.json --max-buyers 100 --min-token-appearances 2 --persist true --csv true --out output/seed-batch-persist',
    );
  }
  if (!input.json) {
    console.log(
      `- Export JSON artifacts: npm run analyze:wallet -- --chain ${input.chain} --wallet ${result.summary.walletAddress} --source ${input.source} --json true --out output/wallet-analysis-json`,
    );
  }
}

async function main() {
  const input = parseArgs();
  const persist = input.persist ?? false;
  if (persist && !env.DATABASE_URL) {
    throw new Error('persist_requested_but_database_url_missing');
  }

  const fromTimestamp = input.from ? new Date(input.from) : undefined;
  const toTimestamp = input.to ? new Date(input.to) : undefined;

  let analysisJobId: string | undefined;
  if (persist) {
    const job = await createAnalysisJob({
      chain: input.chain,
      jobType: 'wallet_analysis',
      targetType: 'wallet',
      targetValue: input.wallet,
      status: 'running',
      input: {
        source: input.source,
        from: input.from,
        to: input.to,
        maxTrades: input['max-trades'],
        token: input.token,
        enrichPrices: input['enrich-prices'],
      },
    });
    analysisJobId = job.id;
  }

  const result = await analyzeWallet({
    chain: input.chain,
    walletAddress: input.wallet,
    source: input.source,
    fromTimestamp,
    toTimestamp,
    maxTrades: input['max-trades'],
    tokenAddress: input.token,
    enrichPrices: input['enrich-prices'],
    persist,
  });

  if (persist) {
    const wallet = await upsertSeedBatchCandidateWallet({
      chain: input.chain,
      address: input.wallet,
      scoreLatest: result.scoreResult.score,
      label: 'wallet_analysis',
    });

    await createWalletScoreSnapshot({
      walletId: wallet.id,
      chain: input.chain,
      score: result.scoreResult.score,
      category: result.scoreResult.category,
      reasons: result.scoreResult.reasons,
      riskFlags: result.scoreResult.riskFlags,
    });

    for (const perf of result.tokenPerformances) {
      const token = await upsertTokenProfile({
        chain: input.chain,
        chainFamily: input.chain === 'solana' ? 'solana' : 'evm',
        tokenAddress: perf.tokenAddress,
        symbol: perf.tokenSymbol,
        warnings: [],
      });

      await upsertWalletTokenPerformance({
        walletId: wallet.id,
        tokenId: token.id,
        chain: input.chain,
        totalBuys: perf.buyCount,
        totalSells: perf.sellCount,
        realizedPnlUsd: perf.realizedPnlUsd,
        unrealizedPnlUsd: perf.unrealizedPnlUsd,
        roi: perf.roi,
        averageHoldSeconds: perf.holdDurationSeconds,
        medianHoldSeconds: perf.holdDurationSeconds,
        firstBuyAt: perf.firstBuyAt,
        firstBuyTxHash: perf.firstBuyTxHash,
      });
    }
  }

  if (input.out) {
    await mkdir(input.out, { recursive: true });
    const jsonPath = path.join(input.out, 'wallet-analysis.json');
    const csvPath = path.join(input.out, 'wallet-token-performances.csv');
    const outputIndexPath = path.join(input.out, 'output-index.json');

    const payload = safeJsonStringify(result, 2);
    await writeFile(jsonPath, payload, 'utf8');

    const rows = result.tokenPerformances.map((x) => ({
      tokenAddress: x.tokenAddress,
      tokenSymbol: x.tokenSymbol,
      tradeCount: x.tradeCount,
      buyCount: x.buyCount,
      sellCount: x.sellCount,
      totalBoughtToken: x.totalBoughtToken,
      totalSoldToken: x.totalSoldToken,
      remainingToken: x.remainingToken,
      totalBuyUsd: x.totalBuyUsd,
      totalSellUsd: x.totalSellUsd,
      realizedPnlUsd: x.realizedPnlUsd,
      unrealizedPnlUsd: x.unrealizedPnlUsd,
      totalPnlUsd: x.totalPnlUsd,
      roi: x.roi,
      holdDurationSeconds: x.holdDurationSeconds,
      isOpenPosition: x.isOpenPosition,
      isWinner: x.isWinner,
      warnings: x.warnings,
    }));
    const csv = toCsv(rows, [
      'tokenAddress',
      'tokenSymbol',
      'tradeCount',
      'buyCount',
      'sellCount',
      'totalBoughtToken',
      'totalSoldToken',
      'remainingToken',
      'totalBuyUsd',
      'totalSellUsd',
      'realizedPnlUsd',
      'unrealizedPnlUsd',
      'totalPnlUsd',
      'roi',
      'holdDurationSeconds',
      'isOpenPosition',
      'isWinner',
      'warnings',
    ]);
    await writeFile(csvPath, csv, 'utf8');

    await writeFile(
      outputIndexPath,
        safeJsonStringify(
          {
            generatedAt: new Date().toISOString(),
            commandType: 'wallet_analysis',
            chain: input.chain,
            walletAddress: input.wallet,
            source: input.source,
            files: {
              walletAnalysisJson: jsonPath,
              walletTokenPerformancesCsv: csvPath,
            },
          },
          2,
        ),
      'utf8',
    );
  }

  if (analysisJobId) {
    await updateAnalysisJobResult({
      id: analysisJobId,
      status: 'success',
      result: {
        chain: result.summary.chain,
        walletAddress: result.summary.walletAddress,
        source: result.providerMetadata.source,
        analyzedTokenCount: result.summary.analyzedTokenCount,
        totalTrades: result.summary.totalTrades,
        score: result.scoreResult.score,
        category: result.scoreResult.category,
      },
      warnings: result.warnings,
    });
  }

  if (input.json) {
    console.log(safeJsonStringify(result, 2));
    return;
  }

  printWalletReport(input, result);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
