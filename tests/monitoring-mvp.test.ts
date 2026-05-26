import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildMonitorWallets, main as importMonitorCandidatesMain } from '../src/cli/import-monitor-candidates.js';
import { buildKnownTokens, buildKnownTokensWithinBudget } from '../src/cli/build-monitor-known-tokens.js';
import { scanRecentWalletActivity } from '../src/monitoring/recent-wallet-activity.js';
import { buildSignals, buildSignalsWithStats } from '../src/monitoring/signal-builder.js';
import { buildSignalDedupeKey } from '../src/monitoring/dedupe.js';
import { buildSignalInlineKeyboard, formatMonitorSignalMessage } from '../src/bot/messages/monitor-signal-message.js';
import { runMonitorPoll } from '../src/cli/monitor-poll.js';
import {
  ExplorerTokenTransferProvider,
  isAddresslessLogsRestrictionError,
  RpcAddresslessActivityProvider,
  RpcKnownTokensActivityProvider,
} from '../src/monitoring/wallet-activity-providers.js';
import { fetchWalletTransfersWithExplorer } from '../src/monitoring/explorer-token-transfer-provider.js';
import { ERC20_TRANSFER_TOPIC } from '../src/monitoring/constants.js';

function makeStats(overrides: Record<string, unknown> = {}) {
  return {
    chainsScanned: ['base'],
    walletsScanned: 1,
    walletScanFailures: 0,
    addresslessLogsSupported: 'true',
    warnings: [],
    walletScanFailureDetailsCount: 0,
    failureKinds: {},
    failuresByChain: {},
    failuresByProviderMode: {},
    knownTokensByChain: {},
    scannedWalletsByChain: { base: 1 },
    scannedTokenWalletPairs: 0,
    successfulTokenWalletPairs: 0,
    failedTokenWalletPairs: 0,
    walletsWithNoActivity: 1,
    walletsWithActivity: 0,
    walletsWithFailures: 0,
    ...overrides,
  };
}

describe('monitoring MVP', () => {
  it('imports + dedupes candidate shortlist rows by chain+wallet', () => {
    const rows = [
      {
        chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', score: '55', category: 'candidate',
        tokenAppearances: '3', tokensAppearedIn: 'a|b', narratives: 'meme', averageFirstBuyRank: '12', bestFirstBuyRank: '5',
        monitorRecommendation: 'watch', reasons: 'overlap', riskFlags: '',
      },
      {
        chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', score: '60', category: 'candidate',
        tokenAppearances: '4', tokensAppearedIn: 'c', narratives: 'ai', averageFirstBuyRank: '11', bestFirstBuyRank: '4',
        monitorRecommendation: 'watch', reasons: 'overlap', riskFlags: '',
      },
    ];
    const result = buildMonitorWallets(rows, '2026-01-01T00:00:00.000Z', {
      input: 'x.csv', out: 'y.json', minAppearances: 2, minScore: 40, includeRejected: true,
    });
    expect(result.wallets).toHaveLength(1);
    expect(result.wallets[0]?.source).toBe('candidate_shortlist');
    expect(result.wallets[0]?.enabled).toBe(true);
  });

  it('includes rejected rows when includeRejected=true and excludes when false', () => {
    const rows = [
      {
        chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', score: '55', category: 'rejected',
        tokenAppearances: '3', tokensAppearedIn: 'a|b', narratives: 'meme', averageFirstBuyRank: '12', bestFirstBuyRank: '5',
        monitorRecommendation: 'watch_after_pnl_enrichment', reasons: 'overlap', riskFlags: '',
      },
    ];

    const withRejected = buildMonitorWallets(rows, '2026-01-01T00:00:00.000Z', {
      input: 'x.csv', out: 'y.json', minAppearances: 2, minScore: 40, includeRejected: true,
    });
    const withoutRejected = buildMonitorWallets(rows, '2026-01-01T00:00:00.000Z', {
      input: 'x.csv', out: 'y.json', minAppearances: 2, minScore: 40, includeRejected: false,
    });

    expect(withRejected.wallets).toHaveLength(1);
    expect(withoutRejected.wallets).toHaveLength(0);
    expect(withoutRejected.excludedReasons.rejected_excluded).toBe(1);
  });

  it('writes watchlist+meta and prints summary, creating missing output directory', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'monitor-import-'));
    const input = path.join(tmp, 'candidates.csv');
    const out = path.join(tmp, 'nested', 'monitor-wallets.json');

    await writeFile(input, [
      'rank,chain,walletAddress,score,category,tokenAppearances,tokensAppearedIn,narratives,averageFirstBuyRank,bestFirstBuyRank,totalBuyCountAcrossSeeds,earliestObservedBuyAt,reasons,riskFlags,evidenceSummary,monitorRecommendation',
      '1,base,0x0000000000000000000000000000000000000001,55,candidate,3,A|B,meme,12,5,6,2026-01-01T00:00:00.000Z,ok,,evidence,investigate_high_activity',
    ].join('\n'), 'utf8');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const prevArgv = process.argv;
    process.argv = ['node', 'test', '--input', input, '--out', out, '--min-appearances', '2', '--min-score', '40', '--include-rejected', 'true'];

    await importMonitorCandidatesMain();

    const watchlist = JSON.parse(await readFile(out, 'utf8'));
    const meta = JSON.parse(await readFile(out.replace(/\.json$/i, '.meta.json'), 'utf8'));
    expect(watchlist).toHaveLength(1);
    expect(meta.importedCount).toBe(1);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('Monitor candidate import summary'))).toBe(true);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('Wrote monitor watchlist:'))).toBe(true);

    process.argv = prevArgv;
    logSpy.mockRestore();
  });

  it('fails loudly when input file is missing', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'monitor-import-missing-'));
    const out = path.join(tmp, 'monitor-wallets.json');
    const prevArgv = process.argv;
    process.argv = ['node', 'test', '--input', path.join(tmp, 'missing.csv'), '--out', out];

    await expect(importMonitorCandidatesMain()).rejects.toThrow(/Input CSV not found/i);

    process.argv = prevArgv;
  });

  it('fails loudly when zero candidates pass filters', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'monitor-import-zero-pass-'));
    const input = path.join(tmp, 'candidates.csv');
    const out = path.join(tmp, 'monitor-wallets.json');
    await writeFile(input, [
      'rank,chain,walletAddress,score,category,tokenAppearances,tokensAppearedIn,narratives,averageFirstBuyRank,bestFirstBuyRank,totalBuyCountAcrossSeeds,earliestObservedBuyAt,reasons,riskFlags,evidenceSummary,monitorRecommendation',
      '1,base,0x0000000000000000000000000000000000000001,20,rejected,1,A|B,meme,12,5,6,2026-01-01T00:00:00.000Z,ok,,evidence,ignore_low_sample',
    ].join('\n'), 'utf8');

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const prevArgv = process.argv;
    process.argv = ['node', 'test', '--input', input, '--out', out, '--min-appearances', '2', '--min-score', '40', '--include-rejected', 'false'];

    await expect(importMonitorCandidatesMain()).rejects.toThrow(/No monitor wallets imported due to filters/i);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('Zero candidates passed filters.'))).toBe(true);

    process.argv = prevArgv;
    errSpy.mockRestore();
  });

  it('decodes recent wallet transfer logs with warning labels', async () => {
    const events = await scanRecentWalletActivity(
      [{
        chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', score: 50, category: 'candidate',
        tokenAppearances: 2, tokensAppearedIn: [], narratives: [], averageFirstBuyRank: 1, bestFirstBuyRank: 1,
        monitorRecommendation: '', reasons: [], riskFlags: [], source: 'candidate_shortlist', importedAt: '', enabled: true, tags: [],
      }],
      {
        chains: ['base'],
        clientFactory: () => ({
          getBlockNumber: async () => 2000n,
          request: async () => ([{
            address: '0x00000000000000000000000000000000000000aa',
            topics: [
              '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55aebc8c7aeb',
              '0x00000000000000000000000000000000000000000000000000000000000000bb',
              '0x0000000000000000000000000000000000000000000000000000000000000001',
            ],
            data: '0x01',
            transactionHash: '0x' + '11'.repeat(32),
            blockNumber: '0x7d0',
            logIndex: '0x1',
          }]),
        } as never),
      },
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.tokenAddress).toBe('0x00000000000000000000000000000000000000aa');
    expect(events[0]?.warnings).toContain('incoming_transfer_not_confirmed_buy');
  });

  it('groups signals by token and classifies stable/wrapped tokens as ignored with risk flags', () => {
    const result = buildSignalsWithStats([
      {
        chain: 'base', walletAddress: '0x1', tokenAddress: '0xaaa', from: '0x2', to: '0x1', rawAmount: '0x1', txHash: '0xtx1',
        blockNumber: 1, logIndex: 0, observedAt: '2026-01-01T00:00:00.000Z', warnings: [], walletScore: 80,
        symbol: 'USDC', liquidityUsd: 200000, marketCap: 10_000_000, tokenAgeSeconds: 100,
      },
      {
        chain: 'base', walletAddress: '0x2', tokenAddress: '0xbbb', from: '0x3', to: '0x2', rawAmount: '0x1', txHash: '0xtx2',
        blockNumber: 1, logIndex: 0, observedAt: '2026-01-01T00:00:00.000Z', warnings: [], walletScore: 90,
        symbol: 'NEW', liquidityUsd: 300000, marketCap: 2_000_000, tokenAgeSeconds: 60,
      },
      {
        chain: 'base', walletAddress: '0x4', tokenAddress: '0xbbb', from: '0x5', to: '0x4', rawAmount: '0x1', txHash: '0xtx3',
        blockNumber: 2, logIndex: 1, observedAt: '2026-01-01T00:01:00.000Z', warnings: [], walletScore: 85,
        symbol: 'NEW', liquidityUsd: 300000, marketCap: 2_000_000, tokenAgeSeconds: 60,
      },
    ]);

    const signals = result.signals;
    const stable = signals.find((s) => s.tokenAddress === '0xaaa');
    const newToken = signals.find((s) => s.tokenAddress === '0xbbb');
    expect(stable).toBeDefined();
    expect(stable?.category).toBe('ignored');
    expect(stable?.riskFlags).toContain('stable_or_wrapped_token');
    expect(newToken?.watchedWalletCount).toBe(2);
    expect(['strong_signal', 'watch_signal', 'weak_signal']).toContain(newToken?.category);
    expect(result.groupsDropped).toBe(0);
    expect(result.dropReasons.stablecoin_or_wrapped_token ?? 0).toBe(0);
  });

  it('classifies all likely_buy context as likely_buy/high with distribution fields', () => {
    const signals = buildSignals([
      {
        chain: 'base', walletAddress: '0x1', tokenAddress: '0xabc', from: '0x2', to: '0x1', rawAmount: '0x1', txHash: '0xtx1',
        blockNumber: 1, logIndex: 0, observedAt: '2026-01-01T00:00:00.000Z', warnings: [], walletScore: 90,
        symbol: 'NEW', liquidityUsd: 300000, marketCap: 2_000_000, tokenAgeSeconds: 60,
        transactionContext: { txHash: '0xtx1', chain: 'base', logCount: 3, involvedAddresses: [], matchedTokenTransfer: true, likelyActivityType: 'likely_buy', confidence: 'high', reasons: ['known_router_seen'], warnings: [], knownRouterSeen: true },
      },
      {
        chain: 'base', walletAddress: '0x2', tokenAddress: '0xabc', from: '0x3', to: '0x2', rawAmount: '0x1', txHash: '0xtx2',
        blockNumber: 1, logIndex: 1, observedAt: '2026-01-01T00:01:00.000Z', warnings: [], walletScore: 85,
        symbol: 'NEW', liquidityUsd: 300000, marketCap: 2_000_000, tokenAgeSeconds: 60,
        transactionContext: { txHash: '0xtx2', chain: 'base', logCount: 4, involvedAddresses: [], matchedTokenTransfer: true, likelyActivityType: 'likely_buy', confidence: 'high', reasons: ['known_router_seen'], warnings: [], knownRouterSeen: true },
      },
    ]);
    expect(signals[0]?.likelyActivityType).toBe('likely_buy');
    expect(signals[0]?.confidence).toBe('high');
    expect(signals[0]?.likelyBuyEventCount).toBe(2);
    expect(signals[0]?.knownRouterEventCount).toBe(2);
    expect(signals[0]?.contextComposition.likely_buy).toBe(2);
  });

  it('classifies mixed likely_buy + airdrop as mixed_activity/medium', () => {
    const signals = buildSignals([
      {
        chain: 'base', walletAddress: '0x1', tokenAddress: '0xmix', from: '0x2', to: '0x1', rawAmount: '0x1', txHash: '0xtx1',
        blockNumber: 1, logIndex: 0, observedAt: '2026-01-01T00:00:00.000Z', warnings: [], walletScore: 90,
        symbol: 'MIX', liquidityUsd: 300000, marketCap: 2_000_000, tokenAgeSeconds: 60,
        transactionContext: { txHash: '0xtx1', chain: 'base', logCount: 3, involvedAddresses: [], matchedTokenTransfer: true, likelyActivityType: 'likely_buy', confidence: 'high', reasons: [], warnings: [], knownRouterSeen: true },
      },
      {
        chain: 'base', walletAddress: '0x2', tokenAddress: '0xmix', from: '0x3', to: '0x2', rawAmount: '0x1', txHash: '0xtx2',
        blockNumber: 2, logIndex: 1, observedAt: '2026-01-01T00:01:00.000Z', warnings: [], walletScore: 88,
        symbol: 'MIX', liquidityUsd: 300000, marketCap: 2_000_000, tokenAgeSeconds: 60,
        transactionContext: { txHash: '0xtx2', chain: 'base', logCount: 9, involvedAddresses: [], matchedTokenTransfer: true, likelyActivityType: 'airdrop_or_claim', confidence: 'medium', reasons: [], warnings: [], knownRouterSeen: false },
      },
    ]);
    expect(signals[0]?.likelyActivityType).toBe('mixed_activity');
    expect(signals[0]?.confidence).toBe('medium');
  });

  it('classifies airdrop dominant groups conservatively', () => {
    const signals = buildSignals([
      {
        chain: 'base', walletAddress: '0x1', tokenAddress: '0xair', from: '0x2', to: '0x1', rawAmount: '0x1', txHash: '0xtx1',
        blockNumber: 1, logIndex: 0, observedAt: '2026-01-01T00:00:00.000Z', warnings: [], walletScore: 80,
        symbol: 'AIR', liquidityUsd: 30000, marketCap: 50_000_000, tokenAgeSeconds: 7 * 24 * 3600,
        transactionContext: { txHash: '0xtx1', chain: 'base', logCount: 9, involvedAddresses: [], matchedTokenTransfer: true, likelyActivityType: 'airdrop_or_claim', confidence: 'medium', reasons: [], warnings: [], knownRouterSeen: false },
      },
      {
        chain: 'base', walletAddress: '0x2', tokenAddress: '0xair', from: '0x3', to: '0x2', rawAmount: '0x1', txHash: '0xtx2',
        blockNumber: 2, logIndex: 1, observedAt: '2026-01-01T00:01:00.000Z', warnings: [], walletScore: 82,
        symbol: 'AIR', liquidityUsd: 30000, marketCap: 50_000_000, tokenAgeSeconds: 7 * 24 * 3600,
        transactionContext: { txHash: '0xtx2', chain: 'base', logCount: 8, involvedAddresses: [], matchedTokenTransfer: true, likelyActivityType: 'airdrop_or_claim', confidence: 'medium', reasons: [], warnings: [], knownRouterSeen: false },
      },
    ]);
    expect(signals[0]?.likelyActivityType).toBe('airdrop_or_claim');
    expect(['medium', 'low']).toContain(signals[0]?.confidence);
  });

  it('keeps old high-market-cap single-wallet likely_buy as weak/ignored', () => {
    const signals = buildSignals([
      {
        chain: 'base', walletAddress: '0x1', tokenAddress: '0xpepe', from: '0x2', to: '0x1', rawAmount: '0x1', txHash: '0xtx1',
        blockNumber: 1, logIndex: 0, observedAt: '2026-01-01T00:00:00.000Z', warnings: [], walletScore: 25,
        symbol: 'PEPE', liquidityUsd: 200000, marketCap: 1_000_000_000, tokenAgeSeconds: 180 * 24 * 3600,
        transactionContext: { txHash: '0xtx1', chain: 'base', logCount: 3, involvedAddresses: [], matchedTokenTransfer: true, likelyActivityType: 'likely_buy', confidence: 'high', reasons: [], warnings: [], knownRouterSeen: true },
      },
    ]);
    expect(['weak_signal', 'ignored']).toContain(signals[0]?.category);
  });

  it('allows multi-wallet likely_buy majority groups to reach watch/strong', () => {
    const signals = buildSignals([
      {
        chain: 'base', walletAddress: '0x1', tokenAddress: '0xwatch', from: '0x2', to: '0x1', rawAmount: '0x1', txHash: '0xtx1',
        blockNumber: 1, logIndex: 0, observedAt: '2026-01-01T00:00:00.000Z', warnings: [], walletScore: 95,
        symbol: 'WATCH', liquidityUsd: 500000, marketCap: 1_500_000, tokenAgeSeconds: 1800,
        transactionContext: { txHash: '0xtx1', chain: 'base', logCount: 3, involvedAddresses: [], matchedTokenTransfer: true, likelyActivityType: 'likely_buy', confidence: 'high', reasons: [], warnings: [], knownRouterSeen: true },
      },
      {
        chain: 'base', walletAddress: '0x2', tokenAddress: '0xwatch', from: '0x3', to: '0x2', rawAmount: '0x1', txHash: '0xtx2',
        blockNumber: 2, logIndex: 1, observedAt: '2026-01-01T00:01:00.000Z', warnings: [], walletScore: 90,
        symbol: 'WATCH', liquidityUsd: 500000, marketCap: 1_500_000, tokenAgeSeconds: 1800,
        transactionContext: { txHash: '0xtx2', chain: 'base', logCount: 4, involvedAddresses: [], matchedTokenTransfer: true, likelyActivityType: 'likely_buy', confidence: 'high', reasons: [], warnings: [], knownRouterSeen: true },
      },
    ]);
    expect(['watch_signal', 'strong_signal']).toContain(signals[0]?.category);
  });

  it('builds bucketed signal dedupe keys deterministically', () => {
    const key1 = buildSignalDedupeKey({ chain: 'base', tokenAddress: '0xABC', watchedWallets: ['0x2', '0x1'], observedAtMs: 1_800_000 });
    const key2 = buildSignalDedupeKey({ chain: 'base', tokenAddress: '0xabc', watchedWallets: ['0x1', '0x2'], observedAtMs: 1_900_000 });
    expect(key1).toBe(key2);
  });

  it('formats strong signal production telegram card', () => {
    const msg = formatMonitorSignalMessage({
      chain: 'base', tokenAddress: '0xabc', symbol: 'NEW', name: 'New Token', watchedWalletCount: 2,
      watchedWallets: ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'],
      firstSeenAt: '', latestSeenAt: '', txCount: 3, uniqueTxCount: 2, marketCap: 1_000_000,
      liquidityUsd: 200_000, tokenAgeSeconds: 1000, warnings: ['requires_dex_context'], score: 70, category: 'strong_signal', reasons: ['likely_buy_detected'],
      positiveReasons: ['likely_buy_context'], negativeReasons: ['manual_review_required'], promotionBlockers: [], qualityNotes: ['high_confidence_context'],
      likelyActivityType: 'likely_buy', confidence: 'high', knownRouterSeen: true,
      contextEventCount: 3,
      likelyBuyEventCount: 2,
      transferEventCount: 1,
      airdropOrClaimEventCount: 0,
      contractInteractionEventCount: 0,
      unknownEventCount: 0,
      highConfidenceEventCount: 2,
      mediumConfidenceEventCount: 1,
      lowConfidenceEventCount: 0,
      knownRouterEventCount: 2,
      contextComposition: { likely_buy: 2, transfer: 1, airdrop_or_claim: 0, unknown: 0 },
    });
    expect(msg).toContain('🟢 BUY SIGNAL 🔁 UPDATE #Base');
    expect(msg).toContain('👥 Smart Wallets: 2');
    expect(msg).toContain('💎 Token: New Token');
    expect(msg).toContain('🔗 CA: 0xabc');
    expect(msg).toContain('Manual review required');
  });

  it('formats watch signal card', () => {
    const msg = formatMonitorSignalMessage({
      chain: 'base', tokenAddress: '0xmix', symbol: 'MIX', name: 'Mixed Token', watchedWalletCount: 2,
      watchedWallets: ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'],
      firstSeenAt: '', latestSeenAt: '', txCount: 4, uniqueTxCount: 3, marketCap: 1_000_000,
      liquidityUsd: 200_000, tokenAgeSeconds: 1000, warnings: [], score: 45, category: 'watch_signal', reasons: ['mixed_activity_detected'],
      positiveReasons: ['likely_buy_context'], negativeReasons: ['manual_review_required'], promotionBlockers: ['manual_review_required'], qualityNotes: ['mixed_activity_detected'],
      likelyActivityType: 'mixed_activity', confidence: 'medium', knownRouterSeen: true,
      contextEventCount: 4,
      likelyBuyEventCount: 1,
      transferEventCount: 1,
      airdropOrClaimEventCount: 2,
      contractInteractionEventCount: 0,
      unknownEventCount: 0,
      highConfidenceEventCount: 1,
      mediumConfidenceEventCount: 3,
      lowConfidenceEventCount: 0,
      knownRouterEventCount: 1,
      contextComposition: { likely_buy: 1, transfer: 1, airdrop_or_claim: 2, unknown: 0 },
    });
    expect(msg).toContain('🟡 WATCH SIGNAL #Base');
    expect(msg).toContain('Manual review required');
  });

  it('formats high activity weak signal card', () => {
    const msg = formatMonitorSignalMessage({
      chain: 'base', tokenAddress: '0xwhale', symbol: 'WHALE', name: 'Whale Token', watchedWalletCount: 1,
      watchedWallets: ['0x1'], firstSeenAt: '', latestSeenAt: '', txCount: 1, uniqueTxCount: 1,
      marketCap: 2_000_000, liquidityUsd: 300_000, tokenAgeSeconds: 3600, warnings: [], score: 30, category: 'weak_signal', reasons: ['large_buy'],
      positiveReasons: ['likely_buy_context'], negativeReasons: ['single_wallet_only'], promotionBlockers: ['single_wallet_only'], qualityNotes: ['single_wallet_watch_upgrade'],
      likelyActivityType: 'likely_buy', confidence: 'medium', knownRouterSeen: true,
      totalAmountNative: 7,
      contextEventCount: 1, likelyBuyEventCount: 1, transferEventCount: 0, airdropOrClaimEventCount: 0, contractInteractionEventCount: 0, unknownEventCount: 0,
      highConfidenceEventCount: 0, mediumConfidenceEventCount: 1, lowConfidenceEventCount: 0, knownRouterEventCount: 1,
      contextComposition: { likely_buy: 1 },
    });
    expect(msg).toContain('🐋 HIGH ACTIVITY #Base');
    expect(msg).toContain('Big-money buy detected');
  });

  it('uses n/a for missing fields', () => {
    const msg = formatMonitorSignalMessage({
      chain: 'base', tokenAddress: '0xna', watchedWalletCount: 1, watchedWallets: ['0x1'],
      firstSeenAt: '', latestSeenAt: '', txCount: 1, uniqueTxCount: 1, warnings: [], score: 10, category: 'watch_signal', reasons: [],
      positiveReasons: [], negativeReasons: ['market_data_missing'], promotionBlockers: ['market_data_missing'], qualityNotes: [],
      likelyActivityType: 'unknown', confidence: 'low', knownRouterSeen: false,
      contextEventCount: 1, likelyBuyEventCount: 0, transferEventCount: 0, airdropOrClaimEventCount: 0, contractInteractionEventCount: 0, unknownEventCount: 1,
      highConfidenceEventCount: 0, mediumConfidenceEventCount: 0, lowConfidenceEventCount: 1, knownRouterEventCount: 0,
      contextComposition: { unknown: 1 },
    });
    expect(msg).toContain('MCAP: n/a');
    expect(msg).toContain('Liquidity: n/a');
    expect(msg).toContain('Price: n/a');
  });

  it('builds inline buttons with chart/explorer/x search', () => {
    const keyboard = buildSignalInlineKeyboard({
      chain: 'base', tokenAddress: '0xabc', watchedWalletCount: 1, watchedWallets: ['0x1'],
      firstSeenAt: '', latestSeenAt: '', txCount: 1, uniqueTxCount: 1, warnings: [], score: 60, category: 'watch_signal', reasons: [],
      positiveReasons: ['likely_buy_context'], negativeReasons: [], promotionBlockers: [], qualityNotes: [],
      likelyActivityType: 'likely_buy', confidence: 'high', knownRouterSeen: true,
      contextEventCount: 1, likelyBuyEventCount: 1, transferEventCount: 0, airdropOrClaimEventCount: 0, contractInteractionEventCount: 0, unknownEventCount: 0,
      highConfidenceEventCount: 1, mediumConfidenceEventCount: 0, lowConfidenceEventCount: 0, knownRouterEventCount: 1,
      contextComposition: { likely_buy: 1 },
      dexUrl: 'https://dexscreener.com/base/0xabc',
      explorerUrl: 'https://basescan.org/address/0xabc',
      xSearchUrl: 'https://x.com/search?q=0xabc',
    });
    expect(JSON.stringify(keyboard)).toContain('📊 Chart');
    expect(JSON.stringify(keyboard)).toContain('🔍 Explorer');
    expect(JSON.stringify(keyboard)).toContain('𝕏 Search');
  });

  it('hides trade placeholder buttons by default', () => {
    const keyboard = buildSignalInlineKeyboard({
      chain: 'base', tokenAddress: '0xabc', watchedWalletCount: 1, watchedWallets: ['0x1'],
      firstSeenAt: '', latestSeenAt: '', txCount: 1, uniqueTxCount: 1, warnings: [], score: 60, category: 'watch_signal', reasons: [],
      positiveReasons: ['likely_buy_context'], negativeReasons: [], promotionBlockers: [], qualityNotes: [],
      likelyActivityType: 'likely_buy', confidence: 'high', knownRouterSeen: true,
      contextEventCount: 1, likelyBuyEventCount: 1, transferEventCount: 0, airdropOrClaimEventCount: 0, contractInteractionEventCount: 0, unknownEventCount: 0,
      highConfidenceEventCount: 1, mediumConfidenceEventCount: 0, lowConfidenceEventCount: 0, knownRouterEventCount: 1,
      contextComposition: { likely_buy: 1 },
    });
    expect(JSON.stringify(keyboard)).not.toContain('trade_placeholder_');
  });

  it('writes monitor poll outputs with mocked deps and dry-run flow', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'monitor-poll-'));
    const watchlist = path.join(tmp, 'monitor-wallets.json');
    const outDir = path.join(tmp, 'out');
    await writeFile(watchlist, JSON.stringify([
      {
        chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', score: 80, category: 'candidate',
        tokenAppearances: 3, tokensAppearedIn: [], narratives: [], averageFirstBuyRank: 1, bestFirstBuyRank: 1,
        monitorRecommendation: '', reasons: [], riskFlags: [], source: 'candidate_shortlist', importedAt: '', enabled: true, tags: [],
      },
    ]), 'utf8');

    const sendTelegram = vi.fn(async () => {});

    await runMonitorPoll(
      {
        watchlist,
        chains: ['base'],
        maxWallets: 20,
        ethereumBlocks: 100,
        baseBlocks: 300,
        bscBlocks: 300,
        out: outDir,
        activityProvider: 'auto',
        knownTokens: '',
        telegramDryRun: true,
        sendTelegram: false,
        telegramChatId: '',
      },
      {
        addresslessProvider: {
          getRecentIncomingTokenEvents: async () => ({
            events: [
              {
                chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', tokenAddress: '0x00000000000000000000000000000000000000aa',
                from: '0x2', to: '0x1', rawAmount: '0x1', txHash: '0x' + '11'.repeat(32), blockNumber: 1, logIndex: 0,
                observedAt: '2026-01-01T00:00:00.000Z', warnings: ['incoming_transfer_not_confirmed_buy'], walletScore: 80,
              },
            ],
            stats: { chainsScanned: ['base'], walletsScanned: 1, walletScanFailures: 0, addresslessLogsSupported: 'true', warnings: [] },
            errors: [],
            failureDetails: [],
          }),
        } as never,
        marketClient: {
          getTokenProfile: async () => ({
            chain: 'base', chainFamily: 'evm', tokenAddress: '0x00000000000000000000000000000000000000aa', symbol: 'NEW',
            name: 'New', liquidityUsd: 300000, marketCap: 2_000_000, fdv: 3_000_000, pairCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
            tokenAgeSeconds: 60, warnings: [], raw: { volume: { h24: 1000 }, priceChange: { h24: 12 } },
          } as never),
        } as never,
        sendTelegram,
        nowMs: () => 1_800_000,
      },
    );

    const summary = JSON.parse(await readFile(path.join(outDir, 'monitor-summary.json'), 'utf8'));
    expect(summary.providerModeRequested).toBe('auto');
    expect(summary.rawEventsFound).toBe(1);
    expect(summary.eventsFound).toBe(1);
    expect(summary.tokenGroupsFound).toBe(1);
    expect(summary.groupsBuilt).toBe(1);
    expect(summary.signalsBuilt).toBe(1);
    expect(summary.signalsByCategory).toBeDefined();
    expect(summary.dedupedSignalsForDelivery).toBeGreaterThanOrEqual(0);
    expect(summary.outputFiles).toContain('wallet-scan-failures.json');
    await expect(readFile(path.join(outDir, 'events.json'), 'utf8')).resolves.toContain('tokenAddress');
    await expect(readFile(path.join(outDir, 'wallet-scan-failures.json'), 'utf8')).resolves.toContain('[]');
    await expect(readFile(path.join(outDir, 'signals.csv'), 'utf8')).resolves.toContain('chain,tokenAddress');
    await expect(readFile(path.join(outDir, 'signals.csv'), 'utf8')).resolves.toContain('contextComposition');
    const signalsJsonRaw = await readFile(path.join(outDir, 'signals.json'), 'utf8');
    const signalsJson = JSON.parse(signalsJsonRaw) as Array<Record<string, unknown>>;
    expect(Array.isArray(signalsJson)).toBe(true);
    expect(signalsJson.length).toBe(1);
    expect(signalsJson[0]).toHaveProperty('likelyBuyEventCount');
    expect(signalsJson[0]).toHaveProperty('transferEventCount');
    expect(signalsJson[0]).toHaveProperty('airdropOrClaimEventCount');
    expect(signalsJson[0]).toHaveProperty('contractInteractionEventCount');
    expect(signalsJson[0]).toHaveProperty('unknownEventCount');
    expect(signalsJson[0]).toHaveProperty('highConfidenceEventCount');
    expect(signalsJson[0]).toHaveProperty('mediumConfidenceEventCount');
    expect(signalsJson[0]).toHaveProperty('lowConfidenceEventCount');
    expect(signalsJson[0]).toHaveProperty('knownRouterEventCount');
    expect(signalsJson[0]).toHaveProperty('contextComposition');
    expect(signalsJson[0]).toHaveProperty('reasons');
    expect(sendTelegram).toHaveBeenCalledTimes(1);
  });

  it('classifies addressless RPC restriction errors', () => {
    expect(isAddresslessLogsRestrictionError(new Error('Please specify an address in your request'))).toBe(true);
    expect(isAddresslessLogsRestrictionError(new Error('order a dedicated full node'))).toBe(true);
    expect(isAddresslessLogsRestrictionError(new Error('timeout'))).toBe(false);
  });

  it('auto mode writes outputs and warnings when addressless is rejected', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'monitor-poll-restricted-'));
    const watchlist = path.join(tmp, 'monitor-wallets.json');
    const outDir = path.join(tmp, 'out');
    await writeFile(watchlist, JSON.stringify([
      {
        chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', score: 80, category: 'candidate',
        tokenAppearances: 3, tokensAppearedIn: [], narratives: [], averageFirstBuyRank: 1, bestFirstBuyRank: 1,
        monitorRecommendation: '', reasons: [], riskFlags: [], source: 'candidate_shortlist', importedAt: '', enabled: true, tags: [],
      },
    ]), 'utf8');

    await runMonitorPoll({
      watchlist,
      chains: ['base'],
      maxWallets: 20,
      ethereumBlocks: 100,
      baseBlocks: 300,
      bscBlocks: 300,
      out: outDir,
      activityProvider: 'auto',
      knownTokens: '',
      telegramDryRun: true,
      sendTelegram: false,
      telegramChatId: '',
    }, {
      addresslessProvider: {
        getRecentIncomingTokenEvents: async () => ({
          events: [],
          stats: makeStats({ walletScanFailures: 1, addresslessLogsSupported: 'false', walletsWithFailures: 1, walletsWithNoActivity: 0 }),
          errors: [{ code: 'addressless_logs_not_supported', chain: 'base', walletAddress: '0x1', message: 'Please specify an address' }],
          failureDetails: [{
            chain: 'base', walletAddress: '0x1', providerMode: 'rpc-addressless', errorKind: 'addressless_logs_not_supported',
            shortMessage: 'Please specify an address', rawMessage: 'Please specify an address',
          }],
        }),
      } as never,
      sendTelegram: vi.fn(async () => {}),
    });

    const summary = JSON.parse(await readFile(path.join(outDir, 'monitor-summary.json'), 'utf8'));
    expect(summary.warnings).toContain('addressless_logs_not_supported');
    await expect(readFile(path.join(outDir, 'events.json'), 'utf8')).resolves.toBeDefined();
    await expect(readFile(path.join(outDir, 'signals.csv'), 'utf8')).resolves.toContain('chain,tokenAddress');
  });

  it('auto mode falls back to known tokens provider when configured', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'monitor-poll-fallback-'));
    const watchlist = path.join(tmp, 'monitor-wallets.json');
    const knownTokensFile = path.join(tmp, 'known-tokens.json');
    const outDir = path.join(tmp, 'out');
    await writeFile(watchlist, JSON.stringify([
      {
        chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', score: 80, category: 'candidate',
        tokenAppearances: 3, tokensAppearedIn: [], narratives: [], averageFirstBuyRank: 1, bestFirstBuyRank: 1,
        monitorRecommendation: '', reasons: [], riskFlags: [], source: 'candidate_shortlist', importedAt: '', enabled: true, tags: [],
      },
    ]), 'utf8');
    await writeFile(knownTokensFile, JSON.stringify([{ chain: 'base', tokenAddress: '0x00000000000000000000000000000000000000aa', symbol: 'NEW' }]), 'utf8');

    await runMonitorPoll({
      watchlist,
      chains: ['base'],
      maxWallets: 20,
      ethereumBlocks: 100,
      baseBlocks: 300,
      bscBlocks: 300,
      out: outDir,
      activityProvider: 'auto',
      knownTokens: knownTokensFile,
      telegramDryRun: true,
      sendTelegram: false,
      telegramChatId: '',
    }, {
      addresslessProvider: {
        getRecentIncomingTokenEvents: async () => ({
          events: [],
          stats: makeStats({ walletScanFailures: 1, addresslessLogsSupported: 'false', walletsWithFailures: 1, walletsWithNoActivity: 0 }),
          errors: [{ code: 'addressless_logs_not_supported', chain: 'base', walletAddress: '0x1', message: 'Please specify an address' }],
          failureDetails: [{
            chain: 'base', walletAddress: '0x1', providerMode: 'rpc-addressless', errorKind: 'addressless_logs_not_supported',
            shortMessage: 'Please specify an address', rawMessage: 'Please specify an address',
          }],
        }),
      } as never,
      knownTokensProvider: {
        getRecentIncomingTokenEvents: async () => ({
          events: [{
            chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', tokenAddress: '0x00000000000000000000000000000000000000aa',
            from: '0x2', to: '0x1', rawAmount: '0x1', txHash: '0x' + '11'.repeat(32), blockNumber: 1, logIndex: 0,
            observedAt: '2026-01-01T00:00:00.000Z', warnings: ['incoming_transfer_not_confirmed_buy'], walletScore: 80,
          }],
          stats: makeStats({
            addresslessLogsSupported: 'unknown',
            knownTokensByChain: { base: 1 },
            scannedTokenWalletPairs: 1,
            successfulTokenWalletPairs: 1,
            walletsWithNoActivity: 0,
            walletsWithActivity: 1,
          }),
          errors: [],
          failureDetails: [],
        }),
      } as never,
      marketClient: { getTokenProfile: async () => null } as never,
      sendTelegram: vi.fn(async () => {}),
    });

    const summary = JSON.parse(await readFile(path.join(outDir, 'monitor-summary.json'), 'utf8'));
    expect(summary.providerModeUsed).toBe('rpc-known-tokens');
    expect(summary.providerFallbackUsed).toBe(true);
  });

  it('known token provider sends eth_getLogs with token address', async () => {
    const requests: unknown[] = [];
    const provider = new RpcKnownTokensActivityProvider();
    await provider.getRecentIncomingTokenEvents({
      wallets: [{
        chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', score: 10, category: 'candidate',
        tokenAppearances: 1, tokensAppearedIn: [], narratives: [], averageFirstBuyRank: 1, bestFirstBuyRank: 1,
        monitorRecommendation: '', reasons: [], riskFlags: [], source: 'candidate_shortlist', importedAt: '', enabled: true, tags: [],
      }],
      chains: ['base'],
      knownTokens: [{ chain: 'base', tokenAddress: '0x00000000000000000000000000000000000000aa', symbol: 'NEW' }],
      clientFactory: () => ({
        getBlockNumber: async () => 10n,
        request: async (payload: unknown) => {
          requests.push(payload);
          return [];
        },
      } as never),
    });
    expect(JSON.stringify(requests)).toContain('"address":"0x00000000000000000000000000000000000000aa"');
    const payload = (requests[0] as any)?.params?.[0];
    expect(payload.fromBlock).toBe('0x0');
    expect(payload.toBlock).toBe('0x9');
  });

  it('rpc-wallet-activity/addressless builds valid addressless getLogs payload', async () => {
    const requests: any[] = [];
    const provider = new RpcAddresslessActivityProvider();
    await provider.getRecentIncomingTokenEvents({
      wallets: [{
        chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', score: 10, category: 'candidate',
        tokenAppearances: 1, tokensAppearedIn: [], narratives: [], averageFirstBuyRank: 1, bestFirstBuyRank: 1,
        monitorRecommendation: '', reasons: [], riskFlags: [], source: 'candidate_shortlist', importedAt: '', enabled: true, tags: [],
      }],
      chains: ['base'],
      blockWindows: { base: 9, ethereum: 9, bsc: 9 },
      clientFactory: () => ({
        getBlockNumber: async () => 9n,
        request: async (payload: unknown) => {
          requests.push(payload);
          return [];
        },
      } as never),
    });

    const payload = requests[0]?.params?.[0];
    expect(payload).toBeDefined();
    expect(payload.address).toBeUndefined();
    expect(Array.isArray(payload.topics)).toBe(true);
    expect(payload.topics[0]).toBe(ERC20_TRANSFER_TOPIC);
    expect(payload.topics[1]).toBeNull();
    expect(payload.topics[2]).toBe('0x0000000000000000000000000000000000000000000000000000000000000001');
    expect(payload.fromBlock).toBe('0x0');
    expect(payload.toBlock).toBe('0x9');
    expect(payload.fromBlock).not.toBe('0x00');
    expect(payload.toBlock).not.toBe('0x09');
    expect(Object.values(payload).some((x) => x === undefined)).toBe(false);
  });

  it('rpc-addressless maps local malformed filter to invalid_getlogs_payload', async () => {
    const provider = new RpcAddresslessActivityProvider();
    const result = await provider.getRecentIncomingTokenEvents({
      wallets: [{
        chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', score: 10, category: 'candidate',
        tokenAppearances: 1, tokensAppearedIn: [], narratives: [], averageFirstBuyRank: 1, bestFirstBuyRank: 1,
        monitorRecommendation: '', reasons: [], riskFlags: [], source: 'candidate_shortlist', importedAt: '', enabled: true, tags: [],
      }],
      chains: ['base'],
      clientFactory: () => ({
        getBlockNumber: async () => 9n,
        request: async () => {
          throw new Error('addressless_getlogs_payload_invalid:from_block_invalid_rpc_quantity_hex');
        },
      } as never),
    });

    expect(result.failureDetails[0]?.errorKind).toBe('invalid_getlogs_payload');
    expect(result.errors[0]?.code).toBe('invalid_getlogs_payload');
    expect(result.stats.failureKinds.invalid_getlogs_payload).toBe(1);
  });

  it('rpc-addressless treats provider JSON-invalid response with locally valid filter as addressless_logs_not_supported', async () => {
    const provider = new RpcAddresslessActivityProvider();
    const result = await provider.getRecentIncomingTokenEvents({
      wallets: [{
        chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', score: 10, category: 'candidate',
        tokenAppearances: 1, tokensAppearedIn: [], narratives: [], averageFirstBuyRank: 1, bestFirstBuyRank: 1,
        monitorRecommendation: '', reasons: [], riskFlags: [], source: 'candidate_shortlist', importedAt: '', enabled: true, tags: [],
      }],
      chains: ['base'],
      clientFactory: () => ({
        getBlockNumber: async () => 9n,
        request: async () => {
          throw new Error('JSON is not a valid request object. Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. Based on your parameters, this block range should work: [0x0, 0x9]. Upgrade to PAYG for expanded block range.');
        },
      } as never),
    });

    expect(result.failureDetails[0]?.errorKind).toBe('addressless_logs_not_supported');
    expect(result.errors[0]?.code).toBe('addressless_logs_not_supported');
    expect(result.stats.failureKinds.addressless_logs_not_supported).toBe(1);
    expect(result.failureDetails[0]?.requestPayload).toBeDefined();
    const sample = result.failureDetails[0]?.requestPayload as any;
    expect(sample?.fromBlock).toBe('0x0');
    expect(sample?.toBlock).toBe('0x9');
    expect(Array.isArray(sample?.topics)).toBe(true);
    expect(sample?.topics?.[0]).toBe(ERC20_TRANSFER_TOPIC);
  });

  it('known token provider pads wallet topic in topics[2]', async () => {
    const requests: any[] = [];
    const provider = new RpcKnownTokensActivityProvider();
    await provider.getRecentIncomingTokenEvents({
      wallets: [{
        chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', score: 10, category: 'candidate',
        tokenAppearances: 1, tokensAppearedIn: [], narratives: [], averageFirstBuyRank: 1, bestFirstBuyRank: 1,
        monitorRecommendation: '', reasons: [], riskFlags: [], source: 'candidate_shortlist', importedAt: '', enabled: true, tags: [],
      }],
      chains: ['base'],
      knownTokens: [{ chain: 'base', tokenAddress: '0x00000000000000000000000000000000000000aa', symbol: 'NEW' }],
      clientFactory: () => ({
        getBlockNumber: async () => 10n,
        request: async (payload: unknown) => {
          requests.push(payload);
          return [];
        },
      } as never),
    });
    const topic2 = requests[0]?.params?.[0]?.topics?.[2];
    expect(topic2).toBe('0x0000000000000000000000000000000000000000000000000000000000000001');
  });

  it('known token provider only scans tokens matching wallet chain', async () => {
    const requests: unknown[] = [];
    const provider = new RpcKnownTokensActivityProvider();
    const result = await provider.getRecentIncomingTokenEvents({
      wallets: [{
        chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', score: 10, category: 'candidate',
        tokenAppearances: 1, tokensAppearedIn: [], narratives: [], averageFirstBuyRank: 1, bestFirstBuyRank: 1,
        monitorRecommendation: '', reasons: [], riskFlags: [], source: 'candidate_shortlist', importedAt: '', enabled: true, tags: [],
      }],
      chains: ['base'],
      knownTokens: [
        { chain: 'base', tokenAddress: '0x00000000000000000000000000000000000000aa', symbol: 'BASE' },
        { chain: 'ethereum', tokenAddress: '0x00000000000000000000000000000000000000bb', symbol: 'ETH' },
      ],
      clientFactory: () => ({
        getBlockNumber: async () => 10n,
        request: async (payload: unknown) => {
          requests.push(payload);
          return [];
        },
      } as never),
    });
    expect(requests).toHaveLength(2);
    expect(result.stats.scannedTokenWalletPairs).toBe(1);
    expect(result.stats.knownTokensByChain.base).toBe(1);
    expect(result.stats.knownTokensByChain.ethereum).toBe(1);
  });

  it('known token provider treats empty logs as success not failure', async () => {
    const provider = new RpcKnownTokensActivityProvider();
    const result = await provider.getRecentIncomingTokenEvents({
      wallets: [{
        chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', score: 10, category: 'candidate',
        tokenAppearances: 1, tokensAppearedIn: [], narratives: [], averageFirstBuyRank: 1, bestFirstBuyRank: 1,
        monitorRecommendation: '', reasons: [], riskFlags: [], source: 'candidate_shortlist', importedAt: '', enabled: true, tags: [],
      }],
      chains: ['base'],
      knownTokens: [{ chain: 'base', tokenAddress: '0x00000000000000000000000000000000000000aa', symbol: 'NEW' }],
      clientFactory: () => ({
        getBlockNumber: async () => 10n,
        request: async () => [],
      } as never),
    });
    expect(result.stats.walletScanFailures).toBe(0);
    expect(result.stats.walletsWithNoActivity).toBe(1);
    expect(result.stats.successfulTokenWalletPairs).toBe(1);
  });

  it('known token provider writes failure details for rpc errors', async () => {
    const provider = new RpcKnownTokensActivityProvider();
    const result = await provider.getRecentIncomingTokenEvents({
      wallets: [{
        chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', score: 10, category: 'candidate',
        tokenAppearances: 1, tokensAppearedIn: [], narratives: [], averageFirstBuyRank: 1, bestFirstBuyRank: 1,
        monitorRecommendation: '', reasons: [], riskFlags: [], source: 'candidate_shortlist', importedAt: '', enabled: true, tags: [],
      }],
      chains: ['base'],
      knownTokens: [{ chain: 'base', tokenAddress: '0x00000000000000000000000000000000000000aa', symbol: 'NEW' }],
      clientFactory: () => ({
        getBlockNumber: async () => 10n,
        request: async () => {
          throw new Error('timeout while calling rpc');
        },
      } as never),
    });
    expect(result.failureDetails.length).toBeGreaterThan(0);
    expect(result.failureDetails[0]?.errorKind).toBe('rpc_timeout');
    expect(result.stats.failureKinds.rpc_timeout).toBe(2);
  });

  it('known token provider invalid wallet address produces invalid_payload without rpc call', async () => {
    const requestSpy = vi.fn();
    const provider = new RpcKnownTokensActivityProvider();
    const result = await provider.getRecentIncomingTokenEvents({
      wallets: [{
        chain: 'base', walletAddress: '0x123', score: 10, category: 'candidate',
        tokenAppearances: 1, tokensAppearedIn: [], narratives: [], averageFirstBuyRank: 1, bestFirstBuyRank: 1,
        monitorRecommendation: '', reasons: [], riskFlags: [], source: 'candidate_shortlist', importedAt: '', enabled: true, tags: [],
      }],
      chains: ['base'],
      knownTokens: [{ chain: 'base', tokenAddress: '0x00000000000000000000000000000000000000aa', symbol: 'NEW' }],
      clientFactory: () => ({
        getBlockNumber: async () => 10n,
        request: requestSpy,
      } as never),
    });
    expect(requestSpy).not.toHaveBeenCalled();
    expect(result.failureDetails[0]?.errorKind).toBe('invalid_payload');
    expect(result.errors[0]?.code).toBe('invalid_payload');
  });

  it('known token provider classifies odd-length hex provider error as invalid_hex_payload', async () => {
    const provider = new RpcKnownTokensActivityProvider();
    const result = await provider.getRecentIncomingTokenEvents({
      wallets: [{
        chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', score: 10, category: 'candidate',
        tokenAppearances: 1, tokensAppearedIn: [], narratives: [], averageFirstBuyRank: 1, bestFirstBuyRank: 1,
        monitorRecommendation: '', reasons: [], riskFlags: [], source: 'candidate_shortlist', importedAt: '', enabled: true, tags: [],
      }],
      chains: ['base'],
      knownTokens: [{ chain: 'base', tokenAddress: '0x00000000000000000000000000000000000000aa', symbol: 'NEW' }],
      clientFactory: () => ({
        getBlockNumber: async () => 10n,
        request: async () => {
          throw new Error('invalid argument 0: hex string of odd length');
        },
      } as never),
    });
    expect(result.failureDetails[0]?.errorKind).toBe('invalid_hex_payload');
    expect(result.errors[0]?.code).toBe('invalid_hex_payload');
    expect(result.stats.failureKinds.invalid_hex_payload).toBe(2);
  });

  it('known token provider validates payload before rpc call and ignores in-flight rpc payload mutation', async () => {
    const requestSpy = vi.fn(async () => []);
    const provider = new RpcKnownTokensActivityProvider();
    const result = await provider.getRecentIncomingTokenEvents({
      wallets: [{
        chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', score: 10, category: 'candidate',
        tokenAppearances: 1, tokensAppearedIn: [], narratives: [], averageFirstBuyRank: 1, bestFirstBuyRank: 1,
        monitorRecommendation: '', reasons: [], riskFlags: [], source: 'candidate_shortlist', importedAt: '', enabled: true, tags: [],
      }],
      chains: ['base'],
      knownTokens: [{ chain: 'base', tokenAddress: '0x00000000000000000000000000000000000000aa', symbol: 'NEW' }],
      clientFactory: () => ({
        getBlockNumber: async () => 10n,
        request: async (payload: any) => {
          if (payload?.method === 'eth_getLogs') {
            payload.params[0].fromBlock = '0x00';
          }
          requestSpy();
          return [];
        },
      } as never),
    });

    expect(requestSpy).toHaveBeenCalledTimes(2);
    expect(result.failureDetails).toHaveLength(0);
    expect(result.stats.successfulTokenWalletPairs).toBe(1);
  });

  it('known token provider classifies leading-zero quantity provider error as invalid_rpc_quantity_hex', async () => {
    const provider = new RpcKnownTokensActivityProvider();
    const result = await provider.getRecentIncomingTokenEvents({
      wallets: [{
        chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', score: 10, category: 'candidate',
        tokenAppearances: 1, tokensAppearedIn: [], narratives: [], averageFirstBuyRank: 1, bestFirstBuyRank: 1,
        monitorRecommendation: '', reasons: [], riskFlags: [], source: 'candidate_shortlist', importedAt: '', enabled: true, tags: [],
      }],
      chains: ['base'],
      knownTokens: [{ chain: 'base', tokenAddress: '0x00000000000000000000000000000000000000aa', symbol: 'NEW' }],
      clientFactory: () => ({
        getBlockNumber: async () => 10n,
        request: async () => {
          throw new Error('invalid argument 0: hex number with leading zero digits');
        },
      } as never),
    });

    expect(result.failureDetails[0]?.errorKind).toBe('invalid_rpc_quantity_hex');
    expect(result.errors[0]?.code).toBe('invalid_rpc_quantity_hex');
    expect(result.failureDetails[0]?.rawMessage).toContain('hex number with leading zero digits');
  });

  it('known token provider chunks getLogs range and merges logs', async () => {
    const requests: any[] = [];
    const provider = new RpcKnownTokensActivityProvider();
    const result = await provider.getRecentIncomingTokenEvents({
      wallets: [{
        chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', score: 10, category: 'candidate',
        tokenAppearances: 1, tokensAppearedIn: [], narratives: [], averageFirstBuyRank: 1, bestFirstBuyRank: 1,
        monitorRecommendation: '', reasons: [], riskFlags: [], source: 'candidate_shortlist', importedAt: '', enabled: true, tags: [],
      }],
      chains: ['base'],
      knownTokens: [{ chain: 'base', tokenAddress: '0x00000000000000000000000000000000000000aa', symbol: 'NEW' }],
      blockWindows: { base: 99, ethereum: 99, bsc: 99 },
      getLogsMaxBlockRange: 10,
      clientFactory: () => ({
        getBlockNumber: async () => 99n,
        request: async (payload: any) => {
          requests.push(payload);
          if (payload.method !== 'eth_getLogs') return [];
          if (payload.params[0].fromBlock === '0x0') {
            return [{
              address: '0x00000000000000000000000000000000000000aa',
              topics: [
                '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                '0x0000000000000000000000000000000000000000000000000000000000000002',
                '0x0000000000000000000000000000000000000000000000000000000000000001',
              ],
              data: '0x1',
              transactionHash: `0x${'11'.repeat(32)}`,
              blockNumber: '0x1',
              logIndex: '0x0',
            }];
          }
          return [];
        },
      } as never),
    });

    const getLogsRequests = requests.filter((x) => x.method === 'eth_getLogs');
    expect(getLogsRequests).toHaveLength(10);
    expect(getLogsRequests[0].params[0].fromBlock).toBe('0x0');
    expect(getLogsRequests[0].params[0].toBlock).toBe('0x9');
    expect(getLogsRequests[1].params[0].fromBlock).toBe('0xa');
    expect(getLogsRequests[9].params[0].fromBlock).toBe('0x5a');
    expect(getLogsRequests[9].params[0].toBlock).toBe('0x63');
    expect(getLogsRequests[0].params[0].fromBlock).not.toContain('0x00');
    expect(result.events.length).toBe(1);
    expect(result.stats.getLogsChunksRequested).toBe(10);
    expect(result.stats.getLogsChunksSucceeded).toBe(10);
    expect(result.stats.getLogsChunksFailed).toBe(0);
  });

  it('known token provider keeps pair successful when one chunk fails', async () => {
    const provider = new RpcKnownTokensActivityProvider();
    const result = await provider.getRecentIncomingTokenEvents({
      wallets: [{
        chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', score: 10, category: 'candidate',
        tokenAppearances: 1, tokensAppearedIn: [], narratives: [], averageFirstBuyRank: 1, bestFirstBuyRank: 1,
        monitorRecommendation: '', reasons: [], riskFlags: [], source: 'candidate_shortlist', importedAt: '', enabled: true, tags: [],
      }],
      chains: ['base'],
      knownTokens: [{ chain: 'base', tokenAddress: '0x00000000000000000000000000000000000000aa', symbol: 'NEW' }],
      blockWindows: { base: 99, ethereum: 99, bsc: 99 },
      getLogsMaxBlockRange: 10,
      clientFactory: () => ({
        getBlockNumber: async () => 99n,
        request: async (payload: any) => {
          if (payload.method !== 'eth_getLogs') return [];
          if (payload.params[0].fromBlock === '0x14') {
            throw new Error('timeout while calling rpc');
          }
          return [];
        },
      } as never),
    });

    expect(result.stats.successfulTokenWalletPairs).toBe(1);
    expect(result.stats.failedTokenWalletPairs).toBe(0);
    expect(result.stats.tokenWalletPairsPartiallyFailed).toBe(1);
    expect(result.stats.getLogsChunksFailed).toBe(1);
  });

  it('known token provider classifies alchemy range error as getlogs_range_too_wide', async () => {
    const provider = new RpcKnownTokensActivityProvider();
    const result = await provider.getRecentIncomingTokenEvents({
      wallets: [{
        chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', score: 10, category: 'candidate',
        tokenAppearances: 1, tokensAppearedIn: [], narratives: [], averageFirstBuyRank: 1, bestFirstBuyRank: 1,
        monitorRecommendation: '', reasons: [], riskFlags: [], source: 'candidate_shortlist', importedAt: '', enabled: true, tags: [],
      }],
      chains: ['base'],
      knownTokens: [{ chain: 'base', tokenAddress: '0x00000000000000000000000000000000000000aa', symbol: 'NEW' }],
      clientFactory: () => ({
        getBlockNumber: async () => 10n,
        request: async () => {
          throw new Error('Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.');
        },
      } as never),
    });

    expect(result.failureDetails[0]?.errorKind).toBe('getlogs_range_too_wide');
    expect(result.errors[0]?.code).toBe('getlogs_range_too_wide');
  });

  it('runMonitorPoll passes getLogsMaxBlockRange to known-token provider', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'monitor-poll-getlogs-arg-'));
    const watchlist = path.join(tmp, 'monitor-wallets.json');
    const knownTokensFile = path.join(tmp, 'known-tokens.json');
    const outDir = path.join(tmp, 'out');
    await writeFile(watchlist, JSON.stringify([{
      chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', score: 80, category: 'candidate',
      tokenAppearances: 3, tokensAppearedIn: [], narratives: [], averageFirstBuyRank: 1, bestFirstBuyRank: 1,
      monitorRecommendation: '', reasons: [], riskFlags: [], source: 'candidate_shortlist', importedAt: '', enabled: true, tags: [],
    }]), 'utf8');
    await writeFile(knownTokensFile, JSON.stringify([{ chain: 'base', tokenAddress: '0x00000000000000000000000000000000000000aa', symbol: 'NEW' }]), 'utf8');

    const knownTokensSpy = vi.fn(async () => ({
      events: [],
      stats: makeStats(),
      errors: [],
      failureDetails: [],
    })) as any;

    await runMonitorPoll({
      watchlist,
      chains: ['base'],
      maxWallets: 20,
      ethereumBlocks: 100,
      baseBlocks: 300,
      bscBlocks: 300,
      out: outDir,
      activityProvider: 'rpc-known-tokens',
      knownTokens: knownTokensFile,
      getLogsMaxBlockRange: 10,
      telegramDryRun: true,
      sendTelegram: false,
      telegramChatId: '',
    }, {
      knownTokensProvider: { getRecentIncomingTokenEvents: knownTokensSpy } as never,
      marketClient: { getTokenProfile: async () => null } as never,
      sendTelegram: vi.fn(async () => {}),
    });

    const passed = (knownTokensSpy.mock.calls[0] as any[] | undefined)?.[0];
    expect(passed).toBeDefined();
    expect(passed.getLogsMaxBlockRange).toBe(10);
  });

  it('monitor summary includes failure detail counts and kinds', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'monitor-poll-failure-summary-'));
    const watchlist = path.join(tmp, 'monitor-wallets.json');
    const knownTokensFile = path.join(tmp, 'known-tokens.json');
    const outDir = path.join(tmp, 'out');
    await writeFile(watchlist, JSON.stringify([
      {
        chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', score: 80, category: 'candidate',
        tokenAppearances: 3, tokensAppearedIn: [], narratives: [], averageFirstBuyRank: 1, bestFirstBuyRank: 1,
        monitorRecommendation: '', reasons: [], riskFlags: [], source: 'candidate_shortlist', importedAt: '', enabled: true, tags: [],
      },
    ]), 'utf8');
    await writeFile(knownTokensFile, JSON.stringify([{ chain: 'base', tokenAddress: '0x00000000000000000000000000000000000000aa', symbol: 'NEW' }]), 'utf8');

    await runMonitorPoll({
      watchlist,
      chains: ['base'],
      maxWallets: 20,
      ethereumBlocks: 100,
      baseBlocks: 300,
      bscBlocks: 300,
      out: outDir,
      activityProvider: 'rpc-known-tokens',
      knownTokens: knownTokensFile,
      telegramDryRun: true,
      sendTelegram: false,
      telegramChatId: '',
    }, {
      knownTokensProvider: {
        getRecentIncomingTokenEvents: async () => ({
          events: [],
          stats: makeStats({
            walletScanFailures: 1,
            walletScanFailureDetailsCount: 2,
            failureKinds: { rpc_timeout: 2 },
            failuresByChain: { base: 2 },
            failuresByProviderMode: { 'rpc-known-tokens': 2 },
            knownTokensByChain: { base: 1 },
            scannedTokenWalletPairs: 1,
            failedTokenWalletPairs: 1,
            walletsWithFailures: 1,
            walletsWithNoActivity: 0,
          }),
          errors: [{ code: 'rpc_timeout', chain: 'base', walletAddress: '0x1', message: 'timeout' }],
          failureDetails: [{
            chain: 'base', walletAddress: '0x1', providerMode: 'rpc-known-tokens', errorKind: 'rpc_timeout',
            shortMessage: 'timeout', rawMessage: 'timeout', tokenAddress: '0x00000000000000000000000000000000000000aa',
          }],
        }),
      } as never,
      marketClient: { getTokenProfile: async () => null } as never,
      sendTelegram: vi.fn(async () => {}),
    });

    const summary = JSON.parse(await readFile(path.join(outDir, 'monitor-summary.json'), 'utf8'));
    expect(summary.walletScanFailureDetailsCount).toBe(2);
    expect(summary.failureKinds.rpc_timeout).toBe(2);
    expect(summary.outputFiles).toContain('wallet-scan-failures.json');
  });

  it('blockscout adapter parses v2 token transfer rows', async () => {
    const result = await fetchWalletTransfersWithExplorer(
      {
        provider: 'blockscout',
        blockscoutUrls: { base: 'https://base.blockscout.com/api' },
      },
      {
        chain: 'base',
        walletAddress: '0x0000000000000000000000000000000000000001',
        maxPages: 1,
        pageSize: 50,
        maxTransfersPerWallet: 20,
      },
      async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          items: [{
            token: { address: '0x00000000000000000000000000000000000000aa' },
            from: { hash: '0x00000000000000000000000000000000000000bb' },
            to: { hash: '0x0000000000000000000000000000000000000001' },
            transaction_hash: `0x${'11'.repeat(32)}`,
            block_number: 123,
            log_index: 2,
            total: { value: '777' },
          }],
        }),
        text: async () => '',
      }),
    );

    expect(result.providerUsed).toBe('blockscout');
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.source).toBe('explorer');
    expect(result.events[0]?.tokenAddress).toBe('0x00000000000000000000000000000000000000aa');
  });

  it('explorer provider handles empty result as success', async () => {
    const provider = new ExplorerTokenTransferProvider();
    const result = await provider.getRecentIncomingTokenEvents({
      wallets: [{
        chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', score: 50, category: 'candidate',
        tokenAppearances: 2, tokensAppearedIn: [], narratives: [], averageFirstBuyRank: 1, bestFirstBuyRank: 1,
        monitorRecommendation: '', reasons: [], riskFlags: [], source: 'candidate_shortlist', importedAt: '', enabled: true, tags: [],
      }],
      chains: ['base'],
      explorerProvider: 'blockscout',
      fetcher: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ items: [] }),
        text: async () => '',
      }),
    });

    expect(result.events).toHaveLength(0);
    expect(result.stats.walletScanFailures).toBe(0);
    expect(result.stats.walletsWithNoActivity).toBe(1);
  });

  it('explorer provider handles rate limit without crashing', async () => {
    const provider = new ExplorerTokenTransferProvider();
    const result = await provider.getRecentIncomingTokenEvents({
      wallets: [{
        chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', score: 50, category: 'candidate',
        tokenAppearances: 2, tokensAppearedIn: [], narratives: [], averageFirstBuyRank: 1, bestFirstBuyRank: 1,
        monitorRecommendation: '', reasons: [], riskFlags: [], source: 'candidate_shortlist', importedAt: '', enabled: true, tags: [],
      }],
      chains: ['base'],
      explorerProvider: 'blockscout',
      fetcher: async () => ({
        ok: false,
        status: 429,
        json: async () => ({}),
        text: async () => 'rate limited',
      }),
    });

    expect(result.stats.walletScanFailures).toBe(1);
    expect(result.errors[0]?.code).toBe('explorer_rate_limited');
    expect(result.failureDetails[0]?.providerMode).toBe('explorer');
  });

  it('auto-indexer falls back to known-token mode when explorer unavailable', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'monitor-poll-auto-indexer-fallback-'));
    const watchlist = path.join(tmp, 'monitor-wallets.json');
    const knownTokensFile = path.join(tmp, 'known-tokens.json');
    const outDir = path.join(tmp, 'out');
    await writeFile(watchlist, JSON.stringify([{
      chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', score: 80, category: 'candidate',
      tokenAppearances: 3, tokensAppearedIn: [], narratives: [], averageFirstBuyRank: 1, bestFirstBuyRank: 1,
      monitorRecommendation: '', reasons: [], riskFlags: [], source: 'candidate_shortlist', importedAt: '', enabled: true, tags: [],
    }]), 'utf8');
    await writeFile(knownTokensFile, JSON.stringify([{ chain: 'base', tokenAddress: '0x00000000000000000000000000000000000000aa', symbol: 'NEW' }]), 'utf8');

    await runMonitorPoll({
      watchlist,
      chains: ['base'],
      maxWallets: 20,
      ethereumBlocks: 100,
      baseBlocks: 300,
      bscBlocks: 300,
      out: outDir,
      activityProvider: 'auto-indexer',
      explorerProvider: 'blockscout',
      knownTokens: knownTokensFile,
      telegramDryRun: true,
      sendTelegram: false,
      telegramChatId: '',
    }, {
      walletActivityProvider: {
        getRecentIncomingTokenEvents: async () => ({
          events: [],
          stats: makeStats({
            addresslessLogsSupported: 'false',
            walletScanFailures: 1,
            walletScanFailureDetailsCount: 1,
            failureKinds: { addressless_logs_not_supported: 1 },
            failuresByProviderMode: { 'rpc-wallet-activity': 1 },
          }),
          errors: [{ code: 'addressless_logs_not_supported', chain: 'base', walletAddress: '0x1', message: 'rpc rejects addressless getLogs' }],
          failureDetails: [{
            chain: 'base', walletAddress: '0x1', providerMode: 'rpc-wallet-activity', errorKind: 'addressless_logs_not_supported', shortMessage: 'rpc rejects addressless getLogs', rawMessage: 'rpc rejects addressless getLogs',
          }],
        }),
      } as never,
      explorerProvider: {
        getRecentIncomingTokenEvents: async () => ({
          events: [],
          stats: makeStats({
            explorerRequests: 1,
            explorerTransfersFetched: 0,
            explorerFailures: 1,
            explorerFailuresByChain: { base: 1 },
            explorerWarnings: ['explorer_unavailable'],
          }),
          errors: [{ code: 'explorer_unavailable', chain: 'base', walletAddress: '0x1', message: 'down' }],
          failureDetails: [{
            chain: 'base', walletAddress: '0x1', providerMode: 'explorer', errorKind: 'explorer_unavailable', shortMessage: 'down', rawMessage: 'down',
          }],
        }),
      } as never,
      knownTokensProvider: {
        getRecentIncomingTokenEvents: async () => ({
          events: [{
            chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', tokenAddress: '0x00000000000000000000000000000000000000aa',
            from: '0x2', to: '0x1', rawAmount: '0x1', txHash: `0x${'11'.repeat(32)}`, blockNumber: 1, logIndex: 0,
            observedAt: '2026-01-01T00:00:00.000Z', warnings: [], source: 'rpc-known-tokens', walletScore: 80,
          }],
          stats: makeStats({ walletsWithActivity: 1, walletsWithNoActivity: 0 }),
          errors: [],
          failureDetails: [],
        }),
      } as never,
      marketClient: { getTokenProfile: async () => null } as never,
      sendTelegram: vi.fn(async () => {}),
    });

    const summary = JSON.parse(await readFile(path.join(outDir, 'monitor-summary.json'), 'utf8'));
    expect(summary.providerModeUsed).toBe('rpc-known-tokens');
    expect(summary.providerFallbackUsed).toBe(true);
    expect(summary.fallbackUsed).toBe(true);
    expect(summary.providerAttemptOrder).toEqual(['rpc-wallet-activity', 'explorer', 'rpc-known-tokens']);
    expect(summary.rpcWalletActivityAttempted).toBe(true);
    expect(summary.rpcWalletActivitySupported).toBe(false);
    expect(summary.rpcWalletActivityFallbackReason).toContain('rpc rejects addressless getLogs');
    expect(summary.addresslessProbeAttempted).toBe(true);
    expect(summary.addresslessProbeResult).toBe('unsupported');
    expect(summary.addresslessProbeErrorKind).toBe('addressless_logs_not_supported');
    expect(summary.sourceBreakdown['rpc-known-tokens']).toBe(1);
  });

  it('rpc-wallet-activity mode uses wallet activity provider and reports source breakdown', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'monitor-poll-rpc-wallet-activity-'));
    const watchlist = path.join(tmp, 'monitor-wallets.json');
    const outDir = path.join(tmp, 'out');
    await writeFile(watchlist, JSON.stringify([{
      chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', score: 80, category: 'candidate',
      tokenAppearances: 3, tokensAppearedIn: [], narratives: [], averageFirstBuyRank: 1, bestFirstBuyRank: 1,
      monitorRecommendation: '', reasons: [], riskFlags: [], source: 'candidate_shortlist', importedAt: '', enabled: true, tags: [],
    }]), 'utf8');

    await runMonitorPoll({
      watchlist,
      chains: ['base'],
      maxWallets: 20,
      ethereumBlocks: 100,
      baseBlocks: 300,
      bscBlocks: 300,
      out: outDir,
      activityProvider: 'rpc-wallet-activity',
      knownTokens: '',
      telegramDryRun: true,
      sendTelegram: false,
      telegramChatId: '',
    }, {
      walletActivityProvider: {
        getRecentIncomingTokenEvents: async () => ({
          events: [{
            chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', tokenAddress: '0x00000000000000000000000000000000000000aa',
            from: '0x2', to: '0x1', rawAmount: '0x1', txHash: `0x${'11'.repeat(32)}`, blockNumber: 1, logIndex: 0,
            observedAt: '2026-01-01T00:00:00.000Z', warnings: [], source: 'rpc-wallet-activity', walletScore: 80,
          }],
          stats: makeStats({
            walletsWithActivity: 1,
            walletsWithNoActivity: 0,
            walletActivityEventsFound: 1,
            walletActivityUniqueTokens: 1,
          }),
          errors: [],
          failureDetails: [],
        }),
      } as never,
      marketClient: { getTokenProfile: async () => null } as never,
      sendTelegram: vi.fn(async () => {}),
    });

    const summary = JSON.parse(await readFile(path.join(outDir, 'monitor-summary.json'), 'utf8'));
    expect(summary.providerModeUsed).toBe('rpc-wallet-activity');
    expect(summary.providerFallbackUsed).toBe(false);
    expect(summary.providerAttemptOrder).toEqual(['rpc-wallet-activity']);
    expect(summary.providerAttempts['rpc-wallet-activity']).toBe('used');
    expect(summary.rpcWalletActivityAttempted).toBe(true);
    expect(summary.rpcWalletActivityFallbackReason).toBe('none');
    expect(summary.rawEventsFound).toBe(1);
    expect(summary.sourceBreakdown['rpc-wallet-activity']).toBe(1);
  });

  it('rpc-wallet-activity mode with no events marks fallback reason as no_events_found', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'monitor-poll-rpc-wallet-activity-empty-'));
    const watchlist = path.join(tmp, 'monitor-wallets.json');
    const outDir = path.join(tmp, 'out');
    await writeFile(watchlist, JSON.stringify([{
      chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', score: 80, category: 'candidate',
      tokenAppearances: 3, tokensAppearedIn: [], narratives: [], averageFirstBuyRank: 1, bestFirstBuyRank: 1,
      monitorRecommendation: '', reasons: [], riskFlags: [], source: 'candidate_shortlist', importedAt: '', enabled: true, tags: [],
    }]), 'utf8');

    await runMonitorPoll({
      watchlist,
      chains: ['base'],
      maxWallets: 20,
      ethereumBlocks: 100,
      baseBlocks: 300,
      bscBlocks: 300,
      out: outDir,
      activityProvider: 'rpc-wallet-activity',
      knownTokens: '',
      telegramDryRun: true,
      sendTelegram: false,
      telegramChatId: '',
    }, {
      walletActivityProvider: {
        getRecentIncomingTokenEvents: async () => ({
          events: [],
          stats: makeStats({
            walletsWithActivity: 0,
            walletsWithNoActivity: 1,
            walletActivityEventsFound: 0,
          }),
          errors: [],
          failureDetails: [],
        }),
      } as never,
      marketClient: { getTokenProfile: async () => null } as never,
      sendTelegram: vi.fn(async () => {}),
    });

    const summary = JSON.parse(await readFile(path.join(outDir, 'monitor-summary.json'), 'utf8'));
    expect(summary.providerModeUsed).toBe('rpc-wallet-activity');
    expect(summary.providerAttemptOrder).toEqual(['rpc-wallet-activity']);
    expect(summary.providerAttempts['rpc-wallet-activity']).toBe('attempted');
    expect(summary.rpcWalletActivityAttempted).toBe(true);
    expect(summary.rpcWalletActivityFallbackReason).toBe('no_events_found');
    expect(summary.addresslessProbeAttempted).toBe(true);
  });

  it('wallet activity profile tiny is reflected in monitor summary requested and applied fields', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'monitor-poll-wallet-profile-tiny-'));
    const watchlist = path.join(tmp, 'monitor-wallets.json');
    const outDir = path.join(tmp, 'out');
    await writeFile(watchlist, JSON.stringify([{
      chain: 'base', walletAddress: '0x0000000000000000000000000000000000000001', score: 80, category: 'candidate',
      tokenAppearances: 3, tokensAppearedIn: [], narratives: [], averageFirstBuyRank: 1, bestFirstBuyRank: 1,
      monitorRecommendation: '', reasons: [], riskFlags: [], source: 'candidate_shortlist', importedAt: '', enabled: true, tags: [],
    }]), 'utf8');

    await runMonitorPoll({
      watchlist,
      chains: ['base'],
      maxWallets: 20,
      ethereumBlocks: 100,
      baseBlocks: 300,
      bscBlocks: 300,
      out: outDir,
      activityProvider: 'rpc-wallet-activity',
      walletActivityProfile: 'tiny',
      knownTokens: '',
      telegramDryRun: true,
      sendTelegram: false,
      telegramChatId: '',
    }, {
      walletActivityProvider: {
        getRecentIncomingTokenEvents: async () => ({
          events: [],
          stats: makeStats({ walletsWithNoActivity: 1 }),
          errors: [],
          failureDetails: [],
        }),
      } as never,
      marketClient: { getTokenProfile: async () => null } as never,
      sendTelegram: vi.fn(async () => {}),
    });

    const summary = JSON.parse(await readFile(path.join(outDir, 'monitor-summary.json'), 'utf8'));
    expect(summary.walletActivityProfileRequested).toBe('tiny');
    expect(summary.walletActivityProfileApplied).toBe('tiny');
  });

  it('etherscan mode without api key warns and does not crash', async () => {
    const result = await fetchWalletTransfersWithExplorer(
      {
        provider: 'etherscan',
        blockscoutUrls: {},
        etherscanApiKey: '',
      },
      {
        chain: 'ethereum',
        walletAddress: '0x0000000000000000000000000000000000000001',
        maxPages: 1,
        pageSize: 10,
        maxTransfersPerWallet: 5,
      },
      async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
    );
    expect(result.events).toHaveLength(0);
    expect(result.errors[0]?.code).toBe('etherscan_api_key_missing');
  });

  it('known token builder extracts success+keep tokens', () => {
    const tokens = buildKnownTokens([
      { chain: 'base', tokenAddress: '0xaaa', symbol: 'A', status: 'success', seedTriageStatus: 'keep' },
      { chain: 'base', tokenAddress: '0xbbb', symbol: 'B', status: 'success', seedTriageStatus: 'drop' },
      { chain: 'ethereum', tokenAddress: '0xccc', symbol: 'C', status: 'success', seedTriageStatus: 'keep' },
      { chain: 'base', tokenAddress: '0xddd', symbol: 'D', status: 'failed', seedTriageStatus: 'keep' },
    ], { seedSummary: 'x', out: 'y', onlyKeep: true });
    expect(tokens.map((t) => `${t.chain}:${t.tokenAddress}`)).toEqual(['ethereum:0xccc', 'base:0xaaa']);
  });

  it('known token builder caps token list to fit chunk budget and includes budget meta', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      chain: i % 2 === 0 ? 'base' : 'ethereum',
      tokenAddress: `0x${String(i + 1).padStart(40, '0')}`,
      symbol: `T${i + 1}`,
      status: 'success',
      seedTriageStatus: 'keep',
      source: 'seed',
    }));

    const result = buildKnownTokensWithinBudget(rows, {
      maxTokens: 12,
      chains: ['ethereum', 'base'],
      walletCount: 20,
      ethereumBlocks: 100,
      baseBlocks: 300,
      getLogsMaxBlockRange: 10,
      chunkBudget: 1000,
    });

    expect(result.finalTokenCount).toBeLessThan(12);
    expect(result.estimatedChunks).toBeLessThanOrEqual(1000);
    expect(result.chunkBudget).toBe(1000);
    expect(result.reducedToFitBudget).toBe(true);
    expect(result.droppedDueToBudget).toBeGreaterThan(0);
  });

  it('known token builder prioritizes stronger evidence tokens over weaker evidence', () => {
    const rows = [
      {
        chain: 'base',
        tokenAddress: `0x${'11'.repeat(20)}`,
        symbol: 'STRONG',
        status: 'success',
        seedTriageStatus: 'keep',
        source: 'seed_keep',
      },
      {
        chain: 'base',
        tokenAddress: `0x${'22'.repeat(20)}`,
        symbol: 'CANDIDATE',
        status: 'success',
        source: 'candidate_evidence',
      },
      {
        chain: 'bsc',
        tokenAddress: `0x${'33'.repeat(20)}`,
        symbol: 'WEAK',
        status: 'success',
      },
    ];

    const tokens = buildKnownTokens(rows, 2);
    expect(tokens.map((t) => t.symbol)).toEqual(['STRONG', 'CANDIDATE']);
  });

  it('default monitoring budget profile yields non-skip chunk estimate', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      chain: i % 2 === 0 ? 'base' : 'ethereum',
      tokenAddress: `0x${String(i + 101).padStart(40, '0')}`,
      symbol: `M${i + 1}`,
      status: 'success',
      seedTriageStatus: 'keep',
      source: 'seed_keep',
    }));

    const result = buildKnownTokensWithinBudget(rows, {
      maxTokens: 20,
      chains: ['ethereum', 'base'],
      walletCount: 20,
      ethereumBlocks: 100,
      baseBlocks: 300,
      getLogsMaxBlockRange: 10,
      chunkBudget: 1000,
    });

    expect(result.estimatedChunks).toBeLessThanOrEqual(1000);
    expect(result.finalTokenCount).toBeLessThanOrEqual(20);
  });
});
