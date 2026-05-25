export function walletComingSoon(): string {
  return [
    'Coming soon: wallet creation, balances, deposits, withdrawals, private key export.',
    'Security note: wallet features will require encrypted key storage and explicit user confirmation.',
  ].join('\n');
}

export function copytradeComingSoon(): string {
  return [
    'Coming soon: strategy-based copy trading.',
    'Planned strategy controls: max buy size, max market cap, min liquidity, max token age, signal category, wallet confidence, TP/SL, slippage, cooldown, max open positions.',
  ].join('\n');
}

export function positionsComingSoon(): string {
  return 'Coming soon: open positions, PnL, TP/SL state.';
}

export function settingsComingSoon(): string {
  return 'Coming soon: signal thresholds, alert categories, chains, min confidence.';
}
