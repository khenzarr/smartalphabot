import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyEvmPool } from '../src/providers/evm/evm-dex-classifier.js';
import { V2_SWAP_TOPIC } from '../src/providers/evm/parsers/uniswap-v2.parser.js';
import { V3_SWAP_TOPIC } from '../src/providers/evm/parsers/uniswap-v3.parser.js';

const mockClient: {
  readContract: ReturnType<typeof vi.fn>;
  getBlockNumber: ReturnType<typeof vi.fn>;
  getLogs: ReturnType<typeof vi.fn>;
  getBytecode: ReturnType<typeof vi.fn>;
} = {
  readContract: vi.fn(),
  getBlockNumber: vi.fn(),
  getLogs: vi.fn(),
  getBytecode: vi.fn(),
};

vi.mock('../src/providers/evm/evm-rpc.client.js', () => ({
  getEvmPublicClient: vi.fn(() => mockClient),
}));

describe('classifyEvmPool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.getBlockNumber.mockResolvedValue(1000n);
    mockClient.getBytecode.mockResolvedValue('0x1234');
  });

  function mockReadContractByMethods(methods: Partial<Record<string, unknown>>) {
    mockClient.readContract.mockImplementation(({ functionName }: { functionName: string }) => {
      if (functionName in methods) return Promise.resolve(methods[functionName]);
      return Promise.reject(new Error(`missing method: ${functionName}`));
    });
  }

  it('returns unsupported fallback', async () => {
    mockClient.readContract.mockRejectedValue(new Error('no abi'));
    mockClient.getLogs.mockResolvedValue([]);

    const result = await classifyEvmPool({
      chain: 'base',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      poolAddress: '0x0000000000000000000000000000000000000002',
    });

    expect(result.parserType).toBe('unsupported');
    expect(result.reason).toBe('no_supported_swap_signature_detected');
  });

  it('classifies v2 from ABI methods when swap logs are empty', async () => {
    mockReadContractByMethods({
      token0: '0x0000000000000000000000000000000000000001',
      token1: '0x0000000000000000000000000000000000000002',
      factory: '0x0000000000000000000000000000000000000003',
      getReserves: [1n, 2n, 3],
    });
    mockClient.getLogs.mockResolvedValue([]);

    const result = await classifyEvmPool({
      chain: 'base',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      poolAddress: '0x0000000000000000000000000000000000000002',
    });

    expect(result.parserType).toBe('uniswap_v2_compatible');
    expect(result.reason).toBe('abi_methods_detected_uniswap_v2');
    expect(result.warnings).toContain('classification_based_on_abi_methods');
    expect(result.warnings).toContain('swap_log_probe_empty');
    expect(mockClient.getLogs.mock.calls[0]?.[0]?.topics).toEqual([[V2_SWAP_TOPIC]]);
    expect(mockClient.getLogs.mock.calls[1]?.[0]?.topics).toEqual([[V3_SWAP_TOPIC]]);
  });

  it('classifies v3 from ABI methods when swap logs are empty', async () => {
    mockReadContractByMethods({
      token0: '0x0000000000000000000000000000000000000001',
      token1: '0x0000000000000000000000000000000000000002',
      factory: '0x0000000000000000000000000000000000000003',
      liquidity: 1000n,
      slot0: [1n, 0, 0, 0, 0, 0, true],
    });
    mockClient.getLogs.mockResolvedValue([]);

    const result = await classifyEvmPool({
      chain: 'base',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      poolAddress: '0x0000000000000000000000000000000000000002',
    });

    expect(result.parserType).toBe('uniswap_v3_compatible');
    expect(result.reason).toBe('abi_methods_detected_uniswap_v3');
    expect(result.warnings).toContain('classification_based_on_abi_methods');
    expect(result.warnings).toContain('swap_log_probe_empty');
  });

  it('keeps ABI-based classification when diagnostics/probe getLogs fail and includes context warnings', async () => {
    mockReadContractByMethods({
      token0: '0x0000000000000000000000000000000000000001',
      token1: '0x0000000000000000000000000000000000000002',
      factory: '0x0000000000000000000000000000000000000003',
      getReserves: [1n, 2n, 3],
    });
    mockClient.getLogs.mockRejectedValue(new Error('rpc timeout'));

    const result = await classifyEvmPool({
      chain: 'base',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      poolAddress: '0x0000000000000000000000000000000000000002',
    });

    expect(result.parserType).toBe('uniswap_v2_compatible');
    expect(result.reason).toBe('abi_methods_detected_uniswap_v2');
    expect(result.warnings.some((x) => x.includes('diagnostic_log_probe_failed'))).toBe(true);
    expect(result.warnings.some((x) => x.includes('getLogsContext:classifier_v2_probe'))).toBe(true);
    expect(result.warnings.some((x) => x.includes('getLogsContext:pool_diagnostics_recent_logs'))).toBe(true);
  });

  it('classifies v2 when abi and topic match', async () => {
    mockReadContractByMethods({
      token0: '0x0000000000000000000000000000000000000001',
      token1: '0x0000000000000000000000000000000000000002',
      factory: '0x0000000000000000000000000000000000000003',
      getReserves: [1n, 2n, 3],
    });
    mockClient.getLogs
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ topics: [V2_SWAP_TOPIC] }]);

    const result = await classifyEvmPool({
      chain: 'base',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      poolAddress: '0x0000000000000000000000000000000000000002',
      dexId: 'uniswap',
    });

    expect(result.parserType).toBe('uniswap_v2_compatible');
    expect(result.reason).toBe('v2_abi_and_logs_confirmed');
  });

  it('classifies v3 when v2 logs absent and v3 topic present', async () => {
    mockReadContractByMethods({
      token0: '0x0000000000000000000000000000000000000001',
      token1: '0x0000000000000000000000000000000000000002',
      factory: '0x0000000000000000000000000000000000000003',
      liquidity: 1000n,
      slot0: [1n, 0, 0, 0, 0, 0, true],
    });
    mockClient.getLogs
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ topics: [V3_SWAP_TOPIC] }]);

    const result = await classifyEvmPool({
      chain: 'base',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      poolAddress: '0x0000000000000000000000000000000000000002',
    });

    expect(result.parserType).toBe('uniswap_v3_compatible');
    expect(result.reason).toBe('v3_abi_and_logs_confirmed');
  });
});
