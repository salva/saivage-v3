import { z } from 'zod';
import type { QualityToolName } from '../schemas/index.js';

export const qualityToolInputSchema = z.object({}).strict();
export interface QualityToolResult {
  operation: string;
  contract_version: 1;
  invocation_id: string;
  outcome: string;
  summary: string;
  values: Readonly<Record<string, string | number | boolean | readonly string[]>>;
  report: string;
  artifacts: readonly { path: string; size_bytes: number }[];
}
/** Bound to one selected policy agent and its actual process owner, not request config. */
export interface QualityToolPort {
  invoke(
    name: QualityToolName,
    caller: { resolveReadablePath(path: string): string },
    signal: AbortSignal,
  ): Promise<QualityToolResult>;
}
