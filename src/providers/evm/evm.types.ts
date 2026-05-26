import type { NormalizedTrade, SupportedChain } from '../../chains/chain.types.js';
import type { GetLogsContext } from './evm-get-logs.js';

export type EvmParserType = 'uniswap_v2_compatible' | 'uniswap_v3_compatible' | 'unsupported';
export type EvmLikelyPoolType =
  | 'uniswap_v2_compatible'
  | 'uniswap_v3_compatible'
  | 'solidly_v2_compatible'
  | 'algebra_compatible'
  | 'aerodrome_slipstream_candidate'
  | 'unsupported_unknown';

export interface EvmPoolDiagnostics {
  chain: SupportedChain;
  tokenAddress: string;
  poolAddress: string;
  dexId?: string;
  bytecodeExists: boolean;
  token0CallResult?: string;
  token1CallResult?: string;
  factoryCallResult?: string;
  getReservesCallResult?: string;
  liquidityCallResult?: string;
  slot0CallResult?: string;
  poolMethodsDetected: string[];
  recentLogTopics: Array<{ topic0: string; count: number }>;
  knownSwapSignatureMatches: string[];
  likelyPoolType: EvmLikelyPoolType;
  warnings: string[];
}

export interface PoolClassification {
  chain: SupportedChain;
  poolAddress: string;
  dexId?: string;
  parserType: EvmParserType;
  likelyPoolType?: EvmLikelyPoolType;
  diagnostics?: EvmPoolDiagnostics;
  reason: string;
  warnings: string[];
}

export interface ScanPoolTradesInput {
  chain: SupportedChain;
  tokenAddress: string;
  poolAddress: string;
  parserType: Exclude<EvmParserType, 'unsupported'>;
  fromBlock: bigint;
  toBlock?: bigint;
  maxLogs?: number;
  maxTrades?: number;
  direction?: 'buy' | 'sell' | 'both';
  chunkSize?: number;
  getLogsMaxBlockRange?: number;
  maxGetLogsRequestsPerRun?: number;
  freeRpcMode?: boolean;
}

export interface ScanPoolTradesMetadata {
  fromBlock: bigint;
  toBlock: bigint;
  latestBlock: bigint;
  getLogsContext: GetLogsContext;
  getLogsMode: 'raw_rpc';
  topicFilterUsed: boolean;
  swapTopic?: `0x${string}`;
  logsScanned: number;
  tradesExtracted: number;
  parserType: Exclude<EvmParserType, 'unsupported'>;
  truncated: boolean;
  adaptiveChunkingUsed?: boolean;
  chunkReductions?: number;
  failedChunks?: Array<{ fromBlock: bigint; toBlock: bigint; reason: string }>;
  minChunkSizeReached?: boolean;
  getLogsRequestsUsed?: number;
  getLogsMaxBlockRangeUsed?: number;
  requestBudgetReached?: boolean;
  requestBudgetLimit?: number;
  nextFromBlock?: bigint;
  warnings: string[];
}

export interface ScanPoolTradesResult {
  trades: NormalizedTrade[];
  metadata: ScanPoolTradesMetadata;
  warnings: string[];
}
