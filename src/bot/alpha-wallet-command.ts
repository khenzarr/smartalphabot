import { isEvmAddress } from '../utils/address.js';
import { upsertAlphaWalletReviewEntry } from '../discovery/alpha-wallet-review-store.js';

export function parseAlphaWalletCommandInput(text: string): string | undefined {
  const args = text.split(/\s+/).slice(1).filter(Boolean);
  return args[0]?.trim().toLowerCase();
}

export async function submitAlphaWalletAddress(params: { walletAddress: string; chatId: string }) {
  const walletAddress = params.walletAddress.trim().toLowerCase();

  if (!isEvmAddress(walletAddress)) {
    return {
      ok: false as const,
      message: 'Invalid wallet address. Send a valid EVM wallet address (0x...) or /cancel.',
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

export async function handleAlphaWalletEkle(params: { text: string; chatId: string }) {
  const walletAddress = parseAlphaWalletCommandInput(params.text);
  if (!walletAddress) {
    return {
      ok: false as const,
      message: [
        'Send the wallet address you want to add to alpha review.',
        '',
        'Example:',
        '0xabc...',
        '',
        'This does not mean the wallet is confirmed smart money yet. It will be reviewed/scored before monitoring.',
      ].join('\n'),
      needsInput: true as const,
    };
  }

  return submitAlphaWalletAddress({ walletAddress, chatId: params.chatId });
}
