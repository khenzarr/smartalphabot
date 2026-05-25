import { describe, expect, it } from 'vitest';
import {
  addressToTopic,
  numberToRpcQuantityHex,
} from '../src/utils/hex.js';

describe('hex utils', () => {
  it('addressToTopic pads wallet address to exactly 32 bytes', () => {
    const topic = addressToTopic('0x0000000000000000000000000000000000000001');
    expect(topic).toBe('0x0000000000000000000000000000000000000000000000000000000000000001');
    expect(topic.length).toBe(66);
  });

  it('numberToRpcQuantityHex formats zero as 0x0', () => {
    expect(numberToRpcQuantityHex(0)).toBe('0x0');
  });

  it('numberToRpcQuantityHex formats 1 as 0x1', () => {
    expect(numberToRpcQuantityHex(1)).toBe('0x1');
  });

  it('numberToRpcQuantityHex formats 15 as 0xf', () => {
    expect(numberToRpcQuantityHex(15)).toBe('0xf');
  });

  it('numberToRpcQuantityHex formats 16 as 0x10', () => {
    expect(numberToRpcQuantityHex(16)).toBe('0x10');
  });

  it('numberToRpcQuantityHex never emits leading-zero quantity digits', () => {
    expect(numberToRpcQuantityHex(25168229)).toBe('0x1800965');
    expect(numberToRpcQuantityHex(1)).not.toBe('0x01');
  });
});
