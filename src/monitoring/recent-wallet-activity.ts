import type { PublicClient } from 'viem';
import type { EvmSupportedChain, MonitorWalletRecord, RecentWalletTokenEvent } from './monitoring.types.js';
import { RpcAddresslessActivityProvider } from './wallet-activity-providers.js';

export interface RecentWalletActivityOptions {
  chains: EvmSupportedChain[];
  maxWallets?: number;
  maxLogsPerWallet?: number;
  blockWindows?: Partial<Record<EvmSupportedChain, number>>;
  clientFactory?: (chain: EvmSupportedChain) => PublicClient;
}

export async function scanRecentWalletActivity(
  wallets: MonitorWalletRecord[],
  options: RecentWalletActivityOptions,
): Promise<RecentWalletTokenEvent[]> {
  const provider = new RpcAddresslessActivityProvider();
  const result = await provider.getRecentIncomingTokenEvents({
    wallets,
    chains: options.chains,
    maxWallets: options.maxWallets,
    maxLogsPerWallet: options.maxLogsPerWallet,
    blockWindows: options.blockWindows,
    clientFactory: options.clientFactory,
  });
  if (result.errors.length > 0) {
    throw new Error(result.errors[0]?.message ?? 'wallet_activity_scan_failed');
  }
  return result.events;
}
