import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from '../utils/file-tree.js';
import { agentSessionSchema, agentMessageSchema } from '../schemas/validators.js';
import type { AgentSession, AgentMessage, MessageRole, MessageKind } from '../schemas/types.js';
import {
  create_card,
  edit_card,
  move_card,
  delete_card,
  add_note,
  list_cards,
  get_card,
  get_tree,
  get_plan_diary,
  get_card_output,
  get_status,
  pause_runtime,
  resume_runtime,
  abort_goal,
  restart_card,
  restart_goal,
  kill_process,
} from './analyst-tools.js';
import type { ToolResult, ToolContext } from './analyst-tools.js';

// ── Exported Types ─────────────────────────────────────────────

export interface ActivityCallback {
  (activity: { type: 'tool_call' | 'tool_result' | 'thinking'; content: Record<string, unknown> }): void;
}

export interface AnalystResponse {
  sessionId: string;
  message: {
    id: string;
    role: 'assistant';
    kind: 'text';
    content: string;
    timestamp: string;
  };
  toolInvocations?: Array<{
    tool: string;
    params: Record<string, unknown>;
    result: ToolResult;
  }>;
}

// ── Internal Types ─────────────────────────────────────────────

interface ParsedIntent {
  tool: string;
  params: Record<string, unknown>;
}

// ── Helpers ────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function saivageDir(projectRoot: string): string {
  return join(projectRoot, '.saivage');
}

function sessionsDir(projectRoot: string): string {
  return join(saivageDir(projectRoot), 'agents', 'sessions');
}

function messagesDir(projectRoot: string): string {
  return join(saivageDir(projectRoot), 'agents', 'messages');
}

function sessionFilePath(projectRoot: string, sessionId: string): string {
  return join(sessionsDir(projectRoot), `${sessionId}.json`);
}

function messagesFilePath(projectRoot: string, sessionId: string): string {
  return join(messagesDir(projectRoot), `${sessionId}.jsonl`);
}

function newMessageId(sessionId: string, existingCount: number): string {
  return `msg-${sessionId}-${existingCount + 1}`;
}

// ── Message Persistence ────────────────────────────────────────

function readMessages(projectRoot: string, sessionId: string): AgentMessage[] {
  const mp = messagesFilePath(projectRoot, sessionId);
  if (!existsSync(mp)) return [];

  const raw = readFileSync(mp, 'utf-8');
  if (raw.trim() === '') return [];

  const lines = raw.split('\n').filter((line) => line.trim() !== '');
  return lines.map((line) => {
    const obj = JSON.parse(line);
    return agentMessageSchema.parse(obj);
  });
}

function appendMessage(
  projectRoot: string,
  sessionId: string,
  message: {
    role: MessageRole;
    kind: MessageKind;
    content: string;
    tool?: string;
  },
): AgentMessage {
  const existing = readMessages(projectRoot, sessionId);
  const msg: AgentMessage = {
    id: newMessageId(sessionId, existing.length),
    session_id: sessionId,
    role: message.role,
    kind: message.kind,
    content: message.content,
    tool: message.tool,
    timestamp: now(),
  };

  agentMessageSchema.parse(msg);

  const mp = messagesFilePath(projectRoot, sessionId);
  const line = JSON.stringify(msg) + '\n';
  if (existsSync(mp)) {
    const existingContent = readFileSync(mp, 'utf-8');
    writeFileAtomic(mp, existingContent + line);
  } else {
    writeFileAtomic(mp, line);
  }

  return msg;
}

// ── Session Persistence ────────────────────────────────────────

function readSession(projectRoot: string, sessionId: string): AgentSession | null {
  const sp = sessionFilePath(projectRoot, sessionId);
  if (!existsSync(sp)) return null;

  const raw = readFileSync(sp, 'utf-8');
  const obj = JSON.parse(raw);
  const parsed = agentSessionSchema.safeParse(obj);
  if (!parsed.success) {
    throw new Error(
      `AgentSession validation failed for ${sessionId}: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function writeSession(projectRoot: string, session: AgentSession): void {
  agentSessionSchema.parse(session);
  writeFileAtomic(
    sessionFilePath(projectRoot, session.id),
    JSON.stringify(session, null, 2) + '\n',
  );
}

// ── Public: getOrCreateAnalystSession ──────────────────────────

export function getOrCreateAnalystSession(
  projectRoot: string,
  sessionId?: string,
): { session: AgentSession; sessionId: string } {
  if (sessionId) {
    const existing = readSession(projectRoot, sessionId);
    if (existing) {
      return { session: existing, sessionId: existing.id };
    }
    const session: AgentSession = {
      id: sessionId,
      role: 'analyst',
      status: 'active',
      started_at: now(),
    };
    writeSession(projectRoot, session);
    return { session, sessionId: session.id };
  }

  const autoId = `analyst-${Date.now()}`;
  const session: AgentSession = {
    id: autoId,
    role: 'analyst',
    status: 'active',
    started_at: now(),
  };
  writeSession(projectRoot, session);
  return { session, sessionId: session.id };
}

// ── Parameter Extraction ───────────────────────────────────────

function extractCardIds(text: string): string[] {
  const matches = text.match(/([a-zA-Z]+-[a-zA-Z0-9]+|project)/g);
  if (!matches) return [];
  return [...new Set(matches)];
}

function extractGoalIds(text: string): string[] {
  const matches = text.match(/goal-\d+/g);
  if (!matches) return [];
  return [...new Set(matches)];
}

function extractProcessIds(text: string): string[] {
  const matches = text.match(/proc-[a-zA-Z0-9-]+/g);
  if (!matches) return [];
  return [...new Set(matches)];
}

function extractStatus(text: string): string | undefined {
  const statuses = ['backlog', 'active', 'done', 'failed', 'cancelled'];
  const lower = text.toLowerCase();
  for (const s of statuses) {
    if (lower.includes(s)) return s;
  }
  return undefined;
}

function extractPriority(text: string): number | undefined {
  const m = text.match(/(?:priority|pri|p)\s*[:=]?\s*(\d+)/i);
  if (m) {
    const val = parseInt(m[1], 10);
    if (!isNaN(val)) return val;
  }
  return undefined;
}

function extractCardType(text: string): string | undefined {
  const types = ['goal', 'plan', 'architecture', 'code', 'test', 'doc', 'data', 'research', 'ops'];
  const lower = text.toLowerCase();
  for (const t of types) {
    const pattern = new RegExp(`\\b${t}\\b`, 'i');
    if (pattern.test(lower)) return t;
  }
  if (/\bproject\b/i.test(lower)) return 'project';
  return undefined;
}

function extractTags(text: string): string[] {
  const tags: string[] = [];
  const tagColon = text.match(/tag\s*:\s*(\S+)/gi);
  if (tagColon) {
    for (const m of tagColon) {
      const val = m.replace(/tag\s*:\s*/i, '');
      tags.push(val);
    }
  }
  const hashTags = text.match(/#(\w[\w-]*)/g);
  if (hashTags) {
    for (const m of hashTags) {
      tags.push(m.slice(1));
    }
  }
  return [...new Set(tags)];
}

function extractLines(text: string): number | undefined {
  const m = text.match(/lines?\s*[:=]\s*(\d+)/i);
  if (m) {
    const val = parseInt(m[1], 10);
    if (!isNaN(val)) return val;
  }
  const m2 = text.match(/(\d+)\s*lines/i);
  if (m2) {
    const val = parseInt(m2[1], 10);
    if (!isNaN(val)) return val;
  }
  return undefined;
}

function extractTitle(text: string): string | undefined {
  const doubleQuoted = text.match(/"([^"]+)"/);
  if (doubleQuoted) return doubleQuoted[1];
  const singleQuoted = text.match(/'([^']+)'/);
  if (singleQuoted) return singleQuoted[1];
  return undefined;
}

function extractParentId(text: string): string | undefined {
  const m = text.match(
    /(?:under|parent|above|below|in|beneath)\s+([a-zA-Z]+-[a-zA-Z0-9]+|project)/i,
  );
  if (m) return m[1];
  return undefined;
}

function extractNewParent(text: string): string | undefined {
  const m = text.match(
    /(?:to|into|under)\s+([a-zA-Z]+-[a-zA-Z0-9]+|project)/i,
  );
  if (m) return m[1];
  return undefined;
}

function extractNoteKind(text: string): string | undefined {
  const lower = text.toLowerCase();
  if (lower.includes('directive')) return 'directive';
  if (lower.includes('progress')) return 'progress';
  if (lower.includes('escalation')) return 'escalation';
  if (lower.includes('comment')) return 'comment';
  return undefined;
}

// ── Intent Parser ──────────────────────────────────────────────

function parseIntent(text: string): ParsedIntent | null {
  const cardIds = extractCardIds(text);

  // "kill process"
  if (/\bkill\b.*\bprocess\b/i.test(text) || /\bprocess\b.*\bkill\b/i.test(text)) {
    const processIds = extractProcessIds(text);
    const nonProject = cardIds.filter((id) => id !== 'project');
    if (processIds.length > 0) {
      return { tool: 'kill_process', params: { processId: processIds[0] } };
    }
    if (nonProject.length > 0) {
      return { tool: 'kill_process', params: { processId: nonProject[0] } };
    }
    return { tool: 'kill_process', params: {} };
  }

  // "pause runtime"
  if (/\bpause\b.*\bruntime\b|\bruntime\b.*\bpause\b/i.test(text)) {
    return { tool: 'pause_runtime', params: {} };
  }

  // "resume runtime"
  if (/\bresume\b.*\bruntime\b|\bruntime\b.*\bresume\b/i.test(text)) {
    return { tool: 'resume_runtime', params: {} };
  }

  // "abort goal" or "cancel goal"
  if (/\b(?:abort|cancel)\b.*\bgoal\b|\bgoal\b.*\b(?:abort|cancel)\b/i.test(text)) {
    const goalIds = extractGoalIds(text);
    if (goalIds.length > 0) {
      return { tool: 'abort_goal', params: { goalId: goalIds[0] } };
    }
    return { tool: 'abort_goal', params: {} };
  }

  // "restart goal" or "reset goal"
  if (/\brestart\s+goal\b|\breset\s+goal\b/i.test(text)) {
    const goalIds = extractGoalIds(text);
    if (goalIds.length > 0) {
      return { tool: 'restart_goal', params: { goalId: goalIds[0] } };
    }
    return { tool: 'restart_goal', params: {} };
  }

  // "restart card" or "re-queue"
  if (/\brestart\s+card\b|\bre-?queue\b/i.test(text)) {
    const ids = cardIds.filter((id) => id !== 'project');
    if (ids.length > 0) {
      return { tool: 'restart_card', params: { id: ids[0] } };
    }
    return { tool: 'restart_card', params: {} };
  }

  // "delete" or "remove"
  if (/\b(?:delete|remove)\b/i.test(text)) {
    const ids = cardIds.filter((id) => id !== 'project');
    if (ids.length > 0) {
      return { tool: 'delete_card', params: { id: ids[0] } };
    }
    return { tool: 'delete_card', params: {} };
  }

  // "move"
  if (/\bmove\b/i.test(text)) {
    const ids = cardIds.filter((id) => id !== 'project');
    const newParent = extractNewParent(text);
    const params: Record<string, unknown> = {};
    if (newParent !== undefined) params.newParent = newParent;
    if (ids.length > 0) {
      params.id = ids[0];
      return { tool: 'move_card', params };
    }
    return { tool: 'move_card', params };
  }

  // "edit" or "update" or "change" or "modify"
  if (/\b(?:edit|update|change|modify)\b/i.test(text)) {
    const ids = cardIds.filter((id) => id !== 'project');
    const params: Record<string, unknown> = {};
    if (ids.length > 0) params.id = ids[0];

    const title = extractTitle(text);
    if (title) params.title = title;
    const status = extractStatus(text);
    if (status) params.status = status;
    const priority = extractPriority(text);
    if (priority !== undefined) params.priority = priority;
    const tags = extractTags(text);
    if (tags.length > 0) params.tags = tags;
    return { tool: 'edit_card', params };
  }

  // "create" or "new" or "add" — after more specific commands
  if (/\b(?:create|new|add)\b/i.test(text)) {
    const type = extractCardType(text);
    const title = extractTitle(text);
    const parent = extractParentId(text);
    const params: Record<string, unknown> = {};
    if (type) params.type = type;
    if (title) params.title = title;
    if (parent) params.parent = parent;
    const descMatch = text.match(/description\s*[:=]\s*(.+?)(?:\s+\w+\s*[:=]|\s*$)/i);
    if (descMatch) params.description = descMatch[1].trim();
    return { tool: 'create_card', params };
  }

  // "note" or "comment" or "directive"
  if (/\b(?:note|comment|directive)\b/i.test(text)) {
    const ids = cardIds.filter((id) => id !== 'project');
    const kind = extractNoteKind(text);
    const params: Record<string, unknown> = {
      kind: kind || 'comment',
      content: text,
    };
    if (ids.length > 0) params.cardId = ids[0];
    return { tool: 'add_note', params };
  }

  // "tree" or "hierarchy"
  if (/\b(?:tree|hierarchy)\b/i.test(text)) {
    const rootMatch = text.match(
      /(?:from|root|of)\s+([a-zA-Z]+-[a-zA-Z0-9]+|project)/i,
    );
    const params: Record<string, unknown> = {};
    if (rootMatch) params.rootId = rootMatch[1];
    return { tool: 'get_tree', params };
  }

  // "diary" or "plan log"
  if (/\b(?:diary|plan\s*log)\b/i.test(text)) {
    const goalIds = extractGoalIds(text);
    if (goalIds.length > 0) {
      return { tool: 'get_plan_diary', params: { goalId: goalIds[0] } };
    }
    return { tool: 'get_plan_diary', params: {} };
  }

  // "output" or "log" or "stdout" or "stderr" — not create/edit/delete/move
  if (
    /\b(?:output|log|stdout|stderr)\b/i.test(text) &&
    !/\b(?:create|edit|delete|move)\b/i.test(text)
  ) {
    const ids = cardIds.filter((id) => id !== 'project');
    const procIds = extractProcessIds(text);
    const lines = extractLines(text);
    const params: Record<string, unknown> = {};
    if (procIds.length > 0) params.processId = procIds[0];
    if (ids.length > 0) params.cardId = ids[0];
    if (lines !== undefined) params.lines = lines;
    return { tool: 'get_card_output', params };
  }

  // "list" or "show" + "cards"
  if (/\b(?:list|show)\b.*\b(?:card|task|item)s?\b/i.test(text)) {
    const status = extractStatus(text);
    const type = extractCardType(text);
    const parent = extractParentId(text);
    const tags = extractTags(text);
    const params: Record<string, unknown> = {};
    if (status) params.status = status;
    if (type && type !== 'project') params.type = type;
    if (parent) params.parent = parent;
    if (tags.length > 0) params.tag = tags[0];
    return { tool: 'list_cards', params };
  }

  // "detail" or "inspect" or "show card" or "look at" or "examine"
  if (/\b(?:detail|inspect|show\s+card|look\s+at|examine)\b/i.test(text)) {
    const ids = cardIds.filter((id) => id !== 'project');
    if (ids.length > 0) {
      return { tool: 'get_card', params: { id: ids[0] } };
    }
    return { tool: 'get_card', params: {} };
  }

  // "status" or "state" or "overview" or "how's it going"
  if (/\b(?:status|state|overview|how.*going|progress)\b/i.test(text)) {
    return { tool: 'get_status', params: {} };
  }

  // If the message contains a card ID reference, default to showing that card
  if (cardIds.length > 0 && cardIds[0] !== 'project') {
    return { tool: 'get_card', params: { id: cardIds[0] } };
  }

  // No tool matched
  return null;
}

// ── Response Builder ───────────────────────────────────────────

function buildResponse(tool: string, result: ToolResult): string {
  if (!result.success) {
    const errMsg = result.error || 'Unknown error';
    return `❌ Failed: ${errMsg}`;
  }

  // Preview (destructive action needs confirmation)
  if (result.preview) {
    const p = result.preview;
    let previewMsg = `⚠️ Destructive action needs confirmation. Type 'yes' or 'confirm' to proceed.\n\n`;
    previewMsg += `**Action**: ${p.type}\n`;
    previewMsg += `**Summary**: ${p.summary}\n`;

    if (p.affectedCards.length > 0) {
      previewMsg += `\n**Affected Cards**:\n`;
      for (const card of p.affectedCards.slice(0, 10)) {
        previewMsg += `  - ${card.id}: "${card.title}" (${card.type}, ${card.status})\n`;
      }
      if (p.affectedCards.length > 10) {
        previewMsg += `  ... and ${p.affectedCards.length - 10} more\n`;
      }
    }

    if (p.affectedProcesses.length > 0) {
      previewMsg += `\n**Affected Processes**:\n`;
      for (const proc of p.affectedProcesses) {
        previewMsg += `  - ${proc.id}: ${proc.command} (${proc.status})\n`;
      }
    }

    if (p.warnings.length > 0) {
      previewMsg += `\n**Warnings**:\n`;
      for (const w of p.warnings) {
        previewMsg += `  - ⚠ ${w}\n`;
      }
    }

    return previewMsg;
  }

  // Success messages by tool
  switch (tool) {
    case 'create_card': {
      const card = result.data as Record<string, unknown> | undefined;
      if (card) {
        const parent = card.parent ? ` under ${card.parent}` : '';
        return `Created card "${card.title}" (${card.id})${parent}.`;
      }
      return 'Card created successfully.';
    }

    case 'edit_card': {
      const card = result.data as Record<string, unknown> | undefined;
      if (card) {
        return `Card "${card.id}" updated successfully.`;
      }
      return 'Card updated successfully.';
    }

    case 'move_card': {
      const card = result.data as Record<string, unknown> | undefined;
      if (card) {
        const parent = card.parent ? ` to ${card.parent}` : ' to root';
        return `Card "${card.id}" moved${parent} successfully.`;
      }
      return 'Card moved successfully.';
    }

    case 'delete_card': {
      const data = result.data as { deleted: string[] } | undefined;
      if (data && data.deleted) {
        return `Deleted ${data.deleted.length} card(s): ${data.deleted.join(', ')}.`;
      }
      return 'Card deleted successfully.';
    }

    case 'add_note': {
      const note = result.data as Record<string, unknown> | undefined;
      if (note) {
        return `Note added to card "${note.card_id}" (${note.kind}).`;
      }
      return 'Note added successfully.';
    }

    case 'list_cards': {
      const cards = result.data as Array<Record<string, unknown>> | undefined;
      if (cards && cards.length > 0) {
        let resp = `Found ${cards.length} card(s):\n`;
        for (const c of cards.slice(0, 20)) {
          resp += `  - ${c.id}: "${c.title}" (${c.type}, ${c.status})`;
          if (c.priority) resp += ` [priority: ${c.priority}]`;
          resp += '\n';
        }
        if (cards.length > 20) {
          resp += `  ... and ${cards.length - 20} more\n`;
        }
        return resp;
      }
      return 'No cards found matching the criteria.';
    }

    case 'get_card': {
      const card = result.data as Record<string, unknown> | undefined;
      if (card) {
        let resp = `**${card.title}** (${card.id})\n`;
        resp += `  Type: ${card.type} | Status: ${card.status} | Priority: ${card.priority}\n`;
        if (card.description) resp += `  Description: ${card.description}\n`;
        if (card.parent) resp += `  Parent: ${card.parent}\n`;
        const tags = card.tags as string[] | undefined;
        if (tags && tags.length > 0) resp += `  Tags: ${tags.join(', ')}\n`;
        const deps = card.depends_on as string[] | undefined;
        if (deps && deps.length > 0) resp += `  Depends on: ${deps.join(', ')}\n`;
        const children = card.children as Array<Record<string, unknown>> | undefined;
        if (children && children.length > 0) {
          resp += `  Children (${children.length}):\n`;
          for (const ch of children.slice(0, 10)) {
            resp += `    - ${ch.id}: "${ch.title}" (${ch.type}, ${ch.status})\n`;
          }
          if (children.length > 10) {
            resp += `    ... and ${children.length - 10} more\n`;
          }
        }
        const notes = card.notes as Array<Record<string, unknown>> | undefined;
        if (notes && notes.length > 0) {
          resp += `  Notes (${notes.length}):\n`;
          for (const n of notes.slice(0, 5)) {
            const content = String(n.content || '').slice(0, 80);
            resp += `    - [${n.kind}] ${content}${content.length >= 80 ? '...' : ''}\n`;
          }
          if (notes.length > 5) {
            resp += `    ... and ${notes.length - 5} more\n`;
          }
        }
        return resp;
      }
      return 'Card details retrieved.';
    }

    case 'get_tree': {
      const tree = result.data as Record<string, unknown> | undefined;
      if (tree) {
        return formatTreeNode(tree, '', true);
      }
      return 'Tree retrieved.';
    }

    case 'get_plan_diary': {
      const entries = result.data as Array<Record<string, unknown>> | undefined;
      if (entries && entries.length > 0) {
        let resp = `Plan diary (${entries.length} entries):\n`;
        for (const entry of entries.slice(0, 10)) {
          const ts = String(entry.timestamp || '').slice(0, 19);
          resp += `  - [${ts}] ${entry.kind}: ${entry.decision || entry.input_summary || '(no summary)'}\n`;
        }
        if (entries.length > 10) {
          resp += `  ... and ${entries.length - 10} more\n`;
        }
        return resp;
      }
      return 'No diary entries found.';
    }

    case 'get_card_output': {
      const processes = result.data as Array<Record<string, unknown>> | undefined;
      if (processes && processes.length > 0) {
        let resp = `Process output (${processes.length} process(es)):\n`;
        for (const proc of processes) {
          resp += `  - ${proc.id}: ${proc.command} (${proc.status})\n`;
          const output = String(proc.output || '').trim();
          if (output) {
            resp += `    Output:\n`;
            resp += output
              .split('\n')
              .map((l) => `      ${l}`)
              .join('\n');
            resp += '\n';
          }
        }
        return resp;
      }
      return 'No process output found.';
    }

    case 'get_status': {
      const data = result.data as Record<string, unknown> | undefined;
      if (data) {
        const rt = data.runtime as Record<string, unknown> | undefined;
        const counts = data.counts as Record<string, unknown> | undefined;
        let resp = `**Project Status**\n`;
        if (rt) resp += `  Runtime: ${rt.status} (paused: ${rt.paused})\n`;
        if (counts) {
          resp += `  Cards: ${counts.total} total (${counts.done} done, ${counts.failed} failed, ${counts.blocked} blocked)\n`;
        }
        resp += `  Running processes: ${data.runningProcesses}\n`;
        const queue = data.queue as string[] | undefined;
        if (queue && queue.length > 0) {
          resp += `  Ready queue (${queue.length}): ${queue.slice(0, 10).join(', ')}${
            queue.length > 10 ? '...' : ''
          }\n`;
        }
        return resp;
      }
      return 'Status retrieved.';
    }

    case 'pause_runtime': {
      const data = result.data as Record<string, unknown> | undefined;
      return `Runtime paused. Status: ${data?.status || 'paused'}.`;
    }

    case 'resume_runtime': {
      const data = result.data as Record<string, unknown> | undefined;
      return `Runtime resumed. Status: ${data?.status || 'idle'}.`;
    }

    case 'abort_goal': {
      const data = result.data as { cancelled: string[] } | undefined;
      if (data && data.cancelled) {
        return `Goal aborted. Cancelled ${data.cancelled.length} card(s): ${data.cancelled.join(', ')}.`;
      }
      return 'Goal aborted successfully.';
    }

    case 'restart_card': {
      const card = result.data as Record<string, unknown> | undefined;
      if (card) {
        return `Card "${card.id}" restarted — status set to ${card.status}.`;
      }
      return 'Card restarted successfully.';
    }

    case 'restart_goal': {
      const data = result.data as Record<string, unknown> | undefined;
      if (data) {
        return `Goal "${data.goalId}" restarted. Plan diary cleared, status set to backlog.`;
      }
      return 'Goal restarted successfully.';
    }

    case 'kill_process': {
      return 'Process killed.';
    }

    default:
      return 'Action completed successfully.';
  }
}

function formatTreeNode(
  node: Record<string, unknown>,
  indent: string,
  isRoot: boolean,
): string {
  let result = `${indent}${isRoot ? '' : '└─ '}${node.id}: "${node.title}" (${node.type}, ${node.status})\n`;
  const children = node.children as Array<Record<string, unknown>> | undefined;
  if (children && children.length > 0) {
    const childIndent = indent + (isRoot ? '' : '   ');
    for (const child of children) {
      result += formatTreeNode(child, childIndent, false);
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
// AnalystHandler
// ═══════════════════════════════════════════════════════════════

const HELP_TEXT =
  "I'm not sure how to help with that. I can create/edit/list/delete cards, " +
  'manage notes, control the runtime (pause/resume/abort/restart), inspect ' +
  'processes and outputs, and show the card tree. Try asking me something specific!';

type ToolFn = (ctx: ToolContext, params: Record<string, unknown>) => Promise<ToolResult>;

const TOOL_REGISTRY: Record<string, ToolFn> = {
  create_card: create_card as unknown as ToolFn,
  edit_card: edit_card as unknown as ToolFn,
  move_card: move_card as unknown as ToolFn,
  delete_card: delete_card as unknown as ToolFn,
  add_note: add_note as unknown as ToolFn,
  list_cards: list_cards as unknown as ToolFn,
  get_card: get_card as unknown as ToolFn,
  get_tree: get_tree as unknown as ToolFn,
  get_plan_diary: get_plan_diary as unknown as ToolFn,
  get_card_output: get_card_output as unknown as ToolFn,
  get_status: get_status as unknown as ToolFn,
  pause_runtime: pause_runtime as unknown as ToolFn,
  resume_runtime: resume_runtime as unknown as ToolFn,
  abort_goal: abort_goal as unknown as ToolFn,
  restart_card: restart_card as unknown as ToolFn,
  restart_goal: restart_goal as unknown as ToolFn,
  kill_process: kill_process as unknown as ToolFn,
};

export class AnalystHandler {
  private projectRoot: string;
  private onActivity?: ActivityCallback;
  private lastIntent: Map<string, ParsedIntent> = new Map();

  constructor(projectRoot: string, onActivity?: ActivityCallback) {
    this.projectRoot = projectRoot;
    this.onActivity = onActivity;
  }

  async handleMessage(sessionId: string, userContent: string): Promise<AnalystResponse> {
    // 1. Load or create session
    let session = readSession(this.projectRoot, sessionId);
    if (!session) {
      const created = getOrCreateAnalystSession(this.projectRoot, sessionId);
      session = created.session;
      sessionId = created.sessionId;
    }

    // 2. Persist user message
    appendMessage(this.projectRoot, sessionId, {
      role: 'user',
      kind: 'text',
      content: userContent,
    });

    // 3. Parse intent
    let intent = parseIntent(userContent);

    // 4. Check for confirmation of a previous preview
    if (!intent) {
      const lower = userContent.trim().toLowerCase();
      if (lower === 'yes' || lower === 'confirm' || lower === 'proceed' || lower === 'ok') {
        const lastInt = this.lastIntent.get(sessionId);
        if (lastInt) {
          intent = {
            tool: lastInt.tool,
            params: { ...lastInt.params, confirmed: true },
          };
          this.lastIntent.delete(sessionId);
        }
      }
    }

    const toolInvocations: AnalystResponse['toolInvocations'] = [];

    try {
      // 5. No intent matched — return help text
      if (!intent) {
        const responseContent = HELP_TEXT;
        const msg = appendMessage(this.projectRoot, sessionId, {
          role: 'assistant',
          kind: 'text',
          content: responseContent,
        });

        return {
          sessionId,
          message: {
            id: msg.id,
            role: 'assistant',
            kind: 'text',
            content: responseContent,
            timestamp: msg.timestamp,
          },
        };
      }

      // 6. Execute the tool
      const toolFn = TOOL_REGISTRY[intent.tool];
      if (!toolFn) {
        const errorContent = `❌ Unknown tool: ${intent.tool}`;
        const msg = appendMessage(this.projectRoot, sessionId, {
          role: 'assistant',
          kind: 'text',
          content: errorContent,
        });
        return {
          sessionId,
          message: {
            id: msg.id,
            role: 'assistant',
            kind: 'text',
            content: errorContent,
            timestamp: msg.timestamp,
          },
        };
      }

      // Emit activity callback if provided
      if (this.onActivity) {
        try {
          this.onActivity({
            type: 'tool_call',
            content: { tool: intent.tool, params: intent.params },
          });
        } catch {
          // Activity callbacks are best-effort
        }
      }

      const ctx: ToolContext = {
        projectRoot: this.projectRoot,
        sessionId,
      };

      const result = await toolFn(ctx, intent.params);

      // Emit activity callback for result
      if (this.onActivity) {
        try {
          this.onActivity({
            type: 'tool_result',
            content: { tool: intent.tool, success: result.success, hasPreview: !!result.preview },
          });
        } catch {
          // Activity callbacks are best-effort
        }
      }

      toolInvocations.push({
        tool: intent.tool,
        params: intent.params,
        result,
      });

      // 7. If result has a preview, store the intent for later confirmation
      if (result.preview) {
        this.lastIntent.set(sessionId, intent);
        const responseContent = buildResponse(intent.tool, result);
        const msg = appendMessage(this.projectRoot, sessionId, {
          role: 'assistant',
          kind: 'text',
          content: responseContent,
          tool: intent.tool,
        });

        return {
          sessionId,
          message: {
            id: msg.id,
            role: 'assistant',
            kind: 'text',
            content: responseContent,
            timestamp: msg.timestamp,
          },
          toolInvocations: toolInvocations.length > 0 ? toolInvocations : undefined,
        };
      }

      // 8. Build and persist the assistant response
      const responseContent = buildResponse(intent.tool, result);
      const msg = appendMessage(this.projectRoot, sessionId, {
        role: 'assistant',
        kind: 'text',
        content: responseContent,
        tool: intent.tool,
      });

      return {
        sessionId,
        message: {
          id: msg.id,
          role: 'assistant',
          kind: 'text',
          content: responseContent,
          timestamp: msg.timestamp,
        },
        toolInvocations: toolInvocations.length > 0 ? toolInvocations : undefined,
      };
    } catch (err) {
      const errorContent = `❌ Error: ${err instanceof Error ? err.message : String(err)}`;
      const msg = appendMessage(this.projectRoot, sessionId, {
        role: 'assistant',
        kind: 'text',
        content: errorContent,
      });

      return {
        sessionId,
        message: {
          id: msg.id,
          role: 'assistant',
          kind: 'text',
          content: errorContent,
          timestamp: msg.timestamp,
        },
      };
    }
  }
}
