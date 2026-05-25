import type { SupportedChain, TradeSide } from '@prisma/client';
import type { NormalizedTrade } from '../../chains/chain.types.js';
import { prisma } from '../prisma.js';

export async function upsertTrade(params: {
  trade: NormalizedTrade;
  walletId: string;
  tokenId: string;
}) {
  const { trade, walletId, tokenId } = params;
  return prisma.trade.upsert({
    where: {
      chain_txHash_walletId_tokenId: {
        chain: trade.chain as SupportedChain,
        txHash: trade.txHash,
        walletId,
        tokenId,
      },
    },
    update: {
      side: trade.side as TradeSide,
      amountToken: trade.amountToken,
      amountUsd: trade.amountUsd,
      priceUsd: trade.priceUsd,
      marketCapAtTrade: trade.marketCapAtTrade,
      liquidityAtTrade: trade.liquidityAtTrade,
      blockNumber: trade.blockNumber,
      slot: trade.slot,
      timestamp: trade.timestamp,
      dex: trade.dex,
      raw: trade.raw as object | undefined,
    },
    create: {
      chain: trade.chain as SupportedChain,
      chainFamily: trade.chainFamily,
      txHash: trade.txHash,
      side: trade.side as TradeSide,
      amountToken: trade.amountToken,
      amountUsd: trade.amountUsd,
      priceUsd: trade.priceUsd,
      marketCapAtTrade: trade.marketCapAtTrade,
      liquidityAtTrade: trade.liquidityAtTrade,
      blockNumber: trade.blockNumber,
      slot: trade.slot,
      timestamp: trade.timestamp,
      dex: trade.dex,
      raw: trade.raw as object | undefined,
      walletId,
      tokenId,
    },
  });
}

export async function findTradesByWallet(input: {
  chain: SupportedChain;
  walletAddress: string;
  tokenAddress?: string;
  fromTimestamp?: Date;
  toTimestamp?: Date;
  maxTrades?: number;
}): Promise<NormalizedTrade[]> {
  const rows = await prisma.trade.findMany({
    where: {
      chain: input.chain,
      wallet: { address: input.walletAddress },
      ...(input.tokenAddress ? { token: { address: input.tokenAddress } } : {}),
      ...(input.fromTimestamp || input.toTimestamp
        ? {
            timestamp: {
              ...(input.fromTimestamp ? { gte: input.fromTimestamp } : {}),
              ...(input.toTimestamp ? { lte: input.toTimestamp } : {}),
            },
          }
        : {}),
    },
    orderBy: [{ timestamp: 'asc' }, { blockNumber: 'asc' }],
    take: input.maxTrades,
    include: {
      wallet: true,
      token: true,
    },
  });

  return rows.map((row) => ({
    chain: row.chain as unknown as NormalizedTrade['chain'],
    chainFamily: row.chainFamily,
    walletAddress: row.wallet.address,
    tokenAddress: row.token.address,
    txHash: row.txHash,
    side: row.side,
    amountToken: Number(row.amountToken),
    amountUsd: row.amountUsd === null ? undefined : Number(row.amountUsd),
    priceUsd: row.priceUsd === null ? undefined : Number(row.priceUsd),
    marketCapAtTrade: row.marketCapAtTrade === null ? undefined : Number(row.marketCapAtTrade),
    liquidityAtTrade: row.liquidityAtTrade === null ? undefined : Number(row.liquidityAtTrade),
    blockNumber: row.blockNumber === null ? undefined : Number(row.blockNumber),
    slot: row.slot === null ? undefined : Number(row.slot),
    timestamp: row.timestamp,
    dex: row.dex ?? undefined,
    raw: row.raw,
  }));
}
