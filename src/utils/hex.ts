export function normalizeHex(value: string): `0x${string}` {
  const trimmed = String(value ?? '').trim().toLowerCase();
  const withoutPrefix = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
  return `0x${withoutPrefix}`;
}

export function normalizeDataHex(value: string): `0x${string}` {
  const normalized = normalizeHex(value);
  const body = normalized.slice(2);
  if (body.length === 0) return '0x00';
  return `0x${body.length % 2 === 0 ? body : `0${body}`}`;
}

export function normalizeRpcQuantityHex(value: string): `0x${string}` {
  const normalized = normalizeHex(value);
  const body = normalized.slice(2);
  if (!/^[0-9a-f]+$/i.test(body)) throw new Error('invalid_rpc_quantity_hex');
  const trimmedBody = body.replace(/^0+/, '');
  return trimmedBody.length === 0 ? '0x0' : `0x${trimmedBody}`;
}

export function numberToRpcQuantityHex(value: bigint | number): `0x${string}` {
  const asBigInt = typeof value === 'bigint' ? value : BigInt(value);
  if (asBigInt < 0n) throw new Error('rpc_quantity_must_be_non_negative');
  return normalizeRpcQuantityHex(`0x${asBigInt.toString(16)}`);
}

export function isValidRpcQuantityHex(value: string): boolean {
  return /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(String(value ?? ''));
}

export function addressToTopic(address: string): `0x${string}` {
  const normalized = normalizeHex(address);
  const body = normalized.slice(2);
  if (!/^[0-9a-f]{40}$/i.test(body)) throw new Error('invalid_evm_address_for_topic');
  return `0x${body.padStart(64, '0')}`;
}

export function isValidTopic(value: string): boolean {
  return /^0x[0-9a-f]{64}$/i.test(String(value ?? ''));
}
