const EVM_REGEX = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isEvmAddress(value: string): boolean {
  return EVM_REGEX.test(value);
}

export function isSolanaAddress(value: string): boolean {
  return SOLANA_REGEX.test(value);
}
