import type { NormalizedWalletStats, SupportedChain } from '../chains/chain.types.js';
import { EvmAdapter } from '../providers/evm/evm.adapter.js';
import { SolanaAdapter } from '../providers/solana/solana.adapter.js';
import type { NormalizedTrade } from '../chains/chain.types.js';
import { getMockEvmWalletTrades } from '../providers/evm/evm.mock-provider.js';
import { getPersistedWalletTrades } from '../providers/internal/persisted-trade.provider.js';
import { calculateWalletPerformance } from './wallet-performance-calculator.js';
import { enrichCurrentTokenPrices } from './enrich-current-token-prices.js';
import { scoreWallet } from './wallet-scoring.js';
import type { WalletAnalysisResult } from './wallet-performance.types.js';

export interface AnalyzeWalletInput {
  chain: SupportedChain;
  walletAddress: string;
  source?: 'persisted' | 'mock' | 'provider';
  fromTimestamp?: Date;
  toTimestamp?: Date;
  maxTrades?: number;
  tokenAddress?: string;
  enrichPrices?: boolean;
  persist?: boolean;
}

export async function analyzeWallet(input: AnalyzeWalletInput): Promise<WalletAnalysisResult> {
  const evmAdapter = new EvmAdapter();
  const solanaAdapter = new SolanaAdapter();
  const walletValid = input.chain === 'solana'
    ? solanaAdapter.validateWalletAddress(input.chain, input.walletAddress)
    : evmAdapter.validateWalletAddress(input.chain, input.walletAddress);

  if (!walletValid) {
    throw new Error(`invalid_wallet_address_for_chain:${input.chain}`);
  }

  if (input.chain === 'solana') {
    const scoreInput: NormalizedWalletStats = {
      chain: input.chain,
      walletAddress: input.walletAddress,
      totalTrades: 0,
      totalRealizedPnlUsd: 0,
      totalUnrealizedPnlUsd: 0,
      winRate: 0,
      medianRoi: 0,
      averageHoldSeconds: 0,
      medianHoldSeconds: 0,
      earlyEntryCount: 0,
      successfulEarlyEntryCount: 0,
      rugExposureCount: 0,
      suspiciousFlags: [],
    };
    const scoreResult = scoreWallet(scoreInput);
    return {
      summary: {
        chain: input.chain,
        walletAddress: input.walletAddress,
        analyzedTokenCount: 0,
        closedPositionCount: 0,
        openPositionCount: 0,
        totalTrades: 0,
        totalBuys: 0,
        totalSells: 0,
        warnings: ['Solana wallet historical analysis is not implemented yet.'],
        limitations: ['Solana wallet historical analysis is not implemented yet.'],
      },
      tokenPerformances: [],
      scoreInput,
      scoreResult,
      providerMetadata: {
        source: 'unsupported_solana',
        chain: input.chain,
        walletAddress: input.walletAddress,
        fromTimestamp: input.fromTimestamp,
        toTimestamp: input.toTimestamp,
        tradesReturned: 0,
        warnings: ['Solana wallet historical analysis is not implemented yet.'],
      },
      warnings: ['Solana wallet historical analysis is not implemented yet.'],
      limitations: ['Solana wallet historical analysis is not implemented yet.'],
    };
  }

  const source = input.source ?? 'persisted';
  const query = {
    chain: input.chain,
    walletAddress: input.walletAddress,
    fromTimestamp: input.fromTimestamp,
    toTimestamp: input.toTimestamp,
    maxTrades: input.maxTrades,
    tokenAddress: input.tokenAddress,
    source,
  };

  const providerResult =
    source === 'mock'
      ? await getMockEvmWalletTrades(query)
      : source === 'provider'
         ? await evmAdapter.getWalletTrades(query)
        : await getPersistedWalletTrades(query);

  const uniqueTokenAddresses: string[] = Array.from(
    new Set((providerResult.trades as NormalizedTrade[]).map((x) => x.tokenAddress.toLowerCase())),
  );
  const enrichPrices = input.enrichPrices ?? true;
  const priceEnrichment = enrichPrices
    ? await enrichCurrentTokenPrices({ chain: input.chain, tokenAddresses: uniqueTokenAddresses })
    : { prices: {}, warnings: [] as string[] };

  const computed = calculateWalletPerformance({
    chain: input.chain,
    walletAddress: input.walletAddress,
    trades: providerResult.trades,
    currentPrices: priceEnrichment.prices,
  });

  const scoreInput: NormalizedWalletStats = {
    chain: input.chain,
    walletAddress: input.walletAddress,
    totalTrades: computed.summary.totalTrades,
    totalRealizedPnlUsd: computed.summary.totalRealizedPnlUsd,
    totalUnrealizedPnlUsd: computed.summary.totalUnrealizedPnlUsd,
    winRate: computed.summary.winRate,
    medianRoi: computed.summary.medianRoi,
    averageHoldSeconds: computed.summary.averageHoldSeconds,
    medianHoldSeconds: computed.summary.medianHoldSeconds,
    earlyEntryCount: computed.summary.analyzedTokenCount,
    successfulEarlyEntryCount: computed.tokenPerformances.filter((x) => x.isWinner === true).length,
    rugExposureCount: 0,
    suspiciousFlags: [],
  };

  const scoreResult = scoreWallet(scoreInput);
  const warnings = [...new Set([...providerResult.metadata.warnings, ...computed.warnings, ...priceEnrichment.warnings])];
  const limitations = [...new Set([...computed.limitations, 'approximate_pnl_not_tax_lot_accounting'])];

  return {
    summary: {
      ...computed.summary,
      warnings,
      limitations,
      earlyEntryCount: scoreInput.earlyEntryCount,
      successfulEarlyEntryCount: scoreInput.successfulEarlyEntryCount,
      rugExposureCount: 0,
    },
    tokenPerformances: computed.tokenPerformances,
    scoreInput,
    scoreResult,
    providerMetadata: {
      ...providerResult.metadata,
      warnings,
    },
    warnings,
    limitations,
  };
}
