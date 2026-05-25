import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverSeedTokens, writeSeedDiscoveryOutputs } from '../src/discovery/discover-seed-tokens.js';

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = '0xcccccccccccccccccccccccccccccccccccccccc';

function buildMockClient() {
  return {
    getLatestTokenProfiles: async () => [
      { chainId: 'base', tokenAddress: A },
      { chainId: 'base', tokenAddress: B },
    ],
    getLatestTokenBoosts: async () => [{ chainId: 'base', tokenAddress: A }],
    getTopTokenBoosts: async () => [{ chainId: 'base', tokenAddress: C }],
    getTokenPairsBatch: async (_chain: string, addresses: string[]) =>
      addresses.flatMap((address): Array<Record<string, unknown>> => {
        if (address.toLowerCase() === A.toLowerCase()) {
          return [
            {
              baseToken: { address: A, symbol: 'AAA' },
              pairAddress: '0xpair1',
              dexId: 'uniswap',
              marketCap: 5_000_000,
              liquidity: { usd: 300_000 },
              volume: { h24: 900_000 },
              priceChange: { h24: 12 },
              pairCreatedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
            },
          ];
        }

        if (address.toLowerCase() === B.toLowerCase()) {
          return [
            {
              baseToken: { address: B, symbol: 'BBB' },
              pairAddress: '0xpair2',
              dexId: 'uniswap',
              marketCap: 800_000,
              liquidity: { usd: 90_000 },
              volume: { h24: 50_000 },
              priceChange: { h24: -5 },
              pairCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
            },
          ];
        }

        if (address.toLowerCase() === C.toLowerCase()) {
          return [
            {
              baseToken: { address: C, symbol: 'CCC' },
              pairAddress: '0xpair3',
              dexId: 'pancakeswap',
              fdv: 2_000_000,
              liquidity: { usd: 200_000 },
              volume: { h24: 200_000 },
              priceChange: {},
              pairCreatedAt: Date.now() - 5 * 24 * 60 * 60 * 1000,
            },
          ];
        }

        return [];
      }),
    getTokenPairs: async () => [],
  };
}

describe('discoverSeedTokens', () => {
  it('dedupes same token from multiple sources', async () => {
    const result = await discoverSeedTokens({ chains: ['base'] }, { client: buildMockClient() as never });
    const tokenA = result.candidates.find((x) => x.tokenAddress.toLowerCase() === A.toLowerCase());
    expect(tokenA).toBeDefined();
    expect(tokenA?.source.sort()).toEqual(['latest_boosts', 'latest_profiles']);
  });

  it('ranks higher market/price/liquidity candidates first', async () => {
    const result = await discoverSeedTokens({ chains: ['base'] }, { client: buildMockClient() as never });
    expect(result.candidates[0]?.tokenAddress.toLowerCase()).toBe(A.toLowerCase());
  });

  it('applies filters', async () => {
    const result = await discoverSeedTokens(
      {
        chains: ['base'],
        minMarketCap: 1_000_000,
        minLiquidityUsd: 100_000,
        minPriceChangeH24: 0,
      },
      { client: buildMockClient() as never },
    );

    expect(result.candidates.some((x) => x.tokenAddress.toLowerCase() === B.toLowerCase())).toBe(false);
    expect(result.candidates.every((x) => x.chain === 'base')).toBe(true);
  });

  it('writes seed json in seed-batch compatible shape', async () => {
    const outDir = path.join('output', 'test-discover-seeds');
    await mkdir(outDir, { recursive: true });
    const outPath = path.join(outDir, 'seed-tokens.generated.json');

    const result = await discoverSeedTokens({ chains: ['base'], limit: 2 }, { client: buildMockClient() as never });
    await writeSeedDiscoveryOutputs(result, outPath);

    const raw = await readFile(outPath, 'utf8');
    const data = JSON.parse(raw) as Array<Record<string, unknown>>;
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]).toHaveProperty('chain');
    expect(data[0]).toHaveProperty('tokenAddress');
    expect(data[0]).toHaveProperty('label');
    expect(data[0]).toHaveProperty('narrative');
    expect(data[0]).toHaveProperty('notes');
  });
});
