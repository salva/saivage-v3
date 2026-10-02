import { redactTextForOutbound } from '../redaction/index.js';

export function formatConfigWarning(warning: string): string {
  return `Configuration warning: ${redactTextForOutbound(warning)}`;
}
