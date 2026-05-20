import { RedactionBoundary } from './redaction-boundary.js';

const OBSERVABILITY_CONTEXT = { sink: 'observability' as const, source: 'observability-redaction' };

export function redactObservabilityValue<T>(value: T, keyHint?: string): T {
  if (keyHint) {
    return RedactionBoundary.object({ [keyHint]: value }, OBSERVABILITY_CONTEXT)[keyHint] as T;
  }
  return RedactionBoundary.object(value, OBSERVABILITY_CONTEXT);
}

export function redactObservabilityText(value: string): string {
  return RedactionBoundary.text(value, OBSERVABILITY_CONTEXT);
}
