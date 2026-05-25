import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface DedupeState {
  keys: string[];
}

const memorySeen = new Set<string>();

export function buildSignalDedupeKey(input: {
  chain: string;
  tokenAddress: string;
  watchedWallets: string[];
  observedAtMs: number;
  bucketMinutes?: number;
}): string {
  const bucketMinutes = input.bucketMinutes ?? 30;
  const bucket = Math.floor(input.observedAtMs / (bucketMinutes * 60_000));
  const wallets = [...new Set(input.watchedWallets.map((x) => x.toLowerCase()))].sort();
  return `${input.chain}:${input.tokenAddress.toLowerCase()}:${wallets.join('|')}:${bucket}`;
}

export function isDuplicateSignal(key: string): boolean {
  if (memorySeen.has(key)) return true;
  memorySeen.add(key);
  return false;
}

export async function loadDedupeState(filePath: string): Promise<Set<string>> {
  try {
    const text = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(text) as DedupeState;
    return new Set((parsed.keys ?? []).map((x) => x.toLowerCase()));
  } catch {
    return new Set<string>();
  }
}

export async function saveDedupeState(filePath: string, keys: Set<string>): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({ keys: [...keys] } satisfies DedupeState, null, 2), 'utf8');
}
