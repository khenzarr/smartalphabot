import { createPublicClient, http } from 'viem';
import { base, bsc, mainnet } from 'viem/chains';
import type { SupportedChain } from '../../chains/chain.types.js';
import { CHAIN_CONFIGS } from '../../chains/chain.config.js';
import { env } from '../../config/env.js';

const evmChainMap = {
  ethereum: mainnet,
  base,
  bsc,
} as const;

type EvmPublicClient = ReturnType<typeof createPublicClient>;
const clients = new Map<SupportedChain, EvmPublicClient>();

export function getEvmRpcUrl(chain: SupportedChain): string | undefined {
  if (chain === 'solana') return undefined;
  const varName = CHAIN_CONFIGS[chain].rpcEnvVar;
  return env[varName];
}

export function getEvmPublicClient(chain: SupportedChain): EvmPublicClient {
  if (chain === 'solana') {
    throw new Error('solana_not_supported_by_evm_public_client');
  }

  const cached = clients.get(chain);
  if (cached) return cached;

  const rpcUrl = getEvmRpcUrl(chain);
  if (!rpcUrl) {
    throw new Error(`missing_rpc_url_for_chain:${chain}`);
  }

  const chainConfig = evmChainMap[chain] as (typeof evmChainMap)['ethereum'];
  const client = createPublicClient({
    chain: chainConfig,
    transport: http(rpcUrl, { retryCount: 2, timeout: 15_000 }),
  });

  clients.set(chain, client);
  return client;
}
