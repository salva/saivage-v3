import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { AgentMessage } from '../../../schemas/index.js';
import { conversationDir } from '../conversation-index.js';
import type { RecoverableEvidenceDescriptor } from './result-dropping.js';

const recoverableEvidenceSchema = z.discriminatedUnion('flavor', [
  z.object({ flavor: z.literal('stash'), url: z.string(), label: z.string(), bytes: z.number().optional() }).strict(),
  z.object({ flavor: z.literal('process_stdout'), url: z.string(), label: z.string(), bytes: z.number().optional() }).strict(),
  z.object({ flavor: z.literal('process_stderr'), url: z.string(), label: z.string(), bytes: z.number().optional() }).strict(),
  z.object({ flavor: z.literal('source_recallable'), tool: z.string(), args: z.any(), label: z.string() }).strict(),
]);

export const summaryCacheEntrySchema = z.object({
  cache_key: z.string(),
  round_id: z.string(),
  content_hash: z.string(),
  summary_text: z.string().min(1),
  recoverable_evidence: z.array(recoverableEvidenceSchema),
  provenance: z.object({ source_message_ids: z.array(z.string()), source_start_token: z.number().optional(), source_end_token: z.number().optional() }).passthrough(),
  created_at: z.string().datetime(),
}).strict();

export type SummaryCacheEntry = z.infer<typeof summaryCacheEntrySchema>;

export function summaryCachePath(projectRoot: string, sessionId: string): string {
  return join(conversationDir(projectRoot, sessionId), 'summaries.jsonl');
}

export function summaryCacheKey(roundId: string, contentHash: string): string {
  return `${roundId}:${contentHash}`;
}

export function contentHashForMessages(messages: AgentMessage[]): string {
  const canonical = messages.map((message) => ({ id: message.id, role: message.role, kind: message.kind, content: message.content, tool: message.tool, tool_call_id: message.tool_call_id })).map((row) => JSON.stringify(row)).join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

export function readSummaryCache(projectRoot: string, sessionId: string): SummaryCacheEntry[] {
  const path = summaryCachePath(projectRoot, sessionId);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map((line) => summaryCacheEntrySchema.parse(JSON.parse(line)));
}

export function getSummaryCacheEntry(projectRoot: string, sessionId: string, cacheKey: string): SummaryCacheEntry | undefined {
  return readSummaryCache(projectRoot, sessionId).find((entry) => entry.cache_key === cacheKey);
}

export function renderRecoverableEvidenceSection(descriptors: readonly RecoverableEvidenceDescriptor[]): string {
  const lines = ['## Recoverable evidence (use `read` to recover full content)', ''];
  if (descriptors.length === 0) return `${lines.join('\n')}\nNone.`;
  for (const descriptor of descriptors) {
    if (descriptor.flavor === 'source_recallable') {
      lines.push(`- **source_recallable** \`${descriptor.tool}\` args \`${stableJson(descriptor.args)}\` — ${descriptor.label}`);
    } else {
      const bytes = descriptor.bytes === undefined ? '' : ` (${formatBytes(descriptor.bytes)})`;
      lines.push(`- **${descriptor.flavor}** \`${descriptor.url}\` — ${descriptor.label}${bytes}`);
    }
  }
  return lines.join('\n');
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, sortJson(val)]));
}

function formatBytes(bytes: number): string {
  return bytes >= 1000 ? `${(bytes / 1000).toFixed(1)} kB` : `${bytes} B`;
}
