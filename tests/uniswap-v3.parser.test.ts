import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from 'viem';
import { describe, expect, it } from 'vitest';
import { parseUniswapV3Swap, V3_SWAP_TOPIC } from '../src/providers/evm/parsers/uniswap-v3.parser.js';

const swapAbi = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
);

function makeLog(
  amounts: { amount0: bigint; amount1: bigint } = { amount0: -100n, amount1: 1n },
  overrides: Partial<Parameters<typeof parseUniswapV3Swap>[0]['log']> = {},
) {
  const sender = '0x00000000000000000000000000000000000000aa';
  const recipient = '0x00000000000000000000000000000000000000bb';
  const topics = encodeEventTopics({
    abi: [swapAbi],
    eventName: 'Swap',
    args: { sender, recipient },
  }) as [`0x${string}`, `0x${string}`, `0x${string}`];

  const data = encodeAbiParameters(
    [
      { type: 'int256' },
      { type: 'int256' },
      { type: 'uint160' },
      { type: 'uint128' },
      { type: 'int24' },
    ],
    [amounts.amount0, amounts.amount1, 0n, 0n, 0],
  );

  return {
    address: '0x0000000000000000000000000000000000000001',
    blockNumber: 1n,
    logIndex: 0,
    transactionHash: '0xv3',
    topics,
    data,
    ...overrides,
  } as Parameters<typeof parseUniswapV3Swap>[0]['log'];
}

describe('parseUniswapV3Swap', () => {
  it('parses token0 buy', () => {
    const result = parseUniswapV3Swap({
      chain: 'base',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      token0: '0x0000000000000000000000000000000000000001',
      token1: '0x0000000000000000000000000000000000000002',
      log: makeLog({ amount0: -123n, amount1: 4n }),
      timestamp: new Date('2024-01-01T00:00:00Z'),
    });

    expect(result.trade?.side).toBe('buy');
    expect(result.trade?.amountToken).toBe(123);
  });

  it('parses token1 buy', () => {
    const result = parseUniswapV3Swap({
      chain: 'base',
      tokenAddress: '0x0000000000000000000000000000000000000002',
      token0: '0x0000000000000000000000000000000000000001',
      token1: '0x0000000000000000000000000000000000000002',
      log: makeLog({ amount0: 10n, amount1: -456n }),
      timestamp: new Date('2024-01-01T00:00:00Z'),
    });

    expect(result.trade?.side).toBe('buy');
    expect(result.trade?.amountToken).toBe(456);
  });

  it('detects sell', () => {
    const result = parseUniswapV3Swap({
      chain: 'base',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      token0: '0x0000000000000000000000000000000000000001',
      token1: '0x0000000000000000000000000000000000000002',
      log: makeLog({ amount0: 99n, amount1: -1n }),
      timestamp: new Date('2024-01-01T00:00:00Z'),
    });

    expect(result.trade?.side).toBe('sell');
  });

  it('ignores unrelated logs', () => {
    const result = parseUniswapV3Swap({
      chain: 'base',
      tokenAddress: '0x0000000000000000000000000000000000000009',
      token0: '0x0000000000000000000000000000000000000001',
      token1: '0x0000000000000000000000000000000000000002',
      log: makeLog(),
      timestamp: new Date('2024-01-01T00:00:00Z'),
    });

    expect(result.trade).toBeUndefined();
    expect(result.warnings).toContain('token_not_in_pool');
    expect(V3_SWAP_TOPIC).toMatch(/^0x/);
  });
});
