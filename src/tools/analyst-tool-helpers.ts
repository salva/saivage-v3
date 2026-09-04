import type { AnalystToolOutcome, SafeToolData } from './analyst-tool-types.js';
import { throwIfPublicationOutcomeUnknown } from '../contracts/index.js';
import { toolFailed } from '../contracts/tool-result.js';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function toolFailure(message: string, safeData?: SafeToolData): AnalystToolOutcome {
  return toolFailed(message, safeData);
}

export function toolFailureFromError(err: unknown, messageOverride?: string): AnalystToolOutcome {
  throwIfPublicationOutcomeUnknown(err);
  return toolFailed(messageOverride ?? errorMessage(err));
}

export function isBinarySample(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  let suspicious = 0;
  const sample = Math.min(buf.length, 1024);
  for (let i = 0; i < sample; i += 1) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 7 || (b > 14 && b < 32)) suspicious += 1;
  }
  return suspicious / sample > 0.3;
}
