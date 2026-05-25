import { Decimal } from 'decimal.js';
import type { CurrentTokenPriceMap, TokenWalletPerformance, WalletPerformanceComputationResult, WalletPerformanceSummary } from './wallet-performance.types.js';
import type { NormalizedTrade, SupportedChain } from '../chains/chain.types.js';

function sortTrades(trades: NormalizedTrade[]): NormalizedTrade[] {
  return [...trades].sort((a, b) => {
    const t = a.timestamp.getTime() - b.timestamp.getTime();
    if (t !== 0) return t;
    const block = (a.blockNumber ?? Number.MAX_SAFE_INTEGER) - (b.blockNumber ?? Number.MAX_SAFE_INTEGER);
    if (block !== 0) return block;
    return (a.txHash ?? '').localeCompare(b.txHash ?? '');
  });
}

function toDecimal(value: unknown): Decimal | undefined {
  if (value === null || value === undefined) return undefined;
  try {
    const decimal = new Decimal(value as Decimal.Value);
    return decimal.isFinite() ? decimal : undefined;
  } catch {
    return undefined;
  }
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function average(values: number[]): number | undefined {
  if (!values.length) return undefined;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function safeNumber(value: Decimal | undefined): number | undefined {
  if (!value) return undefined;
  return value.toNumber();
}

interface OpenLot {
  amountToken: Decimal;
  amountUsd?: Decimal;
  timestamp: Date;
}

export function calculateWalletPerformance(input: {
  chain: SupportedChain;
  walletAddress: string;
  trades: NormalizedTrade[];
  currentPrices?: CurrentTokenPriceMap;
  now?: Date;
}): WalletPerformanceComputationResult {
  const now = input.now ?? new Date();
  const warnings = new Set<string>();
  const limitations = new Set<string>(['approximate_pnl_average_cost_basis']);
  const trades = sortTrades(input.trades).filter((trade, index, arr) => {
    const key = `${trade.chain}:${trade.walletAddress.toLowerCase()}:${trade.tokenAddress.toLowerCase()}:${trade.txHash}:${trade.side}:${trade.timestamp.toISOString()}:${trade.blockNumber ?? ''}:${trade.slot ?? ''}`;
    return arr.findIndex((candidate) => `${candidate.chain}:${candidate.walletAddress.toLowerCase()}:${candidate.tokenAddress.toLowerCase()}:${candidate.txHash}:${candidate.side}:${candidate.timestamp.toISOString()}:${candidate.blockNumber ?? ''}:${candidate.slot ?? ''}` === key) === index;
  });

  const grouped = new Map<string, NormalizedTrade[]>();
  for (const trade of trades) {
    const key = trade.tokenAddress.toLowerCase();
    const list = grouped.get(key) ?? [];
    list.push(trade);
    grouped.set(key, list);
  }

  const tokenPerformances: TokenWalletPerformance[] = [];
  const roiValues: number[] = [];
  const holdValues: number[] = [];
  let totalTrades = 0;
  let totalBuys = 0;
  let totalSells = 0;
  let totalRealized = 0;
  let totalUnrealized = 0;
  let closedPositionCount = 0;
  let openPositionCount = 0;
  let winCount = 0;

  for (const [tokenAddress, tokenTrades] of grouped.entries()) {
    const buys = tokenTrades.filter((trade) => trade.side === 'buy');
    const sells = tokenTrades.filter((trade) => trade.side === 'sell');
    const tokenWarnings = new Set<string>();
    const priceInfo = input.currentPrices?.[tokenAddress];

    const totalBoughtToken = buys.reduce((acc, trade) => acc.plus(toDecimal(trade.amountToken) ?? 0), new Decimal(0));
    const totalSoldToken = sells.reduce((acc, trade) => acc.plus(toDecimal(trade.amountToken) ?? 0), new Decimal(0));
    const remainingToken = Decimal.max(0, totalBoughtToken.minus(totalSoldToken));

    const hasUsd = tokenTrades.some((trade) => trade.amountUsd !== undefined);
    if (!hasUsd) tokenWarnings.add('missing_usd_trade_data');
    if (tokenTrades.some((trade) => trade.amountToken === undefined || trade.amountToken === null)) tokenWarnings.add('missing_token_amount_data');
    if (totalSoldToken.greaterThan(totalBoughtToken)) tokenWarnings.add('sell_exceeds_buy');

    const totalBuyUsd = buys.reduce((acc, trade) => acc.plus(toDecimal(trade.amountUsd) ?? 0), new Decimal(0));
    const totalSellUsd = sells.reduce((acc, trade) => acc.plus(toDecimal(trade.amountUsd) ?? 0), new Decimal(0));

    const averageBuyPriceUsd = totalBoughtToken.gt(0) && totalBuyUsd.gt(0) ? safeNumber(totalBuyUsd.div(totalBoughtToken)) : undefined;
    const averageSellPriceUsd = totalSoldToken.gt(0) && totalSellUsd.gt(0) ? safeNumber(totalSellUsd.div(totalSoldToken)) : undefined;

    const lots: OpenLot[] = [];
    for (const trade of tokenTrades) {
      if (trade.side === 'buy') {
        lots.push({
          amountToken: toDecimal(trade.amountToken) ?? new Decimal(0),
          amountUsd: toDecimal(trade.amountUsd),
          timestamp: trade.timestamp,
        });
        continue;
      }

      let remainingToMatch = toDecimal(trade.amountToken) ?? new Decimal(0);
      while (remainingToMatch.gt(0) && lots.length) {
        const head = lots[0];
        if (!head) break;
        const matched = Decimal.min(head.amountToken, remainingToMatch);
        head.amountToken = head.amountToken.minus(matched);
        remainingToMatch = remainingToMatch.minus(matched);
        if (head.amountToken.lte(0)) lots.shift();
      }
      if (remainingToMatch.gt(0)) tokenWarnings.add('sell_exceeds_buy');
    }

    const soldToken = Decimal.min(totalSoldToken, totalBoughtToken);
    const soldRatio = totalBoughtToken.gt(0) ? soldToken.div(totalBoughtToken) : new Decimal(0);

    let realizedPnlUsd: number | undefined;
    if (soldToken.gt(0) && totalSellUsd.gt(0) && totalBuyUsd.gt(0)) {
      const realizedCostBasis = totalBuyUsd.mul(soldRatio);
      realizedPnlUsd = safeNumber(totalSellUsd.minus(realizedCostBasis));
    }

    let unrealizedPnlUsd: number | undefined;
    if (remainingToken.gt(0)) {
      if (priceInfo?.priceUsd !== undefined && averageBuyPriceUsd !== undefined) {
        unrealizedPnlUsd = remainingToken.mul(priceInfo.priceUsd).minus(remainingToken.mul(averageBuyPriceUsd)).toNumber();
      } else {
        tokenWarnings.add('missing_current_price_for_open_position');
      }
    }

    const totalPnlUsd = (realizedPnlUsd ?? 0) + (unrealizedPnlUsd ?? 0);
    const costBasis = totalBuyUsd.toNumber();
    const roi = costBasis > 0 ? totalPnlUsd / costBasis : undefined;

    const firstBuy = buys[0];
    const firstSell = sells[0];
    const firstBuyAt = firstBuy?.timestamp;
    const firstSellAt = firstSell?.timestamp;
    const isOpenPosition = remainingToken.gt(0);
    const holdDurationSeconds = firstBuyAt
      ? Math.max(0, Math.floor(((isOpenPosition ? now : (sells.at(-1)?.timestamp ?? now)).getTime() - firstBuyAt.getTime()) / 1000))
      : undefined;
    if (isOpenPosition) tokenWarnings.add('open_position_hold_duration_uses_now');
    if (!sells.length && buys.length) tokenWarnings.add('no_sell_trade_for_token');
    if (sells.length && !firstSellAt) tokenWarnings.add('missing_first_sell_timestamp');

    const isWinner = realizedPnlUsd !== undefined ? realizedPnlUsd > 0 : undefined;
    if (roi !== undefined) roiValues.push(roi);
    if (holdDurationSeconds !== undefined) holdValues.push(holdDurationSeconds);
    if (isWinner === true) winCount += 1;
    if (isOpenPosition) openPositionCount += 1; else closedPositionCount += 1;

    totalTrades += tokenTrades.length;
    totalBuys += buys.length;
    totalSells += sells.length;
    totalRealized += realizedPnlUsd ?? 0;
    totalUnrealized += unrealizedPnlUsd ?? 0;

    tokenPerformances.push({
      chain: input.chain,
      walletAddress: input.walletAddress,
      tokenAddress,
      tokenSymbol: priceInfo?.symbol,
      firstBuyAt,
      firstBuyBlockNumber: firstBuy?.blockNumber,
      firstBuyTxHash: firstBuy?.txHash,
      firstSellAt,
      totalBoughtToken: totalBoughtToken.toNumber(),
      totalSoldToken: totalSoldToken.toNumber(),
      remainingToken: remainingToken.toNumber(),
      totalBuyUsd: totalBuyUsd.gt(0) ? totalBuyUsd.toNumber() : undefined,
      totalSellUsd: totalSellUsd.gt(0) ? totalSellUsd.toNumber() : undefined,
      averageBuyPriceUsd,
      averageSellPriceUsd,
      realizedPnlUsd,
      unrealizedPnlUsd,
      totalPnlUsd,
      roi,
      holdDurationSeconds,
      isOpenPosition,
      isWinner,
      tradeCount: tokenTrades.length,
      buyCount: buys.length,
      sellCount: sells.length,
      warnings: [...tokenWarnings],
    });

    tokenWarnings.forEach((warning) => warnings.add(`${tokenAddress}:${warning}`));
  }

  if (!tokenPerformances.length) warnings.add('no_trades_after_normalization');
  if (trades.length !== input.trades.length) warnings.add('duplicate_trades_removed_during_normalization');
  if (tokenPerformances.some((x) => x.isOpenPosition)) limitations.add('open_positions_require_current_price_for_unrealized_pnl');
  if (tokenPerformances.some((x) => x.warnings.some((w) => w.includes('missing_usd')))) {
    limitations.add('missing_trade_usd_values_reduce_pnl_accuracy');
  }

  const summary: WalletPerformanceSummary = {
    chain: input.chain,
    walletAddress: input.walletAddress,
    analyzedTokenCount: tokenPerformances.length,
    closedPositionCount,
    openPositionCount,
    totalTrades,
    totalBuys,
    totalSells,
    totalRealizedPnlUsd: tokenPerformances.length ? totalRealized : undefined,
    totalUnrealizedPnlUsd: tokenPerformances.length ? totalUnrealized : undefined,
    totalPnlUsd: tokenPerformances.length ? totalRealized + totalUnrealized : undefined,
    winRate: tokenPerformances.length ? winCount / tokenPerformances.length : undefined,
    medianRoi: median(roiValues),
    averageRoi: average(roiValues),
    averageHoldSeconds: average(holdValues),
    medianHoldSeconds: median(holdValues),
    earlyEntryCount: undefined,
    successfulEarlyEntryCount: undefined,
    rugExposureCount: undefined,
    warnings: [...warnings],
    limitations: [...limitations],
  };

  return {
    summary,
    tokenPerformances,
    warnings: [...warnings],
    limitations: [...limitations],
    normalizedTrades: trades,
  };
}
