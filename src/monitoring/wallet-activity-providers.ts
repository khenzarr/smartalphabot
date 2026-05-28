import type { PublicClient } from 'viem';
import { getEvmPublicClient } from '../providers/evm/evm-rpc.client.js';
import { ERC20_TRANSFER_TOPIC } from './constants.js';
import {
  addressToTopic,
  isValidRpcQuantityHex,
  isValidTopic,
  normalizeHex,
  numberToRpcQuantityHex,
} from '../utils/hex.js';
import type {
  EvmSupportedChain,
  ExplorerProviderMode,
  MonitorKnownToken,
  MonitorWalletRecord,
  RecentWalletTokenEvent,
  WalletActivityErrorInfo,
  WalletScanFailureDetail,
  WalletScanFailureErrorKind,
  WalletActivityScanStats,
  WalletActivityCursorState,
} from './monitoring.types.js';
import { env } from '../config/env.js';
import {
  fetchWalletTransfersWithExplorer,
  type ExplorerFetchLike,
} from './explorer-token-transfer-provider.js';

export interface WalletActivityProviderInput {
  wallets: MonitorWalletRecord[];
  chains: EvmSupportedChain[];
  maxWallets?: number;
  maxLogsPerWallet?: number;
  blockWindows?: Partial<Record<EvmSupportedChain, number>>;
  knownTokens?: MonitorKnownToken[];
  clientFactory?: (chain: EvmSupportedChain) => PublicClient;
  explorerProvider?: ExplorerProviderMode;
  explorerMaxPages?: number;
  explorerPageSize?: number;
  maxTransfersPerWallet?: number;
  fetcher?: ExplorerFetchLike;
  getLogsMaxBlockRange?: number;
  cursorEnabled?: boolean;
  cursorState?: WalletActivityCursorState;
  lookbackByChain?: Partial<Record<EvmSupportedChain, number>>;
}

export interface WalletActivityProviderResult {
  events: RecentWalletTokenEvent[];
  stats: WalletActivityScanStats;
  errors: WalletActivityErrorInfo[];
  failureDetails: WalletScanFailureDetail[];
  cursorState?: WalletActivityCursorState;
}

export interface IWalletActivityProvider {
  getRecentIncomingTokenEvents(input: WalletActivityProviderInput): Promise<WalletActivityProviderResult>;
}

const ADDRESSLESS_RESTRICTION_PATTERNS = [
  /please specify an address/i,
  /address required/i,
  /eth_getlogs requires address/i,
  /restricted/i,
  /dedicated full node/i,
];

export function isAddresslessLogsRestrictionError(error: unknown): boolean {
  const msg = String((error as { shortMessage?: string; message?: string })?.shortMessage
    ?? (error as { message?: string })?.message
    ?? error
    ?? '');
  return ADDRESSLESS_RESTRICTION_PATTERNS.some((p) => p.test(msg));
}

function baseStats(chains: EvmSupportedChain[]): WalletActivityScanStats {
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

function extractErrorMessages(error: unknown): { shortMessage: string; rawMessage: string } {
  const shortMessage = String(
    (error as { shortMessage?: string; message?: string })?.shortMessage
      ?? (error as { message?: string })?.message
      ?? error
      ?? 'unknown_error',
  );
  const rawMessage = String((error as { message?: string })?.message ?? shortMessage);
  return { shortMessage, rawMessage };
}

function classifyErrorKind(error: unknown): WalletScanFailureErrorKind {
  if (isAddresslessLogsRestrictionError(error)) return 'addressless_logs_not_supported';
  const msg = String((error as { shortMessage?: string; message?: string })?.shortMessage
    ?? (error as { message?: string })?.message
    ?? error
    ?? '').toLowerCase();
  if (msg.includes('addressless_getlogs_payload_invalid')) return 'invalid_getlogs_payload';
  if (msg.includes('json is not a valid request object')) return 'invalid_getlogs_payload';
  if (msg.includes('hex string of odd length')) return 'invalid_hex_payload';
  if (msg.includes('hex number with leading zero digits')) return 'invalid_rpc_quantity_hex';
  if (msg.includes('up to a 10 block range') || msg.includes('block range should work')) return 'getlogs_range_too_wide';
  if (msg.includes('timeout') || msg.includes('timed out')) return 'rpc_timeout';
  if (msg.includes('invalid') || msg.includes('bad request') || msg.includes('revert') || msg.includes('forbidden')) return 'provider_rejection';
  return 'wallet_scan_failed';
}

function shouldTreatJsonInvalidAsAddresslessUnsupported(error: unknown): boolean {
  const shortMsg = String((error as { shortMessage?: string })?.shortMessage ?? '').toLowerCase();
  const rawMsg = String((error as { message?: string })?.message ?? error ?? '').toLowerCase();
  const combined = `${shortMsg}\n${rawMsg}`;
  if (!combined.includes('json is not a valid request object')) return false;
  return combined.includes('under the free tier plan')
    || combined.includes('block range should work')
    || combined.includes('upgrade to payg')
    || combined.includes('please specify an address')
    || combined.includes('address required')
    || combined.includes('eth_getlogs requires address');
}

function incrementMap<K extends string>(obj: Partial<Record<K, number>>, key: K): void {
  obj[key] = (obj[key] ?? 0) + 1;
}

function buildKnownTokenGetLogsPayload(args: {
  tokenAddress: string;
  walletAddress: string;
  fromBlockHex: `0x${string}`;
  toBlockHex: `0x${string}`;
}): {
  address: string;
  topics: [string, null, string];
  fromBlock: `0x${string}`;
  toBlock: `0x${string}`;
} {
  return {
    address: normalizeHex(args.tokenAddress).toLowerCase(),
    topics: [ERC20_TRANSFER_TOPIC, null, addressToTopic(args.walletAddress)],
    fromBlock: numberToRpcQuantityHex(BigInt(args.fromBlockHex)),
    toBlock: numberToRpcQuantityHex(BigInt(args.toBlockHex)),
  };
}

function buildAddresslessGetLogsPayload(args: {
  walletAddress: string;
  fromBlock: bigint;
  toBlock: bigint;
}): {
  topics: [string, null, string];
  fromBlock: `0x${string}`;
  toBlock: `0x${string}`;
} {
  return {
    topics: [ERC20_TRANSFER_TOPIC, null, addressToTopic(args.walletAddress)],
    fromBlock: numberToRpcQuantityHex(args.fromBlock),
    toBlock: numberToRpcQuantityHex(args.toBlock),
  };
}

function validateAddresslessGetLogsPayload(payload: {
  address?: unknown;
  topics?: unknown;
  fromBlock?: unknown;
  toBlock?: unknown;
}, walletAddress: string): string | null {
  if (payload.address !== undefined) return 'address_must_be_omitted_for_addressless';
  if (!Array.isArray(payload.topics) || payload.topics.length < 3) return 'topics_invalid';
  if (payload.topics[0] !== ERC20_TRANSFER_TOPIC) return 'transfer_topic_invalid';
  if (payload.topics[1] !== null) return 'from_topic_must_be_null';
  const expectedTo = addressToTopic(walletAddress).toLowerCase();
  if (String(payload.topics[2] ?? '').toLowerCase() !== expectedTo) return 'to_topic_invalid';
  if (!isValidTopic(String(payload.topics[0] ?? ''))) return 'transfer_topic_shape_invalid';
  if (!isValidTopic(String(payload.topics[2] ?? ''))) return 'to_topic_shape_invalid';
  if (!isValidRpcQuantityHex(String(payload.fromBlock ?? ''))) return 'from_block_invalid_rpc_quantity_hex';
  if (!isValidRpcQuantityHex(String(payload.toBlock ?? ''))) return 'to_block_invalid_rpc_quantity_hex';
  const disallowedUndefined = Object.entries(payload)
    .some(([key, value]) => key !== 'address' && value === undefined);
  if (disallowedUndefined) return 'undefined_field_present';
  try {
    if (BigInt(String(payload.fromBlock)) > BigInt(String(payload.toBlock))) return 'block_range_invalid';
  } catch {
    return 'block_range_parse_failed';
  }
  return null;
}

function sanitizePayloadForDiagnostics(payload: {
  topics: [string, null, string];
  fromBlock: `0x${string}`;
  toBlock: `0x${string}`;
}): Record<string, unknown> {
  return {
    fromBlock: payload.fromBlock,
    toBlock: payload.toBlock,
    topics: [payload.topics[0], payload.topics[1], payload.topics[2]],
  };
}

function validateKnownTokenGetLogsPayload(payload: {
  address?: string;
  topics?: unknown[];
  fromBlock?: string;
  toBlock?: string;
}, tokenAddress: string, walletAddress: string): string | null {
  const normalizedTokenAddress = normalizeHex(tokenAddress).toLowerCase();
  const normalizedWalletAddress = normalizeHex(walletAddress).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/i.test(normalizedTokenAddress)) return 'token_address_invalid';
  if (!/^0x[0-9a-f]{40}$/i.test(normalizedWalletAddress)) return 'wallet_address_invalid';
  const expectedTo = addressToTopic(normalizedWalletAddress);

  if (!payload.address || normalizeHex(payload.address).toLowerCase() !== normalizedTokenAddress) return 'address_mismatch';
  if (!/^0x[0-9a-f]{40}$/i.test(payload.address)) return 'payload_address_invalid';
  if (!Array.isArray(payload.topics) || payload.topics.length < 3) return 'topics_invalid';
  if (!isValidTopic(String(payload.topics[0] ?? ''))) return 'transfer_topic_shape_invalid';
  if (String(payload.topics[0]).toLowerCase() !== ERC20_TRANSFER_TOPIC.toLowerCase()) return 'transfer_topic_invalid';
  if (payload.topics[1] !== null) return 'from_topic_must_be_null';
  if (!isValidTopic(String(payload.topics[2] ?? ''))) return 'to_topic_shape_invalid';
  if (String(payload.topics[2]).toLowerCase() !== expectedTo.toLowerCase()) return 'to_topic_invalid';
  if (!payload.fromBlock || !isValidRpcQuantityHex(payload.fromBlock)) return 'from_block_invalid_rpc_quantity_hex';
  if (!payload.toBlock || !isValidRpcQuantityHex(payload.toBlock)) return 'to_block_invalid_rpc_quantity_hex';
  try {
    if (BigInt(payload.fromBlock) > BigInt(payload.toBlock)) return 'block_range_invalid';
  } catch {
    return 'block_range_parse_failed';
  }
  return null;
}

function decodeLog(log: {
  address?: `0x${string}`;
  topics: `0x${string}`[];
  data: `0x${string}`;
  transactionHash?: `0x${string}`;
  blockNumber?: `0x${string}`;
  logIndex?: `0x${string}`;
}, wallet: MonitorWalletRecord & { chain: EvmSupportedChain }): RecentWalletTokenEvent {
  const fromTopic = log.topics[1] ?? '0x';
  const toTopic = log.topics[2] ?? '0x';
  const from = `0x${fromTopic.slice(-40)}`.toLowerCase();
  const to = `0x${toTopic.slice(-40)}`.toLowerCase();
  return {
    chain: wallet.chain,
    walletAddress: wallet.walletAddress,
    tokenAddress: (log.address ?? '0x').toLowerCase(),
    from,
    to,
    rawAmount: log.data,
    txHash: (log.transactionHash ?? '0x').toLowerCase(),
    blockNumber: Number(log.blockNumber ? BigInt(log.blockNumber) : 0n),
    logIndex: Number(log.logIndex ? BigInt(log.logIndex) : 0n),
    observedAt: new Date().toISOString(),
    warnings: ['incoming_transfer_not_confirmed_buy', 'requires_dex_context'],
    walletScore: wallet.score,
    source: 'rpc-addressless',
  };
}

function selectCandidateWallets(input: WalletActivityProviderInput): Array<MonitorWalletRecord & { chain: EvmSupportedChain }> {
  const maxWallets = input.maxWallets ?? 50;
  return input.wallets
    .filter((w) => w.enabled && input.chains.includes(w.chain as EvmSupportedChain))
    .slice(0, maxWallets) as Array<MonitorWalletRecord & { chain: EvmSupportedChain }>;
}

export class RpcAddresslessActivityProvider implements IWalletActivityProvider {
  async getRecentIncomingTokenEvents(input: WalletActivityProviderInput): Promise<WalletActivityProviderResult> {
    const blockWindows: Record<EvmSupportedChain, number> = {
      ethereum: input.blockWindows?.ethereum ?? 300,
      base: input.blockWindows?.base ?? 1000,
      bsc: input.blockWindows?.bsc ?? 1000,
    };
    const maxLogsPerWallet = input.maxLogsPerWallet ?? 200;
    const candidates = selectCandidateWallets(input);
    const events: RecentWalletTokenEvent[] = [];
    const errors: WalletActivityErrorInfo[] = [];
    const failureDetails: WalletScanFailureDetail[] = [];
    const stats = baseStats(input.chains);
    const nextCursorState: WalletActivityCursorState = { ...(input.cursorState ?? {}) };

    for (const wallet of candidates) {
      console.log(`[monitor][progress] wallet ${stats.walletsScanned + 1}/${candidates.length} chain=${wallet.chain} provider=rpc-addressless events=${events.length}`);
      stats.walletsScanned += 1;
      incrementMap(stats.scannedWalletsByChain, wallet.chain);
      const client = input.clientFactory?.(wallet.chain) ?? getEvmPublicClient(wallet.chain);
      let requestPayload: {
        topics: [string, null, string];
        fromBlock: `0x${string}`;
        toBlock: `0x${string}`;
      } | null = null;
      try {
        const latest = await client.getBlockNumber();
        const cursorKey = `${wallet.chain}:${wallet.walletAddress.toLowerCase()}`;
        const lookback = BigInt(input.lookbackByChain?.[wallet.chain] ?? blockWindows[wallet.chain]);
        const fromBlockFromLookback = latest > lookback ? latest - lookback : 0n;
        const cursorLast = input.cursorEnabled ? BigInt(input.cursorState?.[cursorKey]?.lastScannedBlock ?? -1) : -1n;
        const fromBlock = cursorLast >= 0n ? (cursorLast + 1n) : fromBlockFromLookback;
        if (fromBlock > latest) {
          stats.walletsWithNoActivity += 1;
          continue;
        }
        requestPayload = buildAddresslessGetLogsPayload({
          walletAddress: wallet.walletAddress,
          fromBlock,
          toBlock: latest,
        });
        const invalidPayloadReason = validateAddresslessGetLogsPayload(requestPayload, wallet.walletAddress);
        if (invalidPayloadReason) throw new Error(`addressless_getlogs_payload_invalid:${invalidPayloadReason}`);
        const logs = (await client.request({
          method: 'eth_getLogs',
          params: [requestPayload],
        })) as Array<{
          address?: `0x${string}`;
          topics: `0x${string}`[];
          data: `0x${string}`;
          transactionHash?: `0x${string}`;
          blockNumber?: `0x${string}`;
          logIndex?: `0x${string}`;
        }>;
        stats.addresslessLogsSupported = 'true';
        for (const log of logs.slice(0, maxLogsPerWallet)) events.push(decodeLog(log, wallet));
        if (input.cursorEnabled) {
          nextCursorState[cursorKey] = {
            lastScannedBlock: Number(latest),
            updatedAt: new Date().toISOString(),
          };
        }
      } catch (error) {
        stats.walletScanFailures += 1;
        stats.walletsWithFailures += 1;
        let kind = classifyErrorKind(error);
        if (kind === 'invalid_getlogs_payload' && requestPayload && shouldTreatJsonInvalidAsAddresslessUnsupported(error)) {
          kind = 'addressless_logs_not_supported';
        }
        incrementMap(stats.failureKinds, kind);
        incrementMap(stats.failuresByChain, wallet.chain);
        incrementMap(stats.failuresByProviderMode, 'rpc-addressless');
        const { shortMessage, rawMessage } = extractErrorMessages(error);
        failureDetails.push({
          chain: wallet.chain,
          walletAddress: wallet.walletAddress,
          providerMode: 'rpc-addressless',
          errorKind: kind,
          shortMessage,
          rawMessage,
          requestPayload: requestPayload ? sanitizePayloadForDiagnostics(requestPayload) : undefined,
          transferTopicUsed: ERC20_TRANSFER_TOPIC,
          toTopicUsed: addressToTopic(wallet.walletAddress),
        });
        if (isAddresslessLogsRestrictionError(error)) {
          stats.addresslessLogsSupported = 'false';
          errors.push({
            code: 'addressless_logs_not_supported',
            chain: wallet.chain,
            walletAddress: wallet.walletAddress,
            message: shortMessage,
          });
        } else {
          errors.push({
            code: kind === 'rpc_timeout'
              ? 'rpc_timeout'
              : kind === 'addressless_logs_not_supported'
                ? 'addressless_logs_not_supported'
              : kind === 'provider_rejection'
                ? 'provider_rejection'
                : kind === 'invalid_hex_payload'
                  ? 'invalid_hex_payload'
                  : kind === 'invalid_rpc_quantity_hex'
                    ? 'invalid_rpc_quantity_hex'
                    : kind === 'invalid_getlogs_payload'
                      ? 'invalid_getlogs_payload'
                      : kind === 'getlogs_range_too_wide'
                        ? 'getlogs_range_too_wide'
                        : 'wallet_scan_failed',
            chain: wallet.chain,
            walletAddress: wallet.walletAddress,
            message: shortMessage,
          });
        }
      }
    }

    stats.walletScanFailureDetailsCount = failureDetails.length;

    return { events, stats, errors, failureDetails, cursorState: input.cursorEnabled ? nextCursorState : undefined };
  }
}

export class RpcWalletActivityProvider extends RpcAddresslessActivityProvider {
  override async getRecentIncomingTokenEvents(input: WalletActivityProviderInput): Promise<WalletActivityProviderResult> {
    const result = await super.getRecentIncomingTokenEvents(input);
    const byChain: Partial<Record<EvmSupportedChain, number>> = {};
    const uniqueByChain = new Map<EvmSupportedChain, Set<string>>();
    for (const ev of result.events) {
      incrementMap(byChain, ev.chain);
      if (!uniqueByChain.has(ev.chain)) uniqueByChain.set(ev.chain, new Set());
      uniqueByChain.get(ev.chain)?.add(ev.tokenAddress.toLowerCase());
    }
    const walletsWithEvents = new Set(result.events.map((e) => `${e.chain}:${e.walletAddress.toLowerCase()}`));
    const selectedWallets = selectCandidateWallets(input);
    const windows: Partial<Record<EvmSupportedChain, number>> = {
      ethereum: input.blockWindows?.ethereum ?? 300,
      base: input.blockWindows?.base ?? 1000,
      bsc: input.blockWindows?.bsc ?? 1000,
    };
    console.log(`[monitor][rpc-wallet-activity] wallets=${selectedWallets.length} events=${result.events.length} failures=${result.stats.walletScanFailures}`);
    return {
      ...result,
      events: result.events.map((event) => ({ ...event, source: 'rpc-wallet-activity' })),
      stats: {
        ...result.stats,
        walletActivityEventsFound: result.events.length,
        walletActivityUniqueTokens: new Set(result.events.map((event) => `${event.chain}:${event.tokenAddress.toLowerCase()}`)).size,
        rpcWalletActivityRawLogsFound: result.events.length,
        rpcWalletActivityEventsDecoded: result.events.length,
        rpcWalletActivityEventsDropped: 0,
        rpcWalletActivityDropReasons: {},
        rpcWalletActivityUniqueTokensByChain: Object.fromEntries(
          [...uniqueByChain.entries()].map(([chain, set]) => [chain, set.size]),
        ) as Partial<Record<EvmSupportedChain, number>>,
        rpcWalletActivityWalletsWithEvents: walletsWithEvents.size,
        rpcWalletActivityNoEventWallets: Math.max(0, selectedWallets.length - walletsWithEvents.size),
        rpcWalletActivityProviderErrors: result.errors.length,
        rpcWalletActivityBlockWindowByChain: windows,
        rpcWalletActivityChunksRequested: result.stats.getLogsChunksRequested ?? 0,
        rpcWalletActivityChunksSucceeded: result.stats.getLogsChunksSucceeded ?? 0,
        rpcWalletActivityChunksFailed: result.stats.getLogsChunksFailed ?? 0,
        walletActivityTokensByChain: byChain,
      },
    };
  }
}

export class RpcKnownTokensActivityProvider implements IWalletActivityProvider {
  async getRecentIncomingTokenEvents(input: WalletActivityProviderInput): Promise<WalletActivityProviderResult> {
    const blockWindows: Record<EvmSupportedChain, number> = {
      ethereum: input.blockWindows?.ethereum ?? 300,
      base: input.blockWindows?.base ?? 1000,
      bsc: input.blockWindows?.bsc ?? 1000,
    };
    const maxLogsPerWallet = input.maxLogsPerWallet ?? 200;
    const candidates = selectCandidateWallets(input);
    const events: RecentWalletTokenEvent[] = [];
    const errors: WalletActivityErrorInfo[] = [];
    const failureDetails: WalletScanFailureDetail[] = [];
    const stats = baseStats(input.chains);
    const getLogsMaxBlockRange = Math.max(1, Math.floor(input.getLogsMaxBlockRange ?? 10));
    stats.getLogsMaxBlockRange = getLogsMaxBlockRange;
    const knownTokens = (input.knownTokens ?? []).map((t) => ({ ...t, tokenAddress: t.tokenAddress.toLowerCase() }));
    for (const token of knownTokens) incrementMap(stats.knownTokensByChain, token.chain);

    for (const wallet of candidates) {
      console.log(`[monitor][progress] wallet ${stats.walletsScanned + 1}/${candidates.length} chain=${wallet.chain} provider=rpc-known-tokens pairs=${stats.scannedTokenWalletPairs} chunks=${stats.getLogsChunksRequested ?? 0}/${stats.getLogsChunksSucceeded ?? 0}/${stats.getLogsChunksFailed ?? 0} events=${events.length}`);
      stats.walletsScanned += 1;
      incrementMap(stats.scannedWalletsByChain, wallet.chain);
      const client = input.clientFactory?.(wallet.chain) ?? getEvmPublicClient(wallet.chain);
      const chainTokens = knownTokens.filter((t) => t.chain === wallet.chain);
      let walletHadFailures = false;
      let walletHadActivity = false;

      let fromBlockHex: `0x${string}` = '0x0';
      let toBlockHex: `0x${string}` = '0x0';
      try {
        const latest = await client.getBlockNumber();
        const fromBlock = latest > BigInt(blockWindows[wallet.chain]) ? latest - BigInt(blockWindows[wallet.chain]) : 0n;
        fromBlockHex = numberToRpcQuantityHex(fromBlock);
        toBlockHex = numberToRpcQuantityHex(latest);
      } catch (error) {
        walletHadFailures = true;
        const kind = classifyErrorKind(error);
        incrementMap(stats.failureKinds, kind);
        incrementMap(stats.failuresByChain, wallet.chain);
        incrementMap(stats.failuresByProviderMode, 'rpc-known-tokens');
        const { shortMessage, rawMessage } = extractErrorMessages(error);
        errors.push({
          code: kind === 'rpc_timeout'
            ? 'rpc_timeout'
            : kind === 'provider_rejection'
              ? 'provider_rejection'
              : kind === 'invalid_hex_payload'
                ? 'invalid_hex_payload'
                : 'wallet_scan_failed',
          chain: wallet.chain,
          walletAddress: wallet.walletAddress,
          message: shortMessage,
        });
        failureDetails.push({
          chain: wallet.chain,
          walletAddress: wallet.walletAddress,
          providerMode: 'rpc-known-tokens',
          errorKind: kind,
          shortMessage,
          rawMessage,
          blockRange: { fromBlock: fromBlockHex, toBlock: toBlockHex },
        });
      }

      for (const token of walletHadFailures ? [] : chainTokens) {
        stats.scannedTokenWalletPairs += 1;
        let tokenPairChunkSucceeded = 0;
        let tokenPairChunkFailed = 0;
        let tokenPairLogsFound = false;
        let payload: {
          address: string;
          topics: [string, null, string];
          fromBlock: `0x${string}`;
          toBlock: `0x${string}`;
        };
        try {
          payload = buildKnownTokenGetLogsPayload({
            tokenAddress: token.tokenAddress,
            walletAddress: wallet.walletAddress,
            fromBlockHex,
            toBlockHex,
          });
        } catch (error) {
          walletHadFailures = true;
          stats.failedTokenWalletPairs += 1;
          incrementMap(stats.failureKinds, 'invalid_payload');
          incrementMap(stats.failuresByChain, wallet.chain);
          incrementMap(stats.failuresByProviderMode, 'rpc-known-tokens');
          const { shortMessage, rawMessage } = extractErrorMessages(error);
          errors.push({
            code: 'invalid_payload',
            chain: wallet.chain,
            walletAddress: wallet.walletAddress,
            message: `known_token_get_logs_payload_invalid:${shortMessage}`,
          });
          failureDetails.push({
            chain: wallet.chain,
            walletAddress: wallet.walletAddress,
            tokenAddress: token.tokenAddress,
            tokenSymbol: token.symbol,
            providerMode: 'rpc-known-tokens',
            errorKind: 'invalid_payload',
            shortMessage: 'known_token_get_logs_payload_invalid',
            rawMessage: `known_token_get_logs_payload_invalid:${rawMessage}`,
            blockRange: { fromBlock: fromBlockHex, toBlock: toBlockHex },
          });
          continue;
        }
        const invalidReason = validateKnownTokenGetLogsPayload(payload, token.tokenAddress, wallet.walletAddress);
        if (invalidReason) {
          walletHadFailures = true;
          stats.failedTokenWalletPairs += 1;
          incrementMap(stats.failureKinds, 'invalid_payload');
          incrementMap(stats.failuresByChain, wallet.chain);
          incrementMap(stats.failuresByProviderMode, 'rpc-known-tokens');
          errors.push({
            code: 'invalid_payload',
            chain: wallet.chain,
            walletAddress: wallet.walletAddress,
            message: `known_token_get_logs_payload_invalid:${invalidReason}`,
          });
          failureDetails.push({
            chain: wallet.chain,
            walletAddress: wallet.walletAddress,
            tokenAddress: token.tokenAddress,
            tokenSymbol: token.symbol,
            providerMode: 'rpc-known-tokens',
            errorKind: 'invalid_payload',
            shortMessage: 'known_token_get_logs_payload_invalid',
            rawMessage: `known_token_get_logs_payload_invalid:${invalidReason}`,
            requestPayload: payload,
            blockRange: { fromBlock: fromBlockHex, toBlock: toBlockHex },
            getLogsAddressUsed: payload.address,
            transferTopicUsed: String(payload.topics[0] ?? ''),
            toTopicUsed: String(payload.topics[2] ?? ''),
          });
          continue;
        }

        const fromBlock = BigInt(payload.fromBlock);
        const toBlock = BigInt(payload.toBlock);
        let chunkFrom = fromBlock;
        const mergedLogs: Array<{
          address?: `0x${string}`;
          topics: `0x${string}`[];
          data: `0x${string}`;
          transactionHash?: `0x${string}`;
          blockNumber?: `0x${string}`;
          logIndex?: `0x${string}`;
        }> = [];

        while (chunkFrom <= toBlock) {
          const chunkTo = chunkFrom + BigInt(getLogsMaxBlockRange - 1) <= toBlock
            ? chunkFrom + BigInt(getLogsMaxBlockRange - 1)
            : toBlock;
          const chunkPayload = {
            ...payload,
            fromBlock: numberToRpcQuantityHex(chunkFrom),
            toBlock: numberToRpcQuantityHex(chunkTo),
          };
          stats.getLogsChunksRequested = (stats.getLogsChunksRequested ?? 0) + 1;

          try {
            const logs = (await client.request({
              method: 'eth_getLogs',
              params: [chunkPayload],
            })) as Array<{
              address?: `0x${string}`;
              topics: `0x${string}`[];
              data: `0x${string}`;
              transactionHash?: `0x${string}`;
              blockNumber?: `0x${string}`;
              logIndex?: `0x${string}`;
            }>;
            stats.getLogsChunksSucceeded = (stats.getLogsChunksSucceeded ?? 0) + 1;
            tokenPairChunkSucceeded += 1;
            if (logs.length > 0) tokenPairLogsFound = true;
            mergedLogs.push(...logs);
          } catch (error) {
            walletHadFailures = true;
            stats.getLogsChunksFailed = (stats.getLogsChunksFailed ?? 0) + 1;
            tokenPairChunkFailed += 1;
            const kind = classifyErrorKind(error);
            incrementMap(stats.failureKinds, kind);
            incrementMap(stats.failuresByChain, wallet.chain);
            incrementMap(stats.failuresByProviderMode, 'rpc-known-tokens');
            const { shortMessage, rawMessage } = extractErrorMessages(error);
            errors.push({
              code: kind === 'rpc_timeout'
                ? 'rpc_timeout'
                : kind === 'provider_rejection'
                  ? 'provider_rejection'
                  : kind === 'invalid_hex_payload'
                    ? 'invalid_hex_payload'
                    : kind === 'invalid_rpc_quantity_hex'
                      ? 'invalid_rpc_quantity_hex'
                      : kind === 'getlogs_range_too_wide'
                        ? 'getlogs_range_too_wide'
                        : 'wallet_scan_failed',
              chain: wallet.chain,
              walletAddress: wallet.walletAddress,
              message: shortMessage,
            });
            failureDetails.push({
              chain: wallet.chain,
              walletAddress: wallet.walletAddress,
              tokenAddress: token.tokenAddress,
              tokenSymbol: token.symbol,
              providerMode: 'rpc-known-tokens',
              errorKind: kind,
              shortMessage,
              rawMessage,
              requestPayload: chunkPayload,
              blockRange: { fromBlock: fromBlockHex, toBlock: toBlockHex },
              chunkFromBlock: chunkPayload.fromBlock,
              chunkToBlock: chunkPayload.toBlock,
              getLogsAddressUsed: payload.address,
              transferTopicUsed: String(payload.topics[0] ?? ''),
              toTopicUsed: String(payload.topics[2] ?? ''),
            });
          }
          chunkFrom = chunkTo + 1n;
        }

        if (tokenPairChunkSucceeded > 0) {
          stats.successfulTokenWalletPairs += 1;
          if (tokenPairChunkFailed > 0) stats.tokenWalletPairsPartiallyFailed += 1;
          if (tokenPairLogsFound) walletHadActivity = true;
          for (const log of mergedLogs.slice(0, maxLogsPerWallet)) {
            events.push({ ...decodeLog(log, wallet), source: 'rpc-known-tokens' });
          }
        } else {
          stats.failedTokenWalletPairs += 1;
        }
      }

      if (walletHadFailures) {
        stats.walletScanFailures += 1;
        stats.walletsWithFailures += 1;
      }
      if (walletHadActivity) {
        stats.walletsWithActivity += 1;
      } else if (!walletHadFailures) {
        stats.walletsWithNoActivity += 1;
      }
    }

    stats.walletScanFailureDetailsCount = failureDetails.length;

    return { events, stats, errors, failureDetails };
  }
}

export class ExplorerTokenTransferProvider implements IWalletActivityProvider {
  async getRecentIncomingTokenEvents(input: WalletActivityProviderInput): Promise<WalletActivityProviderResult> {
    const candidates = selectCandidateWallets(input);
    const stats = baseStats(input.chains);
    const events: RecentWalletTokenEvent[] = [];
    const errors: WalletActivityErrorInfo[] = [];
    const failureDetails: WalletScanFailureDetail[] = [];
    const nextCursorState: WalletActivityCursorState = { ...(input.cursorState ?? {}) };
    const explorerWarnings = new Set<string>();
    const explorerFailuresByChain: Partial<Record<EvmSupportedChain, number>> = {};

    const fetcher: ExplorerFetchLike = input.fetcher ?? (globalThis.fetch as unknown as ExplorerFetchLike);
    const providerMode: ExplorerProviderMode = input.explorerProvider ?? 'auto';
    const maxPages = input.explorerMaxPages ?? 2;
    const pageSize = input.explorerPageSize ?? 50;
    const maxTransfersPerWallet = input.maxTransfersPerWallet ?? 100;
    const blockscoutUrls: Partial<Record<EvmSupportedChain, string>> = {
      base: env.BASE_BLOCKSCOUT_API_URL || 'https://base.blockscout.com/api',
      ethereum: env.ETHEREUM_BLOCKSCOUT_API_URL,
      bsc: env.BSC_BLOCKSCOUT_API_URL,
    };

    stats.explorerRequests = 0;
    stats.explorerTransfersFetched = 0;
    stats.explorerFailures = 0;
    stats.explorerFailuresByChain = explorerFailuresByChain;
    stats.explorerWarnings = [];

    for (const wallet of candidates) {
      console.log(`[monitor][progress] wallet ${stats.walletsScanned + 1}/${candidates.length} chain=${wallet.chain} provider=explorer events=${events.length}`);
      stats.walletsScanned += 1;
      incrementMap(stats.scannedWalletsByChain, wallet.chain);

      const cursorKey = `${wallet.chain}:${wallet.walletAddress.toLowerCase()}:explorer`;
      let latestBlockForWallet = 0;
      const lookback = input.lookbackByChain?.[wallet.chain] ?? 300;
      const cursorLast = input.cursorEnabled ? Number(input.cursorState?.[cursorKey]?.lastScannedBlock ?? -1) : -1;
      const fromBlock = cursorLast >= 0 ? cursorLast + 1 : 0;

      const result = await fetchWalletTransfersWithExplorer(
        {
          provider: providerMode,
          blockscoutUrls,
          etherscanApiKey: env.ETHERSCAN_API_KEY,
        },
        {
          chain: wallet.chain,
          walletAddress: wallet.walletAddress,
          fromBlock,
          maxPages,
          pageSize,
          maxTransfersPerWallet,
        },
        fetcher,
      );

      stats.explorerRequests += result.requests;
      stats.explorerTransfersFetched += result.transfersFetched;
      const boundedEvents = result.events
        .filter((ev) => {
          if (cursorLast < 0) return true;
          return ev.blockNumber >= fromBlock;
        })
        .slice(0, Math.max(1, maxTransfersPerWallet));

      for (const ev of boundedEvents) {
        events.push({ ...ev, walletScore: wallet.score, source: 'explorer-wallet-activity' });
        if (ev.blockNumber > latestBlockForWallet) latestBlockForWallet = ev.blockNumber;
      }

      if (input.cursorEnabled) {
        const effectiveLast = latestBlockForWallet > 0
          ? latestBlockForWallet
          : (cursorLast >= 0 ? cursorLast : lookback);
        nextCursorState[cursorKey] = {
          lastScannedBlock: effectiveLast,
          updatedAt: new Date().toISOString(),
        };
      }

      if (boundedEvents.length > 0) {
        stats.walletsWithActivity += 1;
      } else if (result.errors.length === 0) {
        stats.walletsWithNoActivity += 1;
      }

      if (result.errors.length > 0) {
        stats.walletScanFailures += 1;
        stats.walletsWithFailures += 1;
        stats.explorerFailures += 1;
        incrementMap(explorerFailuresByChain, wallet.chain);
      }

      for (const warning of result.warnings) explorerWarnings.add(warning);
      for (const err of result.errors) {
        errors.push({
          code: err.code,
          chain: wallet.chain,
          walletAddress: wallet.walletAddress,
          message: err.message,
        });
        incrementMap(stats.failureKinds, err.code as WalletScanFailureErrorKind);
        incrementMap(stats.failuresByChain, wallet.chain);
        incrementMap(stats.failuresByProviderMode, 'explorer');
        failureDetails.push({
          chain: wallet.chain,
          walletAddress: wallet.walletAddress,
          providerMode: 'explorer',
          errorKind: err.code as WalletScanFailureErrorKind,
          shortMessage: err.message,
          rawMessage: err.message,
        });
      }
    }

    stats.explorerWarnings = [...explorerWarnings];
    stats.warnings.push(...stats.explorerWarnings);
    stats.walletScanFailureDetailsCount = failureDetails.length;

    return { events, stats, errors, failureDetails, cursorState: input.cursorEnabled ? nextCursorState : undefined };
  }
}
