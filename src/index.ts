import { createBot } from './bot/bot.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';

async function main() {
  const bot = createBot();
  if (env.TELEGRAM_BOT_TOKEN) {
    await bot.launch();
    logger.info('Telegram bot launched');
  } else {
    logger.warn('TELEGRAM_BOT_TOKEN is missing; bot not started');
  }
}

main().catch((error) => {
  logger.error({ error }, 'Fatal startup error');
  process.exit(1);
});