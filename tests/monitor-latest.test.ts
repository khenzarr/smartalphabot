import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('monitor-latest latest completed run selection', () => {
  it('picks latest completed run by summary mtime', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'monitor-latest-'));
    const outDir = path.join(tmp, 'monitor-worker');
    const runsDir = path.join(outDir, 'runs');
    await mkdir(runsDir, { recursive: true });

    const oldRun = path.join(runsDir, '2026-01-01T00-00-00-000Z');
    const newRun = path.join(runsDir, '2026-01-01T00-10-00-000Z');
    await mkdir(oldRun, { recursive: true });
    await mkdir(newRun, { recursive: true });

    await writeFile(path.join(oldRun, 'monitor-summary.json'), JSON.stringify({ runAt: '2026-01-01T00:00:00.000Z', eventsFound: 1 }, null, 2), 'utf8');
    await writeFile(path.join(newRun, 'monitor-summary.json'), JSON.stringify({ runAt: '2026-01-01T00:10:00.000Z', eventsFound: 2 }, null, 2), 'utf8');

    const { resolveLatestCompletedRun } = await import('../src/cli/monitor-latest.js');
    const latest = await resolveLatestCompletedRun(outDir);

    expect(latest).toBeTruthy();
    expect(latest?.eventsFound).toBe(2);
    expect(String(latest?.runDir)).toContain('2026-01-01T00-10-00-000Z');
  });
});
