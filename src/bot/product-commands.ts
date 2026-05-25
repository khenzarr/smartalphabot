import type { Telegraf } from 'telegraf';

export const PRODUCT_MENU_COMMANDS = [
  { command: 'start', description: 'Main menu' },
  { command: 'status', description: 'Bot and worker status' },
  { command: 'signals', description: 'Signal notification filters' },
  { command: 'watchlist', description: 'Smart wallet watchlist' },
  { command: 'alpha_wallet_ekle', description: 'Add/check alpha wallet' },
  { command: 'help', description: 'Help and usage' },
  { command: 'copytrade', description: 'Copy trade strategies' },
  { command: 'positions', description: 'Open positions' },
  { command: 'wallet', description: 'Trading wallet controls' },
  { command: 'settings', description: 'Signal and alert settings' },
] as const;

export async function registerBotCommands(bot: Telegraf) {
  await bot.telegram.setMyCommands([...PRODUCT_MENU_COMMANDS]);
}
