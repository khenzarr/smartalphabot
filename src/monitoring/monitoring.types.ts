import type { SupportedChain } from '../chains/chain.types.js';

export type EvmSupportedChain = Extract<SupportedChain, 'ethereum' | 'base' | 'bsc'>;

export type MonitorActivityProviderMode = 'auto' | 'rpc-addressless' | 'rpc-wallet-activity' | 'rpc-known-tokens' | 'explorer' | 'auto-indexer';

export type ExplorerProviderMode = 'auto' | 'blockscout' | 'etherscan';

export interface MonitorKnownToken {
  chain: EvmSupportedChain;
  tokenAddress: string;
  symbol?: string;
}

export interface MonitorWalletRecord {
  chain: SupportedChain;
  walletAddress: string;
  score: number;
  category: string;
  tokenAppearances: number;
  tokensAppearedIn: string[];
  narratives: string[];
  averageFirstBuyRank: number;
  bestFirstBuyRank: number;
  monitorRecommendation: string;
  reasons: string[];
  riskFlags: string[];
  source: 'candidate_shortlist';
  importedAt: string;
  enabled: boolean;
  tags: string[];
}

export interface MonitorWalletImportMeta {
  input: string;
  out: string;
  importedAt: string;
  importedCount: number;
  dedupedCount: number;
  filters: {
    minAppearances: number;
    minScore: number;
    includeRejected: boolean;
  };
}

export interface RecentWalletTokenEvent {
  chain: EvmSupportedChain;
  walletAddress: string;
  tokenAddress: string;
  from: string;
  to: string;
  rawAmount: string;
  txHash: string;
  blockNumber: number;
  logIndex: number;
  observedAt: string;
  warnings: string[];
  walletScore?: number;
  source?: 'rpc-addressless' | 'rpc-wallet-activity' | 'rpc-known-tokens' | 'explorer';
  explorerProvider?: Exclude<ExplorerProviderMode, 'auto'>;
}

export interface DiscoveredTokenCandidate {
  chain: EvmSupportedChain;
  tokenAddress: string;
  firstSeenAt: string;
  walletsSeen: string[];
  txCount: number;
  source: 'rpc-wallet-activity' | 'rpc-addressless' | 'explorer' | 'rpc-known-tokens';
  riskFlags: string[];
  suggestedAction: 'review' | 'merge_known_tokens';
}

export type LikelyActivityType =
  | 'likely_buy'
  | 'mixed_activity'
  | 'transfer'
  | 'airdrop_or_claim'
  | 'contract_interaction'
  | 'unknown';

export type TransactionContextConfidence = 'high' | 'medium' | 'low';

export interface TransactionContext {
  txHash: string;
  chain: EvmSupportedChain;
  txFrom?: string;
  txTo?: string;
  methodSelector?: string;
  receiptStatus?: 'success' | 'reverted' | 'unknown';
  logCount: number;
  involvedAddresses: string[];
  matchedTokenTransfer: boolean;
  likelyActivityType: LikelyActivityType;
  confidence: TransactionContextConfidence;
  reasons: string[];
  warnings: string[];
  knownRouterSeen: boolean;
}

export interface WalletActivityErrorInfo {
  code:
    | 'addressless_logs_not_supported'
    | 'wallet_scan_failed'
    | 'invalid_payload'
    | 'invalid_hex_payload'
    | 'invalid_rpc_quantity_hex'
    | 'getlogs_range_too_wide'
    | 'rpc_timeout'
    | 'provider_rejection'
    | 'not_implemented'
    | 'explorer_unavailable'
    | 'explorer_rate_limited'
    | 'explorer_unsupported_chain'
    | 'explorer_parse_error'
    | 'etherscan_api_key_missing';
  message: string;
  chain?: EvmSupportedChain;
  walletAddress?: string;
}

export type WalletScanFailureErrorKind =
  | 'wallet_scan_failed'
  | 'invalid_payload'
  | 'invalid_hex_payload'
  | 'invalid_rpc_quantity_hex'
  | 'getlogs_range_too_wide'
  | 'rpc_timeout'
  | 'provider_rejection'
  | 'addressless_logs_not_supported'
  | 'explorer_unavailable'
  | 'explorer_rate_limited'
  | 'explorer_unsupported_chain'
  | 'explorer_parse_error'
  | 'etherscan_api_key_missing';

export interface WalletScanFailureDetail {
  chain: EvmSupportedChain;
  walletAddress: string;
  tokenAddress?: string;
  tokenSymbol?: string;
  providerMode: MonitorActivityProviderMode;
  errorKind: WalletScanFailureErrorKind;
  shortMessage: string;
  rawMessage: string;
  requestPayload?: Record<string, unknown>;
  blockRange?: {
    fromBlock: string;
    toBlock: string;
  };
  chunkFromBlock?: string;
  chunkToBlock?: string;
  getLogsAddressUsed?: string;
  transferTopicUsed?: string | null;
  toTopicUsed?: string | null;
}

export interface WalletActivityScanStats {
  chainsScanned: EvmSupportedChain[];
  walletsScanned: number;
  walletScanFailures: number;
  addresslessLogsSupported: 'true' | 'false' | 'unknown';
  warnings: string[];
  walletScanFailureDetailsCount: number;
  failureKinds: Partial<Record<WalletScanFailureErrorKind, number>>;
  failuresByChain: Partial<Record<EvmSupportedChain, number>>;
  failuresByProviderMode: Partial<Record<MonitorActivityProviderMode, number>>;
  knownTokensByChain: Partial<Record<EvmSupportedChain, number>>;
  scannedWalletsByChain: Partial<Record<EvmSupportedChain, number>>;
  scannedTokenWalletPairs: number;
  successfulTokenWalletPairs: number;
  failedTokenWalletPairs: number;
  tokenWalletPairsPartiallyFailed: number;
  getLogsMaxBlockRange?: number;
  getLogsChunksRequested?: number;
  getLogsChunksSucceeded?: number;
  getLogsChunksFailed?: number;
  walletsWithNoActivity: number;
  walletsWithActivity: number;
  walletsWithFailures: number;
  explorerRequests?: number;
  explorerTransfersFetched?: number;
  explorerFailures?: number;
  explorerFailuresByChain?: Partial<Record<EvmSupportedChain, number>>;
  explorerWarnings?: string[];
  providerFallbackUsed?: boolean;
  walletActivityEventsFound?: number;
  walletActivityUniqueTokens?: number;
  walletActivityTokensByChain?: Partial<Record<EvmSupportedChain, number>>;
  walletActivityFallbackUsed?: boolean;
  walletActivityDroppedStable?: number;
  walletActivityDroppedSpam?: number;
  walletActivityDroppedOverLimit?: number;
  walletActivityProviderWarnings?: string[];
  providerAttemptOrder?: Array<'rpc-wallet-activity' | 'explorer' | 'rpc-known-tokens'>;
  providerAttempts?: Partial<Record<'rpc-wallet-activity' | 'explorer' | 'rpc-known-tokens', 'attempted' | 'used' | 'fallback' | 'skipped'>>;
  rpcWalletActivityAttempted?: boolean;
  rpcWalletActivitySupported?: boolean;
  rpcWalletActivityFallbackReason?: string;
  addresslessProbeAttempted?: boolean;
  addresslessProbeResult?: 'supported' | 'unsupported' | 'unknown';
  addresslessProbeErrorKind?: WalletScanFailureErrorKind | 'none';
}

export interface EnrichedTokenEvent extends RecentWalletTokenEvent {
  symbol?: string;
  name?: string;
  priceUsd?: number;
  marketCap?: number;
  fdv?: number;
  liquidityUsd?: number;
  volumeH24?: number;
  priceChangeH24?: number;
  pairCreatedAt?: string;
  tokenAgeSeconds?: number;
  dexUrl?: string;
  transactionContext?: TransactionContext;
}

export type MonitorSignalCategory = 'strong_signal' | 'watch_signal' | 'weak_signal' | 'ignored';

export interface MonitorSignal {
  chain: EvmSupportedChain;
  tokenSymbol?: string;
  tokenName?: string;
  tokenAddress: string;
  symbol?: string;
  name?: string;
  marketCapUsd?: number;
  tokenAge?: number;
  priceUsd?: number;
  smartWalletCount?: number;
  watchedWalletCount: number;
  watchedWallets: string[];
  walletScores?: number[];
  watchedWalletScoreMax?: number;
  watchedWalletScoreAvg?: number;
  watchedWalletCategories?: string[];
  topWallets?: Array<{ walletAddress: string; score: number; category?: string }>;
  firstSeenAt: string;
  latestSeenAt: string;
  txCount: number;
  uniqueTxCount: number;
  marketCap?: number;
  liquidityUsd?: number;
  tokenAgeSeconds?: number;
  totalAmountNative?: number;
  totalAmountUsd?: number;
  warnings: string[];
  score: number;
  category: MonitorSignalCategory;
  reasons: string[];
  positiveReasons: string[];
  negativeReasons: string[];
  promotionBlockers: string[];
  qualityNotes: string[];
  riskFlags?: string[];
  dexScreenerUrl?: string;
  dexUrl?: string;
  explorerUrl?: string;
  xSearchUrl?: string;
  likelyActivityType: LikelyActivityType;
  confidence: TransactionContextConfidence;
  knownRouterSeen: boolean;
  contextEventCount: number;
  likelyBuyEventCount: number;
  transferEventCount: number;
  airdropOrClaimEventCount: number;
  contractInteractionEventCount: number;
  unknownEventCount: number;
  highConfidenceEventCount: number;
  mediumConfidenceEventCount: number;
  lowConfidenceEventCount: number;
  knownRouterEventCount: number;
  contextComposition: Partial<Record<LikelyActivityType, number>>;
}

export interface UserWatchlistWallet {
  chain: SupportedChain;
  walletAddress: string;
  label: string;
  enabled: boolean;
  addedAt: string;
  notes?: string;
}

export interface UserWatchlist {
  userId: string;
  label: string;
  wallets: UserWatchlistWallet[];
}
