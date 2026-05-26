import type { NormalizedTokenProfile, SupportedChain } from '../chains/chain.types.js';
import { TokenAnalyzer } from '../analysis/token-analyzer.js';
import { isEvmAddress } from '../utils/address.js';
import { classifyEvmPool } from '../providers/evm/evm-dex-classifier.js';
import { scanPoolTrades } from '../providers/evm/evm-trade-scanner.js';
import { findBlockAtOrBeforeTimestamp } from '../providers/evm/evm-block-resolution.js';
import { getEvmPublicClient } from '../providers/evm/evm-rpc.client.js';
import { env } from '../config/env.js';
import { groupEarlyBuyers, type EarlyBuyerSummary } from './group-early-buyers.js';
import { createAnalysisJob, updateAnalysisJobResult } from '../db/repositories/analysis-job.repository.js';
import { upsertTokenProfile } from '../db/repositories/token.repository.js';
import { upsertCandidateWallet } from '../db/repositories/wallet.repository.js';
import { upsertTrade } from '../db/repositories/trade.repository.js';
import { upsertWalletTokenPerformance } from '../db/repositories/wallet-token-performance.repository.js';

type EvmSupportedChain = 'ethereum' | 'base' | 'bsc';

export interface ExtractEarlyBuyersInput {
  chain: SupportedChain;
  tokenAddress: string;
  poolAddress?: string;
  fromBlockOverride?: bigint;
  toBlockOverride?: bigint;
  maxBuyers?: number;
  maxHoursAfterCreation?: number;
  maxBlocksAfterCreation?: number;
  freeRpcMode?: boolean;
  getLogsMaxBlockRange?: number;
  maxGetLogsRequestsPerRun?: number;
  persist?: boolean;
  forceParserType?: 'uniswap_v2_compatible' | 'uniswap_v3_compatible';
}

export interface ExtractEarlyBuyersResult {
  chain: SupportedChain;
  tokenAddress: string;
  tokenProfile: NormalizedTokenProfile | null;
  poolClassification?: unknown;
  scanMetadata?: unknown;
  earliestBuyers: EarlyBuyerSummary[];
  warnings: string[];
  seedRecommendation?: 'investigate_or_drop';
  persistenceSummary?: {
    persisted: boolean;
    analysisJobId?: string;
    walletsUpserted?: number;
    tradesUpserted?: number;
  };
}

export async function extractEarlyBuyers(input: ExtractEarlyBuyersInput): Promise<ExtractEarlyBuyersResult> {
  const chain = input.chain;
  const tokenAddress = input.tokenAddress;
  const maxBuyers = input.maxBuyers ?? 100;
  const maxHoursAfterCreation = input.maxHoursAfterCreation ?? 6;
  const maxBlocksAfterCreation = input.maxBlocksAfterCreation ?? 20_000;
  const persist = input.persist ?? false;
  const warnings: string[] = [];

  if (chain === 'solana') {
    return {
      chain,
      tokenAddress,
      tokenProfile: null,
      earliestBuyers: [],
      warnings: ['Solana early-buyer extraction is not implemented yet.'],
    };
  }

  if (!isEvmAddress(tokenAddress)) {
    return {
      chain,
      tokenAddress,
      tokenProfile: null,
      earliestBuyers: [],
      warnings: ['invalid_evm_token_address'],
    };
  }

  if (persist && !env.DATABASE_URL) {
    throw new Error('persist_requested_but_database_url_missing');
  }

  const analyzer = new TokenAnalyzer();
  const tokenAnalysis = await analyzer.analyze(chain, tokenAddress);
  warnings.push(...tokenAnalysis.warnings);

  if (!tokenAnalysis.tokenProfile) {
    return {
      chain,
      tokenAddress,
      tokenProfile: null,
      earliestBuyers: [],
      warnings,
    };
  }

  const tokenProfile = tokenAnalysis.tokenProfile;
  const poolAddress = input.poolAddress ?? tokenProfile.poolAddress ?? tokenProfile.pairAddress;
  if (!poolAddress) {
    warnings.push('pool_address_missing');
    return {
      chain,
      tokenAddress,
      tokenProfile,
      earliestBuyers: [],
      warnings,
    };
  }

  const fromBlockHint = tokenProfile.pairCreatedAt
    ? await findBlockAtOrBeforeTimestamp(chain, Math.floor(tokenProfile.pairCreatedAt.getTime() / 1000))
    : undefined;
  if (!fromBlockHint) warnings.push('pair_created_at_missing_using_latest_window');

  const classification = input.forceParserType
    ? {
        chain,
        poolAddress,
        dexId: tokenProfile.dexId,
        parserType: input.forceParserType,
        reason: 'forced_by_cli',
        warnings: ['forced_parser_type_used'],
      }
    : await classifyEvmPool({ chain, tokenAddress, poolAddress, dexId: tokenProfile.dexId, fromBlockHint });
  warnings.push(...classification.warnings);

  if (classification.parserType === 'unsupported') {
    return {
      chain,
      tokenAddress,
      tokenProfile,
      poolClassification: classification,
      earliestBuyers: [],
      warnings: [...warnings, 'unsupported_pool_parser'],
    };
  }

  const client = getEvmPublicClient(chain);
  const latestBlock = await client.getBlockNumber();

  const fromBlock =
    input.fromBlockOverride ??
    (fromBlockHint ?? (latestBlock > BigInt(maxBlocksAfterCreation) ? latestBlock - BigInt(maxBlocksAfterCreation) : 0n));

  const hoursTarget = maxHoursAfterCreation * 3600;
  let toBlockByTime = latestBlock;
  if (tokenProfile.pairCreatedAt) {
    const targetTs = Math.floor(tokenProfile.pairCreatedAt.getTime() / 1000) + hoursTarget;
    toBlockByTime = await findBlockAtOrBeforeTimestamp(chain, targetTs);
  }

  const toBlockBySpan = fromBlock + BigInt(Math.max(1, maxBlocksAfterCreation));
  const computedToBlock = [latestBlock, toBlockBySpan, toBlockByTime].reduce((acc, cur) => (cur < acc ? cur : acc), latestBlock);
  const toBlock = input.toBlockOverride ?? computedToBlock;

  let scanResult: Awaited<ReturnType<typeof scanPoolTrades>>;
  try {
    scanResult = await scanPoolTrades({
      chain,
      tokenAddress,
      poolAddress,
      parserType: classification.parserType,
      fromBlock,
      toBlock,
      direction: 'buy',
      chunkSize: env.EVM_SCAN_CHUNK_SIZE,
      maxLogs: env.EVM_SCAN_MAX_LOGS,
      maxTrades: env.EVM_SCAN_MAX_TRADES,
      freeRpcMode: input.freeRpcMode,
      getLogsMaxBlockRange: input.getLogsMaxBlockRange,
      maxGetLogsRequestsPerRun: input.maxGetLogsRequestsPerRun,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown_scan_error';
    const isDenseGuardrail =
      message.includes('max_adaptive_splits_reached') || message.includes('min_chunk_size_reached');

    if (!isDenseGuardrail) throw error;

    return {
      chain,
      tokenAddress,
      tokenProfile,
      poolClassification: classification,
      earliestBuyers: [],
      scanMetadata: {
        fromBlock,
        toBlock,
        guardrailHit: true,
        guardrailReason: message,
      },
      warnings: [
        ...new Set([
          ...warnings,
          'max_adaptive_splits_reached',
          'dense_pool_scan_guardrail_hit',
          'try_smaller_window_or_better_rpc',
          `original_scan_error:${message}`,
        ]),
      ],
      seedRecommendation: 'investigate_or_drop',
    };
  }

  warnings.push(...scanResult.warnings);
  const buyTrades = scanResult.trades.filter((trade) => trade.side === 'buy');
  const earliestBuyers = groupEarlyBuyers(buyTrades, maxBuyers);

  if (!buyTrades.some((x) => x.amountUsd !== undefined)) {
    warnings.push('historical_usd_not_reliable_amount_usd_omitted');
  }

  const result: ExtractEarlyBuyersResult = {
    chain,
    tokenAddress,
    tokenProfile,
    poolClassification: classification,
    scanMetadata: scanResult.metadata,
    earliestBuyers,
    warnings: [...new Set(warnings)],
  };

  if (!persist) return result;

  const persisted = await persistExtractionArtifacts({
    chain: chain as EvmSupportedChain,
    tokenProfile,
    buyTrades,
    earliestBuyers,
    warnings: result.warnings,
    result,
    input,
  });
  result.persistenceSummary = persisted;
  return result;
}

async function persistExtractionArtifacts(input: {
  chain: EvmSupportedChain;
  tokenProfile: NormalizedTokenProfile;
  buyTrades: Awaited<ReturnType<typeof scanPoolTrades>>['trades'];
  earliestBuyers: EarlyBuyerSummary[];
  warnings: string[];
  result: ExtractEarlyBuyersResult;
  input: ExtractEarlyBuyersInput;
}) {
  const job = await createAnalysisJob({
    chain: input.chain,
    jobType: 'early_buyer_extraction',
    targetType: 'token',
    targetValue: input.tokenProfile.tokenAddress,
    status: 'running',
    input: input.input,
    warnings: input.warnings,
  });

  try {
    const token = await upsertTokenProfile(input.tokenProfile);
    let walletsUpserted = 0;
    let tradesUpserted = 0;

    for (const trade of input.buyTrades) {
      const wallet = await upsertCandidateWallet(input.chain, trade.walletAddress);
      walletsUpserted += 1;
      await upsertTrade({ trade, walletId: wallet.id, tokenId: token.id });
      tradesUpserted += 1;
    }

    for (const buyer of input.earliestBuyers) {
      const wallet = await upsertCandidateWallet(input.chain, buyer.walletAddress);
      await upsertWalletTokenPerformance({
        walletId: wallet.id,
        tokenId: token.id,
        chain: input.chain,
        firstBuyAt: buyer.firstBuyTimestamp,
        firstBuyMarketCap: input.tokenProfile.marketCap,
        firstBuyTxHash: buyer.firstBuyTxHash,
      });
    }

    await updateAnalysisJobResult({
      id: job.id,
      status: 'success',
      result: {
        earliestBuyerCount: input.earliestBuyers.length,
        warnings: input.warnings,
      },
      warnings: input.warnings,
    });

    return {
      persisted: true,
      analysisJobId: job.id,
      walletsUpserted,
      tradesUpserted,
    };
  } catch (error) {
    await updateAnalysisJobResult({
      id: job.id,
      status: 'failed',
      error: error instanceof Error ? error.message : 'unknown_persistence_error',
      warnings: input.warnings,
    });
    throw error;
  }
}
