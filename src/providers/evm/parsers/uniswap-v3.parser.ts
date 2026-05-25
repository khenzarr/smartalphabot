import { decodeEventLog, keccak256, parseAbiItem, toBytes } from 'viem';
import type { Log } from 'viem';
import type { NormalizedTrade, SupportedChain, TradeSide } from '../../../chains/chain.types.js';

const v3SwapAbi = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
);

export interface ParseV3SwapInput {
  chain: SupportedChain;
  tokenAddress: string;
  token0: string;
  token1: string;
  dex?: string;
  log: Log;
  timestamp: Date;
}

export function parseUniswapV3Swap(input: ParseV3SwapInput): { trade?: NormalizedTrade; warnings: string[] } {
  const warnings: string[] = [];
  try {
    const decoded = decodeEventLog({ abi: [v3SwapAbi], data: input.log.data, topics: input.log.topics });
    const args = decoded.args as {
      sender: `0x${string}`;
      recipient: `0x${string}`;
      amount0: bigint;
      amount1: bigint;
    };

    const token = input.tokenAddress.toLowerCase();
    const isToken0 = input.token0.toLowerCase() === token;
    const isToken1 = input.token1.toLowerCase() === token;
    if (!isToken0 && !isToken1) return { warnings: ['token_not_in_pool'] };

    let side: TradeSide | undefined;
    let wallet: string | undefined;
    let amountToken = 0;

    if (isToken0 && args.amount0 < 0n) {
      side = 'buy';
      wallet = args.recipient;
      amountToken = Number(-args.amount0);
    } else if (isToken1 && args.amount1 < 0n) {
      side = 'buy';
      wallet = args.recipient;
      amountToken = Number(-args.amount1);
    } else if (isToken0 && args.amount0 > 0n) {
      side = 'sell';
      wallet = args.sender;
      amountToken = Number(args.amount0);
    } else if (isToken1 && args.amount1 > 0n) {
      side = 'sell';
      wallet = args.sender;
      amountToken = Number(args.amount1);
    }

    if (!side || !wallet || amountToken <= 0) return { warnings: ['unclassified_swap'] };

    return {
      trade: {
        chain: input.chain,
        chainFamily: 'evm',
        walletAddress: wallet,
        tokenAddress: input.tokenAddress,
        txHash: input.log.transactionHash ?? 'unknown',
        side,
        amountToken,
        blockNumber: Number(input.log.blockNumber ?? 0n),
        timestamp: input.timestamp,
        dex: input.dex,
        raw: { ...args, logIndex: input.log.logIndex?.toString() },
      },
      warnings,
    };
  } catch {
    return { warnings: ['decode_failed_v3'] };
  }
}

export const V3_SWAP_TOPIC = keccak256(
  toBytes('Swap(address,address,int256,int256,uint160,uint128,int24)'),
);
