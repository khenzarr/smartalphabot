import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runMonitorPoll } from '../cli/monitor-poll.js';
import { env } from '../config/env.js';
import {
  buildMonitorArgsFromEnv,
  parseExplorerProvider,
  parseMonitorActivityProvider,
  runOutputDir,
} from '../monitoring/monitor-runtime.js';
import { parseBooleanFlagArg } from '../utils/cli-boolean.js';
import type { ExplorerProviderMode, MonitorActivityProviderMode } from '../monitoring/monitoring.types.js';

function parseFlag(name: string, fallback = false): boolean {
  return parseBooleanFlagArg(process.argv, name, fallback);
}

function parseNumberFlag(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const raw = process.argv[i + 1];
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseListFlag(name: string, fallback: string[]): string[] {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  return (process.argv[i + 1] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}

function parseStringFlag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const raw = process.argv[i + 1];
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim();
  return normalized ? normalized : undefined;
}

async function writeLatestArtifacts(baseDir: string, runDir: string) {
  const summary = JSON.parse(await readFile(path.join(runDir, 'monitor-summary.json'), 'utf8'));
  const signals = JSON.parse(await readFile(path.join(runDir, 'signals.json'), 'utf8'));
  await mkdir(baseDir, { recursive: true });
  await writeFile(path.join(baseDir, 'latest-summary.json'), JSON.stringify({ ...summary, runDir, runAt: new Date().toISOString() }, null, 2), 'utf8');
  await writeFile(path.join(baseDir, 'latest-signals.json'), JSON.stringify(signals, null, 2), 'utf8');
  return { summary, signals };
}

export async function executeWorkerPoll(options: {
  dryRun?: boolean;
  now?: Date;
  activityProvider?: MonitorActivityProviderMode;
  explorerProvider?: ExplorerProviderMode;
} = {}) {
  const outDir = runOutputDir(env.MONITOR_OUTPUT_DIR, options.now);
  const args = buildMonitorArgsFromEnv({
    outDir,
    dryRun: options.dryRun,
    chains: parseListFlag('chains', env.MONITOR_CHAINS.split(',').map((x) => x.trim()).filter(Boolean)) as never,
    maxWallets: parseNumberFlag('max-wallets', env.MONITOR_MAX_WALLETS),
    ethereumBlocks: parseNumberFlag('ethereum-blocks', env.MONITOR_ETHEREUM_BLOCKS),
    baseBlocks: parseNumberFlag('base-blocks', env.MONITOR_BASE_BLOCKS),
    bscBlocks: parseNumberFlag('bsc-blocks', env.MONITOR_BSC_BLOCKS),
    getLogsMaxBlockRange: parseNumberFlag('getlogs-max-block-range', env.MONITOR_GETLOGS_MAX_BLOCK_RANGE),
    maxGetLogsChunksPerRun: parseNumberFlag('max-getlogs-chunks-per-run', env.MONITOR_MAX_GETLOGS_CHUNKS_PER_RUN),
    maxTxContextLookups: parseNumberFlag('max-tx-context-lookups', env.MONITOR_MAX_TX_CONTEXT_LOOKUPS),
    activityProvider: options.activityProvider,
    explorerProvider: options.explorerProvider,
  });
  await runMonitorPoll(args);
  return writeLatestArtifacts(env.MONITOR_OUTPUT_DIR, outDir);
}

export async function startMonitorWorker() {
  let stopped = false;
  const once = parseFlag('once', false);
  const dryRun = parseFlag('dry-run', env.MONITOR_DRY_RUN);
  const activityProvider = parseMonitorActivityProvider(parseStringFlag('activity-provider'));
  const explorerProvider = parseExplorerProvider(parseStringFlag('explorer-provider'));

  const shutdown = (signal: string) => {
    stopped = true;
    console.log(`[worker] received ${signal}; shutting down gracefully`);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  do {
    const startedAt = new Date();
    console.log(
      `[worker] run started at ${startedAt.toISOString()} provider=${activityProvider ?? env.MONITOR_ACTIVITY_PROVIDER}`,
    );
    const resolved = {
      activityProvider: activityProvider ?? env.MONITOR_ACTIVITY_PROVIDER,
      providerModeRequested: activityProvider ?? env.MONITOR_ACTIVITY_PROVIDER,
      explorerProvider: explorerProvider ?? env.MONITOR_EXPLORER_PROVIDER,
      chains: parseListFlag('chains', env.MONITOR_CHAINS.split(',').map((x) => x.trim()).filter(Boolean)),
      maxWallets: parseNumberFlag('max-wallets', env.MONITOR_MAX_WALLETS),
      ethereumBlocks: parseNumberFlag('ethereum-blocks', env.MONITOR_ETHEREUM_BLOCKS),
      baseBlocks: parseNumberFlag('base-blocks', env.MONITOR_BASE_BLOCKS),
      bscBlocks: parseNumberFlag('bsc-blocks', env.MONITOR_BSC_BLOCKS),
      getLogsMaxBlockRange: parseNumberFlag('getlogs-max-block-range', env.MONITOR_GETLOGS_MAX_BLOCK_RANGE),
      maxTxContextLookups: parseNumberFlag('max-tx-context-lookups', env.MONITOR_MAX_TX_CONTEXT_LOOKUPS),
      intervalSeconds: env.MONITOR_INTERVAL_SECONDS,
      dryRun,
    };
    console.log('[worker] resolved config', resolved);
    try {
      const { summary } = await executeWorkerPoll({
        dryRun,
        activityProvider,
        explorerProvider,
      });
      console.log(`[worker] wallets=${summary.watchedWalletsScanned} events=${summary.eventsFound} signals=${summary.signalsBuilt} alerts=${summary.alertsSent}`);
    } catch (error) {
      const failure = {
        runAt: startedAt.toISOString(),
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      await mkdir(env.MONITOR_OUTPUT_DIR, { recursive: true });
      await writeFile(path.join(env.MONITOR_OUTPUT_DIR, 'latest-summary.json'), JSON.stringify(failure, null, 2), 'utf8');
      console.error('[worker] poll failed', error);
    }

    if (once || stopped) break;
    const nextAt = new Date(Date.now() + env.MONITOR_INTERVAL_SECONDS * 1000);
    console.log(`[worker] next run at ${nextAt.toISOString()}`);
    await new Promise((resolve) => setTimeout(resolve, env.MONITOR_INTERVAL_SECONDS * 1000));
  } while (!stopped);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMonitorWorker().catch((error) => {
    console.error('[worker] fatal', error);
    process.exit(1);
  });
}
