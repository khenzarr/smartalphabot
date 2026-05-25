import type { SupportedChain } from '../../chains/chain.types.js';
import { withRetry } from '../../utils/retry.js';
import { getEvmPublicClient } from './evm-rpc.client.js';

const cache = new Map<string, bigint>();

export async function findBlockAtOrBeforeTimestamp(chain: SupportedChain, timestampSeconds: number): Promise<bigint> {
  const key = `${chain}:${timestampSeconds}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const client = getEvmPublicClient(chain);
  const latest = await withRetry(() => client.getBlockNumber(), 2, 300);
  const latestBlock = await withRetry(() => client.getBlock({ blockNumber: latest }), 2, 300);
  const latestTs = Number(latestBlock.timestamp);
  if (timestampSeconds >= latestTs) return latest;

  let low = 0n;
  let high = latest;
  let best = 0n;

  while (low <= high) {
    const mid = (low + high) / 2n;
    const block = await withRetry(() => client.getBlock({ blockNumber: mid }), 2, 250);
    const ts = Number(block.timestamp);

    if (ts <= timestampSeconds) {
      best = mid;
      low = mid + 1n;
    } else {
      if (mid === 0n) break;
      high = mid - 1n;
    }
  }

  cache.set(key, best);
  return best;
}
