import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { toCsv } from '../utils/csv.js';
import { safeJsonStringify } from '../utils/json.js';
import type {
  EnrichedTokenEvent,
  EvmSupportedChain,
  ExplorerProviderMode,
  MonitorActivityProviderMode,
  MonitorKnownToken,
  MonitorSignal,
  MonitorWalletRecord,
  WalletScanFailureDetail,
  WalletActivityScanStats,
} from '../monitoring/monitoring.types.js';
import { DexScreenerClient } from '../providers/market/dexscreener.client.js';
import { buildSignalsWithStats } from '../monitoring/signal-builder.js';
import { buildSignalDedupeKey, loadDedupeState, saveDedupeState } from '../monitoring/dedupe.js';
import { sendSignalsToChats } from '../bot/telegram-alerts.js';
import { pathToFileURL } from 'node:url';
import {
  ExplorerTokenTransferProvider,
  RpcAddresslessActivityProvider,
  RpcKnownTokensActivityProvider,
} from '../monitoring/wallet-activity-providers.js';
import { TransactionContextAnalyzer } from '../monitoring/transaction-context.js';

export interface Args {
  watchlist: string;
  chains: EvmSupportedChain[];
  maxWallets: number;
  ethereumBlocks: number;
  baseBlocks: number;
  bscBlocks: number;
  out: string;
  activityProvider: MonitorActivityProviderMode;
  explorerProvider?: ExplorerProviderMode;
  explorerMaxPages?: number;
  explorerPageSize?: number;
  maxTransfersPerWallet?: number;
  knownTokens?: string;
  getLogsMaxBlockRange?: number;
  maxGetLogsChunksPerRun?: number;
  telegramDryRun: boolean;
  sendTelegram: boolean;
  telegramChatId?: string;
  txContext?: boolean;
  maxTxContextLookups?: number;
}

type DeliveryCategory = MonitorSignal['category'];

function estimateGetLogsChunks(args: Args, wallets: MonitorWalletRecord[], knownTokens: MonitorKnownToken[]): number {
  const maxWallets = Math.max(0, Math.min(args.maxWallets, wallets.length));
  const range = Math.max(1, args.getLogsMaxBlockRange ?? 10);
  const windowsByChain: Record<EvmSupportedChain, number> = {
    ethereum: args.ethereumBlocks,
    base: args.baseBlocks,
    bsc: args.bscBlocks,
  };
  let total = 0;
  for (const chain of args.chains) {
    const chainWalletCount = wallets.slice(0, maxWallets).filter((w) => w.enabled !== false && w.chain === chain).length;
    const chainTokenCount = knownTokens.filter((t) => t.chain === chain).length;
    if (!chainWalletCount || !chainTokenCount) continue;
    const chunksPerPair = Math.ceil(Math.max(1, windowsByChain[chain] ?? 1) / range);
    total += chainWalletCount * chainTokenCount * chunksPerPair;
  }
  return total;
}

function getEligibleSignalsForDelivery(signals: MonitorSignal[], sendWeak: boolean, sendIgnored: boolean): {
  eligibleSignals: MonitorSignal[];
  skippedSignalsByPolicy: Record<DeliveryCategory, number>;
} {
  const skippedSignalsByPolicy: Record<DeliveryCategory, number> = {
    strong_signal: 0,
    watch_signal: 0,
    weak_signal: 0,
    ignored: 0,
  };
  const eligibleSignals = signals.filter((s) => {
    if (s.category === 'strong_signal' || s.category === 'watch_signal') return true;
    if (s.category === 'weak_signal') {
      if (sendWeak) return true;
      skippedSignalsByPolicy.weak_signal += 1;
      return false;
    }
    if (s.category === 'ignored') {
      if (sendIgnored) return true;
      skippedSignalsByPolicy.ignored += 1;
      return false;
    }
    return false;
  });
  return { eligibleSignals, skippedSignalsByPolicy };
}

interface MonitorPollDeps {
  addresslessProvider: RpcAddresslessActivityProvider;
  knownTokensProvider: RpcKnownTokensActivityProvider;
  explorerProvider: ExplorerTokenTransferProvider;
  marketClient: DexScreenerClient;
  nowMs: () => number;
  sendTelegram: (signals: MonitorSignal[], args: Args) => Promise<void>;
  txContextAnalyzerFactory: (maxLookups: number) => TransactionContextAnalyzer;
}

function emptyScanStats(chains: EvmSupportedChain[]): WalletActivityScanStats {
  return {
    chainsScanned: [...new Set(chains)],
    walletsScanned: 0,
    walletScanFailures: 0,
    addresslessLogsSupported: 'unknown',
    warnings: [],
    walletScanFailureDetailsCount: 0,
    failureKinds: {},
    failuresByChain: {},
    failuresByProviderMode: {},
    knownTokensByChain: {},
    scannedWalletsByChain: {},
    scannedTokenWalletPairs: 0,
    successfulTokenWalletPairs: 0,
    failedTokenWalletPairs: 0,
    tokenWalletPairsPartiallyFailed: 0,
    getLogsMaxBlockRange: undefined,
    getLogsChunksRequested: 0,
    getLogsChunksSucceeded: 0,
    getLogsChunksFailed: 0,
    walletsWithNoActivity: 0,
    walletsWithActivity: 0,
    walletsWithFailures: 0,
  };
}

function parseArgs(argv: string[]): Args {
  const read = (key: string, fallback: string) => {
    const i = argv.indexOf(`--${key}`);
    return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
  };
  return {
    watchlist: read('watchlist', 'data/monitor-wallets.json'),
    chains: read('chains', 'ethereum,base,bsc').split(',').map((x) => x.trim()) as EvmSupportedChain[],
    maxWallets: Number(read('max-wallets', '50')),
    ethereumBlocks: Number(read('ethereum-blocks', '300')),
    baseBlocks: Number(read('base-blocks', '1000')),
    bscBlocks: Number(read('bsc-blocks', '1000')),
    out: read('out', 'output/monitor-poll-v1'),
    activityProvider: read('activity-provider', 'auto') as MonitorActivityProviderMode,
    explorerProvider: read('explorer-provider', 'auto') as ExplorerProviderMode,
    explorerMaxPages: Number(read('explorer-max-pages', '2')),
    explorerPageSize: Number(read('explorer-page-size', '50')),
    maxTransfersPerWallet: Number(read('max-transfers-per-wallet', '100')),
    knownTokens: read('known-tokens', ''),
    getLogsMaxBlockRange: Number(read('getlogs-max-block-range', '10')),
    maxGetLogsChunksPerRun: Number(read('max-getlogs-chunks-per-run', '1000')),
    telegramDryRun: read('telegram-dry-run', 'false') === 'true',
    sendTelegram: read('send-telegram', 'false') === 'true',
    telegramChatId: read('telegram-chat-id', ''),
    txContext: read('tx-context', 'true') === 'true',
    maxTxContextLookups: Number(read('max-tx-context-lookups', '100')),
  };
}

async function loadKnownTokens(file: string | undefined): Promise<MonitorKnownToken[]> {
  if (!file) return [];
  const raw = JSON.parse(await readFile(file, 'utf8')) as Array<MonitorKnownToken>;
  return raw
    .filter((x) => x && typeof x.tokenAddress === 'string' && typeof x.chain === 'string')
    .map((x) => ({ ...x, tokenAddress: x.tokenAddress.toLowerCase() }));
}

async function enrichEvents(events: EnrichedTokenEvent[], market: DexScreenerClient): Promise<EnrichedTokenEvent[]> {
  const cache = new Map<string, Awaited<ReturnType<DexScreenerClient['getTokenProfile']>> | null>();
  const out: EnrichedTokenEvent[] = [];
  for (const ev of events) {
    const key = `${ev.chain}:${ev.tokenAddress}`;
    if (!cache.has(key)) {
      try {
        cache.set(key, await market.getTokenProfile(ev.chain, ev.tokenAddress));
      } catch {
        cache.set(key, null);
      }
    }
    const p = cache.get(key);
    if (!p) {
      out.push({ ...ev, warnings: [...ev.warnings, 'token_enrichment_failed'] });
      continue;
    }
    const raw = (p.raw ?? {}) as {
      volume?: { h24?: number };
      priceChange?: { h24?: number };
    };

    out.push({
      ...ev,
      symbol: p.symbol,
      name: p.name,
      priceUsd: p.priceUsd,
      marketCap: p.marketCap,
      fdv: p.fdv,
      liquidityUsd: p.liquidityUsd,
      volumeH24: raw.volume?.h24,
      priceChangeH24: raw.priceChange?.h24,
      pairCreatedAt: p.pairCreatedAt?.toISOString(),
      tokenAgeSeconds: p.tokenAgeSeconds,
      dexUrl: p.dexUrl,
    });
  }
  return out;
}

async function sendTelegramIfEnabled(signals: MonitorSignal[], args: Args): Promise<void> {
  if (!args.sendTelegram && !args.telegramDryRun) return;
  await sendSignalsToChats({
    signals,
    dryRun: args.telegramDryRun,
  });
}

export async function runMonitorPoll(args: Args, deps?: Partial<MonitorPollDeps>) {
  const txContextEnabled = args.txContext ?? true;
  const txContextMaxLookups = args.maxTxContextLookups ?? 100;
  const merged: MonitorPollDeps = {
    addresslessProvider: deps?.addresslessProvider ?? new RpcAddresslessActivityProvider(),
    knownTokensProvider: deps?.knownTokensProvider ?? new RpcKnownTokensActivityProvider(),
    explorerProvider: deps?.explorerProvider ?? new ExplorerTokenTransferProvider(),
    marketClient: deps?.marketClient ?? new DexScreenerClient(),
    nowMs: deps?.nowMs ?? (() => Date.now()),
    sendTelegram: deps?.sendTelegram ?? sendTelegramIfEnabled,
    txContextAnalyzerFactory: deps?.txContextAnalyzerFactory ?? ((maxLookups) => new TransactionContextAnalyzer({ maxLookups })),
  };

  const wallets = JSON.parse(await readFile(args.watchlist, 'utf8')) as MonitorWalletRecord[];
  const knownTokens = await loadKnownTokens(args.knownTokens);
  const maxGetLogsChunksPerRun = Math.max(1, args.maxGetLogsChunksPerRun ?? 1000);
  const estimatedChunks = estimateGetLogsChunks(args, wallets, knownTokens);
  const scanSkippedDueToChunkLimit =
    args.activityProvider === 'rpc-known-tokens' &&
    estimatedChunks > maxGetLogsChunksPerRun;
  const blockWindows = { ethereum: args.ethereumBlocks, base: args.baseBlocks, bsc: args.bscBlocks };
  const warnings = new Set<string>();
  const explorerProviderMode = args.explorerProvider ?? 'auto';
  const explorerMaxPages = args.explorerMaxPages ?? 2;
  const explorerPageSize = args.explorerPageSize ?? 50;
  const maxTransfersPerWallet = args.maxTransfersPerWallet ?? 100;
  let providerModeUsed: MonitorActivityProviderMode | 'none' = args.activityProvider;
  let providerFallbackUsed = false;
  let combinedStats: WalletActivityScanStats = emptyScanStats(args.chains);
  let walletScanFailures: WalletScanFailureDetail[] = [];

  let eventsRaw: EnrichedTokenEvent[] = [];

  if (scanSkippedDueToChunkLimit) {
    warnings.add('scan_skipped_due_to_chunk_limit');
    providerModeUsed = 'rpc-known-tokens';
    combinedStats = emptyScanStats(args.chains);
  } else if (args.activityProvider === 'rpc-known-tokens') {
    providerModeUsed = 'rpc-known-tokens';
    if (!knownTokens.length) {
      warnings.add('known_tokens_required_for_rpc_known_tokens_mode');
    } else {
      const result = await merged.knownTokensProvider.getRecentIncomingTokenEvents({
        wallets,
        chains: args.chains,
        maxWallets: args.maxWallets,
        blockWindows,
        knownTokens,
        getLogsMaxBlockRange: args.getLogsMaxBlockRange ?? 10,
      });
      eventsRaw = result.events as EnrichedTokenEvent[];
      combinedStats = result.stats;
      walletScanFailures = result.failureDetails;
      for (const err of result.errors) warnings.add(err.code);
    }
  } else if (args.activityProvider === 'explorer') {
    providerModeUsed = 'explorer';
    const result = await merged.explorerProvider.getRecentIncomingTokenEvents({
      wallets,
      chains: args.chains,
      maxWallets: args.maxWallets,
      explorerProvider: args.explorerProvider,
      explorerMaxPages,
      explorerPageSize,
      maxTransfersPerWallet,
    });
    eventsRaw = result.events as EnrichedTokenEvent[];
    combinedStats = result.stats;
    walletScanFailures = result.failureDetails;
    for (const err of result.errors) warnings.add(err.code);
  } else if (args.activityProvider === 'auto-indexer') {
    const explorerResult = await merged.explorerProvider.getRecentIncomingTokenEvents({
      wallets,
      chains: args.chains,
      maxWallets: args.maxWallets,
      explorerProvider: explorerProviderMode,
      explorerMaxPages,
      explorerPageSize,
      maxTransfersPerWallet,
    });
    const explorerUnavailable = explorerResult.errors.some((e) => e.code === 'explorer_unavailable' || e.code === 'explorer_unsupported_chain' || e.code === 'explorer_rate_limited');
    if (explorerResult.events.length > 0 || !explorerUnavailable) {
      providerModeUsed = 'explorer';
      eventsRaw = explorerResult.events as EnrichedTokenEvent[];
      combinedStats = explorerResult.stats;
      walletScanFailures = explorerResult.failureDetails;
      for (const err of explorerResult.errors) warnings.add(err.code);
    } else if (knownTokens.length) {
      const fallbackResult = await merged.knownTokensProvider.getRecentIncomingTokenEvents({
        wallets,
        chains: args.chains,
        maxWallets: args.maxWallets,
        blockWindows,
        knownTokens,
        getLogsMaxBlockRange: args.getLogsMaxBlockRange ?? 10,
      });
      providerModeUsed = 'rpc-known-tokens';
      providerFallbackUsed = true;
      eventsRaw = fallbackResult.events as EnrichedTokenEvent[];
      combinedStats = fallbackResult.stats;
      walletScanFailures = fallbackResult.failureDetails;
      warnings.add('explorer_unavailable');
    } else {
      providerModeUsed = 'none';
      combinedStats = explorerResult.stats;
      walletScanFailures = explorerResult.failureDetails;
      warnings.add('explorer_unavailable');
      warnings.add('known_tokens_required_for_auto_indexer_fallback');
    }
  } else {
    const result = await merged.addresslessProvider.getRecentIncomingTokenEvents({
      wallets,
      chains: args.chains,
      maxWallets: args.maxWallets,
      blockWindows,
    });
    eventsRaw = result.events as EnrichedTokenEvent[];
    combinedStats = result.stats;
    walletScanFailures = result.failureDetails;
    const hasAddresslessRestriction = result.errors.some((e) => e.code === 'addressless_logs_not_supported');
    if (hasAddresslessRestriction) {
      warnings.add('addressless_logs_not_supported');
      warnings.add('rpc_provider_requires_address_filter');
      warnings.add('use_indexer_or_known_token_mode');
      if (args.activityProvider === 'auto' && knownTokens.length) {
        const fallbackResult = await merged.knownTokensProvider.getRecentIncomingTokenEvents({
          wallets,
          chains: args.chains,
          maxWallets: args.maxWallets,
          blockWindows,
          knownTokens,
          getLogsMaxBlockRange: args.getLogsMaxBlockRange ?? 10,
        });
        providerModeUsed = 'rpc-known-tokens';
        providerFallbackUsed = true;
        eventsRaw = fallbackResult.events as EnrichedTokenEvent[];
        combinedStats = {
          ...fallbackResult.stats,
          addresslessLogsSupported: 'false',
        };
        walletScanFailures = fallbackResult.failureDetails;
      }
    }
  }

  const marketEnrichedEvents = await enrichEvents(eventsRaw as EnrichedTokenEvent[], merged.marketClient);
  let events = marketEnrichedEvents;
  let txContextLookups = 0;
  let txContextFailures = 0;
  if (txContextEnabled) {
    const analyzer = merged.txContextAnalyzerFactory(txContextMaxLookups);
    const txResult = await analyzer.enrichEvents(marketEnrichedEvents);
    events = txResult.events;
    txContextLookups = txResult.lookups;
    txContextFailures = txResult.failures;
  }
  const {
    signals,
    groupsBuilt,
    groupsDropped,
    dropReasons,
  } = buildSignalsWithStats(events);

  const { eligibleSignals, skippedSignalsByPolicy } = getEligibleSignalsForDelivery(
    signals,
    process.env.MONITOR_SEND_WEAK === 'true',
    process.env.MONITOR_SEND_IGNORED === 'true',
  );

  const dedupeFile = 'data/monitor-sent-signals.local.json';
  const dedupeSet = await loadDedupeState(dedupeFile);
  const now = merged.nowMs();
  const dedupedForDelivery = eligibleSignals.filter((s) => {
    const key = buildSignalDedupeKey({ chain: s.chain, tokenAddress: s.tokenAddress, watchedWallets: s.watchedWallets, observedAtMs: now });
    if (dedupeSet.has(key)) return false;
    dedupeSet.add(key);
    return true;
  });
  await saveDedupeState(dedupeFile, dedupeSet);

  await mkdir(args.out, { recursive: true });
  await writeFile(path.join(args.out, 'events.json'), safeJsonStringify(events, 2), 'utf8');
  await writeFile(path.join(args.out, 'signals.json'), safeJsonStringify(signals, 2), 'utf8');
  await writeFile(path.join(args.out, 'wallet-scan-failures.json'), safeJsonStringify(walletScanFailures, 2), 'utf8');
  const csvRows = signals.map((s) => ({
    chain: s.chain,
    tokenAddress: s.tokenAddress,
    symbol: s.symbol,
    name: s.name,
    watchedWalletCount: s.watchedWalletCount,
    txCount: s.txCount,
    uniqueTxCount: s.uniqueTxCount,
    marketCap: s.marketCap,
    liquidityUsd: s.liquidityUsd,
    tokenAgeSeconds: s.tokenAgeSeconds,
    score: s.score,
    category: s.category,
    likelyActivityType: s.likelyActivityType,
    likelyBuyEventCount: s.likelyBuyEventCount,
    airdropOrClaimEventCount: s.airdropOrClaimEventCount,
    knownRouterEventCount: s.knownRouterEventCount,
    contextComposition: safeJsonStringify(s.contextComposition),
    confidence: s.confidence,
    reasons: s.reasons.join('|'),
  }));
  await writeFile(path.join(args.out, 'signals.csv'), toCsv(csvRows, [
    'chain', 'tokenAddress', 'symbol', 'name', 'watchedWalletCount', 'txCount', 'uniqueTxCount', 'marketCap', 'liquidityUsd', 'tokenAgeSeconds', 'score', 'category', 'likelyActivityType', 'likelyBuyEventCount', 'airdropOrClaimEventCount', 'knownRouterEventCount', 'contextComposition', 'confidence', 'reasons',
  ]), 'utf8');

  const outputFiles = ['events.json', 'signals.json', 'signals.csv', 'wallet-scan-failures.json', 'monitor-summary.json'];
  const signalsByCategory = {
    strong_signal: signals.filter((s) => s.category === 'strong_signal').length,
    watch_signal: signals.filter((s) => s.category === 'watch_signal').length,
    weak_signal: signals.filter((s) => s.category === 'weak_signal').length,
    ignored: signals.filter((s) => s.category === 'ignored').length,
  };
  const sourceBreakdown = {
    'rpc-known-tokens': events.filter((e) => e.source === 'rpc-known-tokens').length,
    'rpc-addressless': events.filter((e) => e.source === 'rpc-addressless').length,
    explorer: events.filter((e) => e.source === 'explorer').length,
  };
  const summary = {
    activityProvider: providerModeUsed,
    explorerProvider: explorerProviderMode,
    fallbackUsed: providerFallbackUsed,
    providerModeRequested: args.activityProvider,
    providerModeUsed,
    providerFallbackUsed,
    chainsScanned: combinedStats.chainsScanned,
    watchedWalletsScanned: combinedStats.walletsScanned,
    txContextEnabled,
    txContextLookups,
    txContextFailures,
    walletScanFailures: combinedStats.walletScanFailures,
    walletScanFailureDetailsCount: combinedStats.walletScanFailureDetailsCount,
    failureKinds: combinedStats.failureKinds,
    failuresByChain: combinedStats.failuresByChain,
    failuresByProviderMode: combinedStats.failuresByProviderMode,
    addresslessLogsSupported: combinedStats.addresslessLogsSupported,
    knownTokensCount: knownTokens.length,
    knownTokensByChain: combinedStats.knownTokensByChain,
    scannedWalletsByChain: combinedStats.scannedWalletsByChain,
    scannedTokenWalletPairs: combinedStats.scannedTokenWalletPairs,
    successfulTokenWalletPairs: combinedStats.successfulTokenWalletPairs,
    failedTokenWalletPairs: combinedStats.failedTokenWalletPairs,
    tokenWalletPairsPartiallyFailed: combinedStats.tokenWalletPairsPartiallyFailed,
    getLogsMaxBlockRange: combinedStats.getLogsMaxBlockRange,
    getLogsChunksRequested: combinedStats.getLogsChunksRequested,
    getLogsChunksSucceeded: combinedStats.getLogsChunksSucceeded,
    getLogsChunksFailed: combinedStats.getLogsChunksFailed,
    estimatedChunks,
    maxChunksPerRun: maxGetLogsChunksPerRun,
    scanSkippedDueToChunkLimit,
    walletsWithNoActivity: combinedStats.walletsWithNoActivity,
    walletsWithActivity: combinedStats.walletsWithActivity,
    walletsWithFailures: combinedStats.walletsWithFailures,
    explorerRequests: combinedStats.explorerRequests ?? 0,
    explorerTransfersFetched: combinedStats.explorerTransfersFetched ?? 0,
    explorerFailures: combinedStats.explorerFailures ?? 0,
    explorerFailuresByChain: combinedStats.explorerFailuresByChain ?? {},
    explorerWarnings: combinedStats.explorerWarnings ?? [],
    sourceBreakdown,
    rawEventsFound: eventsRaw.length,
    eventsAfterStablecoinFilter: events.filter((e) => !e.symbol || !['usdc', 'usdt', 'dai', 'weth', 'wbtc', 'wbnb'].includes(e.symbol.toLowerCase())).length,
    eventsAfterSpamFilter: events.length,
    eventsFound: events.length,
    groupsBuilt,
    groupsDropped,
    dropReasons,
    signalsBuilt: signals.length,
    tokenGroupsFound: groupsBuilt,
    signalsByCategory,
    strongSignals: signalsByCategory.strong_signal,
    watchSignals: signalsByCategory.watch_signal,
    weakSignals: signalsByCategory.weak_signal,
    ignoredSignals: signalsByCategory.ignored,
    eligibleSignalsForDelivery: eligibleSignals.length,
    dedupedSignalsForDelivery: dedupedForDelivery.length,
    alertsSent: dedupedForDelivery.length,
    skippedSignalsByPolicy,
    likelyBuyEvents: events.filter((e) => e.transactionContext?.likelyActivityType === 'likely_buy').length,
    transferEvents: events.filter((e) => e.transactionContext?.likelyActivityType === 'transfer').length,
    unknownContextEvents: events.filter((e) => !e.transactionContext || e.transactionContext.likelyActivityType === 'unknown').length,
    warnings: [...warnings],
    outputFiles,
  };
  await writeFile(path.join(args.out, 'monitor-summary.json'), safeJsonStringify(summary, 2), 'utf8');

  console.log('Monitor poll report:');
  console.log(`- provider mode: ${providerModeUsed}`);
  console.log(`- explorer provider: ${explorerProviderMode}`);
  console.log(`- wallets scanned: ${combinedStats.walletsScanned}`);
  console.log(`- known tokens scanned: ${knownTokens.length}`);
  console.log(`- token-wallet pairs scanned: ${combinedStats.scannedTokenWalletPairs}`);
  console.log(`- events found: ${events.length}`);
  console.log(`- signals found: ${signals.length}`);
  console.log(`- eligible signals for delivery: ${eligibleSignals.length}`);
  console.log(`- alerts sent: ${dedupedForDelivery.length}`);
  console.log(`- estimated chunks / cap: ${estimatedChunks}/${maxGetLogsChunksPerRun}`);
  console.log(`- scan skipped due to chunk cap: ${scanSkippedDueToChunkLimit}`);
  console.log(`- tx context enabled: ${txContextEnabled}`);
  console.log(`- tx context lookups/failures: ${txContextLookups}/${txContextFailures}`);
  console.log(`- wallet failures: ${combinedStats.walletScanFailures}`);
  console.log(`- explorer requests/transfers: ${(combinedStats.explorerRequests ?? 0)}/${(combinedStats.explorerTransfersFetched ?? 0)}`);
  console.log(`- events by source: ${safeJsonStringify(sourceBreakdown)}`);
  console.log(`- failure kinds: ${safeJsonStringify(combinedStats.failureKinds)}`);
  console.log(`- output files: ${outputFiles.join(', ')}`);
  if (combinedStats.walletScanFailures > 0) {
    console.log(`Inspect: ${path.join(args.out, 'wallet-scan-failures.json')}`);
  }
  console.log('Monitor summary:', summary);
  if (warnings.has('addressless_logs_not_supported')) {
    console.warn('Addressless eth_getLogs was rejected by your RPC provider. Generic wallet-wide token activity could not be fully scanned.');
    if (!knownTokens.length) {
      console.warn('Known-token fallback unavailable: no --known-tokens file provided.');
    }
    console.warn('Next command: npm run monitor:build-known-tokens -- --seed-summary output/seed-batch-auto-keep-wide-v1/token-buyer-summary.csv --out data/monitor-known-tokens.json --only-keep true');
    console.warn('Then run: npm run monitor:poll -- --watchlist data/monitor-wallets.json --chains ethereum,base --activity-provider rpc-known-tokens --known-tokens data/monitor-known-tokens.json --max-wallets 20 --ethereum-blocks 100 --base-blocks 300 --out output/monitor-poll-known-tokens-v1 --telegram-dry-run true');
  }
  for (const s of signals.slice(0, 10)) {
    console.log(`- [${s.category}] ${s.chain} ${s.symbol ?? 'unknown'} ${s.tokenAddress} wallets=${s.watchedWalletCount} score=${s.score} activity=${s.likelyActivityType} conf=${s.confidence}`);
  }

  await merged.sendTelegram(dedupedForDelivery, args);
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  await runMonitorPoll(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
