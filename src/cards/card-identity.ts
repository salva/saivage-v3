import { randomBytes } from 'node:crypto';

import type { CardSegmentFactory } from '../schemas/card-id.js';

type RandomBytes = (size: number) => Uint8Array;

export function generateCardSegment(random: RandomBytes = randomBytes): ReturnType<CardSegmentFactory> {
  const bytes = random(16);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  const letters = Array<string>(28).fill('a');
  for (let index = letters.length - 1; index >= 0; index -= 1) {
    letters[index] = String.fromCharCode(97 + Number(value % 26n));
    value /= 26n;
  }
  return letters.join('');
}
