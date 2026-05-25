import type { NormalizedTrade, SupportedChain } from '../../chains/chain.types.js';
import { isEvmAddress } from '../../utils/address.js';
import type { IRealtimeProvider, ITokenProvider, ITradeProvider, IWalletProvider, WalletTradeQuery, WalletTradeResult } from '../interfaces.js';

export class EvmAdapter implements ITradeProvider, IWalletProvider, ITokenProvider, IRealtimeProvider {
  validateWalletAddress(_chain: SupportedChain, walletAddress: string): boolean {
    return isEvmAddress(walletAddress);
  }

  validateTokenAddress(_chain: SupportedChain, tokenAddress: string): boolean {
    return isEvmAddress(tokenAddress);
  }

  async getWalletTrades(input: WalletTradeQuery): Promise<WalletTradeResult> {
    return {
      trades: [],
      metadata: {
        source: input.source ?? 'evm_adapter_stub',
        chain: input.chain,
        walletAddress: input.walletAddress,
        fromTimestamp: input.fromTimestamp,
        toTimestamp: input.toTimestamp,
        tradesReturned: 0,
        warnings: ['evm_wallet_trade_provider_not_implemented_yet'],
      },
    };
  }

  async getTokenEarlyBuyers(_chain: SupportedChain, _tokenAddress: string, _limit = 200): Promise<string[]> {
    return [];
  }

  async getTokenTransfers(_chain: SupportedChain, _tokenAddress: string): Promise<NormalizedTrade[]> {
    return [];
  }

  async subscribeToWalletActivity(
    _chain: SupportedChain,
    _wallets: string[],
    _onEvent: (trade: NormalizedTrade) => void,
  ): Promise<void> {
    return;
  }
}
