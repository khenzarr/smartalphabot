import { encodeAbiParameters } from 'viem';
import { describe, expect, it } from 'vitest';
import { parseUniswapV2Swap, V2_SWAP_TOPIC } from '../src/providers/evm/parsers/uniswap-v2.parser.js';

function makeLog(
  amounts: { amount0In: bigint; amount1In: bigint; amount0Out: bigint; amount1Out: bigint } = {
    amount0In: 0n,
    amount1In: 1n,
    amount0Out: 100n,
    amount1Out: 0n,
  },
  overrides: Partial<Parameters<typeof parseUniswapV2Swap>[0]['log']> = {},
) {
  const sender = '0x00000000000000000000000000000000000000aa';
  const to = '0x00000000000000000000000000000000000000bb';
  const data = encodeAbiParameters(
    [
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint256' },
    ],
    [amounts.amount0In, amounts.amount1In, amounts.amount0Out, amounts.amount1Out],
  );

  return {
    address: '0x0000000000000000000000000000000000000001',
    blockNumber: 1n,
    logIndex: 0,
    transactionHash: '0xabc',
    topics: [
      V2_SWAP_TOPIC,
      `0x000000000000000000000000${sender.slice(2)}`,
      `0x000000000000000000000000${to.slice(2)}`,
    ],
    data,
    ...overrides,
  } as Parameters<typeof parseUniswapV2Swap>[0]['log'];
}

describe('parseUniswapV2Swap', () => {
  it('parses token0 buy', () => {
    const result = parseUniswapV2Swap({
      chain: 'base',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      token0: '0x0000000000000000000000000000000000000001',
      token1: '0x0000000000000000000000000000000000000002',
      log: makeLog(),
      timestamp: new Date('2024-01-01T00:00:00Z'),
    });

    expect(result.trade?.side).toBe('buy');
    expect(result.trade?.amountToken).toBe(100);
  });

  it('parses token1 buy', () => {
    const result = parseUniswapV2Swap({
      chain: 'base',
      tokenAddress: '0x0000000000000000000000000000000000000002',
      token0: '0x0000000000000000000000000000000000000001',
      token1: '0x0000000000000000000000000000000000000002',
      log: makeLog({ amount0In: 2n, amount1In: 0n, amount0Out: 0n, amount1Out: 250n }),
      timestamp: new Date('2024-01-01T00:00:00Z'),
    });

    expect(result.trade?.side).toBe('buy');
    expect(result.trade?.amountToken).toBe(250);
  });

  it('detects sell', () => {
    const result = parseUniswapV2Swap({
      chain: 'base',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      token0: '0x0000000000000000000000000000000000000001',
      token1: '0x0000000000000000000000000000000000000002',
      log: makeLog({ amount0In: 75n, amount1In: 0n, amount0Out: 0n, amount1Out: 0n }),
      timestamp: new Date('2024-01-01T00:00:00Z'),
    });

    expect(result.trade?.side).toBe('sell');
  });

  it('ignores unrelated logs', () => {
    const result = parseUniswapV2Swap({
      chain: 'base',
      tokenAddress: '0x0000000000000000000000000000000000000009',
      token0: '0x0000000000000000000000000000000000000001',
      token1: '0x0000000000000000000000000000000000000002',
      log: makeLog(),
      timestamp: new Date('2024-01-01T00:00:00Z'),
    });

    expect(result.trade).toBeUndefined();
    expect(result.warnings).toContain('token_not_in_pool');
    expect(V2_SWAP_TOPIC).toMatch(/^0x/);
  });
});