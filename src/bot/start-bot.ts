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
import { updateAlphaWalletReviewStatus } from '../discovery/alpha-wallet-review-store.js';
import { handleAlphaWalletEkle, submitAlphaWalletAddress } from './alpha-wallet-command.js';
import { copytradeComingSoon, positionsComingSoon, settingsComingSoon, walletComingSoon } from './placeholder-responses.js';
import { clearPendingInput, getPendingInput, setPendingInput } from './pending-input-state.js';
import { promoteAlphaWallets } from '../discovery/promote-alpha-wallets.js';
import { executeDiscoveryWorkerRun } from '../worker/discovery-worker.js';

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

  const findReviewCandidate = async (walletAddress: string) => {
    const all = await getAlphaWalletReviewEntries();
    return all.find((x) => x.walletAddress.toLowerCase() === walletAddress.toLowerCase());
  };

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
    '/review',
    '/promote <walletAddress>',
    '/reject <walletAddress>',
    '/monitor_now',
    '/discovery_now',
    '/admin_status',
    '/alpha_wallet_ekle (then send wallet) or /alpha_wallet_ekle 0x...',
    '/cancel',
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

  bot.command('review', async (ctx) => {
    const alphaReview = await getAlphaWalletReviewEntries();
    const highConfidence = alphaReview.filter((x) => x.status === 'high_confidence' || x.category === 'high_confidence');
    const watchCandidates = alphaReview.filter((x) => x.category === 'watch_candidate');
    const needsReview = alphaReview.filter((x) => x.status === 'needs_review' || x.status === 'pending_review' || x.category === 'needs_review');
    const top = [...alphaReview]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 5)
      .map((x) => `${x.chain}:${x.walletAddress.slice(0, 8)}... score=${x.score ?? 'n/a'} category=${x.category ?? 'n/a'} reasons=${(x.reasons ?? []).slice(0, 2).join('|') || 'n/a'}`);
    await ctx.reply([
      `Review queue total: ${alphaReview.length}`,
      `High confidence: ${highConfidence.length}`,
      `Watch candidates: ${watchCandidates.length}`,
      `Needs review: ${needsReview.length}`,
      'Top candidates:',
      ...(top.length ? top : ['n/a']),
    ].join('\n'));
  });

  bot.command('promote', async (ctx) => {
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '/promote';
    const parts = text.split(/\s+/).slice(1).filter(Boolean);
    const maybeAddress = parts[0]?.trim() ?? '';
    const force = (parts[1] ?? '').toLowerCase() === 'force';
    if (!maybeAddress) {
      await setPendingInput(String(ctx.chat.id), 'promote_wallet_address');
      await ctx.reply('Send wallet address to promote from review queue.');
      return;
    }
    const candidate = await findReviewCandidate(maybeAddress);
    if (!candidate) {
      await ctx.reply(`Wallet not found in review queue: ${maybeAddress}`);
      return;
    }
    if (force) {
      await promoteAlphaWallets({
        dryRun: false,
        minScore: 0,
        maxAdd: 1,
        includeWatchCandidates: true,
        force: true,
        walletAddress: maybeAddress,
        chain: candidate.chain,
      });
      await ctx.reply(`Forced promotion applied for ${maybeAddress}. Added to monitor list only (no trading).`);
      return;
    }
    const dryRunCheck = await promoteAlphaWallets({
      dryRun: true,
      minScore: env.DISCOVERY_AUTO_ADD_MIN_SCORE,
      maxAdd: 1,
      includeWatchCandidates: false,
      walletAddress: maybeAddress,
      chain: candidate.chain,
    });
    if (!dryRunCheck.eligible) {
      const why = [
        dryRunCheck.skippedLowScore ? `score below threshold(${dryRunCheck.minScore})` : '',
        dryRunCheck.skippedNotHighConfidence ? 'not high confidence' : '',
        dryRunCheck.skippedAlreadyMonitored ? 'already monitored' : '',
        dryRunCheck.skippedRejected ? 'rejected' : '',
        dryRunCheck.skippedMissingEvidence ? 'missing evidence' : '',
      ].filter(Boolean).join(', ') || 'not eligible by current policy';
      await ctx.reply(`Not eligible for promotion: ${why}. Use /promote <wallet> force to override safely.`);
      return;
    }
    await promoteAlphaWallets({
      dryRun: false,
      minScore: env.DISCOVERY_AUTO_ADD_MIN_SCORE,
      maxAdd: 1,
      includeWatchCandidates: false,
      walletAddress: maybeAddress,
      chain: candidate.chain,
    });
    await ctx.reply(`Promotion requested for ${maybeAddress} (policy-compliant).`);
  });

  bot.command('reject', async (ctx) => {
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '/reject';
    const maybeAddress = text.split(/\s+/).slice(1).join(' ').trim();
    if (!maybeAddress) {
      await setPendingInput(String(ctx.chat.id), 'reject_wallet_address');
      await ctx.reply('Send wallet address to reject from review queue.');
      return;
    }
    const candidate = await findReviewCandidate(maybeAddress);
    await updateAlphaWalletReviewStatus({
      chain: candidate?.chain ?? 'ethereum',
      walletAddress: maybeAddress,
      status: 'rejected',
      rejectedAt: new Date().toISOString(),
      notes: 'Rejected via /reject',
    });
    await ctx.reply(`Rejected wallet: ${maybeAddress} (status=rejected).`);
  });

  bot.command('alpha_wallet_ekle', async (ctx) => {
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '/alpha_wallet_ekle';
    const response = await handleAlphaWalletEkle({ text, chatId: String(ctx.chat.id) });
    if ('needsInput' in response && response.needsInput) {
      await setPendingInput(String(ctx.chat.id), 'alpha_wallet_address');
    }
    await ctx.reply(response.message);
  });

  bot.command('cancel', async (ctx) => {
    await clearPendingInput(String(ctx.chat.id));
    await ctx.reply('Cancelled.');
  });

  bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text || text.startsWith('/')) return;

    const chatId = String(ctx.chat.id);
    const pending = await getPendingInput(chatId);

    if (!pending) {
      await ctx.reply('Use /help or Menu to choose an action.');
      return;
    }

    if (pending.type === 'alpha_wallet_address') {
      const response = await submitAlphaWalletAddress({ walletAddress: text, chatId });
      if (response.ok) {
        await clearPendingInput(chatId);
      }
      await ctx.reply(response.message);
      return;
    }

    if (pending.type === 'promote_wallet_address') {
      const candidate = await findReviewCandidate(text);
      if (!candidate) {
        await ctx.reply(`Wallet not found in review queue: ${text}`);
        return;
      }
      await promoteAlphaWallets({
        dryRun: false,
        minScore: env.DISCOVERY_AUTO_ADD_MIN_SCORE,
        maxAdd: 1,
        includeWatchCandidates: false,
        walletAddress: text,
        chain: candidate.chain,
      });
      await clearPendingInput(chatId);
      await ctx.reply(`Promotion requested for ${text} (policy-compliant).`);
      return;
    }

    if (pending.type === 'reject_wallet_address') {
      const candidate = await findReviewCandidate(text);
      await updateAlphaWalletReviewStatus({
        chain: candidate?.chain ?? 'ethereum',
        walletAddress: text,
        status: 'rejected',
        rejectedAt: new Date().toISOString(),
        notes: 'Rejected via /reject conversational flow',
      });
      await clearPendingInput(chatId);
      await ctx.reply(`Rejected wallet: ${text} (status=rejected).`);
      return;
    }

    await ctx.reply('Use /help or Menu to choose an action.');
  });

  bot.command('run_poll', async (ctx) => {
    await ctx.reply('poll started');
    const args = buildMonitorArgsFromEnv({ outDir: path.join(env.MONITOR_OUTPUT_DIR, 'manual-bot-run') });
    await runMonitorPoll(args);
    const summary = await readJsonSafe<Record<string, unknown>>(path.join(args.out, 'monitor-summary.json'), {});
    await ctx.reply(`poll done: events=${String(summary.eventsFound ?? 0)} signals=${String(summary.signalsBuilt ?? 0)} alerts=${String(summary.dedupedSignalsForDelivery ?? 0)}`);
  });

  bot.command('monitor_now', async (ctx) => {
    await ctx.reply('monitor poll started');
    const args = buildMonitorArgsFromEnv({ outDir: path.join(env.MONITOR_OUTPUT_DIR, 'manual-bot-run') });
    await runMonitorPoll(args);
    const summary = await readJsonSafe<Record<string, unknown>>(path.join(args.out, 'monitor-summary.json'), {});
    await ctx.reply(`monitor poll done: events=${String(summary.eventsFound ?? 0)} signals=${String(summary.signalsBuilt ?? 0)} alerts=${String(summary.dedupedSignalsForDelivery ?? 0)}`);
  });

  bot.command('discovery_now', async (ctx) => {
    await ctx.reply('discovery one-shot started (dry-run=true)');
    const summary = await executeDiscoveryWorkerRun({ dryRun: true });
    await ctx.reply(`discovery done: loaded=${String(summary.candidatesLoaded ?? 0)} deduped=${String(summary.candidatesAfterDedupe ?? 0)} high=${String(summary.highConfidenceCount ?? 0)} review=${String(summary.reviewQueueCount ?? 0)}`);
  });

  bot.command('admin_status', async (ctx) => {
    const summary = await readJsonSafe<Record<string, unknown>>(path.join(env.MONITOR_OUTPUT_DIR, 'latest-summary.json'), {});
    const discoverySummary = await readJsonSafe<Record<string, unknown>>(path.join(env.DISCOVERY_OUTPUT_DIR, 'latest-summary.json'), {});
    const watchlist = await readJsonSafe<unknown[]>(env.MONITOR_WATCHLIST_PATH, []);
    const alphaReview = await readJsonSafe<unknown[]>(env.ALPHA_WALLET_REVIEW_PATH, []);
    await ctx.reply([
      'Admin status',
      'Processes: smartbot-telegram, smartbot-worker, smartbot-discovery (PM2)',
      `Latest monitor run: ${String(summary.runAt ?? 'n/a')}`,
      `Latest discovery run: ${String(discoverySummary.runAt ?? 'n/a')}`,
      `Review queue: ${alphaReview.length}`,
      `Monitored wallets: ${watchlist.length}`,
      `Latest alerts: ${String(summary.alertsSent ?? summary.dedupedSignalsForDelivery ?? 'n/a')}`,
      `Send policy: weak=${process.env.MONITOR_SEND_WEAK === 'true'} ignored=${process.env.MONITOR_SEND_IGNORED === 'true'}`,
    ].join('\n'));
  });

  bot.command('wallet', (ctx) => ctx.reply(walletComingSoon()));

  bot.command('copytrade', (ctx) => ctx.reply(copytradeComingSoon()));

  bot.command('positions', (ctx) => ctx.reply(positionsComingSoon()));

  bot.command('settings', (ctx) => ctx.reply(settingsComingSoon()));

  bot.action(/^trade_placeholder_/, async (ctx) => {
    await ctx.answerCbQuery('Trading is not enabled yet.');
  });

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
