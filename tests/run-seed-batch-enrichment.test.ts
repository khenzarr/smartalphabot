import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/discovery/extract-early-buyers.js', () => ({
  extractEarlyBuyers: vi.fn(async ({ chain, tokenAddress }) => {
    const low = String(tokenAddress).toLowerCase();
    if (low.includes('dddd')) {
      return {
        chain,
        tokenAddress,
        tokenProfile: { symbol: 'DENSE', dexId: 'aerodrome', pairAddress: tokenAddress },
        earliestBuyers: [
          {
            walletAddress: '0x4444444444444444444444444444444444444444',
            firstBuyTxHash: `0x${low.slice(-4)}1`,
            firstBuyBlockNumber: 11,
            firstBuyTimestamp: new Date('2025-01-01T00:01:00.000Z'),
            firstBuyAmountToken: 1,
            totalBuyAmountToken: 1,
            buyCount: 1,
            warnings: [],
          },
        ],
        warnings: ['max_adaptive_splits_reached', 'dense_pool_scan_guardrail_hit'],
        scanMetadata: { fromBlock: 1n, toBlock: 10n, tradesExtracted: 1n },
      };
    }
    if (low.includes('cccc')) {
      return {
        chain,
        tokenAddress,
        tokenProfile: { symbol: 'ZERO', dexId: 'uni', pairAddress: tokenAddress },
        earliestBuyers: [],
        warnings: ['no_buyers_found'],
        scanMetadata: { fromBlock: 1n, toBlock: 10n, tradesExtracted: 0n, logSummary: [{ topic0: '0xabc', count: 1n }] },
      };
    }

    const shared = {
      walletAddress: '0x1111111111111111111111111111111111111111',
      firstBuyTxHash: `0x${low.slice(-4)}1`,
      firstBuyBlockNumber: 1,
      firstBuyTimestamp: new Date('2025-01-01T00:00:00.000Z'),
      firstBuyAmountToken: 1,
      totalBuyAmountToken: 1,
      buyCount: 1,
      warnings: [],
    };

    const unique = {
      walletAddress: low.includes('bbbb')
        ? '0x3333333333333333333333333333333333333333'
        : '0x2222222222222222222222222222222222222222',
      firstBuyTxHash: `0x${low.slice(-4)}2`,
      firstBuyBlockNumber: 2,
      firstBuyTimestamp: new Date('2025-01-01T00:05:00.000Z'),
      firstBuyAmountToken: 2,
      totalBuyAmountToken: 2,
      buyCount: 1,
      warnings: ['late_in_block'],
    };

    return {
      chain,
      tokenAddress,
      tokenProfile: {
        symbol: low.includes('bbbb') ? 'AST' : 'PEPE',
        dexId: 'uni',
        pairAddress: tokenAddress,
        liquidityUsd: 1000,
      },
      earliestBuyers: [shared, unique],
      warnings: low.includes('bbbb') ? ['parser_partial_warning'] : [],
      scanMetadata: {
        fromBlock: 1n,
        toBlock: 20n,
        topicFilterUsed: true,
        swapTopic: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
        tradesExtracted: 2n,
        nested: {
          latestBlock: 2n,
          logSummary: [{ topic0: '0xabc', count: 3n }],
        },
        logSummary: [{ topic0: '0xabc', count: 3n }],
      },
    };
  }),
}));

vi.mock('../src/analysis/wallet-analyzer.js', () => ({
  analyzeWallet: vi.fn(async ({ walletAddress }) => {
    if (walletAddress.toLowerCase().includes('fail')) throw new Error('boom');
    return {
      summary: {
        totalTrades: 2,
        analyzedTokenCount: 1,
        totalPnlUsd: 100,
        totalRealizedPnlUsd: 80,
        totalUnrealizedPnlUsd: 20,
        winRate: 1,
        medianRoi: 0.5,
        averageHoldSeconds: 3600,
      },
      scoreResult: { score: 77, category: 'copyable_smart_wallet' },
      warnings: [],
      limitations: [],
    };
  }),
}));

import { runSeedBatch } from '../src/discovery/run-seed-batch.js';
import { deriveSeedTriage } from '../src/discovery/run-seed-batch.js';

describe('seed triage helper', () => {
  it('classifies triage statuses with concise reasons', () => {
    expect(
      deriveSeedTriage({
        status: 'success',
        parserType: 'uniswap_v2_compatible',
        buyersFound: 2,
        warnings: [],
      }).seedTriageStatus,
    ).toBe('keep');

    expect(
      deriveSeedTriage({
        status: 'success',
        parserType: 'uniswap_v2_compatible',
        buyersFound: 0,
        warnings: [],
      }).seedTriageStatus,
    ).toBe('zero_buyers');

    expect(
      deriveSeedTriage({
        status: 'success',
        parserType: 'unsupported',
        buyersFound: 0,
        warnings: ['unsupported_pool_parser'],
      }).seedTriageStatus,
    ).toBe('unsupported_pool');

    expect(
      deriveSeedTriage({
        status: 'success',
        parserType: 'uniswap_v3_compatible',
        buyersFound: 0,
        warnings: ['max_adaptive_splits_reached', 'dense_pool_scan_guardrail_hit'],
      }).seedTriageStatus,
    ).toBe('dense_pool');
  });

  it('keeps ambiguous/previously-useful failed seeds in investigate list via batch curation', async () => {
    const outDir = 'output/test-seed-batch-investigate-failed';
    await mkdir(outDir, { recursive: true });
    const inputPath = path.join(outDir, 'seed.json');
    await writeFile(
      inputPath,
      JSON.stringify([
        { chain: 'base', label: 'KEEP_A', tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        { chain: 'base', label: 'FAILED_USEFUL', tokenAddress: '0xffffffffffffffffffffffffffffffffffffffff' },
      ]),
      'utf8',
    );

    const extractModule = await import('../src/discovery/extract-early-buyers.js');
    const mockedExtract = vi.mocked(extractModule.extractEarlyBuyers);
    const defaultImpl = mockedExtract.getMockImplementation();
    mockedExtract.mockImplementation(async ({ chain, tokenAddress }: any) => {
      if (String(tokenAddress).toLowerCase().includes('ffff')) {
        throw new Error('provider timeout while reading logs');
      }
      return {
        chain,
        tokenAddress,
        tokenProfile: {
          chain,
          chainFamily: 'evm',
          tokenAddress,
          symbol: 'OK',
          dexId: 'uni',
          pairAddress: tokenAddress,
          warnings: [],
        },
        earliestBuyers: [
          {
            walletAddress: '0x1111111111111111111111111111111111111111',
            firstBuyTxHash: '0xabc',
            firstBuyBlockNumber: 10,
            firstBuyTimestamp: new Date('2025-01-01T00:00:00.000Z'),
            firstBuyAmountToken: 1,
            totalBuyAmountToken: 1,
            buyCount: 1,
            warnings: [],
          },
        ],
        warnings: [],
        scanMetadata: { fromBlock: 1n, toBlock: 10n, tradesExtracted: 1n },
      } as any;
    });

    try {
      const result = await runSeedBatch({ inputPath, csv: false, outDir });
      expect(result.seedCuration.investigate.some((x) => x.label === 'FAILED_USEFUL')).toBe(true);
    } finally {
      if (defaultImpl) mockedExtract.mockImplementation(defaultImpl);
    }
  });
});

describe('runSeedBatch wallet enrichment', () => {
  beforeEach(async () => {
    const checkpointPath = path.join('output', 'discovery-checkpoints', 'seed-batch-checkpoint.json');
    await unlink(checkpointPath).catch(() => undefined);
  });

  it('stops gracefully on request budget, writes checkpoint and partial outputs', async () => {
    const outDir = 'output/test-seed-batch-request-budget';
    await mkdir(outDir, { recursive: true });
    const inputPath = path.join(outDir, 'seed.json');
    await writeFile(
      inputPath,
      JSON.stringify([
        { chain: 'base', label: 'BUDGET_HIT', tokenAddress: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
        { chain: 'base', label: 'DEFERRED', tokenAddress: '0xffffffffffffffffffffffffffffffffffffffff' },
      ]),
      'utf8',
    );

    const checkpointPath = path.join('output', 'discovery-checkpoints', 'seed-batch-checkpoint.json');
    await unlink(checkpointPath).catch(() => undefined);

    const extractModule = await import('../src/discovery/extract-early-buyers.js');
    const mockedExtract = vi.mocked(extractModule.extractEarlyBuyers);
    const defaultImpl = mockedExtract.getMockImplementation();
    mockedExtract.mockImplementation(async ({ chain, tokenAddress }: any) => {
      return {
        chain,
        tokenAddress,
        tokenProfile: { symbol: 'BUDGET', dexId: 'uni', pairAddress: tokenAddress },
        earliestBuyers: [],
        warnings: ['request_budget_reached'],
        scanMetadata: {
          fromBlock: 1n,
          toBlock: 10n,
          nextFromBlock: 11n,
          getLogsRequestsUsed: 9,
          requestBudgetReached: true,
          tradesExtracted: 0n,
        },
      } as any;
    });

    try {
      const result = await runSeedBatch({
        inputPath,
        csv: true,
        outDir,
        maxGetLogsRequestsPerRun: 10,
      });

      expect(result.summary.requestBudgetReached).toBe(true);
      expect(result.summary.runStopReason).toBe('request_budget_reached');
      expect(result.checkpoint?.path).toBe(checkpointPath);

      const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as {
        entries: Array<{ tokenAddress: string; nextFromBlock?: string; completed: boolean }>;
      };
      const entry = checkpoint.entries.find((x) => x.tokenAddress.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
      expect(entry?.completed).toBe(false);
      expect(entry?.nextFromBlock).toBe('11');

      const candidateCsv = await readFile(result.outputFiles.candidateWalletsCsv, 'utf8');
      expect(candidateCsv).toContain('rank,chain,walletAddress');
      const batchSummary = JSON.parse(await readFile(result.outputFiles.batchSummaryJson, 'utf8')) as {
        summary: { runStopReason?: string };
      };
      expect(batchSummary.summary.runStopReason).toBe('request_budget_reached');
    } finally {
      if (defaultImpl) mockedExtract.mockImplementation(defaultImpl);
    }
  });

  it('resumes from checkpoint and forwards from/to block overrides', async () => {
    const outDir = 'output/test-seed-batch-resume';
    await mkdir(outDir, { recursive: true });
    const inputPath = path.join(outDir, 'seed.json');
    const tokenAddress = '0xabababababababababababababababababababab';
    await writeFile(inputPath, JSON.stringify([{ chain: 'base', label: 'RESUME', tokenAddress }]), 'utf8');

    const checkpointPath = path.join('output', 'discovery-checkpoints', 'seed-batch-checkpoint.json');
    await writeFile(
      checkpointPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          runInputPath: inputPath,
          freeRpcMode: true,
          getLogsMaxBlockRange: 10,
          maxGetLogsRequestsPerRun: 1000,
          entries: [
            {
              tokenAddress,
              poolAddress: '0xpoolpoolpoolpoolpoolpoolpoolpoolpoolpoolpo',
              nextFromBlock: '123',
              toBlock: '133',
              completed: false,
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    const extractModule = await import('../src/discovery/extract-early-buyers.js');
    const mockedExtract = vi.mocked(extractModule.extractEarlyBuyers);
    const defaultImpl = mockedExtract.getMockImplementation();

    try {
      await runSeedBatch({ inputPath, csv: false, outDir });
      const firstCall = mockedExtract.mock.calls.at(-1)?.[0] as any;
      expect(firstCall.tokenAddress.toLowerCase()).toBe(tokenAddress);
      expect(firstCall.fromBlockOverride).toBe(123n);
      expect(firstCall.toBlockOverride).toBe(133n);
    } finally {
      if (defaultImpl) mockedExtract.mockImplementation(defaultImpl);
    }
  });

  it('enriches only top N candidates and continues on failures', async () => {
    const outDir = 'output/test-seed-batch-enrichment';
    await mkdir(outDir, { recursive: true });
    const inputPath = path.join(outDir, 'seed.json');
    await writeFile(
      inputPath,
      JSON.stringify([
        { chain: 'base', tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        { chain: 'base', tokenAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      ]),
      'utf8',
    );

    const result = await runSeedBatch({
      inputPath,
      enrichWallets: true,
      maxWalletsToEnrich: 1,
      walletSource: 'mock',
      csv: true,
      outDir,
    });

    expect(result.candidates.length).toBeGreaterThan(0);
    const first = result.candidates[0];
    expect(first?.walletEnrichment?.source).toBe('mock');
    expect(first?.walletEnrichment?.category).toBe('copyable_smart_wallet');
    // compatibility check: enrichment data merged
    expect(first?.walletEnrichment?.score).toBe(77);

    expect(result.outputFiles.outputIndexJson).toBeDefined();
    const indexRaw = await readFile(result.outputFiles.outputIndexJson, 'utf8');
    const outputIndex = JSON.parse(indexRaw) as {
      commandType: string;
      inputFile: string;
      files: Record<string, string>;
    };
    expect(outputIndex.commandType).toBe('seed_batch_analysis');
    expect(outputIndex.inputFile).toBe(inputPath);
    expect(outputIndex.files.batchSummaryJson).toContain('batch-summary.json');
  });

  it('exports bigint-bearing seed-batch outputs as parseable json', async () => {
    const outDir = 'output/test-seed-batch-bigint-json';
    await mkdir(outDir, { recursive: true });
    const inputPath = path.join(outDir, 'seed.json');
    await writeFile(
      inputPath,
      JSON.stringify([{ chain: 'base', tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }]),
      'utf8',
    );

    const result = await runSeedBatch({
      inputPath,
      csv: true,
      outDir,
    });

    const filesToCheck = [
      result.outputFiles.batchSummaryJson,
      result.outputFiles.candidateWalletsJson,
      result.outputFiles.tokenResultsJson,
      result.outputFiles.errorsJson,
      result.outputFiles.outputIndexJson,
    ];

    for (const filePath of filesToCheck) {
      const raw = await readFile(filePath, 'utf8');
      expect(() => JSON.parse(raw)).not.toThrow();
    }

    const tokenResultsRaw = await readFile(result.outputFiles.tokenResultsJson, 'utf8');
    const tokenResults = JSON.parse(tokenResultsRaw) as Array<{
      result?: {
        scanMetadata?: {
          fromBlock?: string;
          nested?: { latestBlock?: string; logSummary?: Array<{ count?: string }> };
        };
      };
    }>;

    expect(tokenResults[0]?.result?.scanMetadata?.fromBlock).toBe('1');
    expect(tokenResults[0]?.result?.scanMetadata?.nested?.latestBlock).toBe('2');
    expect(tokenResults[0]?.result?.scanMetadata?.nested?.logSummary?.[0]?.count).toBe('3');

    const csvRaw = await readFile(result.outputFiles.candidateWalletsCsv, 'utf8');
    expect(csvRaw).toContain('rank,chain,walletAddress');
  });

  it('generates token buyer summary, candidate evidence, overlap matrix and overlap summary outputs', async () => {
    const outDir = 'output/test-seed-batch-evidence';
    await mkdir(outDir, { recursive: true });
    const inputPath = path.join(outDir, 'seed.json');
    await writeFile(
      inputPath,
      JSON.stringify([
        { chain: 'base', label: 'ETH_SEED_01', narrative: 'meme', tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        { chain: 'base', label: 'ETH_SEED_03', narrative: 'meme2', tokenAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
        { chain: 'base', label: 'ETH_ZERO', narrative: 'weak', tokenAddress: '0xcccccccccccccccccccccccccccccccccccccccc' },
      ]),
      'utf8',
    );

    const result = await runSeedBatch({
      inputPath,
      csv: true,
      outDir,
      minTokenAppearances: 2,
    });

    const tokenBuyerSummary = JSON.parse(await readFile(result.outputFiles.tokenBuyerSummaryJson, 'utf8')) as Array<Record<string, unknown>>;
    expect(tokenBuyerSummary).toHaveLength(3);
    const zeroRow = tokenBuyerSummary.find((x) => x.tokenLabel === 'ETH_ZERO');
    expect(zeroRow?.buyersFound).toBe(0);
    expect(zeroRow?.seedTriageStatus).toBe('zero_buyers');
    expect(typeof zeroRow?.seedTriageReason).toBe('string');
    const astRow = tokenBuyerSummary.find((x) => x.tokenLabel === 'ETH_SEED_03');
    expect(astRow?.warningsCount).toBe(1);
    const seed01Row = tokenBuyerSummary.find((x) => x.tokenLabel === 'ETH_SEED_01');
    expect(seed01Row?.topicFilterUsed).toBe(true);
    expect(seed01Row?.swapTopic).toBe('0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822');

    const candidateEvidence = JSON.parse(await readFile(result.outputFiles.candidateEvidenceJson, 'utf8')) as Array<Record<string, unknown>>;
    const sharedWalletRows = candidateEvidence.filter(
      (x) => String(x.walletAddress).toLowerCase() === '0x1111111111111111111111111111111111111111',
    );
    expect(sharedWalletRows.length).toBe(2);
    expect(sharedWalletRows.map((x) => x.tokenLabel)).toEqual(expect.arrayContaining(['ETH_SEED_01', 'ETH_SEED_03']));
    expect(sharedWalletRows.every((x) => x.candidateScore !== undefined && x.candidateCategory !== undefined)).toBe(true);

    const overlapMatrix = JSON.parse(await readFile(result.outputFiles.walletOverlapMatrixJson, 'utf8')) as Array<Record<string, unknown>>;
    const basePair = overlapMatrix.find((x) => x.tokenLabelA === 'ETH_SEED_01' && x.tokenLabelB === 'ETH_SEED_03');
    expect(basePair?.overlapWalletCount).toBe(1);
    const zeroPair = overlapMatrix.find((x) => x.tokenLabelA === 'ETH_SEED_03' && x.tokenLabelB === 'ETH_ZERO');
    expect(zeroPair?.overlapWalletCount).toBe(0);
    expect(overlapMatrix.every((x) => x.chainA === 'base' && x.chainB === 'base')).toBe(true);

    const overlapSummary = JSON.parse(await readFile(result.outputFiles.tokenOverlapSummaryJson, 'utf8')) as Array<Record<string, unknown>>;
    const seed01Summary = overlapSummary.find((x) => x.tokenLabel === 'ETH_SEED_01');
    expect(seed01Summary?.strongestOverlapTokenLabel).toBe('ETH_SEED_03');
    expect(seed01Summary?.strongestOverlapCount).toBe(1);
    expect(typeof seed01Summary?.usefulnessScore).toBe('number');
    expect(seed01Summary?.seedTriageStatus).toBe('keep');

    const outputIndex = JSON.parse(await readFile(result.outputFiles.outputIndexJson, 'utf8')) as { files: Record<string, string> };
    expect(outputIndex.files.tokenBuyerSummaryCsv).toContain('token-buyer-summary.csv');
    expect(outputIndex.files.candidateEvidenceJson).toContain('candidate-evidence.json');
    expect(outputIndex.files.walletOverlapMatrixJson).toContain('wallet-overlap-matrix.json');
    expect(outputIndex.files.tokenOverlapSummaryCsv).toContain('token-overlap-summary.csv');
    expect(outputIndex.files.nextSeedsKeepJson).toContain('next-seeds.keep.json');
    expect(outputIndex.files.nextSeedsDropJson).toContain('next-seeds.drop.json');
    expect(outputIndex.files.nextSeedsInvestigateJson).toContain('next-seeds.investigate.json');
    expect(outputIndex.files.candidateShortlistCsv).toContain('candidate-shortlist.csv');
    expect(outputIndex.files.candidateShortlistJson).toContain('candidate-shortlist.json');
  });

  it('builds deterministic candidate shortlist with filters and recommendations', async () => {
    const outDir = 'output/test-seed-batch-shortlist';
    await mkdir(outDir, { recursive: true });
    const inputPath = path.join(outDir, 'seed.json');
    await writeFile(
      inputPath,
      JSON.stringify([
        { chain: 'base', label: 'SEED_A', tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        { chain: 'base', label: 'SEED_B', tokenAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
        { chain: 'base', label: 'SEED_C', tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab' },
      ]),
      'utf8',
    );

    const result = await runSeedBatch({
      inputPath,
      csv: true,
      outDir,
      shortlistMinAppearances: 2,
      shortlistMinScore: 40,
      shortlistMaxAverageRank: 150,
      shortlistIncludeRejected: true,
      minTokenAppearances: 1,
    });

    expect(result.candidateShortlist.length).toBeGreaterThan(0);
    const first = result.candidateShortlist[0];
    expect(first?.tokenAppearances).toBeGreaterThanOrEqual(2);
    expect(typeof first?.score).toBe('number');
    expect(first?.averageFirstBuyRank).toBeLessThanOrEqual(150);
    expect(typeof first?.monitorRecommendation).toBe('string');

    const shortlistRaw = await readFile(result.outputFiles.candidateShortlistJson, 'utf8');
    const shortlist = JSON.parse(shortlistRaw) as Array<{ monitorRecommendation: string; score: number }>;
    expect(shortlist.length).toBe(result.candidateShortlist.length);
    expect(shortlist.every((x) => ['monitor_candidate', 'watch_after_pnl_enrichment', 'ignore_low_sample', 'investigate_high_activity'].includes(x.monitorRecommendation))).toBe(true);
  });

  it('optionally includes cross-chain overlap rows when enabled', async () => {
    const outDir = 'output/test-seed-batch-cross-chain-overlap';
    await mkdir(outDir, { recursive: true });
    const inputPath = path.join(outDir, 'seed.json');
    await writeFile(
      inputPath,
      JSON.stringify([
        { chain: 'base', label: 'BASE_01', tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        { chain: 'ethereum', label: 'ETH_01', tokenAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      ]),
      'utf8',
    );

    const withoutCrossChain = await runSeedBatch({
      inputPath,
      csv: false,
      outDir: `${outDir}/default`,
      maxSeedsPerRun: 10,
    });
    const defaultMatrix = JSON.parse(await readFile(withoutCrossChain.outputFiles.walletOverlapMatrixJson, 'utf8')) as Array<Record<string, unknown>>;
    expect(defaultMatrix).toHaveLength(0);

    const withCrossChain = await runSeedBatch({
      inputPath,
      csv: false,
      outDir: `${outDir}/enabled`,
      includeCrossChainOverlap: true,
      maxSeedsPerRun: 10,
    });
    const enabledMatrix = JSON.parse(await readFile(withCrossChain.outputFiles.walletOverlapMatrixJson, 'utf8')) as Array<Record<string, unknown>>;
    expect(Array.isArray(enabledMatrix)).toBe(true);
  });

  it('filters candidate aggregation to keep seeds when onlyUsefulSeeds=true', async () => {
    const outDir = 'output/test-seed-batch-only-useful';
    await mkdir(outDir, { recursive: true });
    const inputPath = path.join(outDir, 'seed.json');
    await writeFile(
      inputPath,
      JSON.stringify([
        { chain: 'base', label: 'KEEP_A', tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        { chain: 'base', label: 'KEEP_B', tokenAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
        { chain: 'base', label: 'ZERO', tokenAddress: '0xcccccccccccccccccccccccccccccccccccccccc' },
        { chain: 'base', label: 'DENSE', tokenAddress: '0xdddddddddddddddddddddddddddddddddddddddd' },
      ]),
      'utf8',
    );

    const unfocused = await runSeedBatch({
      inputPath,
      outDir: `${outDir}/all`,
      csv: false,
      minTokenAppearances: 1,
      onlyUsefulSeeds: false,
      maxSeedsPerRun: 10,
    });
    const focused = await runSeedBatch({
      inputPath,
      outDir: `${outDir}/focused`,
      csv: false,
      minTokenAppearances: 1,
      onlyUsefulSeeds: true,
      maxSeedsPerRun: 10,
    });

    expect(unfocused.candidates.length).toBeGreaterThan(focused.candidates.length);
    expect(focused.tokenResults.length).toBeGreaterThan(0);
  });

  it('builds cumulative cache across repeated checkpointed free-rpc runs', async () => {
    const outDir = `output/test-seed-batch-cumulative-cache-${Date.now()}`;
    await mkdir(outDir, { recursive: true });
    const inputPath = path.join(outDir, 'seed.json');
    await writeFile(
      inputPath,
      JSON.stringify([
        { chain: 'base', label: 'TOKEN_A', tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        { chain: 'base', label: 'TOKEN_B', tokenAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      ]),
      'utf8',
    );

    const first = await runSeedBatch({
      inputPath,
      outDir,
      csv: true,
      freeRpcMode: true,
      maxSeedsPerRun: 1,
      minTokenAppearances: 2,
    });
    expect(first.summary.cachedTokenResultsLoaded).toBe(0);
    expect(first.summary.cachedTokenResultsWritten).toBe(1);
    expect(first.summary.completedSeedResults).toBe(1);
    expect(first.summary.pendingSeedResults).toBe(1);
    expect(first.candidates.length).toBe(0);

    const second = await runSeedBatch({
      inputPath,
      outDir,
      csv: true,
      freeRpcMode: true,
      maxSeedsPerRun: 1,
      minTokenAppearances: 2,
    });

    expect(second.summary.cachedTokenResultsLoaded).toBeGreaterThanOrEqual(1);
    expect(second.summary.cachedTokenResultsWritten).toBe(1);
    expect(second.summary.completedSeedResults).toBe(2);
    expect(second.summary.pendingSeedResults).toBe(0);
    expect(second.summary.cumulativeMode).toBe(true);
    expect(second.candidates.some((x) => x.walletAddress.toLowerCase() === '0x1111111111111111111111111111111111111111')).toBe(true);

    const tokenRows = JSON.parse(await readFile(second.outputFiles.tokenBuyerSummaryJson, 'utf8')) as Array<{ tokenLabel?: string }>;
    expect(tokenRows.map((x) => x.tokenLabel)).toEqual(expect.arrayContaining(['TOKEN_A', 'TOKEN_B']));

    const cacheA = await readFile(path.join(outDir, 'token-results-cache', 'base-0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json'), 'utf8');
    const cacheB = await readFile(path.join(outDir, 'token-results-cache', 'base-0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json'), 'utf8');
    expect(() => JSON.parse(cacheA)).not.toThrow();
    expect(() => JSON.parse(cacheB)).not.toThrow();
  });

  it('does not classify maxSeedsPerRun-deferred seeds as drop candidates', async () => {
    const outDir = `output/test-seed-batch-deferred-not-drop-${Date.now()}`;
    await mkdir(outDir, { recursive: true });
    const inputPath = path.join(outDir, 'seed.json');
    await writeFile(
      inputPath,
      JSON.stringify([
        { chain: 'base', label: 'TOKEN_A', tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        { chain: 'base', label: 'TOKEN_B', tokenAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      ]),
      'utf8',
    );

    const result = await runSeedBatch({
      inputPath,
      outDir,
      csv: false,
      maxSeedsPerRun: 1,
      freeRpcMode: true,
    });

    const deferred = result.tokenResults.find((x) => (x.seed as { label?: string }).label === 'TOKEN_B');
    expect(deferred?.status).toBe('skipped');
    expect(deferred?.seedTriageStatus).toBe('deferred');
    expect(result.seedCuration.drop.some((x) => x.label === 'TOKEN_B')).toBe(false);
    const keepOrInvestigate = [...result.seedCuration.keep, ...result.seedCuration.investigate];
    expect(keepOrInvestigate.some((x) => x.label === 'TOKEN_B')).toBe(true);
  });
});
