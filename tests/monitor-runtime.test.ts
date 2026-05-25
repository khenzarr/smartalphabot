import { describe, expect, it, vi } from 'vitest';

describe('monitor runtime wiring', () => {
  it('buildMonitorArgsFromEnv includes getLogsMaxBlockRange from env', async () => {
    vi.resetModules();
    process.env.MONITOR_GETLOGS_MAX_BLOCK_RANGE = '10';
    const { buildMonitorArgsFromEnv } = await import('../src/monitoring/monitor-runtime.js');
    const args = buildMonitorArgsFromEnv({ dryRun: true });
    expect(args.getLogsMaxBlockRange).toBe(10);
  });

  it('buildMonitorArgsFromEnv applies explicit overrides', async () => {
    vi.resetModules();
    const { buildMonitorArgsFromEnv } = await import('../src/monitoring/monitor-runtime.js');
    const args = buildMonitorArgsFromEnv({
      dryRun: true,
      ethereumBlocks: 100,
      baseBlocks: 300,
      bscBlocks: 400,
      maxWallets: 7,
      getLogsMaxBlockRange: 11,
      maxGetLogsChunksPerRun: 999,
      maxTxContextLookups: 5,
    });
    expect(args.ethereumBlocks).toBe(100);
    expect(args.baseBlocks).toBe(300);
    expect(args.bscBlocks).toBe(400);
    expect(args.maxWallets).toBe(7);
    expect(args.getLogsMaxBlockRange).toBe(11);
    expect(args.maxGetLogsChunksPerRun).toBe(999);
    expect(args.maxTxContextLookups).toBe(5);
  });
});
