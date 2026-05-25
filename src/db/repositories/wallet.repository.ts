import type { SupportedChain } from '@prisma/client';
import { prisma } from '../prisma.js';

export async function getWalletByAddress(chain: SupportedChain, address: string) {
  return prisma.wallet.findUnique({ where: { chain_address: { chain, address } } });
}

export async function upsertCandidateWallet(chain: SupportedChain, address: string) {
  return prisma.wallet.upsert({
    where: { chain_address: { chain, address } },
    update: {},
    create: {
      chain,
      chainFamily: chain === 'solana' ? 'solana' : 'evm',
      address,
      label: 'candidate',
    },
  });
}

export async function upsertSeedBatchCandidateWallet(input: {
  chain: SupportedChain;
  address: string;
  scoreLatest?: number;
  label?: string;
}) {
  return prisma.wallet.upsert({
    where: { chain_address: { chain: input.chain, address: input.address } },
    update: {
      label: input.label ?? 'candidate',
      scoreLatest: input.scoreLatest,
    },
    create: {
      chain: input.chain,
      chainFamily: input.chain === 'solana' ? 'solana' : 'evm',
      address: input.address,
      label: input.label ?? 'candidate',
      scoreLatest: input.scoreLatest,
      isSmart: false,
    },
  });
}
