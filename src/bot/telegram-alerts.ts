import { Telegraf } from 'telegraf';
import type { MonitorSignal, MonitorSignalCategory } from '../monitoring/monitoring.types.js';
import { env } from '../config/env.js';
import { buildSignalInlineKeyboard, formatMonitorSignalMessage } from './messages/monitor-signal-message.js';
import { listEnabledTelegramChats, type TelegramChatRecord } from './telegram-chat-state.js';

const CATEGORY_RANK: Record<MonitorSignalCategory, number> = {
  strong_signal: 4,
  watch_signal: 3,
  weak_signal: 2,
  ignored: 1,
};

export function shouldSendSignal(signal: MonitorSignal, minCategory: MonitorSignalCategory, sendWeak: boolean, sendIgnored: boolean): boolean {
  if (signal.category === 'ignored' && !sendIgnored) return false;
  if (signal.category === 'weak_signal' && !sendWeak) return false;
  return CATEGORY_RANK[signal.category] >= CATEGORY_RANK[minCategory];
}

export function filterEligibleSignals(signals: MonitorSignal[], minCategory: MonitorSignalCategory, sendWeak: boolean, sendIgnored: boolean): MonitorSignal[] {
  return signals.filter((s) => shouldSendSignal(s, minCategory, sendWeak, sendIgnored));
}

export async function sendSignalsToChats(input: {
  signals: MonitorSignal[];
  dryRun: boolean;
  chatFilePath?: string;
  botToken?: string;
  sendWeak?: boolean;
  sendIgnored?: boolean;
  minCategory?: MonitorSignalCategory;
  rateLimitMs?: number;
}): Promise<number> {
  const chats = await listEnabledTelegramChats(input.chatFilePath);
  const sendWeak = input.sendWeak ?? env.MONITOR_SEND_WEAK;
  const sendIgnored = input.sendIgnored ?? env.MONITOR_SEND_IGNORED;
  const globalMinCategory = input.minCategory ?? env.MONITOR_SIGNAL_MIN_CATEGORY;
  const eligibleByChat = new Map<TelegramChatRecord, MonitorSignal[]>();

  for (const chat of chats) {
    const minCategory = chat.minCategory ?? globalMinCategory;
    eligibleByChat.set(chat, filterEligibleSignals(input.signals, minCategory, sendWeak, sendIgnored));
  }

  if (input.dryRun) {
    for (const [chat, signals] of eligibleByChat.entries()) {
      for (const signal of signals) {
        console.log(`[TELEGRAM DRY RUN] chat=${chat.chatId}\n${formatMonitorSignalMessage(signal)}\n`);
      }
    }
    return [...eligibleByChat.values()].reduce((acc, v) => acc + v.length, 0);
  }

  const token = (input.botToken ?? env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!token) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN: live Telegram sending requires token');
  }
  const bot = new Telegraf(token);
  const sleepMs = input.rateLimitMs ?? 450;
  let sent = 0;
  for (const [chat, signals] of eligibleByChat.entries()) {
    for (const signal of signals) {
      await bot.telegram.sendMessage(chat.chatId, formatMonitorSignalMessage(signal), {
        reply_markup: buildSignalInlineKeyboard(signal),
      });
      sent += 1;
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  }
  return sent;
}
