import type { SupportedChain } from '@prisma/client';
import type { NormalizedTokenProfile } from '../../chains/chain.types.js';
import { prisma } from '../prisma.js';

export async function upsertTokenProfile(profile: NormalizedTokenProfile) {
  return prisma.token.upsert({
    where: { chain_address: { chain: profile.chain as SupportedChain, address: profile.tokenAddress } },
    update: {
      symbol: profile.symbol,
      name: profile.name,
      pairAddress: profile.pairAddress,
      poolAddress: profile.poolAddress,
      dexId: profile.dexId,
      marketCap: profile.marketCap,
      fdv: profile.fdv,
      liquidityUsd: profile.liquidityUsd,
      priceUsd: profile.priceUsd,
      pairCreatedAt: profile.pairCreatedAt,
      metadataRaw: profile.raw as object | undefined,
    },
    create: {
      chain: profile.chain as SupportedChain,
      chainFamily: profile.chainFamily,
      address: profile.tokenAddress,
      symbol: profile.symbol,
      name: profile.name,
      pairAddress: profile.pairAddress,
      poolAddress: profile.poolAddress,
      dexId: profile.dexId,
      marketCap: profile.marketCap,
      fdv: profile.fdv,
      liquidityUsd: profile.liquidityUsd,
      priceUsd: profile.priceUsd,
      pairCreatedAt: profile.pairCreatedAt,
      metadataRaw: profile.raw as object | undefined,
    },
  });
}
