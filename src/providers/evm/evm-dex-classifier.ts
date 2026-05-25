import { parseAbi } from 'viem';
import type { SupportedChain } from '../../chains/chain.types.js';
import { isLikelyRateLimitError, isLikelyRpcUnstableError, withRetryOptions } from '../../utils/retry.js';
import { getEvmPublicClient } from './evm-rpc.client.js';
import { contextWarning, formatGetLogsError } from './evm-get-logs.js';
import { diagnoseEvmPool } from './evm-pool-diagnostics.js';
import type { PoolClassification } from './evm.types.js';
import { V2_SWAP_TOPIC } from './parsers/uniswap-v2.parser.js';
import { V3_SWAP_TOPIC } from './parsers/uniswap-v3.parser.js';

const v2ReadAbi = parseAbi(['function token0() view returns (address)', 'function token1() view returns (address)', 'function getReserves() view returns (uint112, uint112, uint32)']);
const v3ReadAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)',
  'function liquidity() view returns (uint128)',
]);

export interface ClassifyPoolInput {
  chain: SupportedChain;
  tokenAddress: string;
  poolAddress: string;
  dexId?: string;
  fromBlockHint?: bigint;
}

export async function classifyEvmPool(input: ClassifyPoolInput): Promise<PoolClassification> {
  const warnings: string[] = [];
  const client = getEvmPublicClient(input.chain);
  const poolAddress = input.poolAddress as `0x${string}`;

  const probe = async <T>(fn: () => Promise<T>, warningCode: string): Promise<T | undefined> => {
    try {
      return await withRetryOptions(fn, {
        retries: 2,
        baseDelayMs: 200,
        shouldRetry: (error) => isLikelyRateLimitError(error) || isLikelyRpcUnstableError(error),
        onRetry: ({ error }) => {
          warnings.push(isLikelyRateLimitError(error) ? 'rpc_rate_limited' : 'rpc_provider_unstable');
        },
      });
    } catch (error) {
      warnings.push(warningCode);
      if (warningCode.includes('log_probe')) {
        const context = warningCode.startsWith('v2_') ? 'classifier_v2_probe' : 'classifier_v3_probe';
        warnings.push(contextWarning(context));
        warnings.push(`diagnostic_log_probe_failed:${formatGetLogsError(context, error)}`);
      }
      return undefined;
    }
  };

  const diagnostics = await diagnoseEvmPool({
    chain: input.chain,
    tokenAddress: input.tokenAddress,
    poolAddress: input.poolAddress,
    dexId: input.dexId,
    fromBlock: input.fromBlockHint,
  });
  warnings.push(...diagnostics.warnings);

  const bytecodeExists = diagnostics.bytecodeExists;

  let supportsV2 = false;
  let supportsV3 = false;

  const v2Probe = await probe(async () => {
      await client.readContract({ address: poolAddress, abi: v2ReadAbi, functionName: 'token0' });
      await client.readContract({ address: poolAddress, abi: v2ReadAbi, functionName: 'token1' });
      await client.readContract({ address: poolAddress, abi: v2ReadAbi, functionName: 'getReserves' });
    return true;
  }, 'v2_abi_probe_failed');
  supportsV2 = Boolean(v2Probe);

  const v3Probe = await probe(async () => {
      await client.readContract({ address: poolAddress, abi: v3ReadAbi, functionName: 'token0' });
      await client.readContract({ address: poolAddress, abi: v3ReadAbi, functionName: 'token1' });
      await client.readContract({ address: poolAddress, abi: v3ReadAbi, functionName: 'slot0' });
      await client.readContract({ address: poolAddress, abi: v3ReadAbi, functionName: 'liquidity' });
    return true;
  }, 'v3_abi_probe_failed');
  supportsV3 = Boolean(v3Probe);

  const latest = await probe(() => client.getBlockNumber(), 'latest_block_failed');
  if (latest === undefined) {
    return {
      chain: input.chain,
      poolAddress: input.poolAddress,
      dexId: input.dexId,
      parserType: 'unsupported',
      likelyPoolType: diagnostics.likelyPoolType,
      diagnostics,
      reason: 'rpc_probe_failed',
      warnings: [...new Set(warnings)],
    };
  }
  const fromBlock = input.fromBlockHint && input.fromBlockHint <= latest ? input.fromBlockHint : latest > 5000n ? latest - 5000n : 0n;

  const [v2Logs, v3Logs] = await Promise.all([
    probe(
      () =>
        client.getLogs({
          address: poolAddress,
          fromBlock,
          toBlock: latest,
          topics: [[V2_SWAP_TOPIC]],
        } as Parameters<typeof client.getLogs>[0]),
      'v2_log_probe_failed',
    ),
    probe(
      () =>
        client.getLogs({
          address: poolAddress,
          fromBlock,
          toBlock: latest,
          topics: [[V3_SWAP_TOPIC]],
        } as Parameters<typeof client.getLogs>[0]),
      'v3_log_probe_failed',
    ),
  ]);

  const hasV2Topic = (v2Logs ?? []).length > 0;
  const hasV3Topic = (v3Logs ?? []).length > 0;
  const logsChecked = (v2Logs ?? []).length + (v3Logs ?? []).length;
  const hasKnownSwapSignature = hasV2Topic || hasV3Topic || diagnostics.knownSwapSignatureMatches.length > 0;
  const swapLogProbeEmpty = logsChecked === 0 && diagnostics.knownSwapSignatureMatches.length === 0;

  if (!bytecodeExists && !hasKnownSwapSignature) {
    return {
      chain: input.chain,
      poolAddress: input.poolAddress,
      dexId: input.dexId,
      parserType: 'unsupported',
      reason: 'bytecode_missing_and_no_supported_evidence',
      likelyPoolType: diagnostics.likelyPoolType,
      diagnostics,
      warnings: [...new Set([...warnings, `logs_checked:${logsChecked}`, `v2_logs:${(v2Logs ?? []).length}`, `v3_logs:${(v3Logs ?? []).length}`])],
    };
  }

  if (supportsV2 && hasV2Topic) {
    return {
      chain: input.chain,
      poolAddress: input.poolAddress,
      dexId: input.dexId,
      parserType: 'uniswap_v2_compatible',
      reason: 'v2_abi_and_logs_confirmed',
      warnings: [...new Set(warnings)],
    };
  }

  if (supportsV3 && hasV3Topic) {
    return {
      chain: input.chain,
      poolAddress: input.poolAddress,
      dexId: input.dexId,
      parserType: 'uniswap_v3_compatible',
      reason: 'v3_abi_and_logs_confirmed',
      warnings: [...new Set(warnings)],
    };
  }

  if (supportsV2) {
    return {
      chain: input.chain,
      poolAddress: input.poolAddress,
      dexId: input.dexId,
      parserType: 'uniswap_v2_compatible',
      reason: 'abi_methods_detected_uniswap_v2',
      warnings: [
        ...new Set([
          ...warnings,
          'classification_based_on_abi_methods',
          ...(swapLogProbeEmpty ? ['swap_log_probe_empty'] : []),
          `logs_checked:${logsChecked}`,
          `v2_logs:${(v2Logs ?? []).length}`,
          `v3_logs:${(v3Logs ?? []).length}`,
        ]),
      ],
    };
  }

  if (supportsV3) {
    return {
      chain: input.chain,
      poolAddress: input.poolAddress,
      dexId: input.dexId,
      parserType: 'uniswap_v3_compatible',
      reason: 'abi_methods_detected_uniswap_v3',
      warnings: [
        ...new Set([
          ...warnings,
          'classification_based_on_abi_methods',
          ...(swapLogProbeEmpty ? ['swap_log_probe_empty'] : []),
          `logs_checked:${logsChecked}`,
          `v2_logs:${(v2Logs ?? []).length}`,
          `v3_logs:${(v3Logs ?? []).length}`,
        ]),
      ],
    };
  }

  return {
    chain: input.chain,
    poolAddress: input.poolAddress,
    dexId: input.dexId,
    parserType: 'unsupported',
    reason: 'no_supported_swap_signature_detected',
    likelyPoolType: diagnostics.likelyPoolType,
    diagnostics,
    warnings: [...new Set([...warnings, `logs_checked:${logsChecked}`, `v2_logs:${(v2Logs ?? []).length}`, `v3_logs:${(v3Logs ?? []).length}`])],
  };
}
