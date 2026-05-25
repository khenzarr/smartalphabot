import type { EvmSupportedChain } from './monitoring.types.js';

export interface KnownDexAddressSet {
  routers: Set<string>;
  factories: Set<string>;
  extras: Set<string>;
}

function toSet(addresses: string[]): Set<string> {
  return new Set(addresses.map((x) => x.toLowerCase()));
}

const KNOWN: Record<EvmSupportedChain, KnownDexAddressSet> = {
  ethereum: {
    routers: toSet([
      '0x7a250d5630b4cf539739df2c5dacab4c659f2488', // Uniswap V2 Router02
      '0xe592427a0aece92de3edee1f18e0157c05861564', // Uniswap V3 SwapRouter
      '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', // Uniswap V3 SwapRouter02
      '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', // Uniswap Universal Router
    ]),
    factories: toSet([
      '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f', // Uniswap V2 Factory
      '0x1f98431c8ad98523631ae4a59f267346ea31f984', // Uniswap V3 Factory
    ]),
    extras: toSet([
      '0xdef1c0ded9bec7f1a1670819833240f027b25eff', // 0x Exchange Proxy
      '0x000000000022d473030f116ddee9f6b43ac78ba3', // Permit2
    ]),
  },
  base: {
    routers: toSet([
      '0x2626664c2603336e57b271c5c0b26f421741e481', // Uniswap V3 SwapRouter02 (Base)
      '0x6ff5693b99212da76ad316178a184ab56d299b43', // Uniswap Universal Router (Base)
      // TODO: keep Base router list conservative; add only verified addresses.
    ]),
    factories: toSet([
      '0x33128a8fc17869897dce68ed026d694621f6fdfd', // Uniswap V3 Factory (Base)
    ]),
    extras: toSet([
      // TODO: Aerodrome/BaseSwap addresses intentionally excluded until validated in-project.
    ]),
  },
  bsc: {
    routers: toSet([]),
    factories: toSet([]),
    extras: toSet([]),
  },
};

export function getKnownDexAddresses(chain: EvmSupportedChain): KnownDexAddressSet {
  return KNOWN[chain];
}

export function isKnownDexAddress(chain: EvmSupportedChain, address?: string): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  const set = KNOWN[chain];
  return set.routers.has(normalized) || set.factories.has(normalized) || set.extras.has(normalized);
}
