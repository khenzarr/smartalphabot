import type { Telegraf } from 'telegraf';

export const PRODUCT_MENU_COMMANDS = [
  { command: 'start', description: 'Main menu' },
  { command: 'status', description: 'Bot and worker status' },
  { command: 'admin_status', description: 'Admin runtime summary' },
  { command: 'signals', description: 'Signal notification filters' },
  { command: 'preview_signal', description: 'Preview production signal card' },
  { command: 'watchlist', description: 'Smart wallet watchlist' },
  { command: 'review', description: 'Alpha wallet review queue' },
  { command: 'promote', description: 'Promote review wallet to monitor' },
  { command: 'reject', description: 'Reject review wallet' },
  { command: 'monitor_now', description: 'Run one-shot monitor poll' },
  { command: 'discovery_now', description: 'Run one-shot discovery dry-run' },
  { command: 'alpha_wallet_ekle', description: 'Add/check alpha wallet' },
  { command: 'cancel', description: 'Cancel current input' },
  { command: 'help', description: 'Help and usage' },
  { command: 'copytrade', description: 'Copy trade strategies' },
  { command: 'positions', description: 'Open positions' },
  { command: 'wallet', description: 'Trading wallet controls' },
  { command: 'settings', description: 'Signal and alert settings' },
] as const;

export async function registerBotCommands(bot: Telegraf) {
  await bot.telegram.setMyCommands([...PRODUCT_MENU_COMMANDS]);
}
