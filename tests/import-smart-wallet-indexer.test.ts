import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

async function setupTemp() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'indexer-import-'));
  const alphaPath = path.join(tmp, 'alpha-wallet-review.local.json');
  const monitorPath = path.join(tmp, 'monitor-wallets.json');
  await writeFile(alphaPath, '[]', 'utf8');
  await writeFile(monitorPath, '[]', 'utf8');
  return { tmp, alphaPath, monitorPath };
}

function csv(rows: string[]): string {
  return [
    'walletAddress,chain,actorCategory,actorType,rankTier,auditTier,auditScore,originalScore,uniqueTokenCount,avgEarlyIndex,bestEarlyIndex,tokenSymbols,riskLabel,reviewStatus,recommendedAction,examples',
    ...rows,
  ].join('\n');
}

describe('import-smart-wallet-indexer', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('dry-run does not mutate queue', async () => {
    const { tmp, alphaPath, monitorPath } = await setupTemp();
    const input = path.join(tmp, 'final-smart-money-list.csv');
    await writeFile(input, csv([
      '0xf5c4f3dc02c3fb9279495a8fef7b0741da956157,base,EOA_SMART_MONEY,EOA,TIER_2,TIER_2,81,80,3,13,4,DOTA|EVE|PEPE,,OBSERVE_ONLY,Observe only; do not use as direct signal.,sample',
    ]), 'utf8');

    process.env.ALPHA_WALLET_REVIEW_PATH = alphaPath;
    process.env.MONITOR_WATCHLIST_PATH = monitorPath;

    const { runIndexerImport } = await import('../src/cli/import-smart-wallet-indexer.js');
    const result = await runIndexerImport({ input, dryRun: true, maxAdd: 25, includeContractReview: false, autoPromoteSafe: false });

    expect(result.wouldAdd).toBe(1);
    expect(result.added).toBe(0);
    expect(result.safePromoted).toBe(0);
    const after = JSON.parse(await readFile(alphaPath, 'utf8')) as unknown[];
    expect(after).toHaveLength(0);
  });

  it('live mode imports OBSERVE_ONLY EOA as watch_candidate', async () => {
    const { tmp, alphaPath, monitorPath } = await setupTemp();
    const input = path.join(tmp, 'final-smart-money-list.csv');
    await writeFile(input, csv([
      '0xf5c4f3dc02c3fb9279495a8fef7b0741da956157,base,EOA_SMART_MONEY,EOA,TIER_2,TIER_2,81,80,3,13,4,DOTA|EVE|PEPE,,OBSERVE_ONLY,Observe only; do not use as direct signal.,sample',
    ]), 'utf8');

    process.env.ALPHA_WALLET_REVIEW_PATH = alphaPath;
    process.env.MONITOR_WATCHLIST_PATH = monitorPath;

    const { runIndexerImport } = await import('../src/cli/import-smart-wallet-indexer.js');
    const result = await runIndexerImport({ input, dryRun: false, maxAdd: 25, includeContractReview: false, autoPromoteSafe: true });

    expect(result.added).toBe(1);
    const after = JSON.parse(await readFile(alphaPath, 'utf8')) as Array<Record<string, unknown>>;
    expect(after).toHaveLength(1);
    expect(after[0]?.category).toBe('watch_candidate');
    expect(after[0]?.status).toBe('pending_review');
    expect(after[0]?.tags).toContain('observe_only');
    const monitorAfter = JSON.parse(await readFile(monitorPath, 'utf8')) as Array<Record<string, unknown>>;
    expect(monitorAfter).toHaveLength(0);
    expect(result.safePromoted).toBe(0);
  });

  it('contract review rows are skipped by default and imported when enabled', async () => {
    const { tmp, alphaPath, monitorPath } = await setupTemp();
    const input = path.join(tmp, 'final-smart-money-list.csv');
    await writeFile(input, csv([
      '0x1111111111111111111111111111111111111111,base,SMART_CONTRACT,CONTRACT,TIER_2,TIER_3,45,40,2,20,12,TKN,high_risk,NEEDS_CONTRACT_MANUAL_REVIEW,manual review needed,sample',
    ]), 'utf8');

    process.env.ALPHA_WALLET_REVIEW_PATH = alphaPath;
    process.env.MONITOR_WATCHLIST_PATH = monitorPath;

    const { runIndexerImport } = await import('../src/cli/import-smart-wallet-indexer.js');

    const skipped = await runIndexerImport({ input, dryRun: false, maxAdd: 25, includeContractReview: false, autoPromoteSafe: true });
    expect(skipped.skippedContractReview).toBe(1);
    expect(skipped.added).toBe(0);

    const imported = await runIndexerImport({ input, dryRun: false, maxAdd: 25, includeContractReview: true, autoPromoteSafe: true });
    expect(imported.added).toBe(1);
    expect(imported.safePromoted).toBe(0);
    const after = JSON.parse(await readFile(alphaPath, 'utf8')) as Array<Record<string, unknown>>;
    expect(after[0]?.category).toBe('needs_review');
    expect(after[0]?.tags).toContain('contract_review');
  });

  it('infra/proxy/router skipped and dedupe against review + monitor works', async () => {
    const { tmp, alphaPath, monitorPath } = await setupTemp();
    const input = path.join(tmp, 'final-smart-money-list.csv');
    await writeFile(input, csv([
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,base,INFRA_CONTRACT,CONTRACT,TIER_2,TIER_3,50,40,2,15,8,TKN,,WATCHLIST_CANDIDATE,router behavior,sample',
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,base,EOA_SMART_MONEY,EOA,TIER_2,TIER_2,75,70,4,10,2,TKN,,WATCHLIST_CANDIDATE,ok,sample',
      '0xcccccccccccccccccccccccccccccccccccccccc,base,EOA_SMART_MONEY,EOA,TIER_2,TIER_2,77,72,4,9,2,TKN,,WATCHLIST_CANDIDATE,ok,sample',
    ]), 'utf8');

    await writeFile(alphaPath, JSON.stringify([
      { chain: 'base', walletAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', source: 'telegram_manual', addedAt: new Date().toISOString(), status: 'pending_review', tags: [] },
    ], null, 2), 'utf8');
    await writeFile(monitorPath, JSON.stringify([
      { chain: 'base', walletAddress: '0xcccccccccccccccccccccccccccccccccccccccc' },
    ], null, 2), 'utf8');

    process.env.ALPHA_WALLET_REVIEW_PATH = alphaPath;
    process.env.MONITOR_WATCHLIST_PATH = monitorPath;

    const { runIndexerImport } = await import('../src/cli/import-smart-wallet-indexer.js');
    const result = await runIndexerImport({ input, dryRun: false, maxAdd: 25, includeContractReview: false, autoPromoteSafe: true });

    expect(result.skippedInfra).toBe(1);
    expect(result.skippedAlreadyReviewed).toBe(1);
    expect(result.skippedAlreadyMonitored).toBe(1);
    expect(result.wouldAdd).toBe(0);
    expect(result.added).toBe(0);
  });

  it('clean READY_FOR_WATCHLIST EOA auto-promotes when flag true', async () => {
    const { tmp, alphaPath, monitorPath } = await setupTemp();
    const input = path.join(tmp, 'final-smart-money-list.csv');
    await writeFile(input, csv([
      '0x1234567890123456789012345678901234567890,base,EOA_SMART_MONEY,EOA,TIER_2,TIER_2,85,84,3,25,10,TKN|AAA|BBB,LOW_RISK,READY_FOR_WATCHLIST,Monitor,sample',
    ]), 'utf8');

    process.env.ALPHA_WALLET_REVIEW_PATH = alphaPath;
    process.env.MONITOR_WATCHLIST_PATH = monitorPath;

    const { runIndexerImport } = await import('../src/cli/import-smart-wallet-indexer.js');
    const result = await runIndexerImport({ input, dryRun: false, maxAdd: 25, includeContractReview: false, autoPromoteSafe: true });

    expect(result.safePromoteEligible).toBe(1);
    expect(result.safePromoted).toBe(1);
    const monitorAfter = JSON.parse(await readFile(monitorPath, 'utf8')) as Array<Record<string, unknown>>;
    expect(monitorAfter).toHaveLength(1);
    expect(monitorAfter[0]?.walletAddress).toBe('0x1234567890123456789012345678901234567890');
  });

  it('clean WATCHLIST_CANDIDATE EOA auto-promotes when flag true', async () => {
    const { tmp, alphaPath, monitorPath } = await setupTemp();
    const input = path.join(tmp, 'final-smart-money-list.csv');
    await writeFile(input, csv([
      '0x9999999999999999999999999999999999999999,base,EOA_SMART_MONEY,EOA,TIER_2,TIER_2,80,79,4,40,20,TKN|AAA|BBB,,WATCHLIST_CANDIDATE,Monitor,sample',
    ]), 'utf8');

    process.env.ALPHA_WALLET_REVIEW_PATH = alphaPath;
    process.env.MONITOR_WATCHLIST_PATH = monitorPath;

    const { runIndexerImport } = await import('../src/cli/import-smart-wallet-indexer.js');
    const result = await runIndexerImport({ input, dryRun: false, maxAdd: 25, includeContractReview: false, autoPromoteSafe: true });

    expect(result.safePromoteEligible).toBe(1);
    expect(result.safePromoted).toBe(1);
  });

  it('HIGH_RISK_OBSERVE_ONLY is not auto-promoted and is counted as risk skip', async () => {
    const { tmp, alphaPath, monitorPath } = await setupTemp();
    const input = path.join(tmp, 'final-smart-money-list.csv');
    await writeFile(input, csv([
      '0x7777777777777777777777777777777777777777,base,EOA_SMART_MONEY,EOA,TIER_2,TIER_2,60,59,3,30,20,TKN|AAA|BBB,HIGH_RISK_OBSERVE_ONLY,OBSERVE_ONLY,Observe only,sample',
    ]), 'utf8');

    process.env.ALPHA_WALLET_REVIEW_PATH = alphaPath;
    process.env.MONITOR_WATCHLIST_PATH = monitorPath;

    const { runIndexerImport } = await import('../src/cli/import-smart-wallet-indexer.js');
    const result = await runIndexerImport({ input, dryRun: false, maxAdd: 25, includeContractReview: false, autoPromoteSafe: true });

    expect(result.safePromoted).toBe(0);
    expect(result.safePromoteSkippedRisk).toBe(1);
  });

  it('already monitored clean candidate is skipped in safe auto-promote summary', async () => {
    const { tmp, alphaPath, monitorPath } = await setupTemp();
    const input = path.join(tmp, 'final-smart-money-list.csv');
    await writeFile(input, csv([
      '0x5555555555555555555555555555555555555555,base,EOA_SMART_MONEY,EOA,TIER_2,TIER_2,90,89,5,20,10,TKN|AAA|BBB,LOW_RISK,READY_FOR_WATCHLIST,Monitor,sample',
    ]), 'utf8');

    await writeFile(monitorPath, JSON.stringify([
      { chain: 'base', walletAddress: '0x5555555555555555555555555555555555555555' },
    ], null, 2), 'utf8');

    process.env.ALPHA_WALLET_REVIEW_PATH = alphaPath;
    process.env.MONITOR_WATCHLIST_PATH = monitorPath;

    const { runIndexerImport } = await import('../src/cli/import-smart-wallet-indexer.js');
    const result = await runIndexerImport({ input, dryRun: false, maxAdd: 25, includeContractReview: false, autoPromoteSafe: true });

    expect(result.safePromoteEligible).toBe(0);
    expect(result.safePromoteSkippedAlreadyMonitored).toBe(0);
    expect(result.skippedAlreadyMonitored).toBe(1);
  });
});
