import { Telegraf } from 'telegraf';
import { env } from '../config/env.js';
import { registerCommands } from './commands/register.js';

export function createBot() {
  const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN ?? '');
  registerCommands(bot);
  return bot;
}
