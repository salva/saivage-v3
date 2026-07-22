import type { CardRecord } from '../../src/schemas/index.js';
import { workflowResult } from './workflow-result.js';

export const OUTBOUND_IDENTITY = 'tok_primary';
export const OUTBOUND_MODEL_IDENTITY = 'sk-model';
export const OUTBOUND_MCP_SERVER_IDENTITY = 'ghu_server';
export const OUTBOUND_MCP_TOOL_IDENTITY = 'rt_tool';
export const OUTBOUND_RAW_MARKER = 'synthetic-cross-surface-secret';
export const OUTBOUND_TEXT_MARKER = `token=${OUTBOUND_RAW_MARKER}`;
export const OUTBOUND_URL = `https://${OUTBOUND_IDENTITY}.example/path?token=${OUTBOUND_RAW_MARKER}`;
export const OUTBOUND_REDACTED_URL = `https://${OUTBOUND_IDENTITY}.example/path?[REDACTED]`;
export const OUTBOUND_TIMESTAMP = '2026-07-22T10:00:00.000Z';
export const OUTBOUND_SOURCE_INPUT_ID = '11111111-1111-4111-8111-111111111111';

export function credentialShapedCard(overrides: Partial<CardRecord> = {}): CardRecord {
  return {
    id: 'card-token',
    type: 'code',
    children: ['card-token-a'],
    title: `title ${OUTBOUND_TEXT_MARKER}`,
    lifecycle: {
      status: 'blocked',
      result: workflowResult('BLOCKED',OUTBOUND_TEXT_MARKER),
      error: OUTBOUND_TEXT_MARKER,
      completed_at: null,
    },
    subtype: null,
    tags: [OUTBOUND_IDENTITY],
    priority: 3,
    urgency: 'critical',
    created_by: 'planner',
    created_at: OUTBOUND_TIMESTAMP,
    updated_at: OUTBOUND_TIMESTAMP,
    version_seq: 7,
    assigned_to: null,
    depends_on: ['card-sk'],
    related: ['card-rt'],
    metrics: null,
    estimate: null,
    started_at: null,
    duration_ms: null,
    status_text: OUTBOUND_TEXT_MARKER,
    status_text_updated_at: OUTBOUND_TIMESTAMP,
    status_text_author_session_id: null,
    latest_self_report: null,
    metadata: null,
    pending_notifications: [{
      id: 'sk-notification',
      content: OUTBOUND_TEXT_MARKER,
      created_at: OUTBOUND_TIMESTAMP,
      source: OUTBOUND_IDENTITY,
    }],
    ...overrides,
  };
}
