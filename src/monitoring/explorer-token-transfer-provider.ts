import type { EvmSupportedChain, ExplorerProviderMode, RecentWalletTokenEvent } from './monitoring.types.js';

export interface ExplorerFetchLike {
  (input: string, init?: { method?: string; headers?: Record<string, string> }): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }>;
}

export interface ExplorerProviderConfig {
  provider: ExplorerProviderMode;
  blockscoutUrls: Partial<Record<EvmSupportedChain, string>>;
  etherscanApiKey?: string;
}

export interface ExplorerWalletQuery {
  chain: EvmSupportedChain;
  walletAddress: string;
  fromBlock?: number;
  toBlock?: number;
  maxPages: number;
  pageSize: number;
  maxTransfersPerWallet: number;
}

export interface ExplorerWalletResult {
  events: RecentWalletTokenEvent[];
  requests: number;
  transfersFetched: number;
  warnings: string[];
  errors: Array<{ code: 'explorer_unavailable' | 'explorer_rate_limited' | 'explorer_unsupported_chain' | 'explorer_parse_error' | 'etherscan_api_key_missing'; message: string }>;
  providerUsed?: Exclude<ExplorerProviderMode, 'auto'>;
}

function normalizeAddress(value: unknown): string {
  const v = String(value ?? '').toLowerCase();
  return v.startsWith('0x') ? v : `0x${v}`;
}

function parseNumberLike(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    if (value.startsWith('0x')) return Number(BigInt(value));
    const asNum = Number(value);
    if (Number.isFinite(asNum)) return asNum;
  }
  return 0;
}

function normalizeTransfer(args: {
  chain: EvmSupportedChain;
  walletAddress: string;
  tokenAddress: string;
  from: string;
  to: string;
  rawAmount: string;
  txHash: string;
  blockNumber: number;
  logIndex?: number;
  explorerProvider: Exclude<ExplorerProviderMode, 'auto'>;
}): RecentWalletTokenEvent {
  return {
    chain: args.chain,
    walletAddress: normalizeAddress(args.walletAddress),
    tokenAddress: normalizeAddress(args.tokenAddress),
    from: normalizeAddress(args.from),
    to: normalizeAddress(args.to),
    rawAmount: String(args.rawAmount),
    txHash: String(args.txHash).toLowerCase(),
    blockNumber: args.blockNumber,
    logIndex: args.logIndex ?? 0,
    observedAt: new Date().toISOString(),
    warnings: ['incoming_transfer_not_confirmed_buy', 'requires_dex_context'],
    source: 'explorer',
    explorerProvider: args.explorerProvider,
  };
}

function classifyHttpStatus(status: number): 'explorer_rate_limited' | 'explorer_unavailable' {
  if (status === 429) return 'explorer_rate_limited';
  return 'explorer_unavailable';
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function pickBlockscoutV2Array(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload) && Array.isArray(payload.items)) return payload.items;
  return [];
}

function parseBlockscoutV2Transfer(chain: EvmSupportedChain, walletAddress: string, item: unknown): RecentWalletTokenEvent | null {
  if (!isRecord(item)) return null;
  const token = item.token as Record<string, unknown> | undefined;
  const total = isRecord(item.total) ? item.total : undefined;
  const tokenAddress = String(token?.address ?? item.token_address_hash ?? item.tokenAddress ?? '');
  const from = String(item.from?.['hash' as keyof typeof item.from] ?? item.from_address_hash ?? item.from ?? '');
  const to = String(item.to?.['hash' as keyof typeof item.to] ?? item.to_address_hash ?? item.to ?? '');
  const txHash = String(item.transaction_hash ?? item.tx_hash ?? item.hash ?? '');
  if (!tokenAddress || !from || !to || !txHash) return null;
  return normalizeTransfer({
    chain,
    walletAddress,
    tokenAddress,
    from,
    to,
    rawAmount: String(total?.value ?? item.amount ?? item.value ?? '0'),
    txHash,
    blockNumber: parseNumberLike(item.block_number),
    logIndex: parseNumberLike(item.log_index),
    explorerProvider: 'blockscout',
  });
}

function parseExplorerStyleTransfer(chain: EvmSupportedChain, walletAddress: string, item: unknown, provider: 'blockscout' | 'etherscan'): RecentWalletTokenEvent | null {
  if (!isRecord(item)) return null;
  const tokenAddress = String(item.contractAddress ?? item.tokenAddress ?? '');
  const from = String(item.from ?? '');
  const to = String(item.to ?? '');
  const txHash = String(item.hash ?? item.transactionHash ?? '');
  if (!tokenAddress || !from || !to || !txHash) return null;
  return normalizeTransfer({
    chain,
    walletAddress,
    tokenAddress,
    from,
    to,
    rawAmount: String(item.value ?? item.amount ?? '0'),
    txHash,
    blockNumber: parseNumberLike(item.blockNumber),
    logIndex: parseNumberLike(item.logIndex),
    explorerProvider: provider,
  });
}

export async function fetchWalletTransfersWithExplorer(
  config: ExplorerProviderConfig,
  query: ExplorerWalletQuery,
  fetcher: ExplorerFetchLike,
): Promise<ExplorerWalletResult> {
  const mode = config.provider;
  if (mode === 'etherscan' || (mode === 'auto' && config.etherscanApiKey)) {
    const etherscanResult = await fetchViaEtherscan(config, query, fetcher);
    if (etherscanResult.providerUsed || mode === 'etherscan') return etherscanResult;
  }
  return fetchViaBlockscout(config, query, fetcher);
}

async function fetchViaBlockscout(
  config: ExplorerProviderConfig,
  query: ExplorerWalletQuery,
  fetcher: ExplorerFetchLike,
): Promise<ExplorerWalletResult> {
  const url = config.blockscoutUrls[query.chain];
  if (!url) {
    return {
      events: [], requests: 0, transfersFetched: 0, warnings: ['explorer_unsupported_chain'],
      errors: [{ code: 'explorer_unsupported_chain', message: `blockscout_url_missing_for_${query.chain}` }],
    };
  }
  const base = url.replace(/\/$/, '');
  const events: RecentWalletTokenEvent[] = [];
  let requests = 0;

  for (let page = 1; page <= query.maxPages && events.length < query.maxTransfersPerWallet; page += 1) {
    const v2Url = `${base}/v2/addresses/${query.walletAddress}/token-transfers?type=ERC-20&page=${page}&page_size=${query.pageSize}`;
    requests += 1;
    const v2Resp = await fetcher(v2Url, { method: 'GET' });
    if (v2Resp.ok) {
      const payload = await v2Resp.json();
      const rows = pickBlockscoutV2Array(payload);
      for (const row of rows) {
        const ev = parseBlockscoutV2Transfer(query.chain, query.walletAddress, row);
        if (ev && ev.to.toLowerCase() === query.walletAddress.toLowerCase()) events.push(ev);
        if (events.length >= query.maxTransfersPerWallet) break;
      }
      if (rows.length < query.pageSize) break;
      continue;
    }

    if (v2Resp.status === 404 || v2Resp.status === 400) {
      const classicUrl = `${base}?module=account&action=tokentx&address=${query.walletAddress}&page=${page}&offset=${query.pageSize}&sort=desc`;
      requests += 1;
      const classicResp = await fetcher(classicUrl, { method: 'GET' });
      if (!classicResp.ok) {
        return {
          events: [], requests, transfersFetched: 0, warnings: [classifyHttpStatus(classicResp.status)],
          errors: [{ code: classifyHttpStatus(classicResp.status), message: `blockscout_classic_http_${classicResp.status}` }], providerUsed: 'blockscout',
        };
      }
      const payload = await classicResp.json();
      const rows = isRecord(payload) && Array.isArray(payload.result) ? payload.result : [];
      for (const row of rows) {
        const ev = parseExplorerStyleTransfer(query.chain, query.walletAddress, row, 'blockscout');
        if (ev && ev.to.toLowerCase() === query.walletAddress.toLowerCase()) events.push(ev);
        if (events.length >= query.maxTransfersPerWallet) break;
      }
      if (rows.length < query.pageSize) break;
      continue;
    }

    return {
      events: [], requests, transfersFetched: 0, warnings: [classifyHttpStatus(v2Resp.status)],
      errors: [{ code: classifyHttpStatus(v2Resp.status), message: `blockscout_v2_http_${v2Resp.status}` }], providerUsed: 'blockscout',
    };
  }

  return {
    events: events.slice(0, query.maxTransfersPerWallet),
    requests,
    transfersFetched: events.length,
    warnings: [],
    errors: [],
    providerUsed: 'blockscout',
  };
}

async function fetchViaEtherscan(
  config: ExplorerProviderConfig,
  query: ExplorerWalletQuery,
  fetcher: ExplorerFetchLike,
): Promise<ExplorerWalletResult> {
  if (!config.etherscanApiKey) {
    return {
      events: [], requests: 0, transfersFetched: 0, warnings: ['etherscan_api_key_missing'],
      errors: [{ code: 'etherscan_api_key_missing', message: 'etherscan_api_key_missing' }],
    };
  }
  const chainIdByChain: Record<EvmSupportedChain, number> = { ethereum: 1, base: 8453, bsc: 56 };
  const events: RecentWalletTokenEvent[] = [];
  let requests = 0;
  for (let page = 1; page <= query.maxPages && events.length < query.maxTransfersPerWallet; page += 1) {
    const url = `https://api.etherscan.io/v2/api?chainid=${chainIdByChain[query.chain]}&module=account&action=tokentx&address=${query.walletAddress}&page=${page}&offset=${query.pageSize}&sort=desc&apikey=${config.etherscanApiKey}`;
    requests += 1;
    const resp = await fetcher(url, { method: 'GET' });
    if (!resp.ok) {
      const code = classifyHttpStatus(resp.status);
      return { events: [], requests, transfersFetched: 0, warnings: [code], errors: [{ code, message: `etherscan_http_${resp.status}` }], providerUsed: 'etherscan' };
    }
    const payload = await resp.json();
    const rows = isRecord(payload) && Array.isArray(payload.result) ? payload.result : [];
    for (const row of rows) {
      const ev = parseExplorerStyleTransfer(query.chain, query.walletAddress, row, 'etherscan');
      if (ev && ev.to.toLowerCase() === query.walletAddress.toLowerCase()) events.push(ev);
      if (events.length >= query.maxTransfersPerWallet) break;
    }
    if (rows.length < query.pageSize) break;
  }

  return {
    events: events.slice(0, query.maxTransfersPerWallet),
    requests,
    transfersFetched: events.length,
    warnings: [],
    errors: [],
    providerUsed: 'etherscan',
  };
}
