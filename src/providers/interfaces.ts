import type { NormalizedTokenProfile, NormalizedTrade, SupportedChain } from '../chains/chain.types.js';

export interface WalletTradeQuery {
  chain: SupportedChain;
  walletAddress: string;
  fromTimestamp?: Date;
  toTimestamp?: Date;
  maxTrades?: number;
  tokenAddress?: string;
  source?: string;
}

export interface WalletTradeResultMetadata {
  source: string;
  chain: SupportedChain;
  walletAddress: string;
  fromTimestamp?: Date;
  toTimestamp?: Date;
  tradesReturned: number;
  warnings: string[];
}

export interface WalletTradeResult {
  trades: NormalizedTrade[];
  metadata: WalletTradeResultMetadata;
}

export interface ITradeProvider {
  getWalletTrades(input: WalletTradeQuery): Promise<WalletTradeResult>;
  getTokenEarlyBuyers(chain: SupportedChain, tokenAddress: string, limit?: number): Promise<string[]>;
  getTokenTransfers(chain: SupportedChain, tokenAddress: string): Promise<NormalizedTrade[]>;
}

export interface IWalletProvider {
  validateWalletAddress(chain: SupportedChain, walletAddress: string): boolean;
}

export interface ITokenProvider {
  validateTokenAddress(chain: SupportedChain, tokenAddress: string): boolean;
}

export interface IRealtimeProvider {
  subscribeToWalletActivity(
    chain: SupportedChain,
    wallets: string[],
    onEvent: (trade: NormalizedTrade) => void,
  ): Promise<void>;
}

export interface IMarketDataProvider {
  getTokenPairs(chain: SupportedChain, tokenAddress: string): Promise<unknown[]>;
  getBestPairForToken(chain: SupportedChain, tokenAddress: string): Promise<unknown | null>;
  getTokenProfile(chain: SupportedChain, tokenAddress: string): Promise<NormalizedTokenProfile | null>;
}
