import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('indexer sync ops wiring', () => {
  it('package scripts expose live and dry-run indexer sync commands', async () => {
    const raw = await readFile('package.json', 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };

    expect(pkg.scripts?.['ops:indexer-sync']).toBe('bash ops/run-indexer-sync.sh');
    expect(pkg.scripts?.['ops:indexer-sync:dry']).toBe('SYNC_DRY_RUN=true bash ops/run-indexer-sync.sh');
  });

  it('ops script contains required safety and import flags', async () => {
    const script = await readFile('ops/run-indexer-sync.sh', 'utf8');

    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('flock -n 9');
    expect(script).toContain('npm run market');
    expect(script).toContain('npm run actors');
    expect(script).toContain('npm run audit:actors');
    expect(script).toContain('npm run export:final');
    expect(script).toContain('--dry-run "$IMPORT_DRY_RUN"');
    expect(script).toContain('--max-add "$MAX_IMPORT_ADD"');
    expect(script).toContain('INDEXER_SYNC_AUTO_PROMOTE_SAFE="${INDEXER_SYNC_AUTO_PROMOTE_SAFE:-false}"');
    expect(script).toContain('--auto-promote-safe "$INDEXER_SYNC_AUTO_PROMOTE_SAFE"');
  });
});
