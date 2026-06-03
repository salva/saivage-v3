import { randomBytes } from 'node:crypto';
import type { RoundKind } from './round-id.js';

export function generateRoundId(kind: RoundKind): string {
  return `r-${kind}-${randomBytes(16).toString('hex')}`;
}
