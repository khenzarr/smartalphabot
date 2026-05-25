type JsonSafeValue =
  | string
  | number
  | boolean
  | null
  | JsonSafeValue[]
  | { [key: string]: JsonSafeValue };

export function toJsonSafe<T>(value: T): JsonSafeValue {
  if (value === null) return null;
  if (value === undefined) return null;

  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    return value.map((item) => toJsonSafe(item));
  }

  if (typeof value === 'object') {
    const out: Record<string, JsonSafeValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toJsonSafe(item);
    }
    return out;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  return String(value);
}

export function safeJsonStringify(value: unknown, space?: string | number): string {
  return JSON.stringify(toJsonSafe(value), null, space);
}
