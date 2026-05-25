import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedTrade } from '../src/chains/chain.types.js';

const {
  analyzeMock,
  classifyMock,
  scanMock,
  findBlockMock,
  getBlockNumberMock,
  createJobMock,
  updateJobMock,
  upsertTokenMock,
  upsertWalletMock,
  upsertTradeMock,
  upsertPerfMock,
} = vi.hoisted(() => ({
  analyzeMock: vi.fn(),
  classifyMock: vi.fn(),
  scanMock: vi.fn(),
  findBlockMock: vi.fn(),
  getBlockNumberMock: vi.fn(),
  createJobMock: vi.fn(),
  updateJobMock: vi.fn(),
  upsertTokenMock: vi.fn(),
  upsertWalletMock: vi.fn(),
  upsertTradeMock: vi.fn(),
  upsertPerfMock: vi.fn(),
}));

vi.mock('../src/config/env.js', () => ({
  env: {
    DATABASE_URL: 'postgresql://test',
    EVM_SCAN_CHUNK_SIZE: 1200,
    EVM_SCAN_MAX_LOGS: 10000,
    EVM_SCAN_MAX_TRADES: 2000,
  },
}));

vi.mock('../src/analysis/token-analyzer.js', () => ({
  TokenAnalyzer: class {
    analyze = analyzeMock;
  },
}));

vi.mock('../src/providers/evm/evm-dex-classifier.js', () => ({
  classifyEvmPool: classifyMock,
}));

vi.mock('../src/providers/evm/evm-trade-scanner.js', () => ({
  scanPoolTrades: scanMock,
}));

vi.mock('../src/providers/evm/evm-block-resolution.js', () => ({
  findBlockAtOrBeforeTimestamp: findBlockMock,
}));

vi.mock('../src/providers/evm/evm-rpc.client.js', () => ({
  getEvmPublicClient: vi.fn(() => ({ getBlockNumber: getBlockNumberMock })),
}));

vi.mock('../src/db/repositories/analysis-job.repository.js', () => ({
  createAnalysisJob: createJobMock,
  updateAnalysisJobResult: updateJobMock,
}));

vi.mock('../src/db/repositories/token.repository.js', () => ({
  upsertTokenProfile: upsertTokenMock,
}));

vi.mock('../src/db/repositories/wallet.repository.js', () => ({
  upsertCandidateWallet: upsertWalletMock,
}));

vi.mock('../src/db/repositories/trade.repository.js', () => ({
  upsertTrade: upsertTradeMock,
}));

vi.mock('../src/db/repositories/wallet-token-performance.repository.js', () => ({
  upsertWalletTokenPerformance: upsertPerfMock,
}));

import { extractEarlyBuyers } from '../src/discovery/extract-early-buyers.js';

function makeTrade(overrides: Partial<NormalizedTrade>): NormalizedTrade {
  return {
    chain: 'base',
    chainFamily: 'evm',
    walletAddress: '0x00000000000000000000000000000000000000aa',
    tokenAddress: '0x0000000000000000000000000000000000000001',
    txHash: '0xtx1',
    side: 'buy',
    amountToken: 10,
    timestamp: new Date('2024-01-01T00:00:00Z'),
    blockNumber: 101,
    raw: { warnings: [] },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  analyzeMock.mockResolvedValue({
    providerSource: 'dexscreener',
    warnings: ['pair_created_at_missing'],
    raw: {},
    tokenProfile: {
      chain: 'base',
      chainFamily: 'evm',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      symbol: 'TKN',
      name: 'Token',
      pairAddress: '0x00000000000000000000000000000000000000ff',
      poolAddress: '0x00000000000000000000000000000000000000ff',
      dexId: 'uniswap',
      priceUsd: 1,
      marketCap: 100000,
      fdv: 200000,
      liquidityUsd: 50000,
      dexUrl: 'https://example.com',
      warnings: [],
      raw: {},
    },
  });
  classifyMock.mockResolvedValue({
    chain: 'base',
    poolAddress: '0x00000000000000000000000000000000000000ff',
    dexId: 'uniswap',
    parserType: 'uniswap_v2_compatible',
    reason: 'v2_abi_and_logs_confirmed',
    warnings: [],
  });
  scanMock.mockResolvedValue({
    trades: [],
    warnings: [],
    metadata: {
      fromBlock: 100n,
      toBlock: 150n,
      latestBlock: 1200n,
      getLogsContext: 'trade_scanner_v2',
      getLogsMode: 'raw_rpc',
      topicFilterUsed: true,
      swapTopic: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
      logsScanned: 2,
      tradesExtracted: 0,
      parserType: 'uniswap_v2_compatible',
      truncated: false,
      warnings: [],
    },
  });
  findBlockMock.mockResolvedValue(100n);
  getBlockNumberMock.mockResolvedValue(1200n);
  createJobMock.mockResolvedValue({ id: 'job-1' });
  updateJobMock.mockResolvedValue({ id: 'job-1' });
  upsertTokenMock.mockResolvedValue({ id: 'token-1' });
  upsertWalletMock.mockResolvedValue({ id: 'wallet-1' });
  upsertTradeMock.mockResolvedValue({ id: 'trade-1' });
  upsertPerfMock.mockResolvedValue({ id: 'perf-1' });
});

describe('extractEarlyBuyers', () => {
  it('returns unsupported warning for solana', async () => {
    const result = await extractEarlyBuyers({ chain: 'solana', tokenAddress: 'So11111111111111111111111111111111111111112' });

    expect(result.earliestBuyers).toEqual([]);
    expect(result.warnings).toContain('Solana early-buyer extraction is not implemented yet.');
  });

  it('returns structured result for unsupported pool', async () => {
    classifyMock.mockResolvedValueOnce({
      chain: 'base',
      poolAddress: '0x00000000000000000000000000000000000000ff',
      parserType: 'unsupported',
      reason: 'no_supported_swap_signature_detected',
      warnings: ['no_logs'],
    });

    const result = await extractEarlyBuyers({ chain: 'base', tokenAddress: '0x0000000000000000000000000000000000000001' });

    expect(result.earliestBuyers).toEqual([]);
    expect(result.warnings).toContain('unsupported_pool_parser');
    expect(scanMock).not.toHaveBeenCalled();
  });

  it('groups early buyers on the happy path', async () => {
    scanMock.mockResolvedValueOnce({
      trades: [
        makeTrade({
          walletAddress: '0x00000000000000000000000000000000000000bb',
          txHash: '0xaaa',
          blockNumber: 101,
          amountToken: 20,
          amountUsd: 10,
          raw: { warnings: ['buyer_inference_uncertain'] },
        }),
        makeTrade({
          walletAddress: '0x00000000000000000000000000000000000000bb',
          txHash: '0xbbb',
          blockNumber: 102,
          amountToken: 30,
          amountUsd: 15,
          raw: { warnings: [] },
        }),
        makeTrade({
          walletAddress: '0x00000000000000000000000000000000000000cc',
          txHash: '0xccc',
          blockNumber: 103,
          amountToken: 5,
          amountUsd: 3,
          raw: { warnings: [] },
        }),
      ],
      warnings: ['scan_warning'],
      metadata: {
        fromBlock: 100n,
        toBlock: 150n,
        latestBlock: 1200n,
        getLogsContext: 'trade_scanner_v2',
        getLogsMode: 'raw_rpc',
        topicFilterUsed: true,
        swapTopic: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
        logsScanned: 3,
        tradesExtracted: 3,
        parserType: 'uniswap_v2_compatible',
        truncated: false,
        warnings: ['scan_warning'],
      },
    });

    const result = await extractEarlyBuyers({
      chain: 'base',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      persist: true,
      maxBuyers: 10,
    });

    expect(result.earliestBuyers).toHaveLength(2);
    expect(result.earliestBuyers[0]?.walletAddress).toBe('0x00000000000000000000000000000000000000bb');
    expect(result.earliestBuyers[0]?.buyCount).toBe(2);
    expect(result.earliestBuyers[0]?.warnings).toContain('buyer_inference_uncertain');
    expect(result.persistenceSummary?.persisted).toBe(true);
    expect(scanMock).toHaveBeenCalledWith(
      expect.objectContaining({
        parserType: 'uniswap_v2_compatible',
      }),
    );
    expect(result.scanMetadata).toEqual(
      expect.objectContaining({
        topicFilterUsed: true,
        swapTopic: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
        parserType: 'uniswap_v2_compatible',
      }),
    );
    expect(createJobMock).toHaveBeenCalled();
    expect(upsertTradeMock).toHaveBeenCalledTimes(3);
    expect(upsertPerfMock).toHaveBeenCalledTimes(2);
  });

  it('returns structured dense-pool guardrail result instead of throwing', async () => {
    scanMock.mockRejectedValueOnce(new Error('max_adaptive_splits_reached: rpc range too dense'));

    const result = await extractEarlyBuyers({
      chain: 'base',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      maxHoursAfterCreation: 24,
    });

    expect(result.earliestBuyers).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        'max_adaptive_splits_reached',
        'dense_pool_scan_guardrail_hit',
        'try_smaller_window_or_better_rpc',
      ]),
    );
    expect(result.warnings.some((x) => x.startsWith('original_scan_error:'))).toBe(true);
    expect(result.seedRecommendation).toBe('investigate_or_drop');
  });
});
