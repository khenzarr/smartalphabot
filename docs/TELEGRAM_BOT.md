# Telegram Bot

Framework: Telegraf. Commands scaffolded: /start /signals /wallets /addwallet /removewallet /analyze /checktoken /settings /help.

## Monitoring MVP integration

The monitoring poller supports two Telegram modes:

1. **Dry run** (`--telegram-dry-run true`): formats and prints Telegram messages to console only.
2. **Guarded send** (`--send-telegram true`): sends messages using bot token + chat id.

### Dry run

```bash
npm run monitor:poll -- --watchlist data/monitor-wallets.json --chains ethereum,base --max-wallets 20 --ethereum-blocks 100 --base-blocks 300 --out output/monitor-poll-v1 --telegram-dry-run true
```

With provider mode options:

```bash
npm run monitor:poll -- --watchlist data/monitor-wallets.json --chains ethereum,base --activity-provider auto --known-tokens data/monitor-known-tokens.json --max-wallets 20 --ethereum-blocks 100 --base-blocks 300 --out output/monitor-poll-v1 --telegram-dry-run true
```

Explorer-first generic monitoring example:

```bash
npm run monitor:poll -- --watchlist data/monitor-wallets.json --chains base,ethereum --activity-provider explorer --explorer-provider blockscout --explorer-max-pages 2 --explorer-page-size 50 --max-transfers-per-wallet 100 --max-wallets 20 --out output/monitor-poll-explorer-v1 --telegram-dry-run true --tx-context true --max-tx-context-lookups 50
```

Notes:

- Dry run does **not** require `TELEGRAM_BOT_TOKEN`.
- If addressless RPC logs are rejected by provider policy, poll still writes outputs and summary warnings.
- Blockscout path does not require an API key; optional Etherscan path requires `ETHERSCAN_API_KEY`.

### Send mode (optional)

Requirements:

- `TELEGRAM_BOT_TOKEN` in `.env`
- `--telegram-chat-id <CHAT_ID>` argument

Example:

```bash
npm run monitor:poll -- --watchlist data/monitor-wallets.json --chains ethereum,base --max-wallets 20 --out output/monitor-poll-v1 --send-telegram true --telegram-chat-id <CHAT_ID>
```

Notes:

- Sends only `strong_signal` and `watch_signal` by default.
- Basic rate limiting is applied between messages.
- Missing token/chat id fails fast with clear errors.
- Signal text includes "Manual review required" and does not claim guaranteed buys.

## Known-token compatibility workflow (public RPC)

Build known-token list first:

```bash
npm run monitor:build-known-tokens -- --seed-summary output/seed-batch-auto-keep-wide-v1/token-buyer-summary.csv --out data/monitor-known-tokens.json --only-keep true
```

Then run poll in known-token mode:

```bash
npm run monitor:poll -- --watchlist data/monitor-wallets.json --chains ethereum,base --activity-provider rpc-known-tokens --known-tokens data/monitor-known-tokens.json --max-wallets 20 --ethereum-blocks 100 --base-blocks 300 --out output/monitor-poll-known-tokens-v1 --telegram-dry-run true
```
