import { toHex, type Log } from 'viem';
import { normalizeRpcError } from '../../utils/retry.js';

export interface RawEthGetLogsLog {
  address?: `0x${string}`;
  blockHash?: `0x${string}`;
  blockNumber?: `0x${string}`;
  data: `0x${string}`;
  logIndex?: `0x${string}`;
  removed?: boolean;
  topics: `0x${string}`[];
  transactionHash?: `0x${string}`;
  transactionIndex?: `0x${string}`;
}

export interface RawEthGetLogsInput {
  address: `0x${string}`;
  swapTopic: `0x${string}`;
  fromBlock: bigint;
  toBlock: bigint;
}

export type GetLogsContext =
  | 'trade_scanner_v2'
  | 'trade_scanner_v3'
  | 'classifier_v2_probe'
  | 'classifier_v3_probe'
  | 'pool_diagnostics_recent_logs'
  | 'unknown';

export function contextWarning(context: GetLogsContext): string {
  return `getLogsContext:${context}`;
}

export function formatGetLogsError(context: GetLogsContext, error: unknown): string {
  const normalized = normalizeRpcError(error);
  return `getLogsContext:${context}:${normalized.kind}:${normalized.rawMessage}`;
}

export function isGetLogsBlockRangeRejected(error: unknown): boolean {
  const normalized = normalizeRpcError(error);
  const text = normalized.rawMessage.toLowerCase();
  return (
    text.includes('eth_getlogs') &&
    (text.includes('block range') || text.includes('up to 10 block range') || text.includes('range exceeds'))
  );
}

export async function requestRawEthGetLogs(
  client: { request: (args: { method: 'eth_getLogs'; params: Array<Record<string, unknown>> }) => Promise<unknown> },
  input: RawEthGetLogsInput,
): Promise<Log[]> {
  const response = await client.request({
    method: 'eth_getLogs',
    params: [
      {
        address: input.address,
        topics: [input.swapTopic],
        fromBlock: toHex(input.fromBlock),
        toBlock: toHex(input.toBlock),
      },
    ],
  });

  return (response as RawEthGetLogsLog[]).map(
    (log) =>
      ({
        address: log.address ?? input.address,
        blockHash: log.blockHash ?? null,
        blockNumber: log.blockNumber ? BigInt(log.blockNumber) : null,
        data: log.data,
        logIndex: log.logIndex ? Number(BigInt(log.logIndex)) : null,
        removed: log.removed ?? false,
        topics: log.topics,
        transactionHash: log.transactionHash ?? null,
        transactionIndex: log.transactionIndex ? Number(BigInt(log.transactionIndex)) : null,
      }) as Log,
  );
}
