import type { NormalizedWalletStats, WalletScoreResult } from '../chains/chain.types.js';

export function scoreWallet(input: NormalizedWalletStats): WalletScoreResult {
  let score = 40;
  const reasons: string[] = [];
  const riskFlags: string[] = [...input.suspiciousFlags];
  const totalRealizedPnlUsd = input.totalRealizedPnlUsd ?? 0;
  const winRate = input.winRate;
  const medianRoi = input.medianRoi;
  const medianHoldSeconds = input.medianHoldSeconds;

  if (input.totalTrades >= 25) {
    score += 15;
    reasons.push('adequate_sample_size');
  } else if (input.totalTrades < 8) {
    score -= 20;
    riskFlags.push('low_sample_size');
  }

  if (input.successfulEarlyEntryCount >= 5) {
    score += 20;
    reasons.push('repeated_early_success');
  }

  if (totalRealizedPnlUsd > 50_000) score += 20;
  else if (totalRealizedPnlUsd > 10_000) score += 10;

  if (winRate !== undefined && winRate >= 0.6) score += 15;
  else if (winRate !== undefined && winRate < 0.35) {
    score -= 15;
    riskFlags.push('low_winrate');
  }

  if (medianRoi !== undefined && medianRoi >= 1.8) score += 12;
  else if (medianRoi !== undefined && medianRoi < 1) {
    score -= 8;
    riskFlags.push('weak_median_roi');
  }

  if (medianHoldSeconds !== undefined && medianHoldSeconds >= 900 && medianHoldSeconds <= 86_400) score += 8;

  if (input.rugExposureCount >= 5) {
    score -= 25;
    riskFlags.push('high_rug_exposure');
  }

  if (input.suspiciousFlags.length > 0) score -= 20;
  score = Math.max(0, Math.min(100, score));

  let category: WalletScoreResult['category'] = 'rejected';
  if (riskFlags.some((f) => f.includes('insider') || f.includes('deployer'))) category = 'suspicious_insider';
  else if (score >= 80) category = 'copyable_smart_wallet';
  else if (score >= 65) category = input.earlyEntryCount > 6 ? 'early_accumulator' : 'narrative_scout';
  else if (score >= 50 && input.earlyEntryCount > 8 && input.successfulEarlyEntryCount < 4) category = 'sniper';

  return { score, category, reasons, riskFlags: Array.from(new Set(riskFlags)) };
}
