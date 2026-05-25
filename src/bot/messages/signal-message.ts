import { shortAddress } from '../../utils/format.js';

export function formatPlaceholderSignal(chainLabel: string, token: string, caOrMint: string): string {
  return [
    `🟢 SMART BUY SIGNAL — #${chainLabel}`,
    '',
    `🪙 Token: ${token}`,
    `🔗 ${chainLabel.toLowerCase() === 'solana' ? 'Mint' : 'CA'}: ${shortAddress(caOrMint)}`,
    '',
    '⚠️ Placeholder signal skeleton (real-time provider integration pending).',
  ].join('\n');
}
