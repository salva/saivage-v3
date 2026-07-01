import { z } from 'zod';
import { writeFileSync } from 'node:fs';

import { readRuntimeState } from '../runtime/state-api.js';
import { runAuditedAnalystTool } from '../agents/analyst-tool-runner.js';
import type { ToolContext, ToolResult } from './analyst-tool-types.js';
import { describe, emptyInput, type UnifiedToolDefinition } from './tool-catalog.js';
import { toolFailure, toolFailureFromError } from './analyst-tool-helpers.js';
import { closeOpenRecordSlot, discardOpenRecordSlot, openRecordSlot, readRecordSlotIndex } from '../runtime/records/record-slots.js';

export async function navigate_workspace(ctx: ToolContext, params: { target: { kind: 'card' | 'transcript' | 'process' | 'process_list' | 'agent_session_list' | 'config'; id?: string; refinement?: string } }): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'workspace.navigate', safety_class: 'low', target_kind: 'session', getTargetId: (p) => `${p.target.kind}:${p.target.id ?? '-'}`, run: async () => ({ success: true, data: { intent: 'navigate_workspace', target: params.target } }) });
}

export async function navigate_back(ctx: ToolContext, params: Record<string, never> = {}): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'workspace.navigate_back', safety_class: 'low', target_kind: 'session', getTargetId: () => 'workspace', run: async () => ({ success: true, data: { intent: 'navigate_back' } }) });
}

export async function write_file(ctx: ToolContext, params: { path: string; content: string }): Promise<ToolResult> {
  const auditParams = { path: params.path, bytes: Buffer.byteLength(params.content ?? '', 'utf8') };
  return runAuditedAnalystTool(ctx, auditParams, { action: 'record.brief.write', safety_class: 'high', target_kind: 'card', getTargetId: () => {
    try { return params.path.startsWith('record://') ? new URL(params.path).searchParams.get('card') : null; } catch { return null; }
  }, run: async () => {
    try {
      if (!params.path.startsWith('record://')) return toolFailure('permission', 'write_file only writes record://brief.md document records. It cannot write host or project files.', { path: params.path });
      const runtimeState = readRuntimeState(ctx.projectRoot);
      if (runtimeState?.status !== 'stopped' && runtimeState?.status !== 'paused') return toolFailure('permission', `write_file requires runtime status stopped or paused before the Analyst mutates card records. Current runtime status is ${runtimeState?.status ?? 'unknown'}.`, { status: runtimeState?.status ?? 'unknown' });
      const target = parseBriefWriteUrl(params.path);
      if (params.content.length === 0) return toolFailure('validation', 'brief.md content must not be empty.', { path: params.path });
      validateBriefMarkdown(params.content);
      const card = ctx.store.read(target.cardId);
      if (!card) return toolFailure('not_found', `Card '${target.cardId}' not found.`, { cardId: target.cardId });
      const index = readRecordSlotIndex(ctx.projectRoot, target.cardId, 'brief');
      if (index.open !== null) return toolFailure('conflict', `Cannot write '${target.path}': latest brief.md version is open.`, { cardId: target.cardId, open: index.open });
      const open = openRecordSlot(ctx.projectRoot, { cardId: target.cardId, filename: 'brief.md' });
      try {
        writeFileSync(open.absolutePath, params.content, 'utf8');
        const closed = closeOpenRecordSlot(ctx.projectRoot, { cardId: target.cardId, filename: 'brief.md', writer: 'analyst', cardVersionSeq: card.version_seq });
        return { success: true, data: { card_id: target.cardId, path: closed.relativePath, record_url: closed.recordUrl, bytes: Buffer.byteLength(params.content, 'utf8'), written: true } };
      } catch (err) {
        discardOpenRecordSlot(ctx.projectRoot, { cardId: target.cardId, filename: 'brief.md', reason: 'analyst write_file failed' });
        throw err;
      }
    } catch (err) { return toolFailureFromError(err, 'validation'); }
  } });
}

function parseBriefWriteUrl(raw: string): { cardId: string; path: string } {
  const url = new URL(raw);
  const filename = validRecordSegment(decodeURIComponent(`${url.hostname}${url.pathname}`), 'record filename', raw);
  if (filename !== 'brief.md') throw new Error('write_file only supports record://brief.md document writes.');
  const cardId = validRecordSegment(url.searchParams.get('card') ?? '', 'card id', raw);
  const version = url.searchParams.get('v') ?? 'next';
  if (version !== 'next') throw new Error('write_file record writes must use v=next.');
  return { cardId, path: `record://brief.md?card=${encodeURIComponent(cardId)}&v=next` };
}

function validateBriefMarkdown(content: string): void {
  for (const heading of ['# Goal', '# Instructions', '# Acceptance Criteria']) {
    if (!content.includes(heading)) throw new Error(`brief.md must include '${heading}'.`);
  }
}

export const analystWorkspaceTools: readonly UnifiedToolDefinition<string, any>[] = [
  { name: 'navigate_workspace', description: 'Navigate the workspace area.', input: z.object({ target: z.object({ kind: z.enum(['card', 'transcript', 'process', 'process_list', 'agent_session_list', 'config']), id: describe(z.string().optional(), 'Optional target id.'), refinement: describe(z.string().optional(), 'Optional view refinement.') }).strict() }).strict(), roles: ['analyst'], executor: navigate_workspace },
  { name: 'navigate_back', description: 'Navigate back in the workspace area.', input: emptyInput, roles: ['analyst'], executor: navigate_back },
  { name: 'write_file', description: 'Write a new closed brief record while runtime status is stopped or paused. Only supports record://brief.md?card=<id>&v=next; it cannot write host or project files.', input: z.object({ path: describe(z.string(), 'Must be record://brief.md?card=<id>&v=next.'), content: describe(z.string(), 'Full brief.md content including Goal, Instructions, and Acceptance Criteria headings.') }).strict(), roles: ['analyst'], executor: write_file },
] as const;

function validRecordSegment(value: string, label: string, raw: string): string {
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) throw new Error(`Invalid ${label} in record URL '${raw}'.`);
  return value;
}
