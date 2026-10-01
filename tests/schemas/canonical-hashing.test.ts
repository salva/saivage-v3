import { createHash } from 'node:crypto';
import { describe, expect, it, jest } from '@jest/globals';
import { canonicalJson, canonicalValueSha256, sha256Hex } from '../../src/schemas/index.js';

const nodeHash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

describe('canonical JSON and synchronous byte SHA-256', () => {
  it('orders recursive object keys by code units, preserving arrays and ordinary integer enumeration', () => {
    const value = { é: 1, a: [{ é: 2, _: 3, A: 4 }], _: 5, A: 6, '10': 7, '2': 8, '01': 9, Å: 10 };
    const expected = '{"2":8,"10":7,"01":9,"A":6,"_":5,"a":[{"A":4,"_":3,"é":2}],"Å":10,"é":1}';
    const collation = jest.spyOn(String.prototype, 'localeCompare').mockImplementation(() => { throw new Error('locale collation is unavailable'); });
    try {
      expect(canonicalJson(value)).toBe(expected);
      expect(canonicalJson(Object.fromEntries(Object.entries(value).reverse()))).toBe(expected);
      expect(canonicalValueSha256(value)).toBe(nodeHash(expected));
      expect(canonicalJson([value, null, true, 'é'])).toBe(`[${expected},null,true,"é"]`);
      expect(canonicalJson({ absent: undefined, numeric: Infinity, array: [undefined, NaN] })).toBe('{"array":[null,null],"numeric":null}');
      expect(canonicalJson({ 'é': 1, 'e\u0301': 2 })).toBe('{"é":2,"é":1}');
    } finally { collation.mockRestore(); }
  });

  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ])('matches the known vector for %j', (input, expected) => {
    expect(sha256Hex(input)).toBe(expected);
    expect(sha256Hex(new TextEncoder().encode(input))).toBe(expected);
  });

  it('hashes UTF-8 strings and arbitrary byte views without changing the input', () => {
    for (const input of ['é☃😀', '\ud800', 'a'.repeat(1_000_000)]) expect(sha256Hex(input)).toBe(nodeHash(input));
    const allBytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    for (const input of [allBytes, allBytes.subarray(3, 255), new Uint8Array(), new Uint8Array([0xff, 0xfe, 0x80, 0])]) {
      const before = input.slice();
      expect(sha256Hex(input)).toBe(nodeHash(input));
      expect(input).toEqual(before);
    }
  });
});
