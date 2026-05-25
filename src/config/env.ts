import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_DEFAULT_CHAT_ID: z.string().optional(),
  TELEGRAM_SHOW_TRADE_PLACEHOLDER_BUTTONS: z.coerce.boolean().default(false),
  ETHEREUM_RPC_URL: z.string().optional(),
  BASE_RPC_URL: z.string().optional(),
  BSC_RPC_URL: z.string().optional(),
  BASE_BLOCKSCOUT_API_URL: z.string().optional(),
  ETHEREUM_BLOCKSCOUT_API_URL: z.string().optional(),
  BSC_BLOCKSCOUT_API_URL: z.string().optional(),
  ETHERSCAN_API_KEY: z.string().optional(),
  SOLANA_RPC_URL: z.string().optional(),
  DEXSCREENER_BASE_URL: z.string().url().default('https://api.dexscreener.com'),
  EVM_SCAN_CHUNK_SIZE: z.coerce.number().int().positive().optional(),
  EVM_SCAN_MAX_BLOCKS: z.coerce.number().int().positive().optional(),
  EVM_SCAN_MAX_LOGS: z.coerce.number().int().positive().optional(),
  EVM_SCAN_MAX_TRADES: z.coerce.number().int().positive().optional(),
  MONITOR_WATCHLIST_PATH: z.string().default('data/monitor-wallets.json'),
  MONITOR_KNOWN_TOKENS_PATH: z.string().default('data/monitor-known-tokens.json'),
  MONITOR_OUTPUT_DIR: z.string().default('output/monitor-worker'),
  MONITOR_CHAINS: z.string().default('ethereum,base'),
  MONITOR_ACTIVITY_PROVIDER: z.enum(['auto', 'rpc-addressless', 'rpc-known-tokens', 'explorer', 'auto-indexer']).default('rpc-known-tokens'),
  MONITOR_EXPLORER_PROVIDER: z.enum(['auto', 'blockscout', 'etherscan']).default('blockscout'),
  MONITOR_MAX_WALLETS: z.coerce.number().int().positive().default(20),
  MONITOR_ETHEREUM_BLOCKS: z.coerce.number().int().positive().default(3000),
  MONITOR_BASE_BLOCKS: z.coerce.number().int().positive().default(10000),
  MONITOR_BSC_BLOCKS: z.coerce.number().int().positive().default(10000),
  MONITOR_GETLOGS_MAX_BLOCK_RANGE: z.coerce.number().int().positive().default(10),
  MONITOR_MAX_GETLOGS_CHUNKS_PER_RUN: z.coerce.number().int().positive().default(1000),
  MONITOR_TX_CONTEXT: z.coerce.boolean().default(true),
  MONITOR_MAX_TX_CONTEXT_LOOKUPS: z.coerce.number().int().positive().default(50),
  MONITOR_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
  MONITOR_SIGNAL_MIN_CATEGORY: z.enum(['strong_signal', 'watch_signal', 'weak_signal', 'ignored']).default('watch_signal'),
  MONITOR_SEND_WEAK: z.coerce.boolean().default(false),
  MONITOR_SEND_IGNORED: z.coerce.boolean().default(false),
  MONITOR_DRY_RUN: z.coerce.boolean().default(false),
  DISCOVERY_WORKER_ENABLED: z.coerce.boolean().default(true),
  DISCOVERY_INTERVAL_SECONDS: z.coerce.number().int().positive().default(21600),
  DISCOVERY_DRY_RUN: z.coerce.boolean().default(true),
  DISCOVERY_AUTO_ADD: z.coerce.boolean().default(false),
  DISCOVERY_AUTO_ADD_MIN_SCORE: z.coerce.number().int().min(0).max(100).default(70),
  DISCOVERY_MAX_NEW_WALLETS_PER_RUN: z.coerce.number().int().positive().default(20),
  DISCOVERY_OUTPUT_DIR: z.string().default('output/discovery-worker'),
  DISCOVERY_MAX_OUTPUT_FILES: z.coerce.number().int().positive().default(50),
  DISCOVERY_MAX_FILE_BYTES: z.coerce.number().int().positive().default(10_000_000),
  ALPHA_WALLET_REVIEW_PATH: z.string().default('data/alpha-wallet-review.local.json'),
  MONITOR_KNOWN_TOKENS_MAX: z.coerce.number().int().positive().max(100).default(20),
});

export const env = schema.parse(process.env);

export function validateTelegramConfig(input: { dryRun: boolean; sendTelegram: boolean }) {
  if (input.sendTelegram && !input.dryRun && !env.TELEGRAM_BOT_TOKEN) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN: live Telegram sending is enabled but token is empty');
  }
}

export function validateMonitorStartupConfig(input: { dryRun: boolean; sendTelegram: boolean }) {
  validateTelegramConfig(input);
  if (!env.MONITOR_WATCHLIST_PATH) {
    throw new Error('Missing MONITOR_WATCHLIST_PATH');
  }
  if (!env.MONITOR_OUTPUT_DIR) {
    throw new Error('Missing MONITOR_OUTPUT_DIR');
  }
}
