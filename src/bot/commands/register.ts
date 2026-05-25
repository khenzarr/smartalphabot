import type { Telegraf } from 'telegraf';

function placeholder(text: string) {
  return `✅ ${text}\n\nThis is a foundation command placeholder. Provider-backed logic is TODO.`;
}

export function registerCommands(bot: Telegraf) {
  bot.start((ctx) => ctx.reply(placeholder('Welcome to SmartBot.')));
  bot.command('signals', (ctx) => ctx.reply(placeholder('Signals feed endpoint is scaffolded.')));
  bot.command('wallets', (ctx) => ctx.reply(placeholder('Wallet pool listing is scaffolded.')));
  bot.command('addwallet', (ctx) => ctx.reply(placeholder('Add wallet flow is scaffolded.')));
  bot.command('removewallet', (ctx) => ctx.reply(placeholder('Remove wallet flow is scaffolded.')));
  bot.command('analyze', (ctx) => ctx.reply(placeholder('Wallet analysis flow is scaffolded.')));
  bot.command('checktoken', (ctx) => ctx.reply(placeholder('Token analyzer flow is scaffolded.')));
  bot.command('settings', (ctx) => ctx.reply(placeholder('Settings flow is scaffolded.')));
  bot.command('help', (ctx) => ctx.reply(placeholder('Help and command guide.')));
}
