import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeSeedFiles, normalizeSeedFile, writeNormalizedSeeds } from '../src/discovery/seed-expansion.js';

describe('seed expansion helpers', () => {
  it('normalizes text input with chain headings, alias chains, invalid warnings, and dedupe', async () => {
    const outDir = 'output/test-seed-normalize-text';
    await mkdir(outDir, { recursive: true });
    const inputPath = path.join(outDir, 'manual-seeds.txt');
    await writeFile(
      inputPath,
      [
        'ethereum:',
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'eth:',
        '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        'base:',
        '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'binance:',
        '0xcccccccccccccccccccccccccccccccccccccccc',
        'base:',
        'not-an-address',
      ].join('\n'),
      'utf8',
    );

    const result = await normalizeSeedFile(inputPath, 'ethereum_meme');
    expect(result.summary.inputCount).toBe(5);
    expect(result.summary.invalidCount).toBe(1);
    expect(result.summary.duplicateCount).toBe(1);
    expect(result.summary.outputCount).toBe(3);
    expect(result.warnings.some((x) => x.includes('invalid_seed_row'))).toBe(true);
    expect(result.seeds.map((x) => x.chain)).toEqual(expect.arrayContaining(['ethereum', 'base', 'bsc']));
    expect(result.seeds.every((x) => x.narrative === 'ethereum_meme')).toBe(true);
    expect(result.seeds[0]?.label).toMatch(/_SEED_\d{3}$/);
  });

  it('normalizes csv input and preserves provided labels', async () => {
    const outDir = 'output/test-seed-normalize-csv';
    await mkdir(outDir, { recursive: true });
    const inputPath = path.join(outDir, 'manual-seeds.csv');
    await writeFile(
      inputPath,
      [
        'chain,tokenAddress,label,narrative,notes',
        'eth,0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,PEPE,memes,top winner',
        'base,0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,,base_meme,',
      ].join('\n'),
      'utf8',
    );

    const result = await normalizeSeedFile(inputPath);
    expect(result.summary.outputCount).toBe(2);
    expect(result.seeds[0]?.label).toBe('PEPE');
    expect(result.seeds[0]?.chain).toBe('ethereum');
    expect(result.seeds[1]?.label).toMatch(/^BASE_SEED_/);

    const outPath = path.join(outDir, 'seed-tokens.expansion.json');
    await writeNormalizedSeeds(outPath, result);
    const written = JSON.parse(await readFile(outPath, 'utf8')) as Array<{ tokenAddress: string }>;
    expect(written).toHaveLength(2);
    expect(written[0]?.tokenAddress).toMatch(/^0x/);
  });

  it('merges base+add with dedupe, preserving existing metadata and sorted output', async () => {
    const outDir = 'output/test-seed-merge';
    await mkdir(outDir, { recursive: true });
    const basePath = path.join(outDir, 'base.json');
    const addPath = path.join(outDir, 'add.json');

    await writeFile(
      basePath,
      JSON.stringify([
        {
          chain: 'base',
          tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          label: 'BASE_KEEP',
          narrative: 'meme',
          notes: 'existing metadata',
        },
      ]),
      'utf8',
    );

    await writeFile(
      addPath,
      JSON.stringify([
        {
          chain: 'base',
          tokenAddress: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          label: 'SHOULD_NOT_OVERRIDE',
          narrative: 'new',
        },
        {
          chain: 'ethereum',
          tokenAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          label: 'ETH_NEW',
          narrative: 'runner',
        },
      ]),
      'utf8',
    );

    const result = await mergeSeedFiles(basePath, addPath);
    expect(result.summary.baseCount).toBe(1);
    expect(result.summary.addCount).toBe(2);
    expect(result.summary.duplicateCount).toBe(1);
    expect(result.summary.finalCount).toBe(2);

    const existing = result.seeds.find((x) => x.tokenAddress === '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(existing?.label).toBe('BASE_KEEP');
    expect(existing?.notes).toBe('existing metadata');

    expect(result.seeds.map((x) => x.chain)).toEqual(['base', 'ethereum']);
  });
});
