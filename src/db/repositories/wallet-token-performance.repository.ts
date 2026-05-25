import { prisma } from '../prisma.js';

export async function upsertWalletTokenPerformance(input: {
  walletId: string;
  tokenId: string;
  chain: 'ethereum' | 'base' | 'bsc' | 'solana';
  totalBuys?: number;
  totalSells?: number;
  realizedPnlUsd?: number;
  unrealizedPnlUsd?: number;
  roi?: number;
  averageHoldSeconds?: number;
  medianHoldSeconds?: number;
  earlyEntry?: boolean;
  successfulEarlyEntry?: boolean;
  rugExposure?: boolean;
  firstBuyAt?: Date;
  firstBuyMarketCap?: number;
  firstBuyTxHash?: string;
}) {
  return prisma.walletTokenPerformance.upsert({
    where: {
      walletId_tokenId: {
        walletId: input.walletId,
        tokenId: input.tokenId,
      },
    },
    update: {
      totalBuys: input.totalBuys,
      totalSells: input.totalSells,
      realizedPnlUsd: input.realizedPnlUsd,
      unrealizedPnlUsd: input.unrealizedPnlUsd,
      roi: input.roi,
      averageHoldSeconds: input.averageHoldSeconds,
      medianHoldSeconds: input.medianHoldSeconds,
      earlyEntry: input.earlyEntry,
      successfulEarlyEntry: input.successfulEarlyEntry,
      rugExposure: input.rugExposure,
      firstBuyAt: input.firstBuyAt,
      firstBuyMarketCap: input.firstBuyMarketCap,
      firstBuyTxHash: input.firstBuyTxHash,
    },
    create: {
      walletId: input.walletId,
      tokenId: input.tokenId,
      chain: input.chain,
      totalBuys: input.totalBuys ?? 0,
      totalSells: input.totalSells ?? 0,
      realizedPnlUsd: input.realizedPnlUsd,
      unrealizedPnlUsd: input.unrealizedPnlUsd,
      roi: input.roi,
      averageHoldSeconds: input.averageHoldSeconds,
      medianHoldSeconds: input.medianHoldSeconds,
      earlyEntry: input.earlyEntry ?? false,
      successfulEarlyEntry: input.successfulEarlyEntry ?? false,
      rugExposure: input.rugExposure ?? false,
      firstBuyAt: input.firstBuyAt,
      firstBuyMarketCap: input.firstBuyMarketCap,
      firstBuyTxHash: input.firstBuyTxHash,
    },
  });
}
