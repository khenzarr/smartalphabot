import type { NormalizedTrade, SupportedChain } from '../../chains/chain.types.js';
import type { WalletTradeQuery, WalletTradeResult } from '../interfaces.js';

function makeDate(value: string): Date {
  return new Date(value);
}

const MOCK_TRADES: NormalizedTrade[] = [
  {
    chain: 'base',
    chainFamily: 'evm',
    walletAddress: '0x1111111111111111111111111111111111111111',
    tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    txHash: '0xmock1',
    side: 'buy',
    amountToken: 1000,
    amountUsd: 500,
    priceUsd: 0.5,
    timestamp: makeDate('2025-01-01T00:00:00.000Z'),
  },
  {
    chain: 'base',
    chainFamily: 'evm',
    walletAddress: '0x1111111111111111111111111111111111111111',
    tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    txHash: '0xmock2b',
    side: 'sell',
    amountToken: 400,
    amountUsd: 380,
    priceUsd: 0.95,
    timestamp: makeDate('2025-01-06T00:00:00.000Z'),
  },
  {
    chain: 'base',
    chainFamily: 'evm',
    walletAddress: '0x1111111111111111111111111111111111111111',
    tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    txHash: '0xmock2',
    side: 'sell',
    amountToken: 600,
    amountUsd: 540,
    priceUsd: 0.9,
    timestamp: makeDate('2025-01-03T00:00:00.000Z'),
  },
  {
    chain: 'base',
    chainFamily: 'evm',
    walletAddress: '0x1111111111111111111111111111111111111111',
    tokenAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    txHash: '0xmock3',
    side: 'buy',
    amountToken: 200,
    amountUsd: 300,
    priceUsd: 1.5,
    timestamp: makeDate('2025-01-04T00:00:00.000Z'),
  },
  {
    chain: 'base',
    chainFamily: 'evm',
    walletAddress: '0x1111111111111111111111111111111111111111',
    tokenAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    txHash: '0xmock4',
    side: 'sell',
    amountToken: 200,
    amountUsd: 160,
    priceUsd: 0.8,
    timestamp: makeDate('2025-01-05T00:00:00.000Z'),
  },
  {
    chain: 'base',
    chainFamily: 'evm',
    walletAddress: '0x1111111111111111111111111111111111111111',
    tokenAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
    txHash: '0xmock5',
    side: 'buy',
    amountToken: 500,
    amountUsd: 100,
    priceUsd: 0.2,
    timestamp: makeDate('2025-01-07T00:00:00.000Z'),
  },
  {
    chain: 'base',
    chainFamily: 'evm',
    walletAddress: '0x1111111111111111111111111111111111111111',
    tokenAddress: '0xdddddddddddddddddddddddddddddddddddddddd',
    txHash: '0xmock6',
    side: 'buy',
    amountToken: 100,
    timestamp: makeDate('2025-01-08T00:00:00.000Z'),
  },
  {
    chain: 'base',
    chainFamily: 'evm',
    walletAddress: '0x1111111111111111111111111111111111111111',
    tokenAddress: '0xdddddddddddddddddddddddddddddddddddddddd',
    txHash: '0xmock7',
    side: 'sell',
    amountToken: 100,
    timestamp: makeDate('2025-01-09T00:00:00.000Z'),
  },
];

export async function getMockEvmWalletTrades(input: WalletTradeQuery): Promise<WalletTradeResult> {
  const chain = input.chain as SupportedChain;
  const wallet = input.walletAddress.toLowerCase();
  const tokenFilter = input.tokenAddress?.toLowerCase();
  const from = input.fromTimestamp?.getTime();
  const to = input.toTimestamp?.getTime();

  const filtered = MOCK_TRADES.filter((trade) => {
    if (trade.chain !== chain) return false;
    if (trade.walletAddress.toLowerCase() !== wallet) return false;
    if (tokenFilter && trade.tokenAddress.toLowerCase() !== tokenFilter) return false;
    if (from !== undefined && trade.timestamp.getTime() < from) return false;
    if (to !== undefined && trade.timestamp.getTime() > to) return false;
    return true;
  });
  const trades = typeof input.maxTrades === 'number' ? filtered.slice(0, input.maxTrades) : filtered;

  const warnings = ['mock_trade_provider_data_not_real_chain_history'];
  if (trades.some((trade) => trade.amountUsd === undefined)) warnings.push('mock_dataset_includes_missing_usd_data_cases');
  if (trades.some((trade) => trade.side === 'buy') && !trades.some((trade) => trade.side === 'sell')) {
    warnings.push('selected_mock_subset_may_have_open_positions_only');
  }

  return {
    trades,
    metadata: {
      source: input.source ?? 'evm_mock',
      chain: input.chain,
      walletAddress: input.walletAddress,
      fromTimestamp: input.fromTimestamp,
      toTimestamp: input.toTimestamp,
      tradesReturned: trades.length,
        warnings,
    },
  };
}
