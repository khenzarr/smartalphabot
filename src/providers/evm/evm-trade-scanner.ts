import { parseAbi } from 'viem';
import type { SupportedChain } from '../../chains/chain.types.js';
import { normalizeRpcError, withRetry, withRetryOptions } from '../../utils/retry.js';
import { getEvmPublicClient } from './evm-rpc.client.js';
import {
  contextWarning,
  formatGetLogsError,
  isGetLogsBlockRangeRejected,
  requestRawEthGetLogs,
  type GetLogsContext,
} from './evm-get-logs.js';
import type { ScanPoolTradesInput, ScanPoolTradesResult } from './evm.types.js';
import { parseUniswapV2Swap, V2_SWAP_TOPIC } from './parsers/uniswap-v2.parser.js';
import { parseUniswapV3Swap, V3_SWAP_TOPIC } from './parsers/uniswap-v3.parser.js';
import { env } from '../../config/env.js';

const readAbi = parseAbi(['function token0() view returns (address)', 'function token1() view returns (address)']);

const DEFAULT_CHUNK_SIZE = 1200n;
const MIN_CHUNK_SIZE = 25n;
const MAX_TOTAL_BLOCK_SPAN = 80_000n;
const MAX_ADAPTIVE_SPLITS = 40;

interface BlockRange {
  fromBlock: bigint;
  toBlock: bigint;
}

function ensureEvmChain(chain: SupportedChain) {
  if (chain === 'solana') throw new Error('solana_not_supported_for_evm_trade_scanner');
}

export async function scanPoolTrades(input: ScanPoolTradesInput): Promise<ScanPoolTradesResult> {
  ensureEvmChain(input.chain);
  const client = getEvmPublicClient(input.chain);
  const warnings: string[] = [];
  const trades = [] as ScanPoolTradesResult['trades'];
  const latestBlock = await withRetry(() => client.getBlockNumber(), 2, 250);
  const initialToBlock = input.toBlock && input.toBlock <= latestBlock ? input.toBlock : latestBlock;

  const cappedToBlock = input.fromBlock + MAX_TOTAL_BLOCK_SPAN < initialToBlock ? input.fromBlock + MAX_TOTAL_BLOCK_SPAN : initialToBlock;
  if (cappedToBlock !== initialToBlock) warnings.push('scan_window_capped_for_safety');

  const freeRpcMode = input.freeRpcMode ?? env.DISCOVERY_FREE_RPC_MODE;
  const getLogsMaxBlockRange = BigInt(
    Math.max(
      1,
      freeRpcMode
        ? (input.getLogsMaxBlockRange ?? env.DISCOVERY_GETLOGS_MAX_BLOCK_RANGE)
        : (input.getLogsMaxBlockRange ?? Number(DEFAULT_CHUNK_SIZE)),
    ),
  );
  const requestBudgetLimit = Math.max(1, input.maxGetLogsRequestsPerRun ?? env.DISCOVERY_MAX_GETLOGS_REQUESTS_PER_RUN);
  const minChunkByMode = freeRpcMode ? 1n : MIN_CHUNK_SIZE;
  const configuredChunkSize = input.chunkSize ? BigInt(Math.max(1, input.chunkSize)) : DEFAULT_CHUNK_SIZE;
  const chunkSize = configuredChunkSize > getLogsMaxBlockRange ? getLogsMaxBlockRange : configuredChunkSize;
  const maxLogs = input.maxLogs ?? 10_000;
  const maxTrades = input.maxTrades ?? 2_000;
  let getLogsRequestsUsed = 0;
  let requestBudgetReached = false;
  let nextFromBlock: bigint | undefined;
  let logsScanned = 0;
  let truncated = false;
  let adaptiveChunkingUsed = false;
  let chunkReductions = 0;
  let minChunkSizeReached = false;
  const failedChunks: Array<{ fromBlock: bigint; toBlock: bigint; reason: string }> = [];

  const address = input.poolAddress as `0x${string}`;
  const token0 = await withRetry(
    () => client.readContract({ address, abi: readAbi, functionName: 'token0' }),
    2,
    200,
  );
  const token1 = await withRetry(
    () => client.readContract({ address, abi: readAbi, functionName: 'token1' }),
    2,
    200,
  );

  const swapTopicByParser: Record<ScanPoolTradesInput['parserType'], `0x${string}`> = {
    uniswap_v2_compatible: V2_SWAP_TOPIC,
    uniswap_v3_compatible: V3_SWAP_TOPIC,
  };
  const swapTopic = swapTopicByParser[input.parserType];
  const getLogsContext: GetLogsContext =
    input.parserType === 'uniswap_v2_compatible' ? 'trade_scanner_v2' : 'trade_scanner_v3';
  if (!swapTopic) {
    throw new Error(`empty_swap_topic_for_parser:${input.parserType}`);
  }
  const topicFilterUsed = Boolean(swapTopic);

  const pendingRanges: BlockRange[] = [{ fromBlock: input.fromBlock, toBlock: cappedToBlock }];
  let adaptiveSplits = 0;

  while (pendingRanges.length > 0) {
    const current = pendingRanges.shift();
    if (!current) continue;
    let cursor = current.fromBlock;

    while (cursor <= current.toBlock) {
      const spanEnd = cursor + chunkSize > current.toBlock ? current.toBlock : cursor + chunkSize;
      const end = cursor + getLogsMaxBlockRange - 1n < spanEnd ? cursor + getLogsMaxBlockRange - 1n : spanEnd;

      let logs: Awaited<ReturnType<typeof client.getLogs>>;
      try {
        if (getLogsRequestsUsed >= requestBudgetLimit) {
          requestBudgetReached = true;
          warnings.push('request_budget_reached');
          nextFromBlock = cursor;
          break;
        }

        getLogsRequestsUsed += 1;
        logs = await withRetryOptions(
          () =>
            requestRawEthGetLogs(client, {
              address,
              swapTopic,
              fromBlock: cursor,
              toBlock: end,
            }),
          {
            retries: 2,
            baseDelayMs: 250,
            shouldRetry: (error) => {
              const normalized = normalizeRpcError(error);
              return normalized.kind === 'rate_limited' || normalized.kind === 'transient';
            },
          },
        );
      } catch (error) {
        if (isGetLogsBlockRangeRejected(error)) {
          const span = end - cursor + 1n;
          if (span > 10n) {
            warnings.push('provider_range_rejected_retrying_small_chunks');
            const splitEnd = cursor + 9n;
            const splitRanges: BlockRange[] = [
              { fromBlock: cursor, toBlock: splitEnd > end ? end : splitEnd },
              { fromBlock: (splitEnd > end ? end : splitEnd) + 1n, toBlock: end },
            ].filter((x) => x.fromBlock <= x.toBlock);
            const tailRanges = end < current.toBlock ? [{ fromBlock: end + 1n, toBlock: current.toBlock }] : [];
            pendingRanges.unshift(...splitRanges, ...tailRanges);
            adaptiveChunkingUsed = true;
            chunkReductions += 1;
            break;
          }
          warnings.push('provider_range_rejected_at_minimum_chunk');
        }

        const normalized = normalizeRpcError(error);
        if (normalized.kind !== 'too_many_results') {
          throw new Error(formatGetLogsError(getLogsContext, error));
        }

        warnings.push('rpc_log_range_too_dense');
        warnings.push(contextWarning(getLogsContext));
        adaptiveChunkingUsed = true;
        warnings.push('adaptive_chunking_used');

        const span = end - cursor + 1n;
        if (span <= minChunkByMode) {
          minChunkSizeReached = true;
          warnings.push('min_chunk_size_reached');
          failedChunks.push({ fromBlock: cursor, toBlock: end, reason: normalized.rawMessage });
          throw new Error(`min_chunk_size_reached:${normalized.rawMessage}`);
        }

        if (adaptiveSplits >= MAX_ADAPTIVE_SPLITS) {
          failedChunks.push({ fromBlock: cursor, toBlock: end, reason: 'max_adaptive_splits_reached' });
          throw new Error('max_adaptive_splits_reached');
        }

        const hasSuggestedRange =
          normalized.suggestedFromBlock !== undefined &&
          normalized.suggestedToBlock !== undefined &&
          normalized.suggestedFromBlock >= cursor &&
          normalized.suggestedToBlock <= end &&
          normalized.suggestedFromBlock <= normalized.suggestedToBlock;

        let splitRanges: BlockRange[];
        if (hasSuggestedRange) {
          const suggestedFrom = normalized.suggestedFromBlock!;
          const suggestedTo = normalized.suggestedToBlock!;
          splitRanges = [];
          if (cursor < suggestedFrom) splitRanges.push({ fromBlock: cursor, toBlock: suggestedFrom - 1n });
          splitRanges.push({ fromBlock: suggestedFrom, toBlock: suggestedTo });
          if (suggestedTo < end) splitRanges.push({ fromBlock: suggestedTo + 1n, toBlock: end });
        } else {
          const half = span / 2n;
          const mid = cursor + (half > 0n ? half - 1n : 0n);
          splitRanges = [
            { fromBlock: cursor, toBlock: mid },
            { fromBlock: mid + 1n, toBlock: end },
          ].filter((x) => x.fromBlock <= x.toBlock);
        }

        warnings.push('chunk_reduced');
        chunkReductions += 1;
        adaptiveSplits += 1;

        const tailRanges = end < current.toBlock ? [{ fromBlock: end + 1n, toBlock: current.toBlock }] : [];
        pendingRanges.unshift(...splitRanges, ...tailRanges);
        break;
      }

      for (const log of logs) {
        if (input.parserType === 'uniswap_v2_compatible' && log.topics[0] !== V2_SWAP_TOPIC) continue;
        if (input.parserType === 'uniswap_v3_compatible' && log.topics[0] !== V3_SWAP_TOPIC) continue;

        logsScanned += 1;
        if (logsScanned >= maxLogs) {
          truncated = true;
          warnings.push('max_logs_reached');
          break;
        }

        const block = await withRetry(() => client.getBlock({ blockNumber: log.blockNumber! }), 1, 150);
        const timestamp = new Date(Number(block.timestamp) * 1000);

        const parsed =
          input.parserType === 'uniswap_v2_compatible'
            ? parseUniswapV2Swap({ chain: input.chain, tokenAddress: input.tokenAddress, token0, token1, log, timestamp })
            : parseUniswapV3Swap({ chain: input.chain, tokenAddress: input.tokenAddress, token0, token1, log, timestamp });

        warnings.push(...parsed.warnings);
        if (!parsed.trade) continue;
        if (input.direction && input.direction !== 'both' && parsed.trade.side !== input.direction) continue;

        trades.push(parsed.trade);
        if (trades.length >= maxTrades) {
          truncated = true;
          warnings.push('max_trades_reached');
          break;
        }
      }

      if (truncated || requestBudgetReached) break;
      cursor = end + 1n;
    }

    if (truncated || requestBudgetReached) break;
  }

  return {
    trades,
    warnings,
    metadata: {
      fromBlock: input.fromBlock,
      toBlock: cappedToBlock,
      latestBlock,
      getLogsContext,
      getLogsMode: 'raw_rpc',
      topicFilterUsed,
      swapTopic,
      logsScanned,
      tradesExtracted: trades.length,
      parserType: input.parserType,
      truncated,
      adaptiveChunkingUsed,
      chunkReductions,
      failedChunks,
      minChunkSizeReached,
      getLogsRequestsUsed,
      getLogsMaxBlockRangeUsed: Number(getLogsMaxBlockRange),
      requestBudgetReached,
      requestBudgetLimit,
      nextFromBlock,
      warnings,
    },
  };
}
