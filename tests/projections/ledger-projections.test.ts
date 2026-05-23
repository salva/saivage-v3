import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { EventBus } from '../../src/events/bus.js';
import {
  registerNotificationProjection,
  registerControlActionAuditProjection,
  registerCardHistoryProjection,
  registerErrorLogProjection,
} from '../../src/projections/ledger-projections.js';

describe('ledger projection subscribers', () => {
  let projectRoot: string;
  let saivageDir: string;
  let bus: EventBus;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-ledger-projections-'));
    saivageDir = join(projectRoot, '.saivage');
    initProjectTree(projectRoot);
    bus = new EventBus();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('writes notification records from an EventBus subscriber before public fanout events', () => {
    registerNotificationProjection(bus, projectRoot);
    const fanout: string[] = [];
    bus.subscribe('notification_added', () => { fanout.push('public'); });
    const path = join(projectRoot, '.saivage', 'runtime', 'notifications', 'operator.jsonl');
    const record = {
      id: 'n-proj-1',
      session_id: null,
      kind: 'runtime_state',
      severity: 'info',
      payload_summary: 'operator notification',
      source_actor: 'runtime',
      source_surface: 'rest',
      created_at: '2026-01-01T00:00:00.000Z',
      delivered_at: null,
      acknowledged_at: null,
    };

    bus.emit('notification_record_appended', { ledger_path: path, record });
    expect(readFileSync(path, 'utf-8').trim()).toBe(JSON.stringify(record));
    bus.emit('notification_added', { id: record.id, kind: record.kind, severity: record.severity, created_at: record.created_at });
    expect(fanout).toEqual(['public']);
  });

  it('writes control-action audit records from an EventBus subscriber', () => {
    registerControlActionAuditProjection(bus, projectRoot);
    const record = {
      id: 'audit-proj-1',
      created_at: '2026-01-01T00:00:00.000Z',
      actor: 'analyst',
      surface: 'rest',
      action: 'card.update',
      target_kind: 'card',
      target_id: 'card-1',
      params_summary: 'status=done',
      confirmed: true,
      outcome: 'ok',
      outcome_summary: 'updated',
    };

    bus.emit('control_action_record_appended', { record });
    const line = readFileSync(join(projectRoot, '.saivage', 'runtime', 'control-actions.jsonl'), 'utf-8').trim();
    expect(JSON.parse(line)).toEqual(record);
  });

  it('writes card-history records from an EventBus subscriber', () => {
    registerCardHistoryProjection(bus, projectRoot);
    const record = {
      card_id: 'card-1',
      version_seq: 1,
      snapshot: {
        id: 'card-1',
        type: 'code',
        parent: null,
        depth: 0,
        title: 'Card',
        description: 'Card description',
        status: 'drafting',
        subtype: null,
        instructions_file: null,
        tags: [],
        priority: 0,
        urgency: 'normal',
        created_by: 'user',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        assigned_to: null,
        depends_on: [],
        blocks: [],
        related: [],
        acceptance: '',
        result: null,
        metrics: null,
        artifacts: [],
        attachments: [],
        estimate: null,
        started_at: null,
        completed_at: null,
        duration_ms: null,
        error: null,
        status_text: null,
        status_text_updated_at: null,
        status_text_author_session_id: null,
        latest_self_report: null,
        retries: 0,
        version_seq: 1,
      },
      changed_at: '2026-01-01T00:01:00.000Z',
      changed_by_actor: 'analyst',
      changed_by_surface: 'rest',
      change_reason: null,
      changed_fields: ['status'],
      change_summary: 'Updated status',
    };

    bus.emit('card_history_record_appended', { record });
    const line = readFileSync(join(projectRoot, '.saivage', 'cards', 'history', 'card-1.history.jsonl'), 'utf-8').trim();
    expect(JSON.parse(line)).toEqual(record);
  });

  it('writes error records from an EventBus subscriber', () => {
    registerErrorLogProjection(bus, saivageDir);
    const record = {
      id: 'err-proj-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      kind: 'error',
      message: 'boom',
      goalId: 'goal-1',
      phase: 'planner',
    };

    bus.emit('error_log_record_appended', { record });
    const line = readFileSync(join(saivageDir, 'runtime', 'errors.jsonl'), 'utf-8').trim();
    expect(JSON.parse(line)).toEqual(record);
  });

  it('propagates persistence subscriber failures so mutation code can fail before public fanout', () => {
    registerNotificationProjection(bus, projectRoot);
    const seen: string[] = [];
    bus.subscribe('notification_added', () => { seen.push('public'); });

    expect(() => bus.emit('notification_record_appended', { ledger_path: 42 as never, record: {} })).toThrow();
    expect(seen).toEqual([]);
  });
});
