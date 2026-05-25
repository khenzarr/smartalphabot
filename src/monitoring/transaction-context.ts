import type { PublicClient } from 'viem';
import { getEvmPublicClient } from '../providers/evm/evm-rpc.client.js';
import { ERC20_TRANSFER_TOPIC } from './constants.js';
import { isKnownDexAddress } from './known-dex-addresses.js';
import type {
  EvmSupportedChain,
  EnrichedTokenEvent,
  LikelyActivityType,
  TransactionContext,
} from './monitoring.types.js';

interface TxLike {
  from?: string;
  to?: string | null;
  input?: string;
}

interface ReceiptLike {
  status?: string;
  logs?: Array<{
    address?: string;
    topics?: string[];
    transactionHash?: string;
    logIndex?: string;
  }>;
}

export interface TxContextAnalyzerOptions {
  maxLookups: number;
  timeoutMs?: number;
  clientFactory?: (chain: EvmSupportedChain) => ReturnType<typeof getEvmPublicClient>;
}

export interface TxContextEnrichResult {
  events: EnrichedTokenEvent[];
  lookups: number;
  failures: number;
}

function isEoaLike(address?: string): boolean {
  if (!address) return false;
  return /^0x[0-9a-f]{40}$/i.test(address);
}

function toStatus(value?: string): 'success' | 'reverted' | 'unknown' {
  if (!value) return 'unknown';
  return value.toLowerCase() === '0x1' ? 'success' : value.toLowerCase() === '0x0' ? 'reverted' : 'unknown';
}

function classify(args: {
  event: EnrichedTokenEvent;
  txFrom?: string;
  txTo?: string;
  methodSelector?: string;
  involvedAddresses: Set<string>;
  knownRouterSeen: boolean;
  logCount: number;
}): { likelyActivityType: LikelyActivityType; confidence: 'high' | 'medium' | 'low'; reasons: string[] } {
  const reasons: string[] = [];
  const { event, txFrom, txTo, methodSelector, knownRouterSeen, involvedAddresses, logCount } = args;

  if (knownRouterSeen) {
    reasons.push('known_router_seen');
    if (event.to.toLowerCase() === event.walletAddress.toLowerCase()) {
      reasons.push('watched_wallet_received_token');
      return { likelyActivityType: 'likely_buy', confidence: 'high', reasons };
    }
    return { likelyActivityType: 'contract_interaction', confidence: 'medium', reasons };
  }

  const toIsContractLike = !!txTo && involvedAddresses.has(txTo.toLowerCase()) && logCount > 1;
  if (toIsContractLike && logCount >= 8) {
    reasons.push('high_log_count_distribution_pattern');
    return { likelyActivityType: 'airdrop_or_claim', confidence: 'medium', reasons };
  }

  if (toIsContractLike) {
    reasons.push('contract_target_detected');
    return { likelyActivityType: 'contract_interaction', confidence: 'medium', reasons };
  }

  if (isEoaLike(txFrom) && !methodSelector) {
    reasons.push('direct_eoa_sender_no_router_evidence');
    return { likelyActivityType: 'transfer', confidence: 'medium', reasons };
  }

  reasons.push('insufficient_transaction_context');
  return { likelyActivityType: 'unknown', confidence: 'low', reasons };
}

export class TransactionContextAnalyzer {
  private readonly maxLookups: number;
  private readonly timeoutMs: number;
  private readonly clientFactory: (chain: EvmSupportedChain) => ReturnType<typeof getEvmPublicClient>;
  private readonly cache = new Map<string, TransactionContext>();
  private lookups = 0;
  private failures = 0;

  constructor(options: TxContextAnalyzerOptions) {
    this.maxLookups = Math.max(0, options.maxLookups);
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.clientFactory = options.clientFactory ?? ((chain) => getEvmPublicClient(chain));
  }

  getStats(): { lookups: number; failures: number } {
    return { lookups: this.lookups, failures: this.failures };
  }

  async enrichEvents(events: EnrichedTokenEvent[]): Promise<TxContextEnrichResult> {
    const out: EnrichedTokenEvent[] = [];
    for (const event of events) {
      const txContext = await this.getContextForEvent(event);
      out.push({ ...event, transactionContext: txContext });
    }
    return { events: out, ...this.getStats() };
  }

  async getContextForEvent(event: EnrichedTokenEvent): Promise<TransactionContext> {
    const key = `${event.chain}:${event.txHash.toLowerCase()}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    if (this.lookups >= this.maxLookups) {
      const maxed: TransactionContext = {
        txHash: event.txHash,
        chain: event.chain,
        receiptStatus: 'unknown',
        logCount: 0,
        involvedAddresses: [],
        matchedTokenTransfer: false,
        likelyActivityType: 'unknown',
        confidence: 'low',
        reasons: ['tx_context_lookup_budget_exhausted'],
        warnings: ['tx_context_lookup_skipped:max_budget_reached'],
        knownRouterSeen: false,
      };
      this.cache.set(key, maxed);
      return maxed;
    }

    this.lookups += 1;
    const client = this.clientFactory(event.chain);

    try {
      const tx = await Promise.race([
        client.request({ method: 'eth_getTransactionByHash', params: [event.txHash as `0x${string}`] }) as Promise<TxLike>,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('tx_context_timeout_tx')), this.timeoutMs)),
      ]);
      const receipt = await Promise.race([
        client.request({ method: 'eth_getTransactionReceipt', params: [event.txHash as `0x${string}`] }) as Promise<ReceiptLike>,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('tx_context_timeout_receipt')), this.timeoutMs)),
      ]);

      const txFrom = tx?.from?.toLowerCase();
      const txTo = tx?.to?.toLowerCase() ?? undefined;
      const methodSelector = tx?.input && tx.input.length >= 10 ? tx.input.slice(0, 10).toLowerCase() : undefined;
      const logs = receipt?.logs ?? [];
      const involvedAddresses = new Set<string>();
      for (const log of logs) {
        if (log.address) involvedAddresses.add(log.address.toLowerCase());
      }
      if (txFrom) involvedAddresses.add(txFrom);
      if (txTo) involvedAddresses.add(txTo);

      const knownRouterSeen = [...involvedAddresses].some((a) => isKnownDexAddress(event.chain, a));
      const matchedTokenTransfer = logs.some((log) =>
        (log.address ?? '').toLowerCase() === event.tokenAddress.toLowerCase()
        && (log.transactionHash ?? '').toLowerCase() === event.txHash.toLowerCase()
        && Number(log.logIndex ? BigInt(log.logIndex) : -1n) === event.logIndex
        && String(log.topics?.[0] ?? '').toLowerCase() === ERC20_TRANSFER_TOPIC.toLowerCase(),
      );

      const classification = classify({
        event,
        txFrom,
        txTo,
        methodSelector,
        involvedAddresses,
        knownRouterSeen,
        logCount: logs.length,
      });

      const context: TransactionContext = {
        txHash: event.txHash,
        chain: event.chain,
        txFrom,
        txTo,
        methodSelector,
        receiptStatus: toStatus(receipt?.status),
        logCount: logs.length,
        involvedAddresses: [...involvedAddresses],
        matchedTokenTransfer,
        likelyActivityType: classification.likelyActivityType,
        confidence: classification.confidence,
        reasons: classification.reasons,
        warnings: [],
        knownRouterSeen,
      };
      this.cache.set(key, context);
      return context;
    } catch (error) {
      this.failures += 1;
      const failed: TransactionContext = {
        txHash: event.txHash,
        chain: event.chain,
        receiptStatus: 'unknown',
        logCount: 0,
        involvedAddresses: [],
        matchedTokenTransfer: false,
        likelyActivityType: 'unknown',
        confidence: 'low',
        reasons: ['tx_context_fetch_failed'],
        warnings: [String((error as Error)?.message ?? error ?? 'tx_context_error')],
        knownRouterSeen: false,
      };
      this.cache.set(key, failed);
      return failed;
    }
  }
}
