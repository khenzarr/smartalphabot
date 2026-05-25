import { describe, expect, it } from 'vitest';
import { scoreWallet } from '../src/analysis/wallet-scoring.js';

describe('scoreWallet', () => {
  it('classifies strong wallet as copyable_smart_wallet', () => {
    const result = scoreWallet({
      chain: 'base',
      walletAddress: '0xabc',
      totalTrades: 80,
      totalRealizedPnlUsd: 120000,
      totalUnrealizedPnlUsd: 12000,
      winRate: 0.72,
      medianRoi: 2.1,
      averageHoldSeconds: 8600,
      medianHoldSeconds: 7200,
      earlyEntryCount: 12,
      successfulEarlyEntryCount: 8,
      rugExposureCount: 0,
      suspiciousFlags: [],
    });

    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.category).toBe('copyable_smart_wallet');
  });

  it('flags suspicious insider', () => {
    const result = scoreWallet({
      chain: 'ethereum',
      walletAddress: '0xdef',
      totalTrades: 30,
      totalRealizedPnlUsd: 70000,
      totalUnrealizedPnlUsd: 0,
      winRate: 0.66,
      medianRoi: 1.9,
      averageHoldSeconds: 1200,
      medianHoldSeconds: 1200,
      earlyEntryCount: 7,
      successfulEarlyEntryCount: 6,
      rugExposureCount: 1,
      suspiciousFlags: ['insider_pattern'],
    });

    expect(result.category).toBe('suspicious_insider');
    expect(result.riskFlags).toContain('insider_pattern');
  });
});
