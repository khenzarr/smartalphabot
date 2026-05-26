import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { toCsv } from '../utils/csv.js';
import { safeJsonStringify } from '../utils/json.js';
import type {
  DiscoveredTokenCandidate,
  EnrichedTokenEvent,
  EvmSupportedChain,
  ExplorerProviderMode,
  MonitorActivityProviderMode,
  MonitorKnownToken,
  MonitorSignal,
  MonitorWalletRecord,
  WalletActivityProfile,
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
  RpcWalletActivityProvider,
  RpcKnownTokensActivityProvider,
} from '../monitoring/wallet-activity-providers.js';
import { TransactionContextAnalyzer } from '../monitoring/transaction-context.js';
import { env } from '../config/env.js';
import { parseExplorerProvider, parseMonitorActivityProvider } from '../monitoring/monitor-runtime.js';

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
  walletActivityProfile?: WalletActivityProfile;
  walletActivityMaxEventsPerWallet?: number;
  walletActivityMaxUniqueTokens?: number;
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

function estimateWalletActivityChunks(args: Args, wallets: MonitorWalletRecord[]): number {
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
    if (!chainWalletCount) continue;
    const chunksPerWallet = Math.ceil(Math.max(1, windowsByChain[chain] ?? 1) / range);
    total += chainWalletCount * chunksPerWallet;
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
  walletActivityProvider: RpcWalletActivityProvider;
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
    activityProvider: parseMonitorActivityProvider(read('activity-provider', 'auto')) ?? 'auto',
    explorerProvider: parseExplorerProvider(read('explorer-provider', 'auto')) ?? 'auto',
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
    walletActivityProfile: read('wallet-activity-profile', env.MONITOR_WALLET_ACTIVITY_PROFILE) as WalletActivityProfile,
    walletActivityMaxEventsPerWallet: Number(read('wallet-activity-max-events-per-wallet', String(env.MONITOR_WALLET_ACTIVITY_MAX_EVENTS_PER_WALLET))),
    walletActivityMaxUniqueTokens: Number(read('wallet-activity-max-unique-tokens', String(env.MONITOR_WALLET_ACTIVITY_MAX_UNIQUE_TOKENS))),
  };
}

function clampPositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function applyWalletActivityProfile(args: Args): Args {
  const profile = args.walletActivityProfile ?? 'safe';
  const profileScale = profile === 'tiny' ? 0.25 : profile === 'wide' ? 2 : 1;
  return {
    ...args,
    ethereumBlocks: clampPositiveInt(args.ethereumBlocks * profileScale, args.ethereumBlocks),
    baseBlocks: clampPositiveInt(args.baseBlocks * profileScale, args.baseBlocks),
    bscBlocks: clampPositiveInt(args.bscBlocks * profileScale, args.bscBlocks),
  };
}

function buildDiscoveredTokenCandidates(events: EnrichedTokenEvent[], createdAt: string): DiscoveredTokenCandidate[] {
  const map = new Map<string, DiscoveredTokenCandidate>();
  for (const ev of events) {
    const key = `${ev.chain}:${ev.tokenAddress.toLowerCase()}`;
    const current = map.get(key);
    if (!current) {
      map.set(key, {
        chain: ev.chain,
        tokenAddress: ev.tokenAddress.toLowerCase(),
        firstSeenAt: ev.observedAt,
        walletsSeen: [ev.walletAddress.toLowerCase()],
        txCount: 1,
        source: ev.source ?? 'rpc-wallet-activity',
        likelyActivityTypes: ev.transactionContext?.likelyActivityType ? [ev.transactionContext.likelyActivityType] : ['unknown'],
        riskFlags: [],
        suggestedAction: 'review',
        sampleTxHashes: [ev.txHash],
        createdAt,
      });
      continue;
    }
    current.txCount += 1;
    if (!current.walletsSeen.includes(ev.walletAddress.toLowerCase())) current.walletsSeen.push(ev.walletAddress.toLowerCase());
    const lat = ev.transactionContext?.likelyActivityType ?? 'unknown';
    if (!current.likelyActivityTypes.includes(lat)) current.likelyActivityTypes.push(lat);
    if (current.sampleTxHashes.length < 5 && !current.sampleTxHashes.includes(ev.txHash)) current.sampleTxHashes.push(ev.txHash);
    if (new Date(ev.observedAt).getTime() < new Date(current.firstSeenAt).getTime()) current.firstSeenAt = ev.observedAt;
    if (current.walletsSeen.length >= 2 && current.txCount >= 2) current.suggestedAction = 'merge_known_tokens';
  }
  return [...map.values()];
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
  const profiledArgs = applyWalletActivityProfile(args);
  const txContextEnabled = args.txContext ?? true;
  const txContextMaxLookups = args.maxTxContextLookups ?? 100;
  const merged: MonitorPollDeps = {
    addresslessProvider: deps?.addresslessProvider ?? new RpcAddresslessActivityProvider(),
    walletActivityProvider: deps?.walletActivityProvider ?? new RpcWalletActivityProvider(),
    knownTokensProvider: deps?.knownTokensProvider ?? new RpcKnownTokensActivityProvider(),
    explorerProvider: deps?.explorerProvider ?? new ExplorerTokenTransferProvider(),
    marketClient: deps?.marketClient ?? new DexScreenerClient(),
    nowMs: deps?.nowMs ?? (() => Date.now()),
    sendTelegram: deps?.sendTelegram ?? sendTelegramIfEnabled,
    txContextAnalyzerFactory: deps?.txContextAnalyzerFactory ?? ((maxLookups) => new TransactionContextAnalyzer({ maxLookups })),
  };

  const wallets = JSON.parse(await readFile(profiledArgs.watchlist, 'utf8')) as MonitorWalletRecord[];
  const knownTokens = await loadKnownTokens(profiledArgs.knownTokens);
  const maxGetLogsChunksPerRun = Math.max(1, args.maxGetLogsChunksPerRun ?? 1000);
  const estimatedChunks = estimateGetLogsChunks(profiledArgs, wallets, knownTokens);
  const walletActivityChunkBudget = maxGetLogsChunksPerRun;
  const walletActivityEstimatedChunksInitial = estimateWalletActivityChunks(profiledArgs, wallets);
  let effectiveMaxWallets = profiledArgs.maxWallets;
  const effectiveBlockWindows = { ethereum: profiledArgs.ethereumBlocks, base: profiledArgs.baseBlocks, bsc: profiledArgs.bscBlocks };
  let walletActivityWindowReduced = false;
  if ((profiledArgs.activityProvider === 'rpc-wallet-activity' || profiledArgs.activityProvider === 'auto-indexer') && walletActivityEstimatedChunksInitial > walletActivityChunkBudget) {
    const ratio = walletActivityChunkBudget / walletActivityEstimatedChunksInitial;
    effectiveBlockWindows.ethereum = Math.max(1, Math.floor(effectiveBlockWindows.ethereum * ratio));
    effectiveBlockWindows.base = Math.max(1, Math.floor(effectiveBlockWindows.base * ratio));
    effectiveBlockWindows.bsc = Math.max(1, Math.floor(effectiveBlockWindows.bsc * ratio));
    walletActivityWindowReduced = true;
    const afterWindowReduction = estimateWalletActivityChunks({ ...args, ...effectiveBlockWindows }, wallets);
    if (afterWindowReduction > walletActivityChunkBudget) {
      const walletRatio = walletActivityChunkBudget / afterWindowReduction;
      effectiveMaxWallets = Math.max(1, Math.floor(profiledArgs.maxWallets * walletRatio));
    }
  }
  const walletActivityEstimatedChunks = estimateWalletActivityChunks({ ...profiledArgs, maxWallets: effectiveMaxWallets, ...effectiveBlockWindows }, wallets);
  const scanSkippedDueToChunkLimit = false;
  const blockWindows = effectiveBlockWindows;
  const warnings = new Set<string>();
  if (walletActivityWindowReduced || effectiveMaxWallets < profiledArgs.maxWallets) {
    warnings.add('wallet_activity_profile_reduced_to_fit_chunk_budget');
  }
  const explorerProviderMode = profiledArgs.explorerProvider ?? 'auto';
  const explorerMaxPages = profiledArgs.explorerMaxPages ?? 2;
  const explorerPageSize = profiledArgs.explorerPageSize ?? 50;
  const maxTransfersPerWallet = profiledArgs.maxTransfersPerWallet ?? 100;
  let providerModeUsed: MonitorActivityProviderMode | 'none' = profiledArgs.activityProvider;
  let providerFallbackUsed = false;
  const providerAttemptOrder: Array<'rpc-wallet-activity' | 'explorer' | 'rpc-known-tokens'> = [];
  const providerAttempts: Partial<Record<'rpc-wallet-activity' | 'explorer' | 'rpc-known-tokens', 'attempted' | 'used' | 'fallback' | 'skipped'>> = {};
  let rpcWalletActivityAttempted = false;
  let rpcWalletActivitySupported: boolean | undefined;
  let rpcWalletActivityFallbackReason = 'not_attempted';
  let addresslessProbeAttempted = false;
  let addresslessProbeResult: 'supported' | 'unsupported' | 'unknown' = 'unknown';
  let addresslessProbeErrorKind: string = 'none';
  let combinedStats: WalletActivityScanStats = emptyScanStats(args.chains);
  let walletScanFailures: WalletScanFailureDetail[] = [];

  let eventsRaw: EnrichedTokenEvent[] = [];

  if (scanSkippedDueToChunkLimit) {
    warnings.add('scan_skipped_due_to_chunk_limit');
    providerModeUsed = 'rpc-known-tokens';
    combinedStats = emptyScanStats(args.chains);
  } else if (profiledArgs.activityProvider === 'rpc-known-tokens') {
    providerModeUsed = 'rpc-known-tokens';
    if (!knownTokens.length) {
      warnings.add('known_tokens_required_for_rpc_known_tokens_mode');
    } else {
      const result = await merged.knownTokensProvider.getRecentIncomingTokenEvents({
        wallets,
        chains: args.chains,
        maxWallets: effectiveMaxWallets,
        blockWindows,
        knownTokens,
        getLogsMaxBlockRange: profiledArgs.getLogsMaxBlockRange ?? 10,
      });
      eventsRaw = result.events as EnrichedTokenEvent[];
      combinedStats = result.stats;
      walletScanFailures = result.failureDetails;
      for (const err of result.errors) warnings.add(err.code);
    }
  } else if (profiledArgs.activityProvider === 'explorer') {
    providerModeUsed = 'explorer';
    const result = await merged.explorerProvider.getRecentIncomingTokenEvents({
      wallets,
      chains: args.chains,
      maxWallets: effectiveMaxWallets,
      explorerProvider: profiledArgs.explorerProvider,
      explorerMaxPages,
      explorerPageSize,
      maxTransfersPerWallet,
    });
    eventsRaw = result.events as EnrichedTokenEvent[];
    combinedStats = result.stats;
    walletScanFailures = result.failureDetails;
    for (const err of result.errors) warnings.add(err.code);
  } else if (profiledArgs.activityProvider === 'auto-indexer') {
    console.log('[monitor][provider] attempting rpc-wallet-activity');
    providerAttemptOrder.push('rpc-wallet-activity');
    providerAttempts['rpc-wallet-activity'] = 'attempted';
    rpcWalletActivityAttempted = true;
    addresslessProbeAttempted = true;
    const walletActivityResult = await merged.walletActivityProvider.getRecentIncomingTokenEvents({
      wallets,
      chains: args.chains,
      maxWallets: effectiveMaxWallets,
      maxLogsPerWallet: profiledArgs.walletActivityMaxEventsPerWallet,
      blockWindows,
    });
    const walletActivityUnsupportedError = walletActivityResult.errors.find((e) => e.code === 'addressless_logs_not_supported');
    const walletActivityUnsupportedDetail = walletActivityResult.failureDetails.find((d) => d.errorKind === 'addressless_logs_not_supported');
    const walletActivityUnsupported = Boolean(walletActivityUnsupportedError || walletActivityUnsupportedDetail);
    if (walletActivityUnsupported) {
      rpcWalletActivitySupported = false;
      addresslessProbeResult = 'unsupported';
      addresslessProbeErrorKind = walletActivityUnsupportedDetail?.errorKind ?? 'addressless_logs_not_supported';
      rpcWalletActivityFallbackReason = walletActivityUnsupportedError?.message
        ?? walletActivityUnsupportedDetail?.shortMessage
        ?? 'addressless_logs_not_supported';
      console.log(`[monitor][provider] rpc-wallet-activity unsupported: ${rpcWalletActivityFallbackReason}`);
      console.log('[monitor][provider] falling back to explorer');
    } else if (walletActivityResult.events.length > 0) {
      rpcWalletActivitySupported = true;
      addresslessProbeResult = 'supported';
      addresslessProbeErrorKind = 'none';
      rpcWalletActivityFallbackReason = 'none';
      providerModeUsed = 'rpc-wallet-activity';
      providerAttempts['rpc-wallet-activity'] = 'used';
      eventsRaw = walletActivityResult.events as EnrichedTokenEvent[];
      combinedStats = walletActivityResult.stats;
      walletScanFailures = walletActivityResult.failureDetails;
      for (const err of walletActivityResult.errors) warnings.add(err.code);
    } else {
      rpcWalletActivitySupported = true;
      addresslessProbeResult = 'supported';
      addresslessProbeErrorKind = 'none';
      rpcWalletActivityFallbackReason = 'no_events_found';
      console.log('[monitor][provider] falling back to explorer');
    }

    if (providerModeUsed === 'rpc-wallet-activity') {
      // no-op; already selected above
    } else {
      providerAttemptOrder.push('explorer');
      providerAttempts.explorer = 'attempted';
    const explorerResult = await merged.explorerProvider.getRecentIncomingTokenEvents({
      wallets,
      chains: args.chains,
      maxWallets: effectiveMaxWallets,
      explorerProvider: explorerProviderMode,
      explorerMaxPages,
      explorerPageSize,
      maxTransfersPerWallet,
    });
    const explorerUnavailable = explorerResult.errors.some((e) => e.code === 'explorer_unavailable' || e.code === 'explorer_unsupported_chain' || e.code === 'explorer_rate_limited');
    if (explorerResult.events.length > 0 || !explorerUnavailable) {
      providerModeUsed = 'explorer';
      providerAttempts.explorer = 'used';
      eventsRaw = explorerResult.events as EnrichedTokenEvent[];
      combinedStats = explorerResult.stats;
      walletScanFailures = explorerResult.failureDetails;
      for (const err of explorerResult.errors) warnings.add(err.code);
    } else if (knownTokens.length) {
      console.log('[monitor][provider] falling back to rpc-known-tokens');
      providerAttemptOrder.push('rpc-known-tokens');
      providerAttempts['rpc-known-tokens'] = 'fallback';
      const fallbackResult = await merged.knownTokensProvider.getRecentIncomingTokenEvents({
        wallets,
        chains: args.chains,
        maxWallets: effectiveMaxWallets,
        blockWindows,
        knownTokens,
        getLogsMaxBlockRange: profiledArgs.getLogsMaxBlockRange ?? 10,
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
    }
  } else if (profiledArgs.activityProvider === 'rpc-wallet-activity') {
    providerModeUsed = 'rpc-wallet-activity';
    const result = await merged.walletActivityProvider.getRecentIncomingTokenEvents({
      wallets,
      chains: args.chains,
      maxWallets: effectiveMaxWallets,
      maxLogsPerWallet: profiledArgs.walletActivityMaxEventsPerWallet,
      blockWindows,
    });
    eventsRaw = result.events as EnrichedTokenEvent[];
    combinedStats = result.stats;
    walletScanFailures = result.failureDetails;
    for (const err of result.errors) warnings.add(err.code);
  } else {
    const result = await merged.addresslessProvider.getRecentIncomingTokenEvents({
      wallets,
      chains: args.chains,
      maxWallets: effectiveMaxWallets,
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
      if (profiledArgs.activityProvider === 'auto' && knownTokens.length) {
        const fallbackResult = await merged.knownTokensProvider.getRecentIncomingTokenEvents({
          wallets,
          chains: args.chains,
          maxWallets: effectiveMaxWallets,
          blockWindows,
          knownTokens,
          getLogsMaxBlockRange: profiledArgs.getLogsMaxBlockRange ?? 10,
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
    env.MONITOR_SEND_WEAK,
    env.MONITOR_SEND_IGNORED,
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
  const discoveredTokens = buildDiscoveredTokenCandidates(events, new Date().toISOString());
  await writeFile(path.join(args.out, 'discovered-tokens.json'), safeJsonStringify(discoveredTokens, 2), 'utf8');
  await mkdir(env.MONITOR_OUTPUT_DIR, { recursive: true });
  await writeFile(path.join(env.MONITOR_OUTPUT_DIR, 'latest-discovered-tokens.json'), safeJsonStringify(discoveredTokens, 2), 'utf8');
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

  const outputFiles = ['events.json', 'signals.json', 'signals.csv', 'wallet-scan-failures.json', 'discovered-tokens.json', 'monitor-summary.json'];
  const signalsByCategory = {
    strong_signal: signals.filter((s) => s.category === 'strong_signal').length,
    watch_signal: signals.filter((s) => s.category === 'watch_signal').length,
    weak_signal: signals.filter((s) => s.category === 'weak_signal').length,
    ignored: signals.filter((s) => s.category === 'ignored').length,
  };
  const sourceBreakdown = {
    'rpc-wallet-activity': events.filter((e) => e.source === 'rpc-wallet-activity').length,
    'rpc-known-tokens': events.filter((e) => e.source === 'rpc-known-tokens').length,
    'rpc-addressless': events.filter((e) => e.source === 'rpc-addressless').length,
    explorer: events.filter((e) => e.source === 'explorer').length,
  };
  const summary = {
    activityProvider: providerModeUsed,
    explorerProvider: explorerProviderMode,
    fallbackUsed: providerFallbackUsed,
    providerModeRequested: profiledArgs.activityProvider,
    walletActivityProfileRequested: args.walletActivityProfile ?? 'safe',
    walletActivityProfileApplied: profiledArgs.walletActivityProfile ?? 'safe',
    providerModeUsed,
    providerFallbackUsed,
    providerAttemptOrder,
    providerAttempts,
    rpcWalletActivityAttempted,
    rpcWalletActivitySupported,
    rpcWalletActivityFallbackReason,
    addresslessProbeAttempted,
    addresslessProbeResult,
    addresslessProbeErrorKind,
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
    walletActivityEstimatedChunks,
    walletActivityChunkBudget,
    walletActivityWindowReduced,
    walletActivityEffectiveBlockWindows: effectiveBlockWindows,
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
    discoveredTokensCount: discoveredTokens.length,
    discoveredTokensByChain: discoveredTokens.reduce((acc, x) => ({ ...acc, [x.chain]: ((acc as Record<string, number>)[x.chain] ?? 0) + 1 }), {} as Partial<Record<EvmSupportedChain, number>>),
    discoveredTokensOutputFile: path.join(args.out, 'discovered-tokens.json'),
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
