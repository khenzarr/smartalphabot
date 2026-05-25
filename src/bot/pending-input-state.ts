import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_PENDING_INPUT_PATH = 'data/telegram-pending-inputs.local.json';
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export type PendingInputType = 'alpha_wallet_address' | 'promote_wallet_address' | 'reject_wallet_address';

export interface TelegramPendingInput {
  chatId: string;
  type: PendingInputType;
  createdAt: string;
  expiresAt: string;
  metadata?: Record<string, unknown>;
}

async function readPendingInputs(filePath = DEFAULT_PENDING_INPUT_PATH): Promise<TelegramPendingInput[]> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as TelegramPendingInput[] : [];
  } catch {
    return [];
  }
}

async function writePendingInputs(inputs: TelegramPendingInput[], filePath = DEFAULT_PENDING_INPUT_PATH) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(inputs, null, 2), 'utf8');
}

export function isExpiredPendingInput(input: TelegramPendingInput): boolean {
  return Date.now() >= new Date(input.expiresAt).getTime();
}

async function readAndPrune(filePath = DEFAULT_PENDING_INPUT_PATH): Promise<TelegramPendingInput[]> {
  const all = await readPendingInputs(filePath);
  const active = all.filter((x) => !isExpiredPendingInput(x));
  if (active.length !== all.length) {
    await writePendingInputs(active, filePath);
  }
  return active;
}

export async function setPendingInput(
  chatId: string,
  type: PendingInputType,
  metadata?: Record<string, unknown>,
  options?: { filePath?: string; ttlMs?: number },
) {
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const next: TelegramPendingInput = { chatId, type, createdAt, expiresAt, metadata };
  const filePath = options?.filePath ?? DEFAULT_PENDING_INPUT_PATH;

  const active = await readAndPrune(filePath);
  const filtered = active.filter((x) => x.chatId !== chatId);
  filtered.push(next);
  await writePendingInputs(filtered, filePath);
  return next;
}

export async function getPendingInput(chatId: string, options?: { filePath?: string }) {
  const filePath = options?.filePath ?? DEFAULT_PENDING_INPUT_PATH;
  const active = await readAndPrune(filePath);
  return active.find((x) => x.chatId === chatId);
}

export async function clearPendingInput(chatId: string, options?: { filePath?: string }) {
  const filePath = options?.filePath ?? DEFAULT_PENDING_INPUT_PATH;
  const active = await readAndPrune(filePath);
  const filtered = active.filter((x) => x.chatId !== chatId);
  if (filtered.length !== active.length) {
    await writePendingInputs(filtered, filePath);
  }
}
