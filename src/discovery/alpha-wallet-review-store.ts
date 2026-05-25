import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';

export type AlphaWalletSource = 'telegram_manual' | 'discovery_worker' | 'imported_shortlist';
export type AlphaWalletStatus = 'pending_review' | 'accepted' | 'rejected' | 'monitoring';

export interface AlphaWalletReviewEntry {
  chain: string;
  walletAddress: string;
  source: AlphaWalletSource;
  addedByChatId?: string;
  addedAt: string;
  lastSeenAt?: string;
  status: AlphaWalletStatus;
  notes?: string;
  score?: number;
  tags: string[];
}

async function readEntries(filePath = env.ALPHA_WALLET_REVIEW_PATH): Promise<AlphaWalletReviewEntry[]> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as AlphaWalletReviewEntry[] : [];
  } catch {
    return [];
  }
}

async function writeEntries(entries: AlphaWalletReviewEntry[], filePath = env.ALPHA_WALLET_REVIEW_PATH) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(entries, null, 2), 'utf8');
}

export async function getAlphaWalletReviewEntries(filePath?: string): Promise<AlphaWalletReviewEntry[]> {
  return readEntries(filePath);
}

export async function upsertAlphaWalletReviewEntry(input: {
  chain: string;
  walletAddress: string;
  source: AlphaWalletSource;
  addedByChatId?: string;
  notes?: string;
  score?: number;
  tags?: string[];
  status?: AlphaWalletStatus;
  filePath?: string;
}) {
  const now = new Date().toISOString();
  const chain = input.chain.toLowerCase();
  const walletAddress = input.walletAddress.toLowerCase();
  const entries = await readEntries(input.filePath);
  const idx = entries.findIndex((x) => x.chain.toLowerCase() === chain && x.walletAddress.toLowerCase() === walletAddress);
  if (idx >= 0) {
    entries[idx] = {
      ...entries[idx],
      lastSeenAt: now,
      notes: input.notes ?? entries[idx]?.notes,
      score: input.score ?? entries[idx]?.score,
      tags: input.tags ?? entries[idx]?.tags ?? [],
    };
    await writeEntries(entries, input.filePath);
    return { entry: entries[idx], created: false };
  }

  const created: AlphaWalletReviewEntry = {
    chain,
    walletAddress,
    source: input.source,
    addedByChatId: input.addedByChatId,
    addedAt: now,
    status: input.status ?? 'pending_review',
    notes: input.notes,
    score: input.score,
    tags: input.tags ?? [],
  };
  entries.push(created);
  await writeEntries(entries, input.filePath);
  return { entry: created, created: true };
}
