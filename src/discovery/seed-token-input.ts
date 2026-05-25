import { z } from 'zod';
import { isEvmAddress, isSolanaAddress } from '../utils/address.js';

export const seedTokenSchema = z
  .object({
    chain: z.enum(['ethereum', 'base', 'bsc', 'solana']),
    tokenAddress: z.string().min(1),
    label: z.string().min(1).optional(),
    narrative: z.string().min(1).optional(),
    notes: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.chain === 'solana') {
      if (!isSolanaAddress(value.tokenAddress)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tokenAddress'],
          message: 'invalid_solana_address',
        });
      }
      return;
    }

    if (!isEvmAddress(value.tokenAddress)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tokenAddress'],
        message: 'invalid_evm_address',
      });
    }
  });

export const seedTokenBatchSchema = z.array(seedTokenSchema).min(1);

export type SeedTokenInput = z.infer<typeof seedTokenSchema>;
