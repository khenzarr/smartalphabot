import path from 'node:path';
import { env, validateMonitorStartupConfig } from '../config/env.js';
import type { Args } from '../cli/monitor-poll.js';
import type { EvmSupportedChain } from './monitoring.types.js';

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
    activityProvider: env.MONITOR_ACTIVITY_PROVIDER,
    explorerProvider: env.MONITOR_EXPLORER_PROVIDER,
    knownTokens: env.MONITOR_KNOWN_TOKENS_PATH,
    getLogsMaxBlockRange: options.getLogsMaxBlockRange ?? env.MONITOR_GETLOGS_MAX_BLOCK_RANGE,
    maxGetLogsChunksPerRun: options.maxGetLogsChunksPerRun ?? env.MONITOR_MAX_GETLOGS_CHUNKS_PER_RUN,
    telegramDryRun: dryRun,
    sendTelegram,
    telegramChatId: env.TELEGRAM_DEFAULT_CHAT_ID,
    txContext: env.MONITOR_TX_CONTEXT,
    maxTxContextLookups: options.maxTxContextLookups ?? env.MONITOR_MAX_TX_CONTEXT_LOOKUPS,
  };
}

export function runOutputDir(baseDir: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return path.join(baseDir, 'runs', stamp);
}
