import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { autoExpandSeeds, autoRunDiscovery } from '../src/discovery/auto-discovery.js';
import type { SeedDiscoveryResult } from '../src/discovery/seed-discovery.types.js';
import type { SeedBatchRunResult } from '../src/discovery/run-seed-batch.js';

function buildDiscoveryResult(candidates: SeedDiscoveryResult['candidates']): SeedDiscoveryResult {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    inputSummary: {
      chains: ['ethereum', 'base', 'bsc'],
      includeLatestProfiles: true,
      includeLatestBoosts: true,
      includeTopBoosts: true,
      limit: 30,
    },
    diagnostics: {
      sourceFetchCounts: { latest_profiles: 10, latest_boosts: 10, top_boosts: 10 },
      candidatesAfterChainFilter: candidates.length,
      candidatesAfterDedupe: candidates.length,
      pairDataUnavailable: 0,
      skippedByFilter: {
        minMarketCap: 0,
        minLiquidityUsd: 0,
        minVolumeH24: 0,
        minPriceChangeH24: 0,
        maxAgeDays: 0,
      },
      skippedExamples: [],
    },
    candidates,
    warnings: [],
    outputFiles: {},
  };
}

function buildSeedBatchResult(overrides: Partial<SeedBatchRunResult> = {}): SeedBatchRunResult {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    inputSummary: {
      inputPath: 'data/seed-tokens.auto-next.json',
      totalSeedTokens: 6,
      maxBuyers: 200,
      maxHoursAfterCreation: 24,
      maxBlocksAfterCreation: 25000,
      minTokenAppearances: 2,
      persist: false,
      enrichWallets: false,
      walletSource: 'provider',
      maxWalletsToEnrich: 0,
      maxWalletTrades: 0,
      onlyUsefulSeeds: false,
    },
    summary: {
      analyzed: 6,
      succeeded: 6,
      failed: 0,
      skipped: 0,
      totalUniqueEarlyBuyers: 18,
      candidateWalletsFound: 3,
    },
    tokenResults: [],
    candidates: [],
    warnings: [],
    errors: [],
    outputFiles: {
      tokenBuyerSummaryJson: 'output/discovery-auto-run-v1/token-buyer-summary.json',
      candidateEvidenceJson: 'output/discovery-auto-run-v1/candidate-evidence.json',
      candidateShortlistJson: 'output/discovery-auto-run-v1/candidate-shortlist.json',
      nextSeedsKeepJson: 'output/discovery-auto-run-v1/next-seeds.keep.json',
      nextSeedsDropJson: 'output/discovery-auto-run-v1/next-seeds.drop.json',
      nextSeedsInvestigateJson: 'output/discovery-auto-run-v1/next-seeds.investigate.json',
    },
    seedCuration: {
      keep: [{ chain: 'ethereum', tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } as any],
      drop: [{ chain: 'base', tokenAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } as any],
      investigate: [{ chain: 'bsc', tokenAddress: '0xcccccccccccccccccccccccccccccccccccccccc' } as any],
    },
    candidateShortlist: [
      {
        rank: 1,
        chain: 'ethereum',
        walletAddress: '0x1111111111111111111111111111111111111111',
        score: 61,
        category: 'alpha',
        tokenAppearances: 3,
        tokensAppearedIn: ['A', 'B', 'C'],
        narratives: ['ethereum_meme'],
        averageFirstBuyRank: 2,
        bestFirstBuyRank: 1,
        totalBuyCountAcrossSeeds: 5,
        earliestObservedBuyAt: '2026-01-01T00:00:00.000Z',
        reasons: ['high overlap'],
        riskFlags: [],
        evidenceSummary: 'A#1;B#2',
        monitorRecommendation: 'monitor_candidate',
      },
    ],
    ...overrides,
  };
}

describe('auto discovery helpers', () => {
  it('auto expansion with enough DexScreener candidates', async () => {
    const outDir = 'output/test-auto-expand-enough';
    await mkdir(outDir, { recursive: true });
    const basePath = path.join(outDir, 'base.json');
    const outPath = path.join(outDir, 'auto-next.json');

    await writeFile(
      basePath,
      JSON.stringify([{ chain: 'ethereum', tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', label: 'BASE_KEEP' }]),
      'utf8',
    );

    const discover = vi
      .fn()
      .mockResolvedValueOnce(
        buildDiscoveryResult([
          {
            chain: 'ethereum',
            tokenAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            pairAddress: '0x1111111111111111111111111111111111111111',
            liquidityUsd: 200000,
            volumeH24: 150000,
            score: 80,
            source: ['latest_profiles'],
            warnings: [],
          },
          {
            chain: 'base',
            tokenAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
            pairAddress: '0x2222222222222222222222222222222222222222',
            liquidityUsd: 40000,
            volumeH24: 30000,
            score: 70,
            source: ['latest_boosts'],
            warnings: [],
          },
        ]),
      )
      .mockResolvedValueOnce(buildDiscoveryResult([]))
      .mockResolvedValueOnce(buildDiscoveryResult([]));

    const marketClient = { searchPairs: vi.fn().mockResolvedValue([]) };

    const result = await autoExpandSeeds(
      {
        basePath,
        outPath,
        workdir: outDir,
        chains: ['ethereum', 'base', 'bsc'],
        targetCount: 2,
        defaultNarrative: 'ethereum_meme',
        dryRun: false,
        discoveredOutPath: path.join(outDir, 'auto-discovered.json'),
        metaOutPath: path.join(outDir, 'auto-next.meta.json'),
      },
      { discover, marketClient },
    );

    expect(result.autoDiscoveredCount).toBe(2);
    expect(result.finalSeedCount).toBe(3);
    const merged = JSON.parse(await readFile(outPath, 'utf8')) as Array<{ chain: string; tokenAddress: string }>;
    expect(merged).toHaveLength(3);
    expect(merged.some((x) => x.tokenAddress === '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true);
    expect(result.discoveredFromProfilesCount).toBe(2);
    expect(result.discoveredFromSearchQueriesCount).toBe(0);
  });

  it('auto expansion with too few candidates warns clearly', async () => {
    const outDir = 'output/test-auto-expand-few';
    await mkdir(outDir, { recursive: true });
    const basePath = path.join(outDir, 'base.json');
    await writeFile(basePath, JSON.stringify([{ chain: 'ethereum', tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }]), 'utf8');

    const discover = vi.fn().mockResolvedValue(buildDiscoveryResult([]));

    const marketClient = { searchPairs: vi.fn().mockResolvedValue([]) };

    const result = await autoExpandSeeds(
      {
        basePath,
        outPath: path.join(outDir, 'auto-next.json'),
        workdir: outDir,
        chains: ['ethereum', 'base', 'bsc'],
        targetCount: 10,
        defaultNarrative: 'ethereum_meme',
        dryRun: false,
        discoveredOutPath: path.join(outDir, 'auto-discovered.json'),
        metaOutPath: path.join(outDir, 'auto-next.meta.json'),
      },
      { discover, marketClient },
    );

    expect(result.autoDiscoveredCount).toBe(0);
    expect(result.warnings.some((x) => x.startsWith('auto_discovered_seed_count_low:'))).toBe(true);
    expect(result.warnings).toContain('final_seed_count_did_not_grow');
  });

  it('merge preserves base seeds without override', async () => {
    const outDir = 'output/test-auto-expand-merge';
    await mkdir(outDir, { recursive: true });
    const basePath = path.join(outDir, 'base.json');
    const outPath = path.join(outDir, 'auto-next.json');
    await writeFile(
      basePath,
      JSON.stringify([{ chain: 'ethereum', tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', label: 'BASE_KEEP', notes: 'keep me' }]),
      'utf8',
    );

    const discover = vi.fn().mockResolvedValue(
      buildDiscoveryResult([
        {
          chain: 'ethereum',
          tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          pairAddress: '0x1111111111111111111111111111111111111111',
          liquidityUsd: 200000,
          volumeH24: 100000,
          score: 90,
          source: ['latest_profiles'],
          warnings: [],
        },
      ]),
    );

    const marketClient = { searchPairs: vi.fn().mockResolvedValue([]) };

    await autoExpandSeeds(
      {
        basePath,
        outPath,
        workdir: outDir,
        chains: ['ethereum', 'base', 'bsc'],
        targetCount: 1,
        defaultNarrative: 'ethereum_meme',
        dryRun: false,
        discoveredOutPath: path.join(outDir, 'auto-discovered.json'),
        metaOutPath: path.join(outDir, 'auto-next.meta.json'),
      },
      { discover, marketClient },
    );

    const merged = JSON.parse(await readFile(outPath, 'utf8')) as Array<{ label?: string; notes?: string; tokenAddress: string }>;
    expect(merged).toHaveLength(1);
    expect(merged[0]?.label).toBe('BASE_KEEP');
    expect(merged[0]?.notes).toBe('keep me');
  });

  it('query fallback returns candidates, dedupes, and excludes duplicate base seeds', async () => {
    const outDir = 'output/test-auto-expand-query-dedupe';
    await mkdir(outDir, { recursive: true });
    const basePath = path.join(outDir, 'base.json');
    const outPath = path.join(outDir, 'auto-next.json');

    const baseSeed = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    await writeFile(basePath, JSON.stringify([{ chain: 'ethereum', tokenAddress: baseSeed, label: 'BASE_KEEP' }]), 'utf8');

    const discover = vi.fn().mockResolvedValue(buildDiscoveryResult([]));
    const marketClient = {
      searchPairs: vi.fn().mockResolvedValue([
        {
          chainId: 'ethereum',
          baseToken: { address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', symbol: 'BBB' },
          pairAddress: '0x1111111111111111111111111111111111111111',
          liquidity: { usd: 200000 },
          marketCap: 1500000,
          volume: { h24: 300000 },
        },
        {
          chainId: 'ethereum',
          baseToken: { address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', symbol: 'BBB' },
          pairAddress: '0x1111111111111111111111111111111111111111',
          liquidity: { usd: 200000 },
          marketCap: 1500000,
          volume: { h24: 300000 },
        },
        {
          chainId: 'ethereum',
          baseToken: { address: baseSeed, symbol: 'BASE' },
          pairAddress: '0x2222222222222222222222222222222222222222',
          liquidity: { usd: 200000 },
          marketCap: 1500000,
          volume: { h24: 300000 },
        },
      ]),
    };

    const result = await autoExpandSeeds(
      {
        basePath,
        outPath,
        workdir: outDir,
        chains: ['ethereum', 'base', 'bsc'],
        targetCount: 3,
        includeQueryDiscovery: true,
        queries: ['meme'],
        maxPerQuery: 10,
        defaultNarrative: 'ethereum_meme',
        dryRun: false,
        discoveredOutPath: path.join(outDir, 'auto-discovered.json'),
        metaOutPath: path.join(outDir, 'auto-next.meta.json'),
      },
      { discover, marketClient },
    );

    expect(result.discoveredFromSearchQueriesCount).toBe(1);
    const merged = JSON.parse(await readFile(outPath, 'utf8')) as Array<{ tokenAddress: string }>;
    expect(merged.filter((x) => x.tokenAddress === baseSeed).length).toBe(1);
  });

  it('query fallback skips unsupported chains and low liquidity', async () => {
    const outDir = 'output/test-auto-expand-query-filters';
    await mkdir(outDir, { recursive: true });
    const basePath = path.join(outDir, 'base.json');
    await writeFile(basePath, JSON.stringify([{ chain: 'ethereum', tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }]), 'utf8');

    const discover = vi.fn().mockResolvedValue(buildDiscoveryResult([]));
    const marketClient = {
      searchPairs: vi.fn().mockResolvedValue([
        {
          chainId: 'solana',
          baseToken: { address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', symbol: 'BADCHAIN' },
          pairAddress: '0x1111111111111111111111111111111111111111',
          liquidity: { usd: 120000 },
          marketCap: 1200000,
          volume: { h24: 120000 },
        },
        {
          chainId: 'base',
          baseToken: { address: '0xcccccccccccccccccccccccccccccccccccccccc', symbol: 'LOWLQ' },
          pairAddress: '0x2222222222222222222222222222222222222222',
          liquidity: { usd: 0 },
          marketCap: 1200000,
          volume: { h24: 120000 },
        },
      ]),
    };

    const result = await autoExpandSeeds(
      {
        basePath,
        outPath: path.join(outDir, 'auto-next.json'),
        workdir: outDir,
        chains: ['ethereum', 'base', 'bsc'],
        targetCount: 5,
        includeQueryDiscovery: true,
        queries: ['test'],
        maxPerQuery: 10,
        defaultNarrative: 'ethereum_meme',
        dryRun: false,
        discoveredOutPath: path.join(outDir, 'auto-discovered.json'),
        metaOutPath: path.join(outDir, 'auto-next.meta.json'),
      },
      { discover, marketClient },
    );

    expect(result.discoveredFromSearchQueriesCount).toBe(0);
  });

  it('target count stops discovery and custom query list is used', async () => {
    const outDir = 'output/test-auto-expand-query-target';
    await mkdir(outDir, { recursive: true });
    const basePath = path.join(outDir, 'base.json');
    await writeFile(basePath, JSON.stringify([{ chain: 'ethereum', tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }]), 'utf8');

    const discover = vi.fn().mockResolvedValue(buildDiscoveryResult([]));
    const marketClient = {
      searchPairs: vi
        .fn()
        .mockResolvedValue([
          {
            chainId: 'ethereum',
            baseToken: { address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', symbol: 'Q1' },
            pairAddress: '0x1111111111111111111111111111111111111111',
            liquidity: { usd: 150000 },
            marketCap: 1500000,
            volume: { h24: 200000 },
          },
        ])
        .mockResolvedValue([
          {
            chainId: 'base',
            baseToken: { address: '0xcccccccccccccccccccccccccccccccccccccccc', symbol: 'Q2' },
            pairAddress: '0x2222222222222222222222222222222222222222',
            liquidity: { usd: 150000 },
            marketCap: 1500000,
            volume: { h24: 200000 },
          },
        ]),
    };

    const result = await autoExpandSeeds(
      {
        basePath,
        outPath: path.join(outDir, 'auto-next.json'),
        workdir: outDir,
        chains: ['ethereum', 'base', 'bsc'],
        targetCount: 1,
        includeQueryDiscovery: true,
        queries: ['pepe', 'wojak'],
        maxPerQuery: 10,
        defaultNarrative: 'ethereum_meme',
        dryRun: false,
        discoveredOutPath: path.join(outDir, 'auto-discovered.json'),
        metaOutPath: path.join(outDir, 'auto-next.meta.json'),
      },
      { discover, marketClient },
    );

    expect(result.autoDiscoveredCount).toBe(1);
    expect(result.queriesUsed).toEqual(['pepe', 'wojak']);
    expect(marketClient.searchPairs).toHaveBeenCalledTimes(1);
    expect(marketClient.searchPairs).toHaveBeenCalledWith('pepe');
  });

  it('expanded default query pack is used when custom queries are not provided', async () => {
    const outDir = 'output/test-auto-expand-default-queries';
    await mkdir(outDir, { recursive: true });
    const basePath = path.join(outDir, 'base.json');
    await writeFile(basePath, JSON.stringify([{ chain: 'ethereum', tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }]), 'utf8');

    const discover = vi.fn().mockResolvedValue(buildDiscoveryResult([]));
    const marketClient = { searchPairs: vi.fn().mockResolvedValue([]) };

    const result = await autoExpandSeeds(
      {
        basePath,
        outPath: path.join(outDir, 'auto-next.json'),
        workdir: outDir,
        chains: ['ethereum', 'base', 'bsc'],
        targetCount: 1,
        includeQueryDiscovery: true,
        maxPerQuery: 10,
        defaultNarrative: 'ethereum_meme',
        dryRun: false,
        discoveredOutPath: path.join(outDir, 'auto-discovered.json'),
        metaOutPath: path.join(outDir, 'auto-next.meta.json'),
      },
      { discover, marketClient },
    );

    expect(result.queriesUsed).toContain('moodeng');
    expect(result.queryCount).toBe(result.queriesUsed.length);
    expect(result.queriesUsed.length).toBeGreaterThan(30);
  });

  it('query timeout produces partial output and warning', async () => {
    const outDir = 'output/test-auto-expand-query-timeout';
    await mkdir(outDir, { recursive: true });
    const basePath = path.join(outDir, 'base.json');
    await writeFile(basePath, JSON.stringify([{ chain: 'ethereum', tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }]), 'utf8');

    const discover = vi.fn().mockResolvedValue(buildDiscoveryResult([]));
    const marketClient = {
      searchPairs: vi
        .fn()
        .mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve([]), 1200)))
        .mockResolvedValueOnce([
          {
            chainId: 'ethereum',
            baseToken: { address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', symbol: 'TIME' },
            pairAddress: '0x1111111111111111111111111111111111111111',
            liquidity: { usd: 150000 },
            marketCap: 1500000,
            volume: { h24: 200000 },
          },
        ]),
    };

    const result = await autoExpandSeeds(
      {
        basePath,
        outPath: path.join(outDir, 'auto-next.json'),
        workdir: outDir,
        chains: ['ethereum', 'base', 'bsc'],
        targetCount: 2,
        includeQueryDiscovery: true,
        queries: ['pepe', 'wojak'],
        maxPerQuery: 10,
        maxQuerySeconds: 1,
        defaultNarrative: 'ethereum_meme',
        dryRun: false,
        discoveredOutPath: path.join(outDir, 'auto-discovered.json'),
        metaOutPath: path.join(outDir, 'auto-next.meta.json'),
      },
      { discover, marketClient },
    );

    expect(result.warnings.some((w) => w.includes('query_timeout_seconds'))).toBe(true);
    expect(result.finalSeedCount).toBeGreaterThanOrEqual(1);
  });

  it('progress logging hooks do not crash', async () => {
    const outDir = 'output/test-auto-expand-logs';
    await mkdir(outDir, { recursive: true });
    const basePath = path.join(outDir, 'base.json');
    await writeFile(basePath, JSON.stringify([{ chain: 'ethereum', tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }]), 'utf8');

    const discover = vi.fn().mockResolvedValue(buildDiscoveryResult([]));
    const marketClient = { searchPairs: vi.fn().mockResolvedValue([]) };
    const logs: string[] = [];

    await autoExpandSeeds(
      {
        basePath,
        outPath: path.join(outDir, 'auto-next.json'),
        workdir: outDir,
        chains: ['ethereum', 'base', 'bsc'],
        targetCount: 1,
        includeQueryDiscovery: true,
        queries: ['pepe'],
        defaultNarrative: 'ethereum_meme',
        dryRun: false,
        discoveredOutPath: path.join(outDir, 'auto-discovered.json'),
        metaOutPath: path.join(outDir, 'auto-next.meta.json'),
        log: (message) => logs.push(message),
      },
      { discover, marketClient },
    );

    expect(logs.some((x) => x.includes('running profile discovery'))).toBe(true);
    expect(logs.some((x) => x.includes('starting query fallback'))).toBe(true);
  });

  it('auto expansion report includes query stats', async () => {
    const outDir = 'output/test-auto-expand-query-report';
    await mkdir(outDir, { recursive: true });
    const basePath = path.join(outDir, 'base.json');
    await writeFile(basePath, JSON.stringify([{ chain: 'ethereum', tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }]), 'utf8');

    const discover = vi.fn().mockResolvedValue(buildDiscoveryResult([]));
    const marketClient = {
      searchPairs: vi.fn().mockResolvedValue([
        {
          chainId: 'ethereum',
          baseToken: { address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', symbol: 'REP' },
          pairAddress: '0x1111111111111111111111111111111111111111',
          liquidity: { usd: 150000 },
          marketCap: 1500000,
          volume: { h24: 200000 },
        },
      ]),
    };

    const result = await autoExpandSeeds(
      {
        basePath,
        outPath: path.join(outDir, 'auto-next.json'),
        workdir: outDir,
        chains: ['ethereum', 'base', 'bsc'],
        targetCount: 2,
        includeQueryDiscovery: true,
        queries: ['meme'],
        maxPerQuery: 10,
        defaultNarrative: 'ethereum_meme',
        dryRun: false,
        discoveredOutPath: path.join(outDir, 'auto-discovered.json'),
        metaOutPath: path.join(outDir, 'auto-next.meta.json'),
      },
      { discover, marketClient },
    );

    const report = JSON.parse(await readFile(result.outputFiles.reportJson, 'utf8')) as {
      summary?: { queriesUsed?: string[] };
      queryDiscovery?: { queryCount?: number };
    };
    expect(report.summary?.queriesUsed).toEqual(['meme']);
    expect(report.queryDiscovery?.queryCount).toBe(1);
  });

  it('auto discovery calls query fallback when profile discovery returns 0', async () => {
    const outDir = 'output/test-auto-expand-query-trigger';
    await mkdir(outDir, { recursive: true });
    const basePath = path.join(outDir, 'base.json');
    await writeFile(basePath, JSON.stringify([{ chain: 'ethereum', tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }]), 'utf8');

    const discover = vi.fn().mockResolvedValue(buildDiscoveryResult([]));
    const marketClient = {
      searchPairs: vi.fn().mockResolvedValue([
        {
          chainId: 'base',
          baseToken: { address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', symbol: 'FB' },
          pairAddress: '0x1111111111111111111111111111111111111111',
          liquidity: { usd: 150000 },
          marketCap: 1500000,
          volume: { h24: 200000 },
        },
      ]),
    };

    const result = await autoExpandSeeds(
      {
        basePath,
        outPath: path.join(outDir, 'auto-next.json'),
        workdir: outDir,
        chains: ['ethereum', 'base', 'bsc'],
        targetCount: 2,
        includeQueryDiscovery: true,
        queries: ['agent'],
        maxPerQuery: 10,
        defaultNarrative: 'ethereum_meme',
        dryRun: false,
        discoveredOutPath: path.join(outDir, 'auto-discovered.json'),
        metaOutPath: path.join(outDir, 'auto-next.meta.json'),
      },
      { discover, marketClient },
    );

    expect(discover).toHaveBeenCalled();
    expect(marketClient.searchPairs).toHaveBeenCalledWith('agent');
    expect(result.discoveredFromProfilesCount).toBe(0);
    expect(result.discoveredFromSearchQueriesCount).toBe(1);
  });

  it('auto-run calls seed batch with expected parameters and no Postgres requirement', async () => {
    const run = vi.fn().mockResolvedValue(buildSeedBatchResult());
    const result = await autoRunDiscovery(
      {
        inputPath: 'data/seed-tokens.auto-next.json',
        outDir: 'output/discovery-auto-run-v1',
        maxBuyers: 200,
        maxHours: 24,
        minTokenAppearances: 2,
        persist: false,
        csv: true,
      },
      { run },
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        inputPath: 'data/seed-tokens.auto-next.json',
        outDir: 'output/discovery-auto-run-v1',
        maxBuyers: 200,
        maxHoursAfterCreation: 24,
        minTokenAppearances: 2,
        persist: false,
        csv: true,
        onlyUsefulSeeds: true,
      }),
    );
    expect(result.warnings).toEqual([]);
  });

  it('final report data includes candidate and shortlist counts', async () => {
    const run = vi.fn().mockResolvedValue(
      buildSeedBatchResult({
        summary: {
          analyzed: 6,
          succeeded: 5,
          failed: 1,
          skipped: 0,
          totalUniqueEarlyBuyers: 11,
          candidateWalletsFound: 0,
        },
        candidateShortlist: [],
      }),
    );

    const result = await autoRunDiscovery(
      {
        inputPath: 'data/seed-tokens.auto-next.json',
        outDir: 'output/discovery-auto-run-v1',
        maxBuyers: 200,
        maxHours: 24,
        minTokenAppearances: 2,
        persist: false,
        csv: true,
      },
      { run },
    );

    expect(result.runResult.summary.candidateWalletsFound).toBe(0);
    expect(result.runResult.candidateShortlist.length).toBe(0);
    expect(result.warnings.some((w) => w.includes('candidate_count_zero'))).toBe(true);
  });

  it('auto-run supports overriding onlyUsefulSeeds=false', async () => {
    const run = vi.fn().mockResolvedValue(buildSeedBatchResult());
    await autoRunDiscovery(
      {
        inputPath: 'data/seed-tokens.auto-next.json',
        outDir: 'output/discovery-auto-run-v1',
        maxBuyers: 50,
        maxHours: 6,
        minTokenAppearances: 2,
        persist: false,
        csv: true,
        onlyUsefulSeeds: false,
      },
      { run },
    );

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ onlyUsefulSeeds: false }));
  });
});
