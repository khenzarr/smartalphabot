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
import { buildSignalInlineKeyboard, formatMonitorSignalMessage } from './messages/monitor-signal-message.js';
import type { MonitorSignal, MonitorSignalCategory } from '../monitoring/monitoring.types.js';

async function readJsonSafe<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function shortWallet(wallet: string): string {
  return wallet.length > 12 ? `${wallet.slice(0, 8)}...${wallet.slice(-4)}` : wallet;
}

function parseTokens(text: string): string[] {
  return text.split(/\s+/).slice(1).map((x) => x.trim()).filter(Boolean);
}

function toSignalCategory(input?: string): MonitorSignalCategory | undefined {
  const normalized = (input ?? '').toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'strong' || normalized === 'strong_signal') return 'strong_signal';
  if (normalized === 'watch' || normalized === 'watch_signal') return 'watch_signal';
  if (normalized === 'weak' || normalized === 'weak_signal') return 'weak_signal';
  if (normalized === 'ignored') return 'ignored';
  return undefined;
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
    '/preview_signal [strong|watch|weak|ignored]',
    '/watchlist',
    '/review [all|high|watch|needs|stale|active|rejected|monitoring]',
    '/candidate <walletAddress>',
    '/watchlist_quality',
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
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '/signals';
    const parts = parseTokens(text);
    const categoryFilter = toSignalCategory(parts[0]);
    const limit = Math.min(25, Math.max(1, Number(parts[1] ?? '10') || 10));

    const signals = await readJsonSafe<MonitorSignal[]>(path.join(env.MONITOR_OUTPUT_DIR, 'latest-signals.json'), []);
    const scoped = categoryFilter ? signals.filter((x) => x.category === categoryFilter) : signals;
    const lines = scoped.slice(0, limit).map((s) => {
      const positives = (s.positiveReasons ?? []).slice(0, 2).join('|') || 'n/a';
      const negatives = (s.negativeReasons ?? []).slice(0, 2).join('|') || 'n/a';
      const blockers = (s.promotionBlockers ?? []).slice(0, 2).join('|') || 'none';
      return `[${s.category}] ${s.symbol ?? s.name ?? 'unknown'} ${s.chain} score=${s.score ?? 'n/a'} wallets=${s.watchedWalletCount} activity=${s.likelyActivityType ?? 'n/a'} +${positives} -${negatives} blockers=${blockers}`;
    });

    const byCategory = {
      strong: signals.filter((x) => x.category === 'strong_signal').length,
      watch: signals.filter((x) => x.category === 'watch_signal').length,
      weak: signals.filter((x) => x.category === 'weak_signal').length,
      ignored: signals.filter((x) => x.category === 'ignored').length,
    };
    await ctx.reply([
      `Signals total=${signals.length} strong=${byCategory.strong} watch=${byCategory.watch} weak=${byCategory.weak} ignored=${byCategory.ignored}`,
      `Filter=${categoryFilter ?? 'all'} limit=${limit}`,
      ...(lines.length ? lines : ['No latest signals found for this filter.']),
      'Tip: /signals watch 15',
    ].join('\n'));
  });

  bot.command('preview_signal', async (ctx) => {
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '/preview_signal';
    const parts = parseTokens(text);
    const mode = (parts[0] ?? '').toLowerCase();
    const category = toSignalCategory(parts[0]) ?? 'watch_signal';

    if (mode === 'latest') {
      const latestSignals = await readJsonSafe<MonitorSignal[]>(path.join(env.MONITOR_OUTPUT_DIR, 'latest-signals.json'), []);
      const latest = latestSignals[0];
      if (latest) {
        await ctx.reply(formatMonitorSignalMessage(latest), {
          reply_markup: buildSignalInlineKeyboard(latest),
        });
        return;
      }
    }

    const mockSignal: MonitorSignal = {
      chain: 'base', tokenAddress: '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2', tokenSymbol: 'ALPHA', tokenName: 'Alpha Radar',
      symbol: 'ALPHA', name: 'Alpha Radar', marketCapUsd: 2450000, tokenAge: 10800, priceUsd: 0.004812,
      smartWalletCount: 3, watchedWalletCount: 3,
      watchedWallets: ['0x74de5d4fcbf63e00296fd95d33236b9794016631', '0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'],
      walletScores: [82, 76, 71], firstSeenAt: new Date(Date.now() - 7 * 60 * 1000).toISOString(), latestSeenAt: new Date().toISOString(),
      txCount: 6, uniqueTxCount: 4, marketCap: 2450000, liquidityUsd: 185000, tokenAgeSeconds: 10800, totalAmountNative: 8.42, totalAmountUsd: 22840,
      warnings: [], score: category === 'strong_signal' ? 93 : category === 'watch_signal' ? 74 : category === 'weak_signal' ? 38 : -6,
      category, reasons: ['likely_buy_context', 'multi_wallet_consensus', 'manual_review_required'],
      positiveReasons: ['likely_buy_context', 'known_router_seen', 'multi_wallet_consensus'],
      negativeReasons: category === 'ignored' ? ['airdrop_or_claim_dominant'] : ['manual_review_required'],
      promotionBlockers: category === 'strong_signal' ? [] : ['manual_review_required'], qualityNotes: ['high_confidence_context'],
      riskFlags: category === 'ignored' ? ['stable_or_wrapped_token'] : [],
      dexScreenerUrl: 'https://dexscreener.com/base/0x1234', dexUrl: 'https://dexscreener.com/base/0x1234',
      explorerUrl: 'https://basescan.org/token/0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2', xSearchUrl: 'https://x.com/search?q=%24ALPHA%20base',
      likelyActivityType: category === 'ignored' ? 'airdrop_or_claim' : 'likely_buy', confidence: 'high', knownRouterSeen: true,
      contextEventCount: 6, likelyBuyEventCount: 4, transferEventCount: 1, airdropOrClaimEventCount: category === 'ignored' ? 5 : 0,
      contractInteractionEventCount: 1, unknownEventCount: 0, highConfidenceEventCount: 4, mediumConfidenceEventCount: 2,
      lowConfidenceEventCount: 0, knownRouterEventCount: 4,
      contextComposition: category === 'ignored' ? { airdrop_or_claim: 5, transfer: 1 } : { likely_buy: 4, transfer: 1, contract_interaction: 1 },
    };

    await ctx.reply(formatMonitorSignalMessage(mockSignal), {
      reply_markup: buildSignalInlineKeyboard(mockSignal),
    });
  });

  bot.command('review', async (ctx) => {
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '/review';
    const mode = (parseTokens(text)[0] ?? 'all').toLowerCase();
    const alphaReview = await getAlphaWalletReviewEntries();
    const highConfidence = alphaReview.filter((x) => x.status === 'high_confidence' || x.category === 'high_confidence');
    const watchCandidates = alphaReview.filter((x) => x.category === 'watch_candidate');
    const needsReview = alphaReview.filter((x) => x.status === 'needs_review' || x.status === 'pending_review' || x.category === 'needs_review');
    const rejected = alphaReview.filter((x) => x.status === 'rejected' || x.category === 'rejected');
    const monitoring = alphaReview.filter((x) => x.status === 'monitoring');
    const stale = alphaReview.filter((x) => x.qualityStatus === 'stale');
    const active = alphaReview.filter((x) => x.qualityStatus === 'active_alpha' || x.qualityStatus === 'active_watch');
    const filtered = mode === 'high'
      ? highConfidence
      : mode === 'watch'
        ? watchCandidates
        : mode === 'needs'
          ? needsReview
          : mode === 'stale'
            ? stale
            : mode === 'active'
              ? active
          : mode === 'rejected'
            ? rejected
            : mode === 'monitoring'
              ? monitoring
              : alphaReview;
    const top = [...filtered]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 10)
      .map((x) => `${x.chain}:${shortWallet(x.walletAddress)} score=${x.score ?? 'n/a'} category=${x.category ?? 'n/a'} status=${x.status} quality=${x.qualityStatus ?? 'unknown'} readiness=${x.promotionReadiness ?? 'n/a'} +${(x.positiveReasons ?? []).slice(0, 2).join('|') || 'n/a'} blockers=${(x.promotionBlockers ?? []).slice(0, 2).join('|') || 'none'}`);
    await ctx.reply([
      `Review queue total: ${alphaReview.length}`,
      `High confidence: ${highConfidence.length}`,
      `Watch candidates: ${watchCandidates.length}`,
      `Needs review: ${needsReview.length}`,
      `Stale: ${stale.length}`,
      `Active: ${active.length}`,
      `Rejected: ${rejected.length}`,
      `Monitoring: ${monitoring.length}`,
      `Mode: ${mode}`,
      'Candidates:',
      ...(top.length ? top : ['n/a']),
      'Tip: /review high',
    ].join('\n'));
  });

  bot.command('promote', async (ctx) => {
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '/promote';
    const parts = text.split(/\s+/).slice(1).filter(Boolean);
    const maybeAddress = parts[0]?.trim() ?? '';
    const force = (parts[1] ?? '').toLowerCase() === 'force';
    const forceNote = force ? parts.slice(2).join(' ').trim() : '';
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
        promotedNote: forceNote || `Promoted via /promote force by chat:${ctx.chat.id}`,
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
        dryRunCheck.skippedNotEligibleCategory ? 'not eligible category' : '',
        dryRunCheck.skippedAlreadyMonitored ? 'already monitored' : '',
        dryRunCheck.skippedRejected ? 'rejected' : '',
        dryRunCheck.skippedMissingEvidence ? 'missing evidence' : '',
        dryRunCheck.skippedRiskFlag ? 'risk flag' : '',
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
    const parts = text.split(/\s+/).slice(1).filter(Boolean);
    const maybeAddress = parts[0]?.trim() ?? '';
    const reason = parts.slice(1).join(' ').trim();
    if (!maybeAddress) {
      await setPendingInput(String(ctx.chat.id), 'reject_wallet_address');
      await ctx.reply('Send wallet address to reject from review queue.');
      return;
    }
    const candidate = await findReviewCandidate(maybeAddress);
    const chain = candidate?.chain ?? 'ethereum';
    if (!reason) {
      await setPendingInput(String(ctx.chat.id), 'reject_wallet_reason', {
        walletAddress: maybeAddress,
        chain,
      });
      await ctx.reply(`Send reject reason for ${maybeAddress}. Example: low quality flow, suspicious activity, duplicate wallet.`);
      return;
    }
    await updateAlphaWalletReviewStatus({
      chain,
      walletAddress: maybeAddress,
      status: 'rejected',
      rejectedAt: new Date().toISOString(),
      notes: `Rejected via /reject: ${reason}`,
    });
    await ctx.reply(`Rejected wallet: ${maybeAddress} (status=rejected, reason saved).`);
  });

  bot.command('candidate', async (ctx) => {
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '/candidate';
    const walletAddress = parseTokens(text)[0]?.trim();
    if (!walletAddress) {
      await ctx.reply('Usage: /candidate <walletAddress>');
      return;
    }
    const candidate = await findReviewCandidate(walletAddress);
    if (!candidate) {
      await ctx.reply(`Candidate not found: ${walletAddress}`);
      return;
    }
    const watchlist = await readJsonSafe<Array<{ chain?: string; walletAddress?: string }>>(env.MONITOR_WATCHLIST_PATH, []);
    const monitored = watchlist.some((w) =>
      (w.walletAddress ?? '').toLowerCase() === candidate.walletAddress.toLowerCase()
      && (w.chain ?? '').toLowerCase() === (candidate.chain ?? '').toLowerCase());
    await ctx.reply([
      `${candidate.chain}:${candidate.walletAddress}`,
      `score=${candidate.score ?? 'n/a'} category=${candidate.category ?? 'n/a'} status=${candidate.status}`,
      `qualityStatus=${candidate.qualityStatus ?? 'unknown'} promotionReadiness=${candidate.promotionReadiness ?? 'n/a'}`,
      `activeEvidenceCount=${candidate.activeEvidenceCount ?? 0} recentActivityScore=${candidate.recentActivityScore ?? 0} sourceDiversityScore=${candidate.sourceDiversityScore ?? 0}`,
      `tokenAppearances=${candidate.tokenAppearances ?? 0} evidenceRows=${candidate.evidenceRows ?? 0}`,
      `bestFirstBuyRank=${candidate.bestFirstBuyRank ?? 'n/a'} avgFirstBuyRank=${candidate.averageFirstBuyRank ?? 'n/a'}`,
      `positiveReasons=${(candidate.positiveReasons ?? []).slice(0, 5).join('|') || 'n/a'}`,
      `negativeReasons=${(candidate.negativeReasons ?? []).slice(0, 5).join('|') || 'n/a'}`,
      `blockers=${(candidate.promotionBlockers ?? []).slice(0, 5).join('|') || 'none'}`,
      `qualityNotes=${(candidate.qualityNotes ?? []).slice(0, 5).join('|') || 'n/a'}`,
      `riskFlags=${(candidate.riskFlags ?? []).slice(0, 5).join('|') || 'none'}`,
      `sourceFiles=${(candidate.sourceFiles ?? []).slice(0, 5).join('|') || 'n/a'}`,
      `monitored=${monitored}`,
      `recommendedAction=${candidate.qualityStatus === 'stale' ? 'stale_review' : candidate.promotionReadiness === 'eligible' ? 'keep' : candidate.promotionReadiness === 'watch_only' ? 'keep_watch' : 'investigate'}`,
    ].join('\n'));
  });

  bot.command('watchlist_quality', async (ctx) => {
    const reportPath = path.join('output', 'watchlist-quality', 'latest-report.json');
    const report = await readJsonSafe<Record<string, unknown>>(reportPath, {});
    const rows = Array.isArray(report.rows) ? report.rows as Array<Record<string, unknown>> : [];
    if (!rows.length) {
      await ctx.reply('Watchlist quality report not found. Run: npm run watchlist:quality');
      return;
    }
    const counts = (report.counts ?? {}) as Record<string, unknown>;
    const staleOrInvestigate = [...rows]
      .filter((r) => String(r.qualityStatus ?? '') === 'stale' || String(r.recommendedAction ?? '') === 'investigate')
      .slice(0, 5)
      .map((r) => `${String(r.chain ?? 'unknown')}:${shortWallet(String(r.walletAddress ?? ''))} status=${String(r.qualityStatus ?? 'unknown')} action=${String(r.recommendedAction ?? 'n/a')}`);
    const activeTop = [...rows]
      .filter((r) => String(r.qualityStatus ?? '') === 'active_alpha' || String(r.qualityStatus ?? '') === 'active_watch')
      .slice(0, 5)
      .map((r) => `${String(r.chain ?? 'unknown')}:${shortWallet(String(r.walletAddress ?? ''))} status=${String(r.qualityStatus ?? 'unknown')} events=${String(r.recentEventsFound ?? 0)} signals=${String(r.latestSignalCount ?? 0)}`);

    await ctx.reply([
      `Watchlist quality total: ${String(report.totalWatchedWallets ?? rows.length)}`,
      `active_alpha=${String(counts.active_alpha ?? 0)} active_watch=${String(counts.active_watch ?? 0)} stale=${String(counts.stale ?? 0)} noisy=${String(counts.noisy ?? 0)} unknown=${String(counts.unknown ?? 0)}`,
      'Top stale/investigate:',
      ...(staleOrInvestigate.length ? staleOrInvestigate : ['n/a']),
      'Top active:',
      ...(activeTop.length ? activeTop : ['n/a']),
    ].join('\n'));
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
      const chain = candidate?.chain ?? 'ethereum';
      await setPendingInput(chatId, 'reject_wallet_reason', {
        walletAddress: text,
        chain,
      });
      await ctx.reply(`Send reject reason for ${text}.`);
      return;
    }

    if (pending.type === 'reject_wallet_reason') {
      const walletAddress = String(pending.metadata?.walletAddress ?? '').trim();
      const chain = String(pending.metadata?.chain ?? 'ethereum').trim() || 'ethereum';
      if (!walletAddress) {
        await clearPendingInput(chatId);
        await ctx.reply('Reject flow expired. Please run /reject again.');
        return;
      }
      await updateAlphaWalletReviewStatus({
        chain,
        walletAddress,
        status: 'rejected',
        rejectedAt: new Date().toISOString(),
        notes: `Rejected via conversational flow: ${text}`,
      });
      await clearPendingInput(chatId);
      await ctx.reply(`Rejected wallet: ${walletAddress} (status=rejected, reason saved).`);
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
      `Provider: ${String(summary.providerModeUsed ?? summary.activityProvider ?? 'n/a')} (requested=${String(summary.providerModeRequested ?? 'n/a')})`,
      `Wallet activity profile: ${String(summary.walletActivityProfileApplied ?? summary.walletActivityProfileRequested ?? 'n/a')}`,
      `Wallet activity chunks: ${String(summary.walletActivityEstimatedChunks ?? 'n/a')}/${String(summary.walletActivityChunkBudget ?? 'n/a')}`,
      `Wallet activity window reduced: ${String(summary.walletActivityWindowReduced ?? false)}`,
      `Wallet activity events(decoded/raw): ${String(summary.rpcWalletActivityEventsDecoded ?? 'n/a')}/${String(summary.rpcWalletActivityRawLogsFound ?? 'n/a')}`,
      `Wallet activity dropped: ${String(summary.rpcWalletActivityEventsDropped ?? 'n/a')} reasons=${JSON.stringify(summary.rpcWalletActivityDropReasons ?? {})}`,
      `Wallet activity wallets with/no events: ${String(summary.rpcWalletActivityWalletsWithEvents ?? 'n/a')}/${String(summary.rpcWalletActivityNoEventWallets ?? 'n/a')}`,
      `Wallet activity chunks req/succ/fail: ${String(summary.rpcWalletActivityChunksRequested ?? 'n/a')}/${String(summary.rpcWalletActivityChunksSucceeded ?? 'n/a')}/${String(summary.rpcWalletActivityChunksFailed ?? 'n/a')}`,
      `Discovered tokens: ${String(summary.discoveredTokensCount ?? 0)} byChain=${JSON.stringify(summary.discoveredTokensByChain ?? {})}`,
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
