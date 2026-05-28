#!/usr/bin/env bash
set -euo pipefail

INDEXER_DIR="${INDEXER_DIR:-/root/smart-wallet-indexer}"
SMARTBOT_DIR="${SMARTBOT_DIR:-/root/smartalphabot}"
LOG_DIR="${LOG_DIR:-/root/smartalphabot/logs/indexer-sync}"
LOCK_FILE="${LOCK_FILE:-/tmp/smartbot-indexer-sync.lock}"
SYNC_DRY_RUN="${SYNC_DRY_RUN:-false}"
MAX_IMPORT_ADD="${MAX_IMPORT_ADD:-25}"

mkdir -p "$LOG_DIR"

TS="$(date +"%Y%m%d-%H%M%S")"
LOG_FILE="$LOG_DIR/run-$TS.log"

exec > >(tee -a "$LOG_FILE") 2>&1

echo "[$(date -Is)] smartbot indexer sync started"
echo "INDEXER_DIR=$INDEXER_DIR"
echo "SMARTBOT_DIR=$SMARTBOT_DIR"
echo "SYNC_DRY_RUN=$SYNC_DRY_RUN"
echo "MAX_IMPORT_ADD=$MAX_IMPORT_ADD"

if [[ "$SYNC_DRY_RUN" == "true" ]]; then
  IMPORT_DRY_RUN="true"
else
  IMPORT_DRY_RUN="false"
fi

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[$(date -Is)] another run is already in progress (lock: $LOCK_FILE)"
  exit 1
fi

cd "$INDEXER_DIR"

echo "[$(date -Is)] running smart-wallet-indexer pipeline"
npm run market
npm run actors
npm run audit:actors
npm run export:final

CSV_FILE="$INDEXER_DIR/final-smart-money-list.csv"
if [[ ! -s "$CSV_FILE" ]]; then
  echo "[$(date -Is)] missing or empty export file: $CSV_FILE"
  exit 1
fi

cd "$SMARTBOT_DIR"

echo "[$(date -Is)] importing into SmartAlphaBot alpha review queue"
npm run alpha:import-indexer -- \
  --input "$CSV_FILE" \
  --dry-run "$IMPORT_DRY_RUN" \
  --max-add "$MAX_IMPORT_ADD"

echo "[$(date -Is)] smartbot indexer sync finished"