import { describe, expect, it } from 'vitest';
import { safeJsonStringify, toJsonSafe } from '../src/utils/json.js';

describe('json utils', () => {
  it('converts bigint/date recursively into json-safe values', () => {
    const input = {
      n: 42n,
      when: new Date('2024-01-01T00:00:00.000Z'),
      nested: {
        arr: [1n, null, undefined, { x: 9n }],
      },
      maybe: undefined,
    };

    const safe = toJsonSafe(input) as Record<string, unknown>;

    expect(safe).toEqual({
      n: '42',
      when: '2024-01-01T00:00:00.000Z',
      nested: {
        arr: ['1', null, null, { x: '9' }],
      },
      maybe: null,
    });
  });

  it('produces valid JSON for bigint-bearing payloads', () => {
    const payload = {
      getReservesCallResult: [123n, 456n, 789],
      slot0CallResult: [123n, -1, 2n, 3, true],
    };

    const json = safeJsonStringify(payload, 2);
    expect(() => JSON.parse(json)).not.toThrow();

    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed).toEqual({
      getReservesCallResult: ['123', '456', 789],
      slot0CallResult: ['123', -1, '2', 3, true],
    });
  });
});
