import { describe, expect, it } from 'vitest';
import { aggregateCandidateWallets } from '../src/discovery/aggregate-candidate-wallets.js';

function buyer(walletAddress: string, rank: number, opts?: Partial<{ warnings: string[]; buyCount: number; amount: number; usd: number }>) {
  return {
    walletAddress,
    firstBuyTxHash: `0xtx${rank}`,
    firstBuyBlockNumber: 100 + rank,
    firstBuyTimestamp: new Date(`2024-01-01T00:0${rank}:00.000Z`),
    firstBuyAmountToken: 10,
    totalBuyAmountToken: opts?.amount ?? 10,
    buyCount: opts?.buyCount ?? 1,
    approximateUsdSpent: opts?.usd,
    warnings: opts?.warnings ?? [],
  };
}

function tokenResult(tokenAddress: string, earliestBuyers: ReturnType<typeof buyer>[]) {
  return {
    chain: 'base' as const,
    tokenAddress,
    tokenProfile: { symbol: 'TKN' },
    earliestBuyers,
    warnings: [],
  };
}

describe('aggregateCandidateWallets', () => {
  it('ranks repeated wallet higher and filters single appearance by default', () => {
    const result = aggregateCandidateWallets({
      tokenResults: [
        { seed: { chain: 'base', tokenAddress: '0x1111111111111111111111111111111111111111', label: 'A' }, result: tokenResult('0x1111111111111111111111111111111111111111', [buyer('0xaaa', 1), buyer('0xbbb', 2)]) as never },
        { seed: { chain: 'base', tokenAddress: '0x2222222222222222222222222222222222222222', label: 'B' }, result: tokenResult('0x2222222222222222222222222222222222222222', [buyer('0xaaa', 1), buyer('0xccc', 2)]) as never },
      ],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.walletAddress).toBe('0xaaa');
    expect(result[0]?.tokenAppearances).toBe(2);
  });

  it('computes average, median and best rank deterministically', () => {
    const result = aggregateCandidateWallets({
      tokenResults: [
        { seed: { chain: 'base', tokenAddress: '0x1111111111111111111111111111111111111111' }, result: tokenResult('0x1111111111111111111111111111111111111111', [buyer('0xaaa', 1), buyer('0xbbb', 2)]) as never },
        { seed: { chain: 'base', tokenAddress: '0x2222222222222222222222222222222222222222' }, result: tokenResult('0x2222222222222222222222222222222222222222', [buyer('0xbbb', 1), buyer('0xaaa', 2)]) as never },
      ],
      minTokenAppearances: 2,
    });

    const a = result.find((x) => x.walletAddress === '0xaaa');
    expect(a?.averageFirstBuyRank).toBe(1.5);
    expect(a?.medianFirstBuyRank).toBe(1.5);
    expect(a?.bestFirstBuyRank).toBe(1);
  });

  it('aggregates warning count and keeps deterministic tie-break', () => {
    const result = aggregateCandidateWallets({
      tokenResults: [
        { seed: { chain: 'base', tokenAddress: '0x1111111111111111111111111111111111111111' }, result: tokenResult('0x1111111111111111111111111111111111111111', [buyer('0xaaa', 1, { warnings: ['x'] }), buyer('0xbbb', 1, { warnings: ['y', 'y'] })]) as never },
        { seed: { chain: 'base', tokenAddress: '0x2222222222222222222222222222222222222222' }, result: tokenResult('0x2222222222222222222222222222222222222222', [buyer('0xaaa', 1, { warnings: ['x'] }), buyer('0xbbb', 1)]) as never },
      ],
      minTokenAppearances: 2,
    });

    expect(result[0]?.walletAddress).toBe('0xaaa');
    expect(result[0]?.warningCount).toBe(1);
  });
});
