import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Telegraf } from 'telegraf';
import { env } from '../config/env.js';
import { addOrUpdateTelegramChat } from './telegram-chat-state.js';
import { buildMonitorArgsFromEnv } from '../monitoring/monitor-runtime.js';
import { runMonitorPoll } from '../cli/monitor-poll.js';
import { registerBotCommands } from './product-commands.js';
import { getAlphaWalletReviewEntries } from '../discovery/alpha-wallet-review-store.js';
import { handleAlphaWalletEkle } from './alpha-wallet-command.js';
import { copytradeComingSoon, positionsComingSoon, settingsComingSoon, walletComingSoon } from './placeholder-responses.js';

async function readJsonSafe<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function botRequiredToken(): string {
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN: required for bot:start');
  return token;
}

export async function createAndStartBot() {
  const bot = new Telegraf(botRequiredToken());

  bot.start(async (ctx) => {
    await addOrUpdateTelegramChat({
      chatId: String(ctx.chat.id),
      username: ctx.from?.username,
      enabled: true,
      notes: 'Registered via /start',
    });
    await ctx.reply('SmartBot monitor online. Use /help for commands.');
  });

  bot.command('help', (ctx) => ctx.reply([
    '/start',
    '/status',
    '/signals',
    '/watchlist',
    '/alpha_wallet_ekle <walletAddress>',
    '/help',
    '/copytrade',
    '/positions',
    '/wallet',
    '/settings',
  ].join('\n')));

  bot.command('status', async (ctx) => {
    const summary = await readJsonSafe<Record<string, unknown>>(path.join(env.MONITOR_OUTPUT_DIR, 'latest-summary.json'), {});
    const discoverySummary = await readJsonSafe<Record<string, unknown>>(path.join(env.DISCOVERY_OUTPUT_DIR, 'latest-summary.json'), {});
    const watchlist = await readJsonSafe<unknown[]>(env.MONITOR_WATCHLIST_PATH, []);
    const knownTokens = await readJsonSafe<unknown[]>(env.MONITOR_KNOWN_TOKENS_PATH, []);
    const alphaReview = await readJsonSafe<unknown[]>(env.ALPHA_WALLET_REVIEW_PATH, []);
    await ctx.reply([
      'Bot: online',
      `Monitor worker configured: yes (interval ${env.MONITOR_INTERVAL_SECONDS}s)`,
      `Discovery worker configured: ${env.DISCOVERY_WORKER_ENABLED ? 'yes' : 'no'} (interval ${env.DISCOVERY_INTERVAL_SECONDS}s)`,
      `Watchlist wallets: ${watchlist.length}`,
      `Alpha review queue: ${alphaReview.length}`,
      `Known tokens: ${knownTokens.length}`,
      `Latest monitor run: ${String(summary.runAt ?? 'n/a')}`,
      `Latest discovery run: ${String(discoverySummary.runAt ?? 'n/a')}`,
      `Latest signals: ${String(summary.signalsBuilt ?? 'n/a')}`,
    ].join('\n'));
  });

  bot.command('watchlist', async (ctx) => {
    const watchlist = await readJsonSafe<Array<{ chain?: string; walletAddress?: string; score?: number }>>(env.MONITOR_WATCHLIST_PATH, []);
    const alphaReview = await getAlphaWalletReviewEntries();
    const byChain = new Map<string, number>();
    for (const w of watchlist) byChain.set(w.chain ?? 'unknown', (byChain.get(w.chain ?? 'unknown') ?? 0) + 1);
    const top = [...watchlist]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 5)
      .map((x) => `${x.chain}:${x.walletAddress} score=${x.score ?? 'n/a'}`);
    const topReview = [...alphaReview]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 5)
      .map((x) => `${x.chain}:${x.walletAddress} score=${x.score ?? 'n/a'} status=${x.status}`);
    await ctx.reply([
      `Monitored wallets: ${watchlist.length}`,
      `Manual alpha review queue: ${alphaReview.length}`,
      `By chain: ${[...byChain.entries()].map(([k, v]) => `${k}=${v}`).join(', ') || 'n/a'}`,
      'Top monitored by score:',
      ...(top.length ? top : ['n/a']),
      'Top alpha review by score:',
      ...(topReview.length ? topReview : ['n/a']),
    ].join('\n'));
  });

  bot.command('signals', async (ctx) => {
    const signals = await readJsonSafe<Array<{ category?: string; symbol?: string; name?: string; chain?: string; score?: number; likelyActivityType?: string; confidence?: string }>>(path.join(env.MONITOR_OUTPUT_DIR, 'latest-signals.json'), []);
    const lines = signals.slice(0, 10).map((s) => `[${s.category}] ${s.symbol ?? s.name ?? 'unknown'} ${s.chain} score=${s.score ?? 'n/a'} activity=${s.likelyActivityType ?? 'n/a'} conf=${s.confidence ?? 'n/a'}`);
    await ctx.reply(lines.length ? lines.join('\n') : 'No latest signals found yet.');
  });

  bot.command('alpha_wallet_ekle', async (ctx) => {
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '/alpha_wallet_ekle';
    const response = await handleAlphaWalletEkle({ text, chatId: String(ctx.chat.id) });
    await ctx.reply(response.message);
  });

  bot.command('run_poll', async (ctx) => {
    await ctx.reply('poll started');
    const args = buildMonitorArgsFromEnv({ outDir: path.join(env.MONITOR_OUTPUT_DIR, 'manual-bot-run') });
    await runMonitorPoll(args);
    const summary = await readJsonSafe<Record<string, unknown>>(path.join(args.out, 'monitor-summary.json'), {});
    await ctx.reply(`poll done: events=${String(summary.eventsFound ?? 0)} signals=${String(summary.signalsBuilt ?? 0)} alerts=${String(summary.dedupedSignalsForDelivery ?? 0)}`);
  });

  bot.command('wallet', (ctx) => ctx.reply(walletComingSoon()));

  bot.command('copytrade', (ctx) => ctx.reply(copytradeComingSoon()));

  bot.command('positions', (ctx) => ctx.reply(positionsComingSoon()));

  bot.command('settings', (ctx) => ctx.reply(settingsComingSoon()));

  await registerBotCommands(bot);

  await bot.launch();

  const stop = (signal: string) => {
    console.log(`[bot] received ${signal}; shutting down`);
    bot.stop(signal);
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createAndStartBot().catch((error) => {
    console.error('[bot] fatal', error);
    process.exit(1);
  });
}
