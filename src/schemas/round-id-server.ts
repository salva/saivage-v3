import { createHash, randomBytes } from 'node:crypto';
import type { RoundKind } from './round-id.js';

export function generateRoundId(kind: RoundKind): string {
  return `r-${kind}-${randomBytes(16).toString('hex')}`;
}

export function deterministicRoundId(
  kind: Exclude<RoundKind, 'compacted'>,
  seed: string,
): string {
  return `r-${kind}-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}
