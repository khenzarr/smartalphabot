# VPS Deployment (Telegram Monitor MVP)

## Telegram Bot Setup

1. Open Telegram.
2. Search `@BotFather`.
3. Run `/newbot`.
4. Choose bot name.
5. Choose bot username.
6. Copy bot token.
7. Put token into `.env` as `TELEGRAM_BOT_TOKEN`.
8. Start bot locally or on VPS.
9. Send `/start` to the bot.

## GitHub Push Reminder

Before VPS sync:

```bash
git status
git add .
git commit -m "Build Telegram monitoring worker MVP"
git push
```

Before push, ensure these are ignored:

```text
.env
.env.local
data/*.local.json
data/monitor-sent-signals.local.json
data/telegram-chats.local.json
output/
node_modules/
```

## Manual Deploy Workflow

Do not implement auto-update yet. Use manual updates:

```bash
git pull
npm install
npm run build
pm2 restart smartbot-telegram
pm2 restart smartbot-worker
pm2 restart smartbot-discovery
```

## VPS Setup

1. SSH into VPS.
2. Install Node.js LTS.
3. Clone repo.
4. Run `npm install`.
5. Create `.env`.
6. Copy or prepare:
   - `data/monitor-wallets.json`
   - `data/monitor-known-tokens.json`
7. Test one-shot worker.
8. Start bot and worker with PM2.

## PM2 Process Layout

```bash
npm install -g pm2
pm2 start npm --name smartbot-telegram -- run bot:start
pm2 start npm --name smartbot-worker -- run worker:monitor
pm2 start npm --name smartbot-discovery -- run worker:discovery
pm2 save
pm2 logs smartbot-telegram
pm2 logs smartbot-worker
pm2 logs smartbot-discovery
```

Discovery worker defaults to dry-run / review-queue mode.
Do not auto-add wallets until scoring quality is trusted in production.

## Update Workflow

```bash
git pull
npm install
npm run build
pm2 restart smartbot-telegram
pm2 restart smartbot-worker
pm2 restart smartbot-discovery
```
