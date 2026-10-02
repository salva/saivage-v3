import { randomBytes } from 'node:crypto';
import { sha256Hex } from './sha256.js';
import type { RoundKind } from './round-id.js';

export function generateRoundId(kind: RoundKind): string {
  return `r-${kind}-${randomBytes(16).toString('hex')}`;
}

export function deterministicRoundId(kind: Exclude<RoundKind, 'compacted'>, seed: string): string {
  return `r-${kind}-${sha256Hex(seed).slice(0, 32)}`;
}
