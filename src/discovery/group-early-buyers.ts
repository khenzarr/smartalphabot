import type { NormalizedTrade } from '../chains/chain.types.js';

export interface EarlyBuyerSummary {
  walletAddress: string;
  firstBuyTxHash: string;
  firstBuyBlockNumber?: number;
  firstBuyTimestamp: Date;
  firstBuyAmountToken: number;
  totalBuyAmountToken: number;
  buyCount: number;
  firstBuyRaw?: unknown;
  approximateQuoteSpent?: number;
  approximateUsdSpent?: number;
  warnings: string[];
}

export function groupEarlyBuyers(buyTrades: NormalizedTrade[], maxBuyers = 100): EarlyBuyerSummary[] {
  if (!buyTrades.length) return [];

  const grouped = new Map<string, EarlyBuyerSummary>();

  for (const trade of buyTrades) {
    const key = trade.walletAddress.toLowerCase();
    const existing = grouped.get(key);
    const tradeWarnings = extractWarningsFromRawTrade(trade.raw);

    if (!existing) {
      grouped.set(key, {
        walletAddress: trade.walletAddress,
        firstBuyTxHash: trade.txHash,
        firstBuyBlockNumber: trade.blockNumber,
        firstBuyTimestamp: trade.timestamp,
        firstBuyAmountToken: trade.amountToken,
        totalBuyAmountToken: trade.amountToken,
        buyCount: 1,
        firstBuyRaw: trade.raw,
        approximateQuoteSpent: undefined,
        approximateUsdSpent: trade.amountUsd,
        warnings: [...tradeWarnings],
      });
      continue;
    }

    existing.buyCount += 1;
    existing.totalBuyAmountToken += trade.amountToken;
    if (trade.amountUsd !== undefined) {
      existing.approximateUsdSpent = (existing.approximateUsdSpent ?? 0) + trade.amountUsd;
    }
    existing.warnings.push(...tradeWarnings);

    if (isEarlier(trade, existing)) {
      existing.firstBuyTxHash = trade.txHash;
      existing.firstBuyBlockNumber = trade.blockNumber;
      existing.firstBuyTimestamp = trade.timestamp;
      existing.firstBuyAmountToken = trade.amountToken;
      existing.firstBuyRaw = trade.raw;
    }
  }

  return [...grouped.values()]
    .map((summary) => ({ ...summary, warnings: [...new Set(summary.warnings)] }))
    .sort((a, b) => {
      const aBlock = a.firstBuyBlockNumber ?? Number.MAX_SAFE_INTEGER;
      const bBlock = b.firstBuyBlockNumber ?? Number.MAX_SAFE_INTEGER;
      if (aBlock !== bBlock) return aBlock - bBlock;
      return a.firstBuyTimestamp.getTime() - b.firstBuyTimestamp.getTime();
    })
    .slice(0, Math.max(0, maxBuyers));
}

function isEarlier(trade: NormalizedTrade, existing: EarlyBuyerSummary): boolean {
  if (trade.blockNumber !== undefined && existing.firstBuyBlockNumber !== undefined) {
    return trade.blockNumber < existing.firstBuyBlockNumber;
  }
  return trade.timestamp.getTime() < existing.firstBuyTimestamp.getTime();
}

function extractWarningsFromRawTrade(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const maybeWarnings = (raw as { warnings?: unknown }).warnings;
  if (!Array.isArray(maybeWarnings)) return [];
  return maybeWarnings.filter((x): x is string => typeof x === 'string');
}
