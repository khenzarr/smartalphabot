import { describe, expect, it } from 'vitest';
import { seedTokenBatchSchema } from '../src/discovery/seed-token-input.js';

describe('seedTokenBatchSchema', () => {
  it('accepts valid input', () => {
    const result = seedTokenBatchSchema.safeParse([
      { chain: 'base', tokenAddress: '0x0000000000000000000000000000000000000001', label: 'A', narrative: 'meme', notes: 'x' },
    ]);
    expect(result.success).toBe(true);
  });

  it('rejects unsupported chain address format for evm', () => {
    const result = seedTokenBatchSchema.safeParse([{ chain: 'base', tokenAddress: 'bad' }]);
    expect(result.success).toBe(false);
  });

  it('rejects invalid solana address', () => {
    const result = seedTokenBatchSchema.safeParse([{ chain: 'solana', tokenAddress: 'bad' }]);
    expect(result.success).toBe(false);
  });

  it('rejects missing tokenAddress', () => {
    const result = seedTokenBatchSchema.safeParse([{ chain: 'base' } as never]);
    expect(result.success).toBe(false);
  });
});
