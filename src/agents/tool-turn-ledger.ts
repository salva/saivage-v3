import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRole } from '../schemas/index.js';

export type ToolCallExecutionStatus = 'pending' | 'running' | 'waiting_barrier' | 'completed' | 'failed' | 'interrupted' | 'skipped';
export type ToolTurnStatus = 'running' | 'waiting_barrier' | 'completed' | 'interrupted';

export interface ToolCallExecutionRecord {
  tool_call_id: string;
  index: number;
  tool_name: string;
  arguments_json: string;
  barrier: boolean;
  status: ToolCallExecutionStatus;
  started_at?: string | null;
  completed_at?: string | null;
  result_message_id?: string | null;
  error_message?: string | null;
  activation_id?: string | null;
}

export interface ToolTurnRecord {
  turn_id: string;
  session_id: string;
  role: AgentRole;
  card_id: string;
  assistant_round_id: string;
  status: ToolTurnStatus;
  calls: ToolCallExecutionRecord[];
  created_at: string;
  updated_at: string;
}

function toolTurnsDir(saivageDir: string): string {
  return join(saivageDir, 'agents', 'tool-turns');
}

function toolTurnPath(saivageDir: string, turnId: string): string {
  return join(toolTurnsDir(saivageDir), `${encodeURIComponent(turnId)}.json`);
}

function saveToolTurn(saivageDir: string, record: ToolTurnRecord): ToolTurnRecord {
  mkdirSync(toolTurnsDir(saivageDir), { recursive: true });
  writeFileSync(toolTurnPath(saivageDir, record.turn_id), JSON.stringify(record, null, 2));
  return record;
}

export function createToolTurnRecord(input: {
  saivageDir: string;
  sessionId: string;
  role: AgentRole;
  cardId: string;
  assistantRoundId: string;
  calls: Array<{ id: string; name: string; argumentsJson: string; barrier: boolean }>;
  now?: string;
}): ToolTurnRecord {
  const now = input.now ?? new Date().toISOString();
  const turnId = `${input.sessionId}:${input.assistantRoundId}:${input.calls.map((call) => call.id).join(',')}`;
  return saveToolTurn(input.saivageDir, {
    turn_id: turnId,
    session_id: input.sessionId,
    role: input.role,
    card_id: input.cardId,
    assistant_round_id: input.assistantRoundId,
    status: 'running',
    calls: input.calls.map((call, index) => ({
      tool_call_id: call.id,
      index,
      tool_name: call.name,
      arguments_json: call.argumentsJson,
      barrier: call.barrier,
      status: 'pending',
      started_at: null,
      completed_at: null,
      result_message_id: null,
      error_message: null,
      activation_id: null,
    })),
    created_at: now,
    updated_at: now,
  });
}

export function readToolTurnRecord(saivageDir: string, turnId: string): ToolTurnRecord | null {
  try {
    return JSON.parse(readFileSync(toolTurnPath(saivageDir, turnId), 'utf-8')) as ToolTurnRecord;
  } catch {
    return null;
  }
}

export function updateToolCallExecution(input: {
  saivageDir: string;
  turnId: string;
  toolCallId: string;
  status: ToolCallExecutionStatus;
  resultMessageId?: string | null;
  errorMessage?: string | null;
  activationId?: string | null;
  now?: string;
}): ToolTurnRecord | null {
  const record = readToolTurnRecord(input.saivageDir, input.turnId);
  if (!record) return null;
  const now = input.now ?? new Date().toISOString();
  const call = record.calls.find((entry) => entry.tool_call_id === input.toolCallId);
  if (!call) return record;
  if (input.status === 'running' && !call.started_at) call.started_at = now;
  if (input.status === 'completed' || input.status === 'failed' || input.status === 'interrupted' || input.status === 'skipped') call.completed_at = now;
  call.status = input.status;
  if (input.resultMessageId !== undefined) call.result_message_id = input.resultMessageId;
  if (input.errorMessage !== undefined) call.error_message = input.errorMessage;
  if (input.activationId !== undefined) call.activation_id = input.activationId;
  record.status = record.calls.some((entry) => entry.status === 'waiting_barrier')
    ? 'waiting_barrier'
    : record.calls.every((entry) => entry.status === 'completed' || entry.status === 'failed' || entry.status === 'skipped' || entry.status === 'interrupted')
      ? 'completed'
      : 'running';
  record.updated_at = now;
  return saveToolTurn(input.saivageDir, record);
}
