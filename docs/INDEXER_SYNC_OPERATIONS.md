# Indexer Sync Operations

## What this sync does

`ops/run-indexer-sync.sh` runs the external `smart-wallet-indexer` pipeline, validates that `final-smart-money-list.csv` was produced, then imports eligible wallets into SmartAlphaBot's **alpha review queue** through:

```bash
npm run alpha:import-indexer -- --input <csv> --dry-run <true|false> --max-add <n>
```

Pipeline steps executed in `/root/smart-wallet-indexer`:

1. `npm run market`
2. `npm run actors`
3. `npm run audit:actors`
4. `npm run export:final`

## Safety boundaries

- Imports into **review queue only** (`alpha-wallet-review` store).
- Does **not** auto-promote wallets to `monitor-wallets`.
- Does **not** change monitor alert policy.
- Does **not** execute trading logic or private-key behavior.

## Manual run

```bash
cd /root/smartalphabot
npm run ops:indexer-sync
```

## Dry-run

Dry-run still runs indexer pipeline, but import is forced to `--dry-run true`:

```bash
cd /root/smartalphabot
npm run ops:indexer-sync:dry
```

## PM2 setup (recommended)

```bash
pm2 start "bash ops/run-indexer-sync.sh" \
  --name smartbot-indexer-sync \
  --cron "0 */12 * * *" \
  --no-autorestart
```

## Cron alternative

Example: run every 12 hours.

```bash
0 */12 * * * cd /root/smartalphabot && /usr/bin/bash ops/run-indexer-sync.sh >> /root/smartalphabot/logs/indexer-sync/cron.log 2>&1
```

## Log location

- Directory: `/root/smartalphabot/logs/indexer-sync`
- Per-run log file pattern: `run-YYYYMMDD-HHMMSS.log`

## Configuration knobs

Optional environment variables:

- `INDEXER_DIR` (default: `/root/smart-wallet-indexer`)
- `SMARTBOT_DIR` (default: `/root/smartalphabot`)
- `LOG_DIR` (default: `/root/smartalphabot/logs/indexer-sync`)
- `LOCK_FILE` (default: `/tmp/smartbot-indexer-sync.lock`)
- `SYNC_DRY_RUN` (default: `false`)
- `MAX_IMPORT_ADD` (default: `25`)

## Rollback / disable

- Disable PM2 job:

```bash
pm2 stop smartbot-indexer-sync
pm2 delete smartbot-indexer-sync
pm2 save
```

- If using cron, remove the cron entry:

```bash
crontab -e
```

Then delete the `smartbot-indexer-sync` line and save.
