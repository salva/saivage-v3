import { describe, expect, it, jest } from '@jest/globals';

import { generateCardSegment } from '../../src/cards/card-identity.js';

describe('card identity generation', () => {
  it('encodes one 128-bit random value as one left-padded base-26 segment', () => {
    const random = jest.fn<(size: number) => Uint8Array>(() => new Uint8Array(16));

    expect(generateCardSegment(random)).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(random).toHaveBeenCalledTimes(1);
    expect(random).toHaveBeenCalledWith(16);
  });

  it('encodes the full unsigned 128-bit value deterministically', () => {
    const bytes = new Uint8Array(16).fill(0xff);
    expect(generateCardSegment(() => bytes)).toBe('cdhefomrsrxetmsvhtomcungjkbv');
  });
});
