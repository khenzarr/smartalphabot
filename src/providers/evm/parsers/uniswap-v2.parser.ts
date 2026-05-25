import { decodeEventLog, keccak256, parseAbiItem, toBytes } from 'viem';
import type { Log } from 'viem';
import type { NormalizedTrade, SupportedChain, TradeSide } from '../../../chains/chain.types.js';

const v2SwapAbi = parseAbiItem(
  'event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)',
);

export interface ParseV2SwapInput {
  chain: SupportedChain;
  tokenAddress: string;
  token0: string;
  token1: string;
  dex?: string;
  log: Log;
  timestamp: Date;
}

export function parseUniswapV2Swap(input: ParseV2SwapInput): { trade?: NormalizedTrade; warnings: string[] } {
  const warnings: string[] = [];
  try {
    const decoded = decodeEventLog({ abi: [v2SwapAbi], data: input.log.data, topics: input.log.topics });
    const args = decoded.args as {
      sender: `0x${string}`;
      amount0In: bigint;
      amount1In: bigint;
      amount0Out: bigint;
      amount1Out: bigint;
      to: `0x${string}`;
    };

    const token = input.tokenAddress.toLowerCase();
    const isToken0 = input.token0.toLowerCase() === token;
    const isToken1 = input.token1.toLowerCase() === token;
    if (!isToken0 && !isToken1) return { warnings: ['token_not_in_pool'] };

    let side: TradeSide | undefined;
    let wallet = args.to;
    let amountToken = 0;

    if (isToken0 && args.amount0Out > 0n) {
      side = 'buy';
      amountToken = Number(args.amount0Out);
    } else if (isToken1 && args.amount1Out > 0n) {
      side = 'buy';
      amountToken = Number(args.amount1Out);
    } else if (isToken0 && args.amount0In > 0n) {
      side = 'sell';
      wallet = args.sender;
      amountToken = Number(args.amount0In);
    } else if (isToken1 && args.amount1In > 0n) {
      side = 'sell';
      wallet = args.sender;
      amountToken = Number(args.amount1In);
    }

    if (!side || amountToken <= 0) return { warnings: ['unclassified_swap'] };
    if (side === 'buy' && !wallet) warnings.push('buyer_inference_uncertain');

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
    return { warnings: ['decode_failed_v2'] };
  }
}

export const V2_SWAP_TOPIC = keccak256(
  toBytes('Swap(address,uint256,uint256,uint256,uint256,address)'),
);
