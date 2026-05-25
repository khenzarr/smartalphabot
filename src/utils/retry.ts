export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (ctx: { attempt: number; retries: number; delayMs: number; error: unknown }) => void;
}

export type NormalizedRpcErrorKind = 'too_many_results' | 'rate_limited' | 'transient' | 'unknown';

export interface NormalizedRpcError {
  kind: NormalizedRpcErrorKind;
  suggestedFromBlock?: bigint;
  suggestedToBlock?: bigint;
  rawMessage: string;
}

function defaultShouldRetry(_error: unknown) {
  return true;
}

export function isLikelyRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.toLowerCase();
  return (
    normalized.includes('429') ||
    normalized.includes('rate limit') ||
    normalized.includes('too many requests') ||
    normalized.includes('request limit')
  );
}

export function isLikelyRpcUnstableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.toLowerCase();
  return (
    normalized.includes('timeout') ||
    normalized.includes('network') ||
    normalized.includes('econnreset') ||
    normalized.includes('socket hang up') ||
    normalized.includes('503') ||
    normalized.includes('504')
  );
}

function toRawMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error ?? '');
  }
}

export function normalizeRpcError(error: unknown): NormalizedRpcError {
  const rawMessage = toRawMessage(error);
  const normalized = rawMessage.toLowerCase();

  const tooManyResultsPatterns = [
    'query exceeds max results',
    'response size exceeded',
    'block range is too wide',
    'too many results',
    'log response size exceeded',
  ];

  const rangeMatch = normalized.match(/retry with the range\s+(\d+)-(\d+)/i);
  const suggestedFromBlock = rangeMatch?.[1] ? BigInt(rangeMatch[1]) : undefined;
  const suggestedToBlock = rangeMatch?.[2] ? BigInt(rangeMatch[2]) : undefined;

  if (tooManyResultsPatterns.some((pattern) => normalized.includes(pattern))) {
    return {
      kind: 'too_many_results',
      suggestedFromBlock,
      suggestedToBlock,
      rawMessage,
    };
  }

  if (isLikelyRateLimitError(error)) {
    return {
      kind: 'rate_limited',
      suggestedFromBlock,
      suggestedToBlock,
      rawMessage,
    };
  }

  if (isLikelyRpcUnstableError(error)) {
    return {
      kind: 'transient',
      suggestedFromBlock,
      suggestedToBlock,
      rawMessage,
    };
  }

  return {
    kind: 'unknown',
    suggestedFromBlock,
    suggestedToBlock,
    rawMessage,
  };
}

export async function withRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 300): Promise<T> {
  return withRetryOptions(fn, { retries, baseDelayMs: delayMs });
}

export async function withRetryOptions<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 300;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === retries || !shouldRetry(error)) break;

      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      options.onRetry?.({ attempt: attempt + 1, retries, delayMs: delay, error });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}




