import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';

export type TelegramSignalCategory = 'strong_signal' | 'watch_signal' | 'weak_signal' | 'ignored';

export interface TelegramChatRecord {
  chatId: string;
  username?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  enabled: boolean;
  minCategory: TelegramSignalCategory;
  notes?: string;
}

const CHAT_FILE = 'data/telegram-chats.local.json';

export async function loadTelegramChats(filePath = CHAT_FILE): Promise<TelegramChatRecord[]> {
  let rows: TelegramChatRecord[] = [];
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as TelegramChatRecord[];
    rows = Array.isArray(parsed) ? parsed : [];
  } catch {
    rows = [];
  }

  const defaultChatId = (env.TELEGRAM_DEFAULT_CHAT_ID ?? '').trim();
  if (defaultChatId && !rows.some((x) => x.chatId === defaultChatId)) {
    const now = new Date().toISOString();
    rows.push({
      chatId: defaultChatId,
      firstSeenAt: now,
      lastSeenAt: now,
      enabled: true,
      minCategory: 'watch_signal',
      notes: 'Added from TELEGRAM_DEFAULT_CHAT_ID',
    });
  }
  return rows;
}

export async function saveTelegramChats(chats: TelegramChatRecord[], filePath = CHAT_FILE): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(chats, null, 2), 'utf8');
}

export async function addOrUpdateTelegramChat(input: {
  chatId: string;
  username?: string;
  enabled?: boolean;
  minCategory?: TelegramSignalCategory;
  notes?: string;
}, filePath = CHAT_FILE): Promise<TelegramChatRecord[]> {
  const now = new Date().toISOString();
  const chats = await loadTelegramChats(filePath);
  const existing = chats.find((x) => x.chatId === input.chatId);
  if (existing) {
    existing.username = input.username ?? existing.username;
    existing.lastSeenAt = now;
    existing.enabled = input.enabled ?? existing.enabled;
    existing.minCategory = input.minCategory ?? existing.minCategory;
    existing.notes = input.notes ?? existing.notes;
  } else {
    chats.push({
      chatId: input.chatId,
      username: input.username,
      firstSeenAt: now,
      lastSeenAt: now,
      enabled: input.enabled ?? true,
      minCategory: input.minCategory ?? 'watch_signal',
      notes: input.notes,
    });
  }
  await saveTelegramChats(chats, filePath);
  return chats;
}

export async function listEnabledTelegramChats(filePath = CHAT_FILE): Promise<TelegramChatRecord[]> {
  const chats = await loadTelegramChats(filePath);
  return chats.filter((x) => x.enabled);
}
