import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('telegram menu command registration', () => {
  it('includes active product commands and alpha_wallet_ekle', async () => {
    const { PRODUCT_MENU_COMMANDS, registerBotCommands } = await import('../src/bot/product-commands.js');
    const setMyCommands = vi.fn().mockResolvedValue(undefined);
    const bot = { telegram: { setMyCommands } } as any;
    await registerBotCommands(bot);

    expect(PRODUCT_MENU_COMMANDS.map((x) => x.command)).toEqual([
      'start',
      'status',
      'signals',
      'watchlist',
      'alpha_wallet_ekle',
      'cancel',
      'help',
      'copytrade',
      'positions',
      'wallet',
      'settings',
    ]);
    expect(setMyCommands).toHaveBeenCalledTimes(1);
  });
});

describe('alpha wallet command', () => {
  it('returns conversational prompt when no args are supplied', async () => {
    const { handleAlphaWalletEkle } = await import('../src/bot/alpha-wallet-command.js');
    const result = await handleAlphaWalletEkle({ text: '/alpha_wallet_ekle', chatId: '1' });
    expect(result.message).toContain('Send the wallet address you want to add to alpha review.');
    expect((result as { needsInput?: boolean }).needsInput).toBe(true);
  });

  it('writes wallet to review queue and dedupes duplicates', async () => {
    vi.resetModules();
    const tmpDir = path.join('output', 'test-productization-alpha');
    await mkdir(tmpDir, { recursive: true });
    const reviewPath = path.join(tmpDir, 'alpha-wallet-review.local.json');
    await writeFile(reviewPath, '[]', 'utf8');

    process.env.ALPHA_WALLET_REVIEW_PATH = reviewPath;

    const { handleAlphaWalletEkle } = await import('../src/bot/alpha-wallet-command.js');
    const address = '0x1111111111111111111111111111111111111111';
    const first = await handleAlphaWalletEkle({ text: `/alpha_wallet_ekle ${address}`, chatId: '12345' });
    expect(first.message).toContain('Wallet added to alpha review/watchlist.');

    const second = await handleAlphaWalletEkle({ text: `/alpha_wallet_ekle ${address}`, chatId: '12345' });
    expect(second.message).toContain('already exists');

    const parsed = JSON.parse(await readFile(reviewPath, 'utf8')) as Array<{ walletAddress: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.walletAddress).toBe(address);
  });
});

describe('pending input state', () => {
  it('sets, gets, and clears pending input', async () => {
    vi.resetModules();
    const tmpDir = path.join('output', 'test-pending-input-state');
    await mkdir(tmpDir, { recursive: true });
    const pendingPath = path.join(tmpDir, 'telegram-pending-inputs.local.json');

    const {
      setPendingInput,
      getPendingInput,
      clearPendingInput,
    } = await import('../src/bot/pending-input-state.js');

    await setPendingInput('chat-1', 'alpha_wallet_address', undefined, { filePath: pendingPath });
    const found = await getPendingInput('chat-1', { filePath: pendingPath });
    expect(found?.type).toBe('alpha_wallet_address');

    await clearPendingInput('chat-1', { filePath: pendingPath });
    const afterClear = await getPendingInput('chat-1', { filePath: pendingPath });
    expect(afterClear).toBeUndefined();
  });
});

describe('telegram conversational alpha wallet flow', () => {
  it('handles pending input flow and /cancel through bot handlers', async () => {
    vi.resetModules();
    const tmpDir = path.join('output', 'test-telegram-conversation');
    await mkdir(tmpDir, { recursive: true });
    const reviewPath = path.join(tmpDir, 'alpha-wallet-review.local.json');
    const pendingPath = path.join('data', 'telegram-pending-inputs.local.json');
    await writeFile(reviewPath, '[]', 'utf8');
    await writeFile(pendingPath, '[]', 'utf8');

    process.env.ALPHA_WALLET_REVIEW_PATH = reviewPath;

    const commandHandlers = new Map<string, (ctx: any) => Promise<void> | void>();
    let textHandler: ((ctx: any) => Promise<void> | void) | undefined;

    class TelegrafMock {
      telegram = { setMyCommands: vi.fn().mockResolvedValue(undefined) };
      start(handler: any) { commandHandlers.set('start', handler); }
      command(name: string, handler: any) { commandHandlers.set(name, handler); }
      on(event: string, handler: any) { if (event === 'text') textHandler = handler; }
      launch = vi.fn().mockResolvedValue(undefined);
      stop = vi.fn();
    }

    vi.doMock('telegraf', () => ({ Telegraf: TelegrafMock }));

    const { createAndStartBot } = await import('../src/bot/start-bot.js');
    await createAndStartBot();

    expect(commandHandlers.has('alpha_wallet_ekle')).toBe(true);
    expect(commandHandlers.has('cancel')).toBe(true);
    expect(textHandler).toBeTypeOf('function');

    const replies: string[] = [];
    const makeCtx = (text: string) => ({
      chat: { id: 123 },
      message: { text },
      reply: async (msg: string) => { replies.push(msg); },
    });

    await commandHandlers.get('alpha_wallet_ekle')!(makeCtx('/alpha_wallet_ekle'));
    expect(replies.at(-1)).toContain('Send the wallet address you want to add to alpha review.');

    await textHandler!(makeCtx('hello'));
    expect(replies.at(-1)).toContain('Invalid wallet address');

    const validAddress = '0x74de5d4fcbf63e00296fd95d33236b9794016631';
    await textHandler!(makeCtx(validAddress));
    expect(replies.at(-1)).toContain('Wallet added to alpha review/watchlist.');

    const parsed = JSON.parse(await readFile(reviewPath, 'utf8')) as Array<{ walletAddress: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.walletAddress).toBe(validAddress);

    await textHandler!(makeCtx('random text no pending'));
    expect(replies.at(-1)).toContain('Use /help or Menu to choose an action.');

    await commandHandlers.get('alpha_wallet_ekle')!(makeCtx('/alpha_wallet_ekle'));
    await commandHandlers.get('cancel')!(makeCtx('/cancel'));
    expect(replies.at(-1)).toBe('Cancelled.');

    await textHandler!(makeCtx('0x1111111111111111111111111111111111111111'));
    expect(replies.at(-1)).toContain('Use /help or Menu to choose an action.');

    await commandHandlers.get('alpha_wallet_ekle')!(makeCtx(`/alpha_wallet_ekle ${validAddress}`));
    expect(replies.at(-1)).toContain('already exists');
  });
});

describe('placeholder commands', () => {
  it('return coming soon messages', async () => {
    const {
      walletComingSoon,
      copytradeComingSoon,
      positionsComingSoon,
      settingsComingSoon,
    } = await import('../src/bot/placeholder-responses.js');
    expect(walletComingSoon()).toContain('Coming soon');
    expect(copytradeComingSoon()).toContain('Coming soon');
    expect(positionsComingSoon()).toContain('Coming soon');
    expect(settingsComingSoon()).toContain('Coming soon');
  });
});

describe('discovery worker one-shot dry run behavior', () => {
  it('writes latest summary and does not auto-add when DISCOVERY_AUTO_ADD=false', async () => {
    vi.resetModules();
    const tmpDir = path.join('output', 'test-discovery-worker-mvp');
    const watchlistPath = path.join(tmpDir, 'monitor-wallets.json');
    const reviewPath = path.join(tmpDir, 'alpha-wallet-review.local.json');
    const discoveryOut = path.join(tmpDir, 'discovery-worker');
    await mkdir(tmpDir, { recursive: true });

    await writeFile(watchlistPath, JSON.stringify([{ chain: 'ethereum', walletAddress: '0x1111111111111111111111111111111111111111', score: 80 }], null, 2), 'utf8');
    await writeFile(reviewPath, JSON.stringify([{ chain: 'ethereum', walletAddress: '0x2222222222222222222222222222222222222222', source: 'telegram_manual', addedAt: new Date().toISOString(), status: 'pending_review', score: 95, tags: [] }], null, 2), 'utf8');

    process.env.MONITOR_WATCHLIST_PATH = watchlistPath;
    process.env.ALPHA_WALLET_REVIEW_PATH = reviewPath;
    process.env.DISCOVERY_OUTPUT_DIR = discoveryOut;
    process.env.DISCOVERY_AUTO_ADD = 'false';
    process.env.DISCOVERY_DRY_RUN = 'true';
    process.env.DISCOVERY_AUTO_ADD_MIN_SCORE = '70';
    process.env.DISCOVERY_MAX_NEW_WALLETS_PER_RUN = '20';

    const { executeDiscoveryWorkerRun } = await import('../src/worker/discovery-worker.js');
    const summary = await executeDiscoveryWorkerRun({ dryRun: true });

    expect(summary.dryRun).toBe(true);
    expect(summary.autoAddEnabled).toBe(false);
    expect(summary.autoAddedCount).toBe(0);

    const latestSummaryPath = path.join(discoveryOut, 'latest-summary.json');
    const latest = JSON.parse(await readFile(latestSummaryPath, 'utf8')) as Record<string, unknown>;
    expect(latest.runAt).toBeDefined();
    expect(latest.autoAddEnabled).toBe(false);
  });
});

describe('discovery env defaults and docs presence', () => {
  it('parses discovery defaults from env schema', async () => {
    vi.resetModules();
    delete process.env.DISCOVERY_WORKER_ENABLED;
    delete process.env.DISCOVERY_INTERVAL_SECONDS;
    delete process.env.DISCOVERY_DRY_RUN;
    delete process.env.DISCOVERY_AUTO_ADD;
    delete process.env.DISCOVERY_AUTO_ADD_MIN_SCORE;
    delete process.env.DISCOVERY_MAX_NEW_WALLETS_PER_RUN;
    const { env } = await import('../src/config/env.js');
    expect(env.DISCOVERY_WORKER_ENABLED).toBe(true);
    expect(env.DISCOVERY_INTERVAL_SECONDS).toBe(21600);
    expect(env.DISCOVERY_DRY_RUN).toBe(true);
    expect(env.DISCOVERY_AUTO_ADD).toBe(false);
    expect(env.DISCOVERY_AUTO_ADD_MIN_SCORE).toBe(70);
    expect(env.DISCOVERY_MAX_NEW_WALLETS_PER_RUN).toBe(20);
  });

  it('vps deployment doc mentions three PM2 processes', async () => {
    const vpsDoc = await readFile('docs/VPS_DEPLOYMENT.md', 'utf8');
    expect(vpsDoc).toContain('smartbot-telegram');
    expect(vpsDoc).toContain('smartbot-worker');
    expect(vpsDoc).toContain('smartbot-discovery');
  });

  it('auto-trade roadmap doc exists with phase headings', async () => {
    const roadmap = await readFile('docs/AUTOTRADE_ROADMAP.md', 'utf8');
    expect(roadmap).toContain('Phase 1 - Signal Bot MVP');
    expect(roadmap).toContain('Phase 6 - Advanced Alpha Engine');
  });
});
