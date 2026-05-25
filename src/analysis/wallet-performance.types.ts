import type { NormalizedTrade, NormalizedWalletStats, SupportedChain, WalletScoreResult } from '../chains/chain.types.js';
import type { WalletTradeResultMetadata } from '../providers/interfaces.js';

export interface TokenWalletPerformance {
  chain: SupportedChain;
  walletAddress: string;
  tokenAddress: string;
  tokenSymbol?: string;
  firstBuyAt?: Date;
  firstBuyBlockNumber?: number;
  firstBuyTxHash?: string;
  firstSellAt?: Date;
  totalBoughtToken: number;
  totalSoldToken: number;
  remainingToken: number;
  totalBuyUsd?: number;
  totalSellUsd?: number;
  averageBuyPriceUsd?: number;
  averageSellPriceUsd?: number;
  realizedPnlUsd?: number;
  unrealizedPnlUsd?: number;
  totalPnlUsd?: number;
  roi?: number;
  holdDurationSeconds?: number;
  isOpenPosition: boolean;
  isWinner?: boolean;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  warnings: string[];
}

export interface WalletPerformanceSummary {
  chain: SupportedChain;
  walletAddress: string;
  analyzedTokenCount: number;
  closedPositionCount: number;
  openPositionCount: number;
  totalTrades: number;
  totalBuys: number;
  totalSells: number;
  totalRealizedPnlUsd?: number;
  totalUnrealizedPnlUsd?: number;
  totalPnlUsd?: number;
  winRate?: number;
  medianRoi?: number;
  averageRoi?: number;
  averageHoldSeconds?: number;
  medianHoldSeconds?: number;
  earlyEntryCount?: number;
  successfulEarlyEntryCount?: number;
  rugExposureCount?: number;
  warnings: string[];
  limitations: string[];
}

export interface WalletAnalysisResult {
  summary: WalletPerformanceSummary;
  tokenPerformances: TokenWalletPerformance[];
  scoreInput: NormalizedWalletStats;
  scoreResult: WalletScoreResult;
  providerMetadata: WalletTradeResultMetadata;
  warnings: string[];
  limitations: string[];
}

export interface CurrentTokenPriceInfo {
  priceUsd?: number;
  liquidityUsd?: number;
  marketCap?: number;
  symbol?: string;
  warnings: string[];
}

export type CurrentTokenPriceMap = Record<string, CurrentTokenPriceInfo>;

export interface WalletPerformanceComputationResult {
  summary: WalletPerformanceSummary;
  tokenPerformances: TokenWalletPerformance[];
  warnings: string[];
  limitations: string[];
  normalizedTrades: NormalizedTrade[];
}
