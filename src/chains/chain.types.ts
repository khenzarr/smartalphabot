export type SupportedChain = 'ethereum' | 'base' | 'bsc' | 'solana';
export type ChainFamily = 'evm' | 'solana';
export type TradeSide = 'buy' | 'sell';

export type WalletScoreCategory =
  | 'sniper'
  | 'early_accumulator'
  | 'narrative_scout'
  | 'copyable_smart_wallet'
  | 'suspicious_insider'
  | 'rejected';

export interface NormalizedTrade {
  chain: SupportedChain;
  chainFamily: ChainFamily;
  walletAddress: string;
  tokenAddress: string;
  txHash: string;
  side: TradeSide;
  amountToken: number;
  amountUsd?: number;
  priceUsd?: number;
  marketCapAtTrade?: number;
  liquidityAtTrade?: number;
  blockNumber?: number;
  slot?: number;
  timestamp: Date;
  dex?: string;
  raw?: unknown;
}

export interface NormalizedTokenProfile {
  chain: SupportedChain;
  chainFamily: ChainFamily;
  tokenAddress: string;
  symbol?: string;
  name?: string;
  pairAddress?: string;
  poolAddress?: string;
  dexId?: string;
  priceUsd?: number;
  marketCap?: number;
  fdv?: number;
  liquidityUsd?: number;
  pairCreatedAt?: Date;
  tokenAgeSeconds?: number;
  dexUrl?: string;
  warnings: string[];
  raw?: unknown;
}

export interface NormalizedWalletStats {
  chain: SupportedChain;
  walletAddress: string;
  totalTrades: number;
  totalRealizedPnlUsd?: number;
  totalUnrealizedPnlUsd?: number;
  winRate?: number;
  medianRoi?: number;
  averageHoldSeconds?: number;
  medianHoldSeconds?: number;
  earlyEntryCount: number;
  successfulEarlyEntryCount: number;
  rugExposureCount: number;
  suspiciousFlags: string[];
}

export interface WalletScoreResult {
  score: number;
  category: WalletScoreCategory;
  reasons: string[];
  riskFlags: string[];
}