import type { ChainFamily, SupportedChain } from './chain.types.js';

export interface ChainConfig {
  key: SupportedChain;
  displayName: string;
  chainFamily: ChainFamily;
  chainId?: number;
  nativeCurrency: string;
  explorerBaseUrl: string;
  dexScreenerSlug?: string;
  rpcEnvVar: 'ETHEREUM_RPC_URL' | 'BASE_RPC_URL' | 'BSC_RPC_URL' | 'SOLANA_RPC_URL';
  enabled: boolean;
}

export const CHAIN_CONFIGS: Record<SupportedChain, ChainConfig> = {
  ethereum: {
    key: 'ethereum',
    displayName: 'Ethereum Mainnet',
    chainFamily: 'evm',
    chainId: 1,
    nativeCurrency: 'ETH',
    explorerBaseUrl: 'https://etherscan.io',
    dexScreenerSlug: 'ethereum',
    rpcEnvVar: 'ETHEREUM_RPC_URL',
    enabled: true,
  },
  base: {
    key: 'base',
    displayName: 'Base',
    chainFamily: 'evm',
    chainId: 8453,
    nativeCurrency: 'ETH',
    explorerBaseUrl: 'https://basescan.org',
    dexScreenerSlug: 'base',
    rpcEnvVar: 'BASE_RPC_URL',
    enabled: true,
  },
  bsc: {
    key: 'bsc',
    displayName: 'BNB Chain',
    chainFamily: 'evm',
    chainId: 56,
    nativeCurrency: 'BNB',
    explorerBaseUrl: 'https://bscscan.com',
    dexScreenerSlug: 'bsc',
    rpcEnvVar: 'BSC_RPC_URL',
    enabled: true,
  },
  solana: {
    key: 'solana',
    displayName: 'Solana',
    chainFamily: 'solana',
    nativeCurrency: 'SOL',
    explorerBaseUrl: 'https://solscan.io',
    dexScreenerSlug: 'solana',
    rpcEnvVar: 'SOLANA_RPC_URL',
    enabled: true,
  },
};
