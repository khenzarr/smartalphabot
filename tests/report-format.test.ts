import { describe, expect, it } from 'vitest';
import {
  formatAddress,
  formatDateTime,
  formatDuration,
  formatNullable,
  formatNumber,
  formatPercent,
  formatTokenAmount,
  formatUsd,
} from '../src/utils/report-format.js';

describe('report format utils', () => {
  it('formats usd safely', () => {
    expect(formatUsd(1234.56)).toBe('$1,234.56');
    expect(formatUsd(-240.12)).toBe('-$240.12');
    expect(formatUsd(undefined)).toBe('n/a');
  });

  it('formats percent', () => {
    expect(formatPercent(0.425)).toBe('42.50%');
    expect(formatPercent(-0.123)).toBe('-12.30%');
  });

  it('formats numbers and token amounts', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatTokenAmount(1234.567891234)).toBe('1,234.567891');
  });

  it('formats durations by range', () => {
    expect(formatDuration(32)).toBe('32s');
    expect(formatDuration(720)).toBe('12m');
    expect(formatDuration(15660)).toBe('4h 21m');
    expect(formatDuration(266400)).toBe('3d 2h');
  });

  it('formats date and address and nullable', () => {
    expect(formatDateTime('2024-01-01T00:00:00.000Z')).toBe('2024-01-01T00:00:00.000Z');
    expect(formatDateTime('bad-date')).toBe('n/a');
    expect(formatAddress('0x1234567890abcdef1234567890abcdef1234abcd')).toBe('0x1234...abcd');
    expect(formatNullable(null, (x: number) => String(x))).toBe('n/a');
  });
});