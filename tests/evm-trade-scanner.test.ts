import { encodeAbiParameters } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scanPoolTrades } from '../src/providers/evm/evm-trade-scanner.js';
import { V2_SWAP_TOPIC } from '../src/providers/evm/parsers/uniswap-v2.parser.js';
import { V3_SWAP_TOPIC } from '../src/providers/evm/parsers/uniswap-v3.parser.js';

const getBlockNumberMock = vi.fn();
const readContractMock = vi.fn();
const requestMock = vi.fn();
const getBlockMock = vi.fn();

vi.mock('../src/providers/evm/evm-rpc.client.js', () => ({
  getEvmPublicClient: vi.fn(() => ({
    getBlockNumber: getBlockNumberMock,
    readContract: readContractMock,
    getLogs: vi.fn(),
    request: requestMock,
    getBlock: getBlockMock,
  })),
}));

function makeV2RawLog(blockNumber: bigint) {
  const sender = '0x00000000000000000000000000000000000000aa';
  const to = '0x00000000000000000000000000000000000000bb';
  const data = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
    [0n, 1n, 100n, 0n],
  );

  return {
    blockNumber: `0x${blockNumber.toString(16)}`,
    transactionHash: `0x${String(blockNumber).padStart(64, '0')}`,
    topics: [
      V2_SWAP_TOPIC,
      `0x000000000000000000000000${sender.slice(2)}`,
      `0x000000000000000000000000${to.slice(2)}`,
    ],
    data,
    logIndex: '0x0',
  };
}

describe('scanPoolTrades adaptive chunking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBlockNumberMock.mockResolvedValue(2000n);
    getBlockMock.mockResolvedValue({ timestamp: 1n });
    readContractMock.mockImplementation(({ functionName }: { functionName: string }) => {
      if (functionName === 'token0') return Promise.resolve('0x0000000000000000000000000000000000000001');
      if (functionName === 'token1') return Promise.resolve('0x0000000000000000000000000000000000000002');
      return Promise.reject(new Error(`unexpected method: ${functionName}`));
    });
  });

  it('reduces chunk and retries when dense range error occurs', async () => {
    requestMock
      .mockRejectedValueOnce(new Error('query exceeds max results 20000'))
      .mockResolvedValueOnce([makeV2RawLog(1001n)])
      .mockResolvedValueOnce([makeV2RawLog(1002n)]);

    const result = await scanPoolTrades({
      chain: 'base',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      poolAddress: '0x0000000000000000000000000000000000000010',
      parserType: 'uniswap_v2_compatible',
      fromBlock: 1000n,
      toBlock: 1200n,
      chunkSize: 200,
      maxLogs: 100,
      maxTrades: 100,
    });

    expect(result.metadata.adaptiveChunkingUsed).toBe(true);
    expect(result.metadata.chunkReductions).toBeGreaterThan(0);
    expect(result.warnings).toContain('rpc_log_range_too_dense');
    expect(result.warnings).toContain('chunk_reduced');
    expect(result.trades.length).toBeGreaterThan(0);

    const requests = requestMock.mock.calls.map((call) => call[0]);
    expect(requests.every((r) => r.method === 'eth_getLogs')).toBe(true);
    expect(requests.every((r) => Array.isArray(r.params?.[0]?.topics))).toBe(true);
    expect(requests.every((r) => r.params?.[0]?.topics?.[0] === V2_SWAP_TOPIC)).toBe(true);
    expect(requests.every((r) => JSON.stringify(r.params?.[0]?.topics) !== '[]')).toBe(true);
  });

  it('uses provider suggested range when present', async () => {
    requestMock
      .mockRejectedValueOnce(new Error('query exceeds max results, retry with the range 1000-1050'))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await scanPoolTrades({
      chain: 'base',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      poolAddress: '0x0000000000000000000000000000000000000010',
      parserType: 'uniswap_v2_compatible',
      fromBlock: 1000n,
      toBlock: 1100n,
      chunkSize: 200,
    });

    const requests = requestMock.mock.calls.map((call) => call[0]);
    expect(
      requests.some((r) => r.params?.[0]?.fromBlock === '0x3e8' && r.params?.[0]?.toBlock === '0x41a'),
    ).toBe(true);
    expect(requests.every((r) => r.params?.[0]?.topics?.[0] === V2_SWAP_TOPIC)).toBe(true);
    expect(requests.every((r) => JSON.stringify(r.params?.[0]?.topics) !== '[]')).toBe(true);
  });

  it('fails when minimum chunk size still fails', async () => {
    requestMock.mockRejectedValue(new Error('too many results'));

    await expect(
      scanPoolTrades({
        chain: 'base',
        tokenAddress: '0x0000000000000000000000000000000000000001',
        poolAddress: '0x0000000000000000000000000000000000000010',
        parserType: 'uniswap_v2_compatible',
        fromBlock: 1000n,
        toBlock: 1200n,
        chunkSize: 100,
      }),
    ).rejects.toThrow(/min_chunk_size_reached/);
  });

  it('uses raw eth_getLogs payload for v2 trade scanner context', async () => {
    requestMock.mockResolvedValueOnce([]);

    const result = await scanPoolTrades({
      chain: 'base',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      poolAddress: '0x0000000000000000000000000000000000000010',
      parserType: 'uniswap_v2_compatible',
      fromBlock: 1000n,
      toBlock: 1001n,
    });

    const req = requestMock.mock.calls[0]?.[0];
    expect(req.method).toBe('eth_getLogs');
    expect(req.params?.[0]?.topics).toEqual([V2_SWAP_TOPIC]);
    expect(req.params?.[0]?.topics).not.toEqual([]);
    expect(result.metadata.topicFilterUsed).toBe(true);
    expect(result.metadata.swapTopic).toBe(V2_SWAP_TOPIC);
    expect(result.metadata.getLogsContext).toBe('trade_scanner_v2');
    expect(result.metadata.getLogsMode).toBe('raw_rpc');
  });

  it('uses raw eth_getLogs payload for v3 trade scanner context', async () => {
    readContractMock.mockResolvedValueOnce('0x0000000000000000000000000000000000000001');
    readContractMock.mockResolvedValueOnce('0x0000000000000000000000000000000000000002');
    readContractMock.mockResolvedValueOnce('0x0000000000000000000000000000000000000001');
    readContractMock.mockResolvedValueOnce('0x0000000000000000000000000000000000000002');
    requestMock.mockResolvedValueOnce([]);

    await scanPoolTrades({
      chain: 'base',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      poolAddress: '0x0000000000000000000000000000000000000010',
      parserType: 'uniswap_v3_compatible',
      fromBlock: 1000n,
      toBlock: 1001n,
    });

    const req = requestMock.mock.calls[0]?.[0];
    expect(req.method).toBe('eth_getLogs');
    expect(req.params?.[0]?.topics).toEqual([V3_SWAP_TOPIC]);
    expect(req.params?.[0]?.topics).not.toEqual([]);
  });

  it('returns topic filter metadata for v2 and v3', async () => {
    requestMock.mockResolvedValue([]);

    const v2 = await scanPoolTrades({
      chain: 'base',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      poolAddress: '0x0000000000000000000000000000000000000010',
      parserType: 'uniswap_v2_compatible',
      fromBlock: 1000n,
      toBlock: 1001n,
    });
    expect(v2.metadata.topicFilterUsed).toBe(true);
    expect(v2.metadata.swapTopic).toBe(V2_SWAP_TOPIC);
    expect(v2.metadata.getLogsContext).toBe('trade_scanner_v2');
    expect(v2.metadata.getLogsMode).toBe('raw_rpc');

    readContractMock.mockReset();
    readContractMock.mockResolvedValueOnce('0x0000000000000000000000000000000000000001');
    readContractMock.mockResolvedValueOnce('0x0000000000000000000000000000000000000002');
    requestMock.mockResolvedValue([]);

    const v3 = await scanPoolTrades({
      chain: 'base',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      poolAddress: '0x0000000000000000000000000000000000000010',
      parserType: 'uniswap_v3_compatible',
      fromBlock: 1000n,
      toBlock: 1001n,
    });
    expect(v3.metadata.topicFilterUsed).toBe(true);
    expect(v3.metadata.swapTopic).toBe(V3_SWAP_TOPIC);
    expect(v3.metadata.getLogsContext).toBe('trade_scanner_v3');
    expect(v3.metadata.getLogsMode).toBe('raw_rpc');
  });

  it('formats non-dense getLogs errors with v2 context', async () => {
    requestMock.mockRejectedValueOnce(new Error('boom_v2'));

    await expect(
      scanPoolTrades({
        chain: 'base',
        tokenAddress: '0x0000000000000000000000000000000000000001',
        poolAddress: '0x0000000000000000000000000000000000000010',
        parserType: 'uniswap_v2_compatible',
        fromBlock: 1000n,
        toBlock: 1001n,
      }),
    ).rejects.toThrow(/getLogsContext:trade_scanner_v2/);
  });

  it('formats non-dense getLogs errors with v3 context', async () => {
    requestMock.mockRejectedValueOnce(new Error('boom_v3'));

    await expect(
      scanPoolTrades({
        chain: 'base',
        tokenAddress: '0x0000000000000000000000000000000000000001',
        poolAddress: '0x0000000000000000000000000000000000000010',
        parserType: 'uniswap_v3_compatible',
        fromBlock: 1000n,
        toBlock: 1001n,
      }),
    ).rejects.toThrow(/getLogsContext:trade_scanner_v3/);
  });
});
