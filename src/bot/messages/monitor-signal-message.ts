import type { MonitorSignal } from '../../monitoring/monitoring.types.js';
import { shortAddress } from '../../utils/format.js';

function fmtNum(v?: number): string {
  if (v === undefined || Number.isNaN(v)) return 'n/a';
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function formatMonitorSignalMessage(signal: MonitorSignal): string {
  const wallets = signal.watchedWallets.slice(0, 6).map((w) => `• ${shortAddress(w)}`).join('\n');
  const reasons = signal.reasons.slice(0, 5).join(', ');
  const header = signal.likelyActivityType === 'mixed_activity'
    ? `📡 ${signal.category.toUpperCase()} — Mixed watched-wallet token activity`
    : `📡 ${signal.category.toUpperCase()} — watched wallet token activity`;
  const manualReviewLine = signal.likelyActivityType === 'mixed_activity'
    ? 'Manual review required. Some txs look like likely buys, but others look like transfers/claims.'
    : 'Manual review required. This is likely watched wallet activity and not guaranteed buy confirmation.';
  return [
    header,
    '',
    `🪙 Token: ${signal.symbol ?? 'Unknown'} ${signal.name ? `(${signal.name})` : ''}`,
    `⛓️ Chain: ${signal.chain}`,
    `📄 Contract: ${signal.tokenAddress}`,
    `💰 Market Cap: ${fmtNum(signal.marketCap)}`,
    `💧 Liquidity: ${fmtNum(signal.liquidityUsd)}`,
    `⏱️ Token Age (sec): ${fmtNum(signal.tokenAgeSeconds)}`,
    `🧭 Activity: ${signal.likelyActivityType.replaceAll('_', ' ')} (${signal.confidence} confidence)`,
    `🛣️ Router Evidence: ${signal.knownRouterSeen ? 'seen' : 'not seen'}`,
    `👀 Watched Wallet Count: ${signal.watchedWalletCount}`,
    `🔁 Tx Count: ${signal.txCount} (unique: ${signal.uniqueTxCount})`,
    signal.dexUrl ? `🔎 DexScreener: ${signal.dexUrl}` : '🔎 DexScreener: n/a',
    `🧠 Reasons: ${reasons || 'n/a'}`,
    '',
    'Watched wallets:',
    wallets || '• n/a',
    '',
    signal.warnings.length ? `⚠️ Warnings: ${signal.warnings.join(', ')}` : '⚠️ Warnings: none',
    manualReviewLine,
  ].join('\n');
}
