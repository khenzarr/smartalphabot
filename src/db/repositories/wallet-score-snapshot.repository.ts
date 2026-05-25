import type { SupportedChain } from '@prisma/client';
import { prisma } from '../prisma.js';

export async function createWalletScoreSnapshot(input: {
  walletId: string;
  chain: SupportedChain;
  score: number;
  category: string;
  reasons: string[];
  riskFlags: string[];
}) {
  return prisma.walletScoreSnapshot.create({
    data: {
      walletId: input.walletId,
      chain: input.chain,
      score: input.score,
      category: input.category,
      reasons: input.reasons,
      riskFlags: input.riskFlags,
    },
  });
}
