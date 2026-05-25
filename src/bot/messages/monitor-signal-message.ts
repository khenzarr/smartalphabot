import type { MonitorSignal } from '../../monitoring/monitoring.types.js';
import { env } from '../../config/env.js';

function fmtUsd(v?: number): string {
  if (v === undefined || Number.isNaN(v)) return 'n/a';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  return `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function fmtAge(seconds?: number): string {
  if (seconds === undefined || Number.isNaN(seconds)) return 'n/a';
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return `${d}d ${h}h`;
}

function fmtPrice(v?: number): string {
  if (v === undefined || Number.isNaN(v)) return 'n/a';
  if (v === 0) return '$0';
  return `$${v.toLocaleString('en-US', { maximumFractionDigits: v < 0.01 ? 8 : 6 })}`;
}

function chainTag(chain: string): string {
  const m: Record<string, string> = {
    ethereum: '#Ethereum',
    base: '#Base',
    bsc: '#BSC',
    solana: '#Solana',
  };
  return m[chain] ?? `#${chain}`;
}

export function formatSignalTitle(signal: MonitorSignal): string {
  if (signal.category === 'strong_signal' && signal.likelyActivityType === 'likely_buy') return '🟢 BUY SIGNAL 🔁 UPDATE';
  if (signal.category === 'watch_signal') return '🟡 WATCH SIGNAL';
  if (signal.category === 'weak_signal' && (signal.totalAmountNative ?? 0) >= 5) return '🐋 HIGH ACTIVITY';
  if (signal.category === 'ignored') return '⚪ IGNORED';
  return signal.category === 'weak_signal' ? '🐋 HIGH ACTIVITY' : '🟢 BUY SIGNAL';
}

function riskSubtitle(signal: MonitorSignal): string {
  if ((signal.riskFlags ?? []).some((x) => x.includes('holder'))) return '🟡 RISKY TOKEN — evaluate carefully';
  if (signal.likelyActivityType === 'airdrop_or_claim') return '⚠️ Airdrop/claim-like activity';
  if (signal.watchedWalletCount <= 1) return '⚠️ Single-wallet activity';
  if (signal.likelyActivityType === 'unknown') return '⚠️ Unknown transaction context';
  return '⚠️ Manual review required. Not financial advice.';
}

function value<T>(v: T | undefined, fallback = 'n/a'): T | string {
  return v === undefined || v === null || v === '' ? fallback : v;
}

export function formatMonitorSignalMessage(signal: MonitorSignal): string {
  const reasons = signal.reasons.slice(0, 2).join(', ') || 'n/a';
  const headline = `${formatSignalTitle(signal)} ${chainTag(signal.chain)}`;
  const activityLine = signal.category === 'weak_signal'
    ? `🐋 Big-money buy detected — ${value(signal.totalAmountNative?.toFixed(2), 'n/a')} ETH in last 15m`
    : `👥 ${signal.watchedWalletCount} smart wallets bought this token — total ${value(signal.totalAmountNative?.toFixed(4), 'n/a')} ETH`;
  return [
    headline,
    '━━━━━━━━━━━━━━━━━━━━',
    riskSubtitle(signal),
    '',
    `👥 Smart Wallets: ${value(signal.smartWalletCount ?? signal.watchedWalletCount)}`,
    `💎 Token: ${value(signal.tokenName ?? signal.name ?? signal.tokenSymbol ?? signal.symbol ?? 'n/a')}`,
    `💰 MCAP: ${fmtUsd(signal.marketCapUsd ?? signal.marketCap)}`,
    `💧 Liquidity: ${fmtUsd(signal.liquidityUsd)}`,
    `⏳ Age: ${fmtAge(signal.tokenAge ?? signal.tokenAgeSeconds)}`,
    `💵 Price: ${fmtPrice(signal.priceUsd)}`,
    `🪙 Total: ${value(signal.totalAmountNative?.toFixed(4), 'n/a')} ETH`,
    `🔗 CA: ${value(signal.tokenAddress)}`,
    '',
    activityLine,
    `🧠 Reason: ${reasons}`,
    '⚠️ Manual review required. Not financial advice.',
  ].join('\n');
}

export function buildSignalInlineKeyboard(signal: MonitorSignal) {
  const linkRow: Array<{ text: string; url: string }> = [];
  const chartUrl = signal.dexScreenerUrl ?? signal.dexUrl;
  if (chartUrl) linkRow.push({ text: '📊 Chart', url: chartUrl });
  if (signal.explorerUrl) linkRow.push({ text: '🔍 Explorer', url: signal.explorerUrl });
  if (signal.xSearchUrl) linkRow.push({ text: '𝕏 Search', url: signal.xSearchUrl });

  const rows: Array<Array<{ text: string; url: string } | { text: string; callback_data: string }>> = [];
  if (linkRow.length) rows.push(linkRow);

  if (env.TELEGRAM_SHOW_TRADE_PLACEHOLDER_BUTTONS) {
    rows.push([
      { text: '🦅 0.005', callback_data: 'trade_placeholder_0.005' },
      { text: '🦅 0.01', callback_data: 'trade_placeholder_0.01' },
      { text: '🦅 0.02', callback_data: 'trade_placeholder_0.02' },
      { text: '🦅 0.05', callback_data: 'trade_placeholder_0.05' },
    ]);
  }
  return { inline_keyboard: rows };
}
