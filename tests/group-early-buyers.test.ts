import { describe, expect, it } from 'vitest';
import { groupEarlyBuyers } from '../src/discovery/group-early-buyers.js';
import type { NormalizedTrade } from '../src/chains/chain.types.js';

function buy(overrides: Partial<NormalizedTrade> = {}): NormalizedTrade {
  return {
    chain: 'base',
    chainFamily: 'evm',
    walletAddress: '0xwallet1',
    tokenAddress: '0xtoken',
    txHash: '0xtx1',
    side: 'buy',
    amountToken: 10,
    timestamp: new Date('2024-01-01T00:00:00Z'),
    blockNumber: 100,
    ...overrides,
  };
}

describe('groupEarlyBuyers', () => {
  it('handles multiple buys by same wallet', () => {
    const result = groupEarlyBuyers([
      buy({ amountToken: 10, txHash: '0x1', amountUsd: 5 }),
      buy({ amountToken: 20, txHash: '0x2', amountUsd: 7, blockNumber: 101 }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.buyCount).toBe(2);
    expect(result[0]?.totalBuyAmountToken).toBe(30);
    expect(result[0]?.approximateUsdSpent).toBe(12);
  });

  it('orders by first buy', () => {
    const result = groupEarlyBuyers([
      buy({ walletAddress: '0xb', blockNumber: 200, txHash: '0xbtx' }),
      buy({ walletAddress: '0xa', blockNumber: 100, txHash: '0xatx' }),
    ]);

    expect(result[0]?.walletAddress).toBe('0xa');
    expect(result[1]?.walletAddress).toBe('0xb');
  });

  it('applies maxBuyers limit', () => {
    const result = groupEarlyBuyers(
      [
        buy({ walletAddress: '0x1', blockNumber: 1 }),
        buy({ walletAddress: '0x2', blockNumber: 2 }),
        buy({ walletAddress: '0x3', blockNumber: 3 }),
      ],
      2,
    );

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.walletAddress)).toEqual(['0x1', '0x2']);
  });

  it('aggregates and deduplicates warnings', () => {
    const result = groupEarlyBuyers([
      buy({ raw: { warnings: ['buyer_inference_uncertain', 'foo'] } }),
      buy({ txHash: '0x2', blockNumber: 101, raw: { warnings: ['foo'] } }),
    ]);

    expect(result[0]?.warnings).toContain('buyer_inference_uncertain');
    expect(result[0]?.warnings.filter((w) => w === 'foo')).toHaveLength(1);
  });

  it('returns empty for empty input', () => {
    expect(groupEarlyBuyers([])).toEqual([]);
  });
});
