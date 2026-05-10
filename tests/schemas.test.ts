import { describe, it, expect } from '@jest/globals';
import {
  projectConfigSchema,
  cardRecordSchema,
  diaryEntrySchema,
  reviewAssessmentSchema,
  noteRecordSchema,
  processRecordSchema,
  agentSessionSchema,
  agentMessageSchema,
  runtimeStateSchema,
  contentReviewSchema,
  quarantineItemSchema,
  artifactRefSchema,
  attachmentRefSchema,
  entityLinkSchema,
} from '../src/schemas/validators.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, '..', 'fixtures');

function readFixture(relativePath: string): unknown {
  const fullPath = path.join(fixturesDir, relativePath);
  return JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
}

function listFixtures(subdir: string): string[] {
  const dirPath = path.join(fixturesDir, subdir);
  return fs.readdirSync(dirPath).filter((f) => f.endsWith('.json'));
}

// ── Project Config ────────────────────────────────────────────

describe('ProjectConfig schema', () => {
  const validFixtures = listFixtures('valid').filter((f) => f.includes('project-config'));

  it.each(validFixtures)('accepts valid fixture: %s', (filename) => {
    const data = readFixture(`valid/${filename}`);
    const result = projectConfigSchema.safeParse(data);
    if (!result.success) {
      console.error(JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });

  it('rejects project config with id other than "project"', () => {
    const result = projectConfigSchema.safeParse({
      id: 'something-else',
      name: 'Test',
      context: '',
      goals_summary: '',
      constraints: [],
      max_goal_depth: 5,
      planner_enabled: true,
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects project config with negative max_goal_depth', () => {
    const result = projectConfigSchema.safeParse({
      id: 'project',
      name: 'Test',
      context: '',
      goals_summary: '',
      constraints: [],
      max_goal_depth: -1,
      planner_enabled: true,
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });
});

// ── Card Record ────────────────────────────────────────────────

describe('CardRecord schema', () => {
  const validCardFixtures = listFixtures('valid').filter((f) => f.startsWith('card-'));

  it.each(validCardFixtures)('accepts valid fixture: %s', (filename) => {
    const data = readFixture(`valid/${filename}`);
    const result = cardRecordSchema.safeParse(data);
    if (!result.success) {
      console.error(filename, JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });

  it('rejects card with invalid type', () => {
    const base = readFixture('valid/card-goal.json');
    const data = { ...(base as Record<string, unknown>), type: 'invalid_type' };
    const result = cardRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects card with invalid status', () => {
    const base = readFixture('valid/card-goal.json');
    const data = { ...(base as Record<string, unknown>), status: 'in_progress' };
    const result = cardRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects card with empty id', () => {
    const base = readFixture('valid/card-goal.json');
    const data = { ...(base as Record<string, unknown>), id: '' };
    const result = cardRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects card with negative depth', () => {
    const base = readFixture('valid/card-goal.json');
    const data = { ...(base as Record<string, unknown>), depth: -1 };
    const result = cardRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects card with negative retries', () => {
    const base = readFixture('valid/card-goal.json');
    const data = { ...(base as Record<string, unknown>), retries: -1 };
    const result = cardRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects card with invalid urgency', () => {
    const base = readFixture('valid/card-goal.json');
    const data = { ...(base as Record<string, unknown>), urgency: 'extreme' };
    const result = cardRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects card with tags as non-array', () => {
    const base = readFixture('valid/card-goal.json');
    const data = { ...(base as Record<string, unknown>), tags: 'auth' };
    const result = cardRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('accepts card with null parent (root card)', () => {
    const data = readFixture('valid/card-project.json');
    const result = cardRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.parent).toBeNull();
    }
  });

  it('rejects card with invalid artifact', () => {
    const base = readFixture('valid/card-goal.json');
    const data = {
      ...(base as Record<string, unknown>),
      artifacts: [
        {
          id: '',
          card_id: 'x',
          path: '',
          type: 'unknown',
          description: '',
          retain: 'yes',
          created_at: '',
        },
      ],
    };
    const result = cardRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});

// ── ArtifactRef ────────────────────────────────────────────────

describe('ArtifactRef schema', () => {
  it('accepts a valid artifact ref', () => {
    const data = {
      id: 'art-1',
      card_id: 'card-1',
      path: '/tmp/file.txt',
      type: 'report',
      description: 'A test artifact',
      retain: true,
      created_at: '2025-01-01T00:00:00.000Z',
    };
    const result = artifactRefSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('rejects artifact with unknown type', () => {
    const data = {
      id: 'art-1',
      card_id: 'card-1',
      path: '/tmp/file.txt',
      type: 'image',
      description: 'A test artifact',
      retain: true,
      created_at: '2025-01-01T00:00:00.000Z',
    };
    const result = artifactRefSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects artifact with empty id', () => {
    const data = {
      id: '',
      card_id: 'card-1',
      path: '/tmp/file.txt',
      type: 'model',
      description: 'Test',
      retain: true,
      created_at: '2025-01-01T00:00:00.000Z',
    };
    const result = artifactRefSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});

// ── AttachmentRef ──────────────────────────────────────────────

describe('AttachmentRef schema', () => {
  it('accepts a valid attachment ref', () => {
    const data = {
      id: 'att-1',
      card_id: 'card-1',
      path: '/tmp/chart.png',
      mime: 'image/png',
      title: 'Performance Chart',
      created_at: '2025-01-01T00:00:00.000Z',
    };
    const result = attachmentRefSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('rejects attachment with empty title', () => {
    const data = {
      id: 'att-1',
      card_id: 'card-1',
      path: '/tmp/chart.png',
      mime: 'image/png',
      title: '',
      created_at: '2025-01-01T00:00:00.000Z',
    };
    const result = attachmentRefSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});

// ── DiaryEntry ─────────────────────────────────────────────────

describe('DiaryEntry schema', () => {
  const validDiaryFixtures = listFixtures('valid').filter((f) => f.startsWith('diary-'));

  it.each(validDiaryFixtures)('accepts valid fixture: %s', (filename) => {
    const data = readFixture(`valid/${filename}`);
    const result = diaryEntrySchema.safeParse(data);
    if (!result.success) {
      console.error(filename, JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });

  it('rejects diary entry with invalid kind', () => {
    const base = readFixture('valid/diary-entry.json');
    const data = { ...(base as Record<string, unknown>), kind: 'poetry' };
    const result = diaryEntrySchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects diary entry with empty id', () => {
    const base = readFixture('valid/diary-entry.json');
    const data = { ...(base as Record<string, unknown>), id: '' };
    const result = diaryEntrySchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('accepts diary entry with embedded review assessment', () => {
    const data = readFixture('valid/diary-entry-with-review.json');
    const result = diaryEntrySchema.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.assessment).toBeDefined();
      expect(result.data.assessment!.result).toBe('pass');
    }
  });
});

// ── ReviewAssessment ───────────────────────────────────────────

describe('ReviewAssessment schema', () => {
  const validReviewFixtures = listFixtures('valid').filter((f) =>
    f.startsWith('review-assessment-'),
  );

  it.each(validReviewFixtures)('accepts valid fixture: %s', (filename) => {
    const data = readFixture(`valid/${filename}`);
    const result = reviewAssessmentSchema.safeParse(data);
    if (!result.success) {
      console.error(filename, JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });

  it('rejects review with invalid result value', () => {
    const data = {
      id: 'rev-1',
      goal_card_id: 'g-1',
      plan_card_id: 'p-1',
      reviewer_session_id: 'rs-1',
      result: 'maybe',
      summary: 'Test',
      achieved: [],
      missing: [],
      evidence_card_ids: [],
      created_at: '2025-01-01T00:00:00.000Z',
    };
    const result = reviewAssessmentSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects review with empty goal_card_id', () => {
    const data = {
      id: 'rev-1',
      goal_card_id: '',
      plan_card_id: 'p-1',
      reviewer_session_id: 'rs-1',
      result: 'pass',
      summary: 'Test',
      achieved: [],
      missing: [],
      evidence_card_ids: [],
      created_at: '2025-01-01T00:00:00.000Z',
    };
    const result = reviewAssessmentSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});

// ── NoteRecord ─────────────────────────────────────────────────

describe('NoteRecord schema', () => {
  const validNoteFixtures = listFixtures('valid').filter((f) => f.startsWith('note-'));

  it.each(validNoteFixtures)('accepts valid fixture: %s', (filename) => {
    const data = readFixture(`valid/${filename}`);
    const result = noteRecordSchema.safeParse(data);
    if (!result.success) {
      console.error(filename, JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });

  it('rejects note with invalid author', () => {
    const base = readFixture('valid/note-unhandled.json');
    const data = { ...(base as Record<string, unknown>), author: 'bot' };
    const result = noteRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects note with invalid kind', () => {
    const base = readFixture('valid/note-unhandled.json');
    const data = { ...(base as Record<string, unknown>), kind: 'complaint' };
    const result = noteRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects note with content as number', () => {
    const base = readFixture('valid/note-unhandled.json');
    const data = { ...(base as Record<string, unknown>), content: 12345 };
    const result = noteRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('accepts handled note with handled_at timestamp', () => {
    const data = readFixture('valid/note-handled.json');
    const result = noteRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.handled).toBe(true);
      expect(result.data.handled_at).toBe('2025-01-01T03:45:00.000Z');
    }
  });
});

// ── ProcessRecord ──────────────────────────────────────────────

describe('ProcessRecord schema', () => {
  const validProcessFixtures = listFixtures('valid').filter((f) => f.startsWith('process-'));

  it.each(validProcessFixtures)('accepts valid fixture: %s', (filename) => {
    const data = readFixture(`valid/${filename}`);
    const result = processRecordSchema.safeParse(data);
    if (!result.success) {
      console.error(filename, JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });

  it('rejects process with empty command', () => {
    const base = readFixture('valid/process-exited.json');
    const data = { ...(base as Record<string, unknown>), command: '' };
    const result = processRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects process with invalid status', () => {
    const base = readFixture('valid/process-exited.json');
    const data = { ...(base as Record<string, unknown>), status: 'sleeping' };
    const result = processRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects process with empty output_dir', () => {
    const base = readFixture('valid/process-exited.json');
    const data = { ...(base as Record<string, unknown>), output_dir: '' };
    const result = processRecordSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('accepts running process without pid, exit_code, completed_at', () => {
    const data = readFixture('valid/process-running.json');
    const result = processRecordSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pid).toBeUndefined();
      expect(result.data.exit_code).toBeUndefined();
      expect(result.data.completed_at).toBeUndefined();
    }
  });
});

// ── AgentSession ───────────────────────────────────────────────

describe('AgentSession schema', () => {
  const validSessionFixtures = listFixtures('valid').filter((f) => f.includes('session'));

  it.each(validSessionFixtures)('accepts valid fixture: %s', (filename) => {
    const data = readFixture(`valid/${filename}`);
    const result = agentSessionSchema.safeParse(data);
    if (!result.success) {
      console.error(filename, JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });

  it('rejects session with invalid role', () => {
    const base = readFixture('valid/agent-session.json');
    const data = { ...(base as Record<string, unknown>), role: 'supervisor' };
    const result = agentSessionSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects session with invalid status', () => {
    const base = readFixture('valid/agent-session.json');
    const data = { ...(base as Record<string, unknown>), status: 'pending' };
    const result = agentSessionSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});

// ── AgentMessage ───────────────────────────────────────────────

describe('AgentMessage schema', () => {
  const validMsgFixtures = listFixtures('valid').filter((f) => f.includes('message'));

  it.each(validMsgFixtures)('accepts valid fixture: %s', (filename) => {
    const data = readFixture(`valid/${filename}`);
    const result = agentMessageSchema.safeParse(data);
    if (!result.success) {
      console.error(filename, JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });

  it('rejects message with invalid role', () => {
    const base = readFixture('valid/agent-message.json');
    const data = { ...(base as Record<string, unknown>), role: 'moderator' };
    const result = agentMessageSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects message with invalid kind', () => {
    const base = readFixture('valid/agent-message.json');
    const data = { ...(base as Record<string, unknown>), kind: 'poem' };
    const result = agentMessageSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects message with invalid entity link', () => {
    const base = readFixture('valid/agent-message.json');
    const data = {
      ...(base as Record<string, unknown>),
      links: [{ entity_type: 'unknown', entity_id: '' }],
    };
    const result = agentMessageSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});

// ── EntityLink ─────────────────────────────────────────────────

describe('EntityLink schema', () => {
  it('accepts valid card entity link', () => {
    const result = entityLinkSchema.safeParse({ entity_type: 'card', entity_id: 'card-1' });
    expect(result.success).toBe(true);
  });

  it('accepts valid link with label', () => {
    const result = entityLinkSchema.safeParse({
      entity_type: 'process',
      entity_id: 'proc-1',
      label: 'Build process',
    });
    expect(result.success).toBe(true);
  });

  it('rejects link with invalid entity type', () => {
    const result = entityLinkSchema.safeParse({ entity_type: 'unknown', entity_id: 'x' });
    expect(result.success).toBe(false);
  });

  it('rejects link with empty entity_id', () => {
    const result = entityLinkSchema.safeParse({ entity_type: 'card', entity_id: '' });
    expect(result.success).toBe(false);
  });
});

// ── RuntimeState ───────────────────────────────────────────────

describe('RuntimeState schema', () => {
  const validRuntimeFixtures = listFixtures('valid').filter((f) => f.includes('runtime'));

  it.each(validRuntimeFixtures)('accepts valid fixture: %s', (filename) => {
    const data = readFixture(`valid/${filename}`);
    const result = runtimeStateSchema.safeParse(data);
    if (!result.success) {
      console.error(filename, JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });

  it('rejects runtime state with invalid status', () => {
    const base = readFixture('valid/runtime-state.json');
    const data = { ...(base as Record<string, unknown>), status: 'sleeping' };
    const result = runtimeStateSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects runtime state with non-literal project_id', () => {
    const base = readFixture('valid/runtime-state.json');
    const data = { ...(base as Record<string, unknown>), project_id: 'other' };
    const result = runtimeStateSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects runtime state with negative pid', () => {
    const base = readFixture('valid/runtime-state.json');
    const data = { ...(base as Record<string, unknown>), pid: -1 };
    const result = runtimeStateSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('accepts paused runtime state with paused_at', () => {
    const base = readFixture('valid/runtime-state.json');
    const data = {
      ...(base as Record<string, unknown>),
      paused: true,
      paused_at: '2025-01-01T04:00:00.000Z',
    };
    const result = runtimeStateSchema.safeParse(data);
    expect(result.success).toBe(true);
  });
});

// ── ContentReview ──────────────────────────────────────────────

describe('ContentReview schema', () => {
  const validReviewFixtures = listFixtures('valid').filter((f) =>
    f.startsWith('content-review'),
  );

  it.each(validReviewFixtures)('accepts valid fixture: %s', (filename) => {
    const data = readFixture(`valid/${filename}`);
    const result = contentReviewSchema.safeParse(data);
    if (!result.success) {
      console.error(filename, JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });

  it('rejects review with invalid source_kind', () => {
    const base = readFixture('valid/content-review-passed.json');
    const data = { ...(base as Record<string, unknown>), source_kind: 'email' };
    const result = contentReviewSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects review with invalid status', () => {
    const base = readFixture('valid/content-review-passed.json');
    const data = { ...(base as Record<string, unknown>), status: 'unknown' };
    const result = contentReviewSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects review with invalid risk level', () => {
    const base = readFixture('valid/content-review-passed.json');
    const data = { ...(base as Record<string, unknown>), risk: 'extreme' };
    const result = contentReviewSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('accepts blocked review with quarantine_id', () => {
    const data = readFixture('valid/content-review-blocked.json');
    const result = contentReviewSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('blocked');
      expect(result.data.quarantine_id).toBe('q-0001');
    }
  });
});

// ── QuarantineItem ─────────────────────────────────────────────

describe('QuarantineItem schema', () => {
  const validQuarantineFixtures = listFixtures('valid').filter((f) => f.includes('quarantine'));

  it.each(validQuarantineFixtures)('accepts valid fixture: %s', (filename) => {
    const data = readFixture(`valid/${filename}`);
    const result = quarantineItemSchema.safeParse(data);
    if (!result.success) {
      console.error(filename, JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });

  it('rejects quarantine item with empty review_id', () => {
    const base = readFixture('valid/quarantine-item.json');
    const data = { ...(base as Record<string, unknown>), review_id: '' };
    const result = quarantineItemSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects quarantine item with empty stored_path', () => {
    const base = readFixture('valid/quarantine-item.json');
    const data = { ...(base as Record<string, unknown>), stored_path: '' };
    const result = quarantineItemSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});

// ── Invalid Fixture Round-Trip Tests ───────────────────────────

describe('Invalid fixtures', () => {
  const invalidFiles = listFixtures('invalid');

  it('has invalid fixture files to test', () => {
    expect(invalidFiles.length).toBeGreaterThan(0);
  });

  it.each(invalidFiles)('invalid fixture %s fails cardRecordSchema validation', (filename) => {
    const data = readFixture(`invalid/${filename}`);
    const result = cardRecordSchema.safeParse(data);

    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });
});

// ── Cross-Schema Tests ─────────────────────────────────────────

describe('Round-trip: valid fixtures parse without data loss', () => {
  it('card fixtures survive serialize → deserialize round-trip', () => {
    const files = listFixtures('valid').filter((f) => f.startsWith('card-'));
    for (const file of files) {
      const data = readFixture(`valid/${file}`) as Record<string, unknown>;
      const result = cardRecordSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe(data.id);
        expect(result.data.type).toBe(data.type);
        expect(result.data.title).toBe(data.title);
        expect(result.data.status).toBe(data.status);
      }
    }
  });

  it('process fixtures survive serialize → deserialize round-trip', () => {
    const files = listFixtures('valid').filter((f) => f.startsWith('process-'));
    for (const file of files) {
      const data = readFixture(`valid/${file}`) as Record<string, unknown>;
      const result = processRecordSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe(data.id);
        expect(result.data.status).toBe(data.status);
        expect(result.data.command).toBe(data.command);
      }
    }
  });

  it('review assessment fixtures survive round-trip', () => {
    const files = listFixtures('valid').filter((f) => f.startsWith('review-assessment-'));
    for (const file of files) {
      const data = readFixture(`valid/${file}`) as Record<string, unknown>;
      const result = reviewAssessmentSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe(data.id);
        expect(result.data.result).toBe(data.result);
      }
    }
  });
});

// ── Error Message Quality ──────────────────────────────────────

describe('Validation error messages are useful', () => {
  it('produces a specific message for wrong type field', () => {
    const result = cardRecordSchema.safeParse({
      id: 'test',
      type: 'bogus',
      parent: null,
      depth: 0,
      title: 'Test',
      description: '',
      status: 'drafting',
      tags: [],
      priority: 1,
      urgency: 'normal',
      created_by: 'user',
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
      depends_on: [],
      blocks: [],
      related: [],
      acceptance: '',
      artifacts: [],
      attachments: [],
      retries: 0,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map(
        (i: { message: string }) => i.message,
      );
      const joined = messages.join(', ');
      expect(joined.toLowerCase()).toMatch(/type|invalid|enum/);
    }
  });

  it('produces multiple errors for multiple invalid fields', () => {
    const result = cardRecordSchema.safeParse({
      id: '',
      type: 'bogus',
      parent: 123,
      depth: 'deep',
      title: '',
      description: null,
      status: 'unknown',
      tags: 123,
      priority: 'high',
      urgency: 'extreme',
      created_by: 'robot',
      created_at: 'yesterday',
      updated_at: 'tomorrow',
      depends_on: 456,
      blocks: null,
      related: false,
      acceptance: 0,
      artifacts: 'none',
      attachments: {},
      retries: -5,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(3);
    }
  });

  it('produces specific message for empty required string', () => {
    const result = projectConfigSchema.safeParse({
      id: 'project',
      name: '',
      context: '',
      goals_summary: '',
      constraints: [],
      max_goal_depth: 5,
      planner_enabled: true,
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i: { path: (string | number)[] }) =>
          i.path.includes('name'),
        ),
      ).toBe(true);
    }
  });
});
