import { describe, expect, it } from 'vitest';
import { escapeCsvCell, toCsv } from '../src/utils/csv.js';

describe('csv utils', () => {
  it('escapes commas', () => {
    expect(escapeCsvCell('a,b')).toBe('"a,b"');
  });

  it('escapes quotes', () => {
    expect(escapeCsvCell('a"b')).toBe('"a""b"');
  });

  it('handles empty fields', () => {
    expect(escapeCsvCell(undefined)).toBe('');
    expect(escapeCsvCell(null)).toBe('');
  });

  it('serializes arrays with pipe separator', () => {
    expect(escapeCsvCell(['a', 'b'])).toBe('a|b');
  });

  it('renders csv table', () => {
    const csv = toCsv([{ a: 'x', b: 'y' }], ['a', 'b']);
    expect(csv).toContain('a,b');
    expect(csv).toContain('x,y');
  });
});
