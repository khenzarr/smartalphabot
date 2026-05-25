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

  it('MONITOR_DRY_RUN=false resolves to false from env', async () => {
    vi.resetModules();
    process.env.MONITOR_DRY_RUN = 'false';
    const { env } = await import('../src/config/env.js');
    expect(env.MONITOR_DRY_RUN).toBe(false);
  });

  it('MONITOR_DRY_RUN=true resolves to true from env', async () => {
    vi.resetModules();
    process.env.MONITOR_DRY_RUN = 'true';
    const { env } = await import('../src/config/env.js');
    expect(env.MONITOR_DRY_RUN).toBe(true);
  });

  it('false-like env values do not become true', async () => {
    vi.resetModules();
    const { parseBooleanEnvValue } = await import('../src/config/env.js');
    expect(parseBooleanEnvValue('false', true)).toBe(false);
    expect(parseBooleanEnvValue('0', true)).toBe(false);
    expect(parseBooleanEnvValue('no', true)).toBe(false);
    expect(parseBooleanEnvValue('n', true)).toBe(false);
    expect(parseBooleanEnvValue('off', true)).toBe(false);
  });

  it('worker CLI --dry-run true overrides env false', async () => {
    vi.resetModules();
    const { parseBooleanFlagArg } = await import('../src/utils/cli-boolean.js');
    expect(parseBooleanFlagArg(['node', 'worker', '--dry-run', 'true'], 'dry-run', false)).toBe(true);
  });

  it('worker CLI --dry-run false overrides env true', async () => {
    vi.resetModules();
    const { parseBooleanFlagArg } = await import('../src/utils/cli-boolean.js');
    expect(parseBooleanFlagArg(['node', 'worker', '--dry-run', 'false'], 'dry-run', true)).toBe(false);
  });
});
