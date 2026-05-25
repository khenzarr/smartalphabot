import { parseAbi } from 'viem';
import type { SupportedChain } from '../../chains/chain.types.js';
import { isLikelyRateLimitError, isLikelyRpcUnstableError, withRetryOptions } from '../../utils/retry.js';
import { getEvmPublicClient } from './evm-rpc.client.js';
import type { EvmPoolDiagnostics } from './evm.types.js';
import { contextWarning, formatGetLogsError, type GetLogsContext } from './evm-get-logs.js';
import { V2_SWAP_TOPIC } from './parsers/uniswap-v2.parser.js';
import { V3_SWAP_TOPIC } from './parsers/uniswap-v3.parser.js';
import { safeJsonStringify } from '../../utils/json.js';

const readAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function factory() view returns (address)',
  'function getReserves() view returns (uint112, uint112, uint32)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)',
]);

const SOLIDLY_SWAP_TOPIC = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
const ALGEBRA_SWAP_TOPIC = '0x56c5f5f0e588d5c6f3d31e44f0f188e8e2cfd5b3af1f6a0b7f5f6829f6aa6f6f';

export interface DiagnosePoolInput {
  chain: SupportedChain;
  tokenAddress: string;
  poolAddress: string;
  dexId?: string;
  fromBlock?: bigint;
  toBlock?: bigint;
  lookbackBlocks?: number;
}

async function safeCall<T>(
  fn: () => Promise<T>,
  warnings: string[],
  code: string,
  getLogsContext?: GetLogsContext,
): Promise<T | undefined> {
  try {
    return await withRetryOptions(fn, {
      retries: 2,
      baseDelayMs: 250,
      shouldRetry: (error) => isLikelyRateLimitError(error) || isLikelyRpcUnstableError(error),
      onRetry: ({ error }) => {
        if (isLikelyRateLimitError(error)) warnings.push('rpc_rate_limited');
        else warnings.push('rpc_provider_unstable');
      },
    });
  } catch (error) {
    if (isLikelyRateLimitError(error)) warnings.push('rpc_retry_exhausted');
    warnings.push(code);
    if (getLogsContext) {
      warnings.push('diagnostic_log_probe_failed');
      warnings.push(contextWarning(getLogsContext));
      warnings.push(formatGetLogsError(getLogsContext, error));
    }
    return undefined;
  }
}

export async function diagnoseEvmPool(input: DiagnosePoolInput): Promise<EvmPoolDiagnostics> {
  const warnings: string[] = [];
  const client = getEvmPublicClient(input.chain);
  const address = input.poolAddress as `0x${string}`;
  const lookback = BigInt(Math.max(500, input.lookbackBlocks ?? 5000));

  const bytecode = await safeCall(() => client.getBytecode({ address }), warnings, 'bytecode_probe_failed');
  const bytecodeExists = !!bytecode && bytecode !== '0x';

  const token0 = await safeCall(() => client.readContract({ address, abi: readAbi, functionName: 'token0' }), warnings, 'token0_call_failed');
  const token1 = await safeCall(() => client.readContract({ address, abi: readAbi, functionName: 'token1' }), warnings, 'token1_call_failed');
  const factory = await safeCall(() => client.readContract({ address, abi: readAbi, functionName: 'factory' }), warnings, 'factory_call_failed');
  const reserves = await safeCall(() => client.readContract({ address, abi: readAbi, functionName: 'getReserves' }), warnings, 'getreserves_call_failed');
  const liquidity = await safeCall(() => client.readContract({ address, abi: readAbi, functionName: 'liquidity' }), warnings, 'liquidity_call_failed');
  const slot0 = await safeCall(() => client.readContract({ address, abi: readAbi, functionName: 'slot0' }), warnings, 'slot0_call_failed');

  const latestBlock = await safeCall(() => client.getBlockNumber(), warnings, 'latest_block_failed');
  const fromBlock = input.fromBlock ?? (latestBlock && latestBlock > lookback ? latestBlock - lookback : 0n);
  const toBlock = input.toBlock ?? latestBlock ?? fromBlock;

  const [v2Logs, v3Logs] = await Promise.all([
    safeCall(
      () =>
        client.getLogs({
          address,
          fromBlock,
          toBlock,
          topics: [[V2_SWAP_TOPIC]],
        } as Parameters<typeof client.getLogs>[0]),
      warnings,
      'pool_logs_probe_v2_failed',
      'pool_diagnostics_recent_logs',
    ),
    safeCall(
      () =>
        client.getLogs({
          address,
          fromBlock,
          toBlock,
          topics: [[V3_SWAP_TOPIC]],
        } as Parameters<typeof client.getLogs>[0]),
      warnings,
      'pool_logs_probe_v3_failed',
      'pool_diagnostics_recent_logs',
    ),
  ]);

  const topicCount = new Map<string, number>();
  topicCount.set(V2_SWAP_TOPIC, (v2Logs ?? []).length);
  topicCount.set(V3_SWAP_TOPIC, (v3Logs ?? []).length);

  const recentLogTopics = [...topicCount.entries()]
    .map(([topic0, count]) => ({ topic0, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const knownSwapSignatureMatches: string[] = [];
  if ((topicCount.get(V2_SWAP_TOPIC) ?? 0) > 0) knownSwapSignatureMatches.push('uniswap_v2_swap');
  if ((topicCount.get(V3_SWAP_TOPIC) ?? 0) > 0) knownSwapSignatureMatches.push('uniswap_v3_swap');
  if ((topicCount.get(SOLIDLY_SWAP_TOPIC) ?? 0) > 0) knownSwapSignatureMatches.push('solidly_v2_swap');
  if ((topicCount.get(ALGEBRA_SWAP_TOPIC) ?? 0) > 0) knownSwapSignatureMatches.push('algebra_swap');

  const poolMethodsDetected: string[] = [];
  if (token0) poolMethodsDetected.push('token0');
  if (token1) poolMethodsDetected.push('token1');
  if (factory) poolMethodsDetected.push('factory');
  if (reserves) poolMethodsDetected.push('getReserves');
  if (liquidity) poolMethodsDetected.push('liquidity');
  if (slot0) poolMethodsDetected.push('slot0');

  let likelyPoolType: EvmPoolDiagnostics['likelyPoolType'] = 'unsupported_unknown';
  if (reserves || knownSwapSignatureMatches.includes('uniswap_v2_swap')) likelyPoolType = 'uniswap_v2_compatible';
  else if (slot0 || knownSwapSignatureMatches.includes('uniswap_v3_swap')) likelyPoolType = 'uniswap_v3_compatible';
  else if (knownSwapSignatureMatches.includes('solidly_v2_swap')) likelyPoolType = 'solidly_v2_compatible';
  else if (knownSwapSignatureMatches.includes('algebra_swap')) likelyPoolType = 'algebra_compatible';
  else if ((input.dexId ?? '').toLowerCase().includes('aerodrome')) likelyPoolType = 'aerodrome_slipstream_candidate';

  return {
    chain: input.chain,
    tokenAddress: input.tokenAddress,
    poolAddress: input.poolAddress,
    dexId: input.dexId,
    bytecodeExists,
    token0CallResult: token0 ? String(token0) : undefined,
    token1CallResult: token1 ? String(token1) : undefined,
    factoryCallResult: factory ? String(factory) : undefined,
    getReservesCallResult: reserves ? safeJsonStringify(reserves) : undefined,
    liquidityCallResult: liquidity ? String(liquidity) : undefined,
    slot0CallResult: slot0 ? safeJsonStringify(slot0) : undefined,
    poolMethodsDetected,
    recentLogTopics,
    knownSwapSignatureMatches,
    likelyPoolType,
    warnings: [...new Set(warnings)],
  };
}
