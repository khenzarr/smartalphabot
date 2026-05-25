import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/providers/internal/persisted-trade.provider.js', () => ({
  getPersistedWalletTrades: vi.fn(async () => ({
    trades: [],
    metadata: { source: 'persisted', chain: 'base', walletAddress: '0x1111111111111111111111111111111111111111', tradesReturned: 0, warnings: [] },
  })),
}));

vi.mock('../src/analysis/enrich-current-token-prices.js', () => ({
  enrichCurrentTokenPrices: vi.fn(async () => ({ prices: {}, warnings: [] })),
}));

import { analyzeWallet } from '../src/analysis/wallet-analyzer.js';

describe('analyzeWallet', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns clear unsupported message for solana', async () => {
    const result = await analyzeWallet({
      chain: 'solana',
      walletAddress: '8fj6w8n9Y46fYfXKcP6W4YB8x1k5bQkBf3k8V9x2yM1L',
      source: 'persisted',
    });
    expect(result.warnings).toContain('Solana wallet historical analysis is not implemented yet.');
  });

  it('works with mock provider happy path', async () => {
    const result = await analyzeWallet({
      chain: 'base',
      walletAddress: '0x1111111111111111111111111111111111111111',
      source: 'mock',
      enrichPrices: false,
    });
    expect(result.summary.totalTrades).toBeGreaterThan(0);
    expect(typeof result.scoreResult.score).toBe('number');
  });

  it('does not crash on empty persisted result', async () => {
    const result = await analyzeWallet({
      chain: 'base',
      walletAddress: '0x1111111111111111111111111111111111111111',
      source: 'persisted',
      enrichPrices: false,
    });
    expect(result.summary.totalTrades).toBe(0);
    expect(result.tokenPerformances).toHaveLength(0);
  });
});
