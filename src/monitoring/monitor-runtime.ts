import path from 'node:path';
import { env, validateMonitorStartupConfig } from '../config/env.js';
import type { Args } from '../cli/monitor-poll.js';
import type { EvmSupportedChain, ExplorerProviderMode, MonitorActivityProviderMode, WalletActivityProfile } from './monitoring.types.js';

export interface MonitorRuntimeOptions {
  outDir?: string;
  dryRun?: boolean;
  sendTelegram?: boolean;
  chains?: EvmSupportedChain[];
  maxWallets?: number;
  ethereumBlocks?: number;
  baseBlocks?: number;
  bscBlocks?: number;
  getLogsMaxBlockRange?: number;
  maxGetLogsChunksPerRun?: number;
  maxTxContextLookups?: number;
  activityProvider?: MonitorActivityProviderMode;
  explorerProvider?: ExplorerProviderMode;
  walletActivityProfile?: WalletActivityProfile;
}

const ACTIVITY_PROVIDER_MODES = new Set<MonitorActivityProviderMode>([
  'auto',
  'rpc-addressless',
  'rpc-wallet-activity',
  'rpc-known-tokens',
  'explorer',
  'auto-indexer',
]);

const EXPLORER_PROVIDER_MODES = new Set<ExplorerProviderMode>(['auto', 'blockscout', 'etherscan']);

export function parseMonitorActivityProvider(value: string | undefined): MonitorActivityProviderMode | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (!ACTIVITY_PROVIDER_MODES.has(normalized as MonitorActivityProviderMode)) {
    throw new Error(
      `Invalid --activity-provider value "${value}". Allowed: ${Array.from(ACTIVITY_PROVIDER_MODES).join(', ')}`,
    );
  }
  return normalized as MonitorActivityProviderMode;
}

export function parseExplorerProvider(value: string | undefined): ExplorerProviderMode | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (!EXPLORER_PROVIDER_MODES.has(normalized as ExplorerProviderMode)) {
    throw new Error(
      `Invalid --explorer-provider value "${value}". Allowed: ${Array.from(EXPLORER_PROVIDER_MODES).join(', ')}`,
    );
  }
  return normalized as ExplorerProviderMode;
}

export function buildMonitorArgsFromEnv(options: MonitorRuntimeOptions = {}): Args {
  const sendTelegram = options.sendTelegram ?? !env.MONITOR_DRY_RUN;
  const dryRun = options.dryRun ?? env.MONITOR_DRY_RUN;
  validateMonitorStartupConfig({ dryRun, sendTelegram });
  return {
    watchlist: env.MONITOR_WATCHLIST_PATH,
    chains: options.chains ?? env.MONITOR_CHAINS.split(',').map((x) => x.trim()).filter(Boolean) as EvmSupportedChain[],
    maxWallets: options.maxWallets ?? env.MONITOR_MAX_WALLETS,
    ethereumBlocks: options.ethereumBlocks ?? env.MONITOR_ETHEREUM_BLOCKS,
    baseBlocks: options.baseBlocks ?? env.MONITOR_BASE_BLOCKS,
    bscBlocks: options.bscBlocks ?? env.MONITOR_BSC_BLOCKS,
    out: options.outDir ?? env.MONITOR_OUTPUT_DIR,
    activityProvider: options.activityProvider ?? env.MONITOR_ACTIVITY_PROVIDER,
    explorerProvider: options.explorerProvider ?? env.MONITOR_EXPLORER_PROVIDER,
    knownTokens: env.MONITOR_KNOWN_TOKENS_PATH,
    getLogsMaxBlockRange: options.getLogsMaxBlockRange ?? env.MONITOR_GETLOGS_MAX_BLOCK_RANGE,
    maxGetLogsChunksPerRun: options.maxGetLogsChunksPerRun ?? env.MONITOR_MAX_GETLOGS_CHUNKS_PER_RUN,
    telegramDryRun: dryRun,
    sendTelegram,
    telegramChatId: env.TELEGRAM_DEFAULT_CHAT_ID,
    txContext: env.MONITOR_TX_CONTEXT,
    maxTxContextLookups: options.maxTxContextLookups ?? env.MONITOR_MAX_TX_CONTEXT_LOOKUPS,
    walletActivityProfile: options.walletActivityProfile ?? env.MONITOR_WALLET_ACTIVITY_PROFILE,
    walletActivityMaxEventsPerWallet: env.MONITOR_WALLET_ACTIVITY_MAX_EVENTS_PER_WALLET,
    walletActivityMaxUniqueTokens: env.MONITOR_WALLET_ACTIVITY_MAX_UNIQUE_TOKENS,
  };
}

export function runOutputDir(baseDir: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return path.join(baseDir, 'runs', stamp);
}
