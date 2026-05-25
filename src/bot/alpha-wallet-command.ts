import { isEvmAddress } from '../utils/address.js';
import { upsertAlphaWalletReviewEntry } from '../discovery/alpha-wallet-review-store.js';

export function parseAlphaWalletCommandInput(text: string): string | undefined {
  const args = text.split(/\s+/).slice(1).filter(Boolean);
  return args[0]?.trim().toLowerCase();
}

export async function handleAlphaWalletEkle(params: { text: string; chatId: string }) {
  const walletAddress = parseAlphaWalletCommandInput(params.text);
  if (!walletAddress) {
    return {
      ok: false as const,
      message: 'Usage: /alpha_wallet_ekle <walletAddress>\nExample: /alpha_wallet_ekle 0xabc...',
    };
  }

  if (!isEvmAddress(walletAddress)) {
    return {
      ok: false as const,
      message: 'Invalid address. Please provide a valid EVM wallet address (0x...).',
    };
  }

  const result = await upsertAlphaWalletReviewEntry({
    chain: 'ethereum',
    walletAddress,
    source: 'telegram_manual',
    addedByChatId: params.chatId,
    notes: 'Added via /alpha_wallet_ekle',
    tags: ['telegram', 'manual'],
    status: 'pending_review',
  });

  if (!result.created) {
    return {
      ok: true as const,
      message: 'Wallet already exists in alpha review/watchlist queue. lastSeenAt updated.',
    };
  }

  return {
    ok: true as const,
    message: [
      'Wallet added to alpha review/watchlist.',
      'It will be monitored if it passes future scoring checks.',
      'Manual review may be required.',
    ].join('\n'),
  };
}
