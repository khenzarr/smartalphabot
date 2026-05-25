import type { WalletTradeQuery, WalletTradeResult } from '../interfaces.js';
import { findTradesByWallet } from '../../db/repositories/trade.repository.js';

function toDate(value?: Date): Date | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value : new Date(value);
}

export async function getPersistedWalletTrades(input: WalletTradeQuery): Promise<WalletTradeResult> {
  try {
    const trades = await findTradesByWallet({
      chain: input.chain,
      walletAddress: input.walletAddress,
      tokenAddress: input.tokenAddress,
      fromTimestamp: toDate(input.fromTimestamp),
      toTimestamp: toDate(input.toTimestamp),
      maxTrades: input.maxTrades,
    });

    return {
      trades,
      metadata: {
        source: 'persisted',
        chain: input.chain,
        walletAddress: input.walletAddress,
        fromTimestamp: input.fromTimestamp,
        toTimestamp: input.toTimestamp,
        tradesReturned: trades.length,
        warnings: [],
      },
    };
  } catch (error) {
    return {
      trades: [],
      metadata: {
        source: 'persisted',
        chain: input.chain,
        walletAddress: input.walletAddress,
        fromTimestamp: input.fromTimestamp,
        toTimestamp: input.toTimestamp,
        tradesReturned: 0,
        warnings: [
          `persisted_trade_query_failed:${error instanceof Error ? error.message : 'unknown_error'}`,
          'falling_back_to_empty_trade_set',
        ],
      },
    };
  }
}
