import type { SupportedChain } from '../chains/chain.types.js';
import { scoreWallet } from '../analysis/wallet-scoring.js';
import type { ExtractEarlyBuyersResult } from './extract-early-buyers.js';
import type { SeedTokenInput } from './seed-token-input.js';

export interface CandidateEvidenceItem {
  tokenAddress: string;
  tokenSymbol?: string;
  tokenLabel?: string;
  narrative?: string;
  firstBuyRank: number;
  firstBuyBlockNumber?: number;
  firstBuyTimestamp: Date;
  buyCount: number;
  firstBuyTxHash: string;
  warnings: string[];
}

export interface CandidateWallet {
  rank: number;
  walletAddress: string;
  chain: SupportedChain;
  tokenAppearances: number;
  labelsOrTokensAppearedIn: string[];
  firstSeenAt: Date;
  earliestObservedBuyAt: Date;
  averageFirstBuyRank: number;
  medianFirstBuyRank: number;
  bestFirstBuyRank: number;
  totalBuyCountAcrossSeeds: number;
  totalTokenAmountBoughtAcrossSeeds: number;
  approximateUsdSpentAcrossSeeds?: number;
  narratives: string[];
  warnings: string[];
  warningCount: number;
  scoreInput: Record<string, unknown>;
  scoreResult: ReturnType<typeof scoreWallet>;
  evidence: CandidateEvidenceItem[];
  walletEnrichment?: {
    source: string;
    analyzedTradeCount: number;
    analyzedTokenCount: number;
    approximateTotalPnlUsd?: number;
    totalRealizedPnlUsd?: number;
    totalUnrealizedPnlUsd?: number;
    winRate?: number;
    medianRoi?: number;
    averageHoldSeconds?: number;
    score?: number;
    category?: string;
    warnings: string[];
    limitations: string[];
  };
}

export interface AggregateInputItem {
  seed: SeedTokenInput;
  result: ExtractEarlyBuyersResult;
}

export function aggregateCandidateWallets(input: {
  tokenResults: AggregateInputItem[];
  minTokenAppearances?: number;
}): CandidateWallet[] {
  const minTokenAppearances = input.minTokenAppearances ?? 2;
  const groups = new Map<string, CandidateWallet>();

  for (const item of input.tokenResults) {
    const seed = item.seed;
    const result = item.result;

    const tokenLabel = seed.label ?? result.tokenProfile?.symbol ?? result.tokenAddress;
    const tokenSymbol = result.tokenProfile?.symbol;

    for (let i = 0; i < result.earliestBuyers.length; i += 1) {
      const buyer = result.earliestBuyers[i];
      const key = `${result.chain}:${buyer.walletAddress.toLowerCase()}`;
      const current = groups.get(key);
      const firstBuyRank = i + 1;

      const evidenceItem: CandidateEvidenceItem = {
        tokenAddress: result.tokenAddress,
        tokenSymbol,
        tokenLabel,
        narrative: seed.narrative,
        firstBuyRank,
        firstBuyBlockNumber: buyer.firstBuyBlockNumber,
        firstBuyTimestamp: buyer.firstBuyTimestamp,
        buyCount: buyer.buyCount,
        firstBuyTxHash: buyer.firstBuyTxHash,
        warnings: buyer.warnings,
      };

      if (!current) {
        groups.set(key, {
          rank: 0,
          walletAddress: buyer.walletAddress,
          chain: result.chain,
          tokenAppearances: 1,
          labelsOrTokensAppearedIn: [tokenLabel],
          firstSeenAt: buyer.firstBuyTimestamp,
          earliestObservedBuyAt: buyer.firstBuyTimestamp,
          averageFirstBuyRank: firstBuyRank,
          medianFirstBuyRank: firstBuyRank,
          bestFirstBuyRank: firstBuyRank,
          totalBuyCountAcrossSeeds: buyer.buyCount,
          totalTokenAmountBoughtAcrossSeeds: buyer.totalBuyAmountToken,
          approximateUsdSpentAcrossSeeds: buyer.approximateUsdSpent,
          narratives: seed.narrative ? [seed.narrative] : [],
          warnings: [...buyer.warnings],
          warningCount: buyer.warnings.length,
          scoreInput: {},
          scoreResult: { score: 0, category: 'rejected', reasons: [], riskFlags: [] },
          evidence: [evidenceItem],
        });
        continue;
      }

      current.tokenAppearances += 1;
      if (!current.labelsOrTokensAppearedIn.includes(tokenLabel)) current.labelsOrTokensAppearedIn.push(tokenLabel);
      if (seed.narrative && !current.narratives.includes(seed.narrative)) current.narratives.push(seed.narrative);
      current.firstSeenAt = new Date(Math.min(current.firstSeenAt.getTime(), buyer.firstBuyTimestamp.getTime()));
      current.earliestObservedBuyAt = new Date(
        Math.min(current.earliestObservedBuyAt.getTime(), buyer.firstBuyTimestamp.getTime()),
      );
      current.totalBuyCountAcrossSeeds += buyer.buyCount;
      current.totalTokenAmountBoughtAcrossSeeds += buyer.totalBuyAmountToken;
      if (buyer.approximateUsdSpent !== undefined) {
        current.approximateUsdSpentAcrossSeeds = (current.approximateUsdSpentAcrossSeeds ?? 0) + buyer.approximateUsdSpent;
      }
      current.warnings.push(...buyer.warnings);
      current.evidence.push(evidenceItem);
    }
  }

  const candidates = [...groups.values()]
    .map((candidate) => {
      candidate.warnings = [...new Set(candidate.warnings)];
      candidate.warningCount = candidate.warnings.length;

      const ranks = candidate.evidence.map((x) => x.firstBuyRank).sort((a, b) => a - b);
      candidate.bestFirstBuyRank = ranks[0] ?? Number.MAX_SAFE_INTEGER;
      candidate.averageFirstBuyRank = ranks.length ? Number((ranks.reduce((a, b) => a + b, 0) / ranks.length).toFixed(4)) : 0;
      candidate.medianFirstBuyRank = ranks.length
        ? ranks.length % 2 === 1
          ? ranks[(ranks.length - 1) / 2]!
          : (ranks[ranks.length / 2 - 1]! + ranks[ranks.length / 2]!) / 2
        : 0;

      const scoreInput = {
        chain: candidate.chain,
        walletAddress: candidate.walletAddress,
        totalTrades: candidate.totalBuyCountAcrossSeeds,
        totalRealizedPnlUsd: undefined,
        totalUnrealizedPnlUsd: undefined,
        winRate: undefined,
        medianRoi: undefined,
        averageHoldSeconds: undefined,
        medianHoldSeconds: undefined,
        earlyEntryCount: candidate.tokenAppearances,
        successfulEarlyEntryCount: candidate.tokenAppearances,
        rugExposureCount: 0,
        suspiciousFlags: candidate.warnings.filter((w) => w.includes('insider') || w.includes('deployer')),
      };

      const scoreResult = scoreWallet(scoreInput);
      scoreResult.reasons = [...scoreResult.reasons, 'seed_batch_early_entry_evidence_only_not_realized_pnl'];

      candidate.scoreInput = scoreInput;
      candidate.scoreResult = scoreResult;
      return candidate;
    })
    .filter((x) => x.tokenAppearances >= minTokenAppearances)
    .sort((a, b) => {
      if (b.tokenAppearances !== a.tokenAppearances) return b.tokenAppearances - a.tokenAppearances;
      if (a.averageFirstBuyRank !== b.averageFirstBuyRank) return a.averageFirstBuyRank - b.averageFirstBuyRank;
      if (a.medianFirstBuyRank !== b.medianFirstBuyRank) return a.medianFirstBuyRank - b.medianFirstBuyRank;
      if (b.scoreResult.score !== a.scoreResult.score) return b.scoreResult.score - a.scoreResult.score;
      if (a.warningCount !== b.warningCount) return a.warningCount - b.warningCount;
      return a.walletAddress.localeCompare(b.walletAddress);
    })
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));

  return candidates;
}
