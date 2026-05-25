import { describe, expect, it } from 'vitest';
import { calculateWalletPerformance } from '../src/analysis/wallet-performance-calculator.js';
import type { NormalizedTrade } from '../src/chains/chain.types.js';

function t(partial: Partial<NormalizedTrade>): NormalizedTrade {
  return {
    chain: 'base',
    chainFamily: 'evm',
    walletAddress: '0x1111111111111111111111111111111111111111',
    tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    txHash: '0x1',
    side: 'buy',
    amountToken: 1,
    timestamp: new Date('2025-01-01T00:00:00.000Z'),
    ...partial,
  };
}

describe('calculateWalletPerformance', () => {
  it('handles profitable and losing closed positions', () => {
    const trades = [
      t({ tokenAddress: '0xaaa', txHash: '0x1', side: 'buy', amountToken: 100, amountUsd: 100 }),
      t({ tokenAddress: '0xaaa', txHash: '0x2', side: 'sell', amountToken: 100, amountUsd: 150 }),
      t({ tokenAddress: '0xbbb', txHash: '0x3', side: 'buy', amountToken: 100, amountUsd: 200 }),
      t({ tokenAddress: '0xbbb', txHash: '0x4', side: 'sell', amountToken: 100, amountUsd: 100 }),
    ];
    const result = calculateWalletPerformance({ chain: 'base', walletAddress: t({}).walletAddress, trades });
    expect(result.summary.totalRealizedPnlUsd).toBe(50 - 100);
    expect(result.summary.winRate).toBe(0.5);
  });

  it('supports partial sell + open position + deterministic medians', () => {
    const trades = [
      t({ tokenAddress: '0xccc', txHash: '0x1', side: 'buy', amountToken: 10, amountUsd: 100, timestamp: new Date('2025-01-01T00:00:00.000Z') }),
      t({ tokenAddress: '0xccc', txHash: '0x2', side: 'buy', amountToken: 10, amountUsd: 100, timestamp: new Date('2025-01-02T00:00:00.000Z') }),
      t({ tokenAddress: '0xccc', txHash: '0x3', side: 'sell', amountToken: 5, amountUsd: 80, timestamp: new Date('2025-01-03T00:00:00.000Z') }),
      t({ tokenAddress: '0xddd', txHash: '0x4', side: 'buy', amountToken: 10, amountUsd: 100, timestamp: new Date('2025-01-01T00:00:00.000Z') }),
      t({ tokenAddress: '0xddd', txHash: '0x5', side: 'sell', amountToken: 20, amountUsd: 100, timestamp: new Date('2025-01-04T00:00:00.000Z') }),
    ];
    const result = calculateWalletPerformance({
      chain: 'base',
      walletAddress: t({}).walletAddress,
      trades,
      now: new Date('2025-01-05T00:00:00.000Z'),
      currentPrices: { '0xccc': { priceUsd: 20, warnings: [] } },
    });
    const ccc = result.tokenPerformances.find((x) => x.tokenAddress === '0xccc');
    expect(ccc?.isOpenPosition).toBe(true);
    expect(ccc?.unrealizedPnlUsd).toBeDefined();
    expect(result.warnings.some((w) => w.includes('sell_exceeds_buy'))).toBe(true);
    expect(result.summary.medianHoldSeconds).toBeDefined();
  });

  it('warns on missing USD data', () => {
    const trades = [
      t({ tokenAddress: '0xeee', txHash: '0x1', side: 'buy', amountToken: 10 }),
      t({ tokenAddress: '0xeee', txHash: '0x2', side: 'sell', amountToken: 10 }),
    ];
    const result = calculateWalletPerformance({ chain: 'base', walletAddress: t({}).walletAddress, trades });
    expect(result.warnings.some((w) => w.includes('missing_usd_trade_data'))).toBe(true);
  });
});
