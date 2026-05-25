export interface FormatAddressOptions {
  prefixLength?: number;
  suffixLength?: number;
}

export function formatNullable<T>(
  value: T | null | undefined,
  formatter: (value: T) => string,
): string {
  if (value === null || value === undefined) return 'n/a';
  return formatter(value);
}

export function formatUsd(value: number | null | undefined): string {
  return formatNullable(value, (v) => {
    const sign = v < 0 ? '-' : '';
    const amount = Math.abs(v);
    return `${sign}$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  });
}

export function formatPercent(value: number | null | undefined): string {
  return formatNullable(value, (v) => `${(v * 100).toFixed(2)}%`);
}

export function formatNumber(value: number | null | undefined): string {
  return formatNullable(value, (v) => v.toLocaleString('en-US'));
}

export function formatTokenAmount(value: number | null | undefined): string {
  return formatNullable(value, (v) =>
    v.toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 6,
    }),
  );
}

export function formatDuration(seconds: number | null | undefined): string {
  return formatNullable(seconds, (raw) => {
    const total = Math.max(0, Math.floor(raw));
    if (total < 60) return `${total}s`;

    const days = Math.floor(total / 86_400);
    const hours = Math.floor((total % 86_400) / 3_600);
    const minutes = Math.floor((total % 3_600) / 60);

    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  });
}

export function formatDateTime(value: string | Date | null | undefined): string {
  return formatNullable(value, (v) => {
    const date = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(date.getTime())) return 'n/a';
    return date.toISOString();
  });
}

export function formatAddress(address: string | null | undefined, options?: FormatAddressOptions): string {
  return formatNullable(address, (value) => {
    const prefixLength = options?.prefixLength ?? 6;
    const suffixLength = options?.suffixLength ?? 4;
    const minLength = prefixLength + suffixLength + 3;
    if (value.length <= minLength) return value;
    return `${value.slice(0, prefixLength)}...${value.slice(-suffixLength)}`;
  });
}