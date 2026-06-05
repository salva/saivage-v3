import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  existsSync,
  readFileSync,
  rmSync,
  mkdtempSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initDiary,
  deleteDiary,
  appendDiaryEntry,
  getDiaryEntries,
  getDiaryEntry,
  appendReviewAssessment,
  getReviewAssessments,
} from '../../src/cards/diary.js';
import type { DiaryEntry, ReviewAssessment } from '../../src/schemas/types.js';

let tmpDir: string;
let saivageDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'saivage-diary-test-'));
  saivageDir = join(tmpDir, '.saivage');
  // Ensure the base directories exist
  mkdirSync(join(saivageDir, 'diaries'), { recursive: true });
  mkdirSync(join(saivageDir, 'reviews', 'by-goal'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function readIndexFile(goalCardId: string): Record<string, unknown> | null {
  const path = join(saivageDir, 'diaries', goalCardId, 'index.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function readEntryFile(goalCardId: string, filename: string): DiaryEntry | null {
  const path = join(saivageDir, 'diaries', goalCardId, filename);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8')) as DiaryEntry;
}

function readReviewIndex(goalCardId: string): Record<string, unknown> | null {
  const path = join(saivageDir, 'reviews', 'by-goal', `${goalCardId}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function baseEntry(
  goalCardId: string,
  kind: 'planner_invocation' | 'planner_decision' | 'card_mutation' | 'failure_handling',
) {
  return {
    goal_card_id: goalCardId,
    invocation_id: 'inv-1',
    kind,
  };
}

// ═══════════════════════════════════════════════════════════════
// initDiary
// ═══════════════════════════════════════════════════════════════

describe('initDiary', () => {
  it('creates diary directory and index.json with sequence=0', () => {
    initDiary(saivageDir, 'plan-abc');

    const dirPath = join(saivageDir, 'diaries', 'plan-abc');
    expect(existsSync(dirPath)).toBe(true);

    const index = readIndexFile('plan-abc');
    expect(index).not.toBeNull();
    expect(index!.sequence).toBe(0);
    expect(index!.entries).toEqual([]);
  });

  it('is idempotent — re-initializing keeps sequence', () => {
    initDiary(saivageDir, 'plan-abc');

    // Add an entry to bump sequence
    appendDiaryEntry(saivageDir, baseEntry('plan-abc', 'planner_invocation'));

    // Re-initialize
    initDiary(saivageDir, 'plan-abc');

    const index = readIndexFile('plan-abc');
    // Sequence should still be 1, not reset to 0
    expect(index!.sequence).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// appendDiaryEntry
// ═══════════════════════════════════════════════════════════════

describe('appendDiaryEntry', () => {
  it('creates sequential JSON files and updates index counter', () => {
    initDiary(saivageDir, 'plan-1');

    const e1 = appendDiaryEntry(saivageDir, baseEntry('plan-1', 'planner_invocation'));
    expect(e1.id).toBe('entry-1');
    expect(e1.timestamp).toBeDefined();
    expect(new Date(e1.timestamp).toISOString()).toBe(e1.timestamp);

    let index = readIndexFile('plan-1');
    expect(index!.sequence).toBe(1);
    expect((index!.entries as Array<Record<string, unknown>>).length).toBe(1);

    const e2 = appendDiaryEntry(saivageDir, baseEntry('plan-1', 'planner_decision'));
    expect(e2.id).toBe('entry-2');

    index = readIndexFile('plan-1');
    expect(index!.sequence).toBe(2);
    expect((index!.entries as Array<Record<string, unknown>>).length).toBe(2);
  });

  it('produces sequential filenames with correct kind suffix', () => {
    initDiary(saivageDir, 'plan-1');

    appendDiaryEntry(saivageDir, baseEntry('plan-1', 'planner_invocation'));

    const dirPath = join(saivageDir, 'diaries', 'plan-1');
    expect(existsSync(join(dirPath, '000001.planner_invocation.json'))).toBe(true);

    appendDiaryEntry(saivageDir, baseEntry('plan-1', 'card_mutation'));
    expect(existsSync(join(dirPath, '000002.card_mutation.json'))).toBe(true);

    appendDiaryEntry(saivageDir, baseEntry('plan-1', 'failure_handling'));
    expect(existsSync(join(dirPath, '000003.failure_handling.json'))).toBe(true);
  });

  it('auto-generates IDs when not provided', () => {
    initDiary(saivageDir, 'plan-1');

    const e3 = appendDiaryEntry(saivageDir, baseEntry('plan-1', 'planner_invocation'));
    expect(e3.id).toBe('entry-1');

    const e4 = appendDiaryEntry(saivageDir, baseEntry('plan-1', 'planner_decision'));
    expect(e4.id).toBe('entry-2');
  });

  it('respects provided IDs', () => {
    initDiary(saivageDir, 'plan-1');

    const e = appendDiaryEntry(saivageDir, {
      ...baseEntry('plan-1', 'planner_invocation'),
      id: 'custom-id',
    });
    expect(e.id).toBe('custom-id');
  });

  it('stores all diary entry fields in the entry file', () => {
    initDiary(saivageDir, 'plan-1');

    appendDiaryEntry(saivageDir, {
      goal_card_id: 'plan-1',
      invocation_id: 'inv-42',
      kind: 'planner_decision',
      input_summary: 'Decided approach',
      decision: 'Use A over B',
      rationale: 'A is faster',
      reviewed_cards: ['card-1', 'card-2'],
    });

    const fileContent = readEntryFile('plan-1', '000001.planner_decision.json');
    expect(fileContent).not.toBeNull();
    expect(fileContent!.goal_card_id).toBe('plan-1');
    expect(fileContent!.invocation_id).toBe('inv-42');
    expect(fileContent!.kind).toBe('planner_decision');
    expect(fileContent!.input_summary).toBe('Decided approach');
    expect(fileContent!.decision).toBe('Use A over B');
    expect(fileContent!.rationale).toBe('A is faster');
    expect(fileContent!.reviewed_cards).toEqual(['card-1', 'card-2']);
  });

  it('validates with diaryEntrySchema before writing (rejects invalid)', () => {
    initDiary(saivageDir, 'plan-1');

    expect(() =>
      appendDiaryEntry(saivageDir, {
        goal_card_id: 'plan-1',
        invocation_id: 'inv-1',
        kind: 'invalid_kind' as 'planner_invocation',
      }),
    ).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// getDiaryEntries
// ═══════════════════════════════════════════════════════════════

describe('getDiaryEntries', () => {
  it('returns all entries in order', () => {
    initDiary(saivageDir, 'plan-1');

    appendDiaryEntry(saivageDir, baseEntry('plan-1', 'planner_invocation'));
    appendDiaryEntry(saivageDir, baseEntry('plan-1', 'planner_decision'));
    appendDiaryEntry(saivageDir, baseEntry('plan-1', 'card_mutation'));

    const entries = getDiaryEntries(saivageDir, 'plan-1');
    expect(entries.length).toBe(3);
    expect(entries[0].kind).toBe('planner_invocation');
    expect(entries[1].kind).toBe('planner_decision');
    expect(entries[2].kind).toBe('card_mutation');
  });

  it('returns empty array for missing diary', () => {
    const entries = getDiaryEntries(saivageDir, 'nonexistent');
    expect(entries).toEqual([]);
  });

  it('returns entries with full data intact', () => {
    initDiary(saivageDir, 'plan-1');

    appendDiaryEntry(saivageDir, {
      goal_card_id: 'plan-1',
      invocation_id: 'inv-9',
      kind: 'planner_decision',
      decision: 'X',
      rationale: 'Because Y',
      reviewed_cards: ['c1'],
    });

    const entries = getDiaryEntries(saivageDir, 'plan-1');
    expect(entries.length).toBe(1);
    expect(entries[0].decision).toBe('X');
    expect(entries[0].rationale).toBe('Because Y');
    expect(entries[0].reviewed_cards).toEqual(['c1']);
  });
});

// ═══════════════════════════════════════════════════════════════
// getDiaryEntry
// ═══════════════════════════════════════════════════════════════

describe('getDiaryEntry', () => {
  it('returns entry by ID', () => {
    initDiary(saivageDir, 'plan-1');

    appendDiaryEntry(saivageDir, baseEntry('plan-1', 'planner_invocation'));
    appendDiaryEntry(saivageDir, baseEntry('plan-1', 'planner_decision'));

    const entry = getDiaryEntry(saivageDir, 'plan-1', 'entry-2');
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe('entry-2');
    expect(entry!.kind).toBe('planner_decision');
  });

  it('returns null for missing entry', () => {
    initDiary(saivageDir, 'plan-1');

    appendDiaryEntry(saivageDir, baseEntry('plan-1', 'planner_invocation'));

    const entry = getDiaryEntry(saivageDir, 'plan-1', 'entry-99');
    expect(entry).toBeNull();
  });

  it('returns null for missing diary', () => {
    const entry = getDiaryEntry(saivageDir, 'nonexistent', 'entry-1');
    expect(entry).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// appendReviewAssessment
// ═══════════════════════════════════════════════════════════════

describe('appendReviewAssessment', () => {
  it('creates review_assessment entry in the plan diary', () => {
    initDiary(saivageDir, 'plan-g1');

    const result = appendReviewAssessment(saivageDir, {
      goal_card_id: 'goal-1',
      reviewer_session_id: 'ses-1',
      assessment_id: 'assessment-test',
      at: '2025-01-01T00:00:00.000Z',
      result: 'pass',
      summary: 'All acceptance criteria met',
      achieved: ['Goal achieved'],
      issues: [],
      evidence_card_ids: ['card-a', 'card-b'],
    });

    expect(result.entry).toBeDefined();
    expect(result.entry.kind).toBe('review_assessment');
    expect(result.entry.goal_card_id).toBe('goal-1');
    expect(result.assessment).toBeDefined();
    expect(result.assessment.result).toBe('pass');
    expect(result.assessment.goal_card_id).toBe('goal-1');

    // Verify diary file exists
    const dirPath = join(saivageDir, 'diaries', 'goal-1');
    expect(existsSync(join(dirPath, '000001.review_assessment.json'))).toBe(true);

    const fileContent = readEntryFile('goal-1', '000001.review_assessment.json');
    expect(fileContent!.assessment).toBeDefined();
    expect(fileContent!.assessment!.result).toBe('pass');
    expect(fileContent!.assessment!.summary).toBe('All acceptance criteria met');
  });

  it('updates reviews/by-goal index', () => {
    initDiary(saivageDir, 'plan-g1');

    appendReviewAssessment(saivageDir, {
      goal_card_id: 'goal-1',
      reviewer_session_id: 'ses-1',
      assessment_id: 'assessment-test',
      at: '2025-01-01T00:00:00.000Z',
      result: 'needs_corrections',
      summary: 'Missing items',
      achieved: ['Partial'],
      issues: [{ summary: 'Item A', severity: 'blocker' }, { summary: 'Item B', severity: 'blocker' }],
      evidence_card_ids: ['card-1'],
    });

    const reviewIdx = readReviewIndex('goal-1');
    expect(reviewIdx).not.toBeNull();
    expect(reviewIdx!.reviews).toBeDefined();
    expect((reviewIdx!.reviews as Array<Record<string, unknown>>).length).toBe(1);

    const rev = (reviewIdx!.reviews as Array<Record<string, unknown>>)[0];
    expect(rev.id).toBe('rev-1');
    expect(rev.result).toBe('needs_corrections');
    expect(rev.diary_entry_id).toBeTruthy();
    expect(rev.diary_entry_id).toBeTruthy();
  });

  it('auto-generates review assessment IDs incrementally', () => {
    initDiary(saivageDir, 'plan-g1');

    const r1 = appendReviewAssessment(saivageDir, {
      goal_card_id: 'goal-1',
      reviewer_session_id: 'ses-1',
      assessment_id: 'assessment-test',
      at: '2025-01-01T00:00:00.000Z',
      result: 'pass',
      summary: 'First',
      achieved: [],
      issues: [],
      evidence_card_ids: [],
    });
    expect(r1.assessment.id).toBe('rev-1');

    const r2 = appendReviewAssessment(saivageDir, {
      goal_card_id: 'goal-1',
      reviewer_session_id: 'ses-2',
      assessment_id: 'assessment-test',
      at: '2025-01-01T00:00:00.000Z',
      result: 'needs_corrections',
      summary: 'Second',
      achieved: [],
      issues: [],
      evidence_card_ids: [],
    });
    expect(r2.assessment.id).toBe('rev-2');
  });

  it('respects provided review assessment IDs', () => {
    initDiary(saivageDir, 'plan-g1');

    const result = appendReviewAssessment(saivageDir, {
      id: 'custom-rev-42',
      goal_card_id: 'goal-1',
      reviewer_session_id: 'ses-1',
      assessment_id: 'assessment-test',
      at: '2025-01-01T00:00:00.000Z',
      result: 'pass',
      summary: 'Custom',
      achieved: [],
      issues: [],
      evidence_card_ids: [],
    });

    expect(result.assessment.id).toBe('custom-rev-42');
  });

  it('validates assessment with reviewAssessmentSchema', () => {
    initDiary(saivageDir, 'plan-g1');

    expect(() =>
      appendReviewAssessment(saivageDir, {
        goal_card_id: 'goal-1',
        reviewer_session_id: 'ses-1',
        assessment_id: 'assessment-test',
        at: '2025-01-01T00:00:00.000Z',
        result: 'invalid_result' as 'pass',
        summary: 'Test',
        achieved: [],
        issues: [],
        evidence_card_ids: [],
      }),
    ).toThrow();
  });

  it('embeds assessment in the diary entry', () => {
    initDiary(saivageDir, 'plan-g1');

    const result = appendReviewAssessment(saivageDir, {
      goal_card_id: 'goal-1',
      reviewer_session_id: 'ses-1',
      assessment_id: 'assessment-test',
      at: '2025-01-01T00:00:00.000Z',
      result: 'pass',
      summary: 'Embedded test',
      achieved: ['A1'],
      issues: [],
      evidence_card_ids: ['card-x'],
    });

    expect(result.entry.assessment).toBeDefined();
    expect(result.entry.assessment!.summary).toBe('Embedded test');
    expect(result.entry.assessment!.achieved).toEqual(['A1']);
    expect(result.entry.assessment!.evidence_card_ids).toEqual(['card-x']);
    expect(result.entry.reviewed_cards).toEqual(['card-x']);
  });
});

// ═══════════════════════════════════════════════════════════════
// getReviewAssessments
// ═══════════════════════════════════════════════════════════════

describe('getReviewAssessments', () => {
  it('returns all review assessments from index', () => {
    initDiary(saivageDir, 'plan-g1');

    appendReviewAssessment(saivageDir, {
      goal_card_id: 'goal-1',
      reviewer_session_id: 'ses-1',
      assessment_id: 'assessment-test',
      at: '2025-01-01T00:00:00.000Z',
      result: 'pass',
      summary: 'First review',
      achieved: ['A'],
      issues: [],
      evidence_card_ids: ['c1'],
    });

    appendReviewAssessment(saivageDir, {
      goal_card_id: 'goal-1',
      reviewer_session_id: 'ses-2',
      assessment_id: 'assessment-test',
      at: '2025-01-01T00:00:00.000Z',
      result: 'needs_corrections',
      summary: 'Second review',
      achieved: [],
      issues: [{ summary: 'B', severity: 'blocker' }],
      evidence_card_ids: [],
    });

    const assessments = getReviewAssessments(saivageDir, 'goal-1');
    expect(assessments.length).toBe(2);
    expect(assessments[0].result).toBe('pass');
    expect(assessments[0].summary).toBe('First review');
    expect(assessments[1].result).toBe('needs_corrections');
    expect(assessments[1].summary).toBe('Second review');
  });

  it('returns empty array when no reviews exist', () => {
    const assessments = getReviewAssessments(saivageDir, 'goal-nonexistent');
    expect(assessments).toEqual([]);
  });

  it('handles multiple assessments for same goal', () => {
    initDiary(saivageDir, 'plan-g1');
    initDiary(saivageDir, 'plan-g2');

    appendReviewAssessment(saivageDir, {
      goal_card_id: 'goal-1',
      reviewer_session_id: 'ses-1',
      assessment_id: 'assessment-test',
      at: '2025-01-01T00:00:00.000Z',
      result: 'pass',
      summary: 'First plan review',
      achieved: [],
      issues: [],
      evidence_card_ids: [],
    });

    appendReviewAssessment(saivageDir, {
      goal_card_id: 'goal-1',
      reviewer_session_id: 'ses-2',
      assessment_id: 'assessment-test',
      at: '2025-01-01T00:00:00.000Z',
      result: 'needs_corrections',
      summary: 'Second plan review',
      achieved: [],
      issues: [],
      evidence_card_ids: [],
    });

    const assessments = getReviewAssessments(saivageDir, 'goal-1');
    expect(assessments.length).toBe(2);
    expect(assessments[0].goal_card_id).toBe('goal-1');
    expect(assessments[1].goal_card_id).toBe('goal-1');
  });
});

// ═══════════════════════════════════════════════════════════════
// deleteDiary
// ═══════════════════════════════════════════════════════════════

describe('deleteDiary', () => {
  it('removes entire diary directory', () => {
    initDiary(saivageDir, 'plan-1');

    appendDiaryEntry(saivageDir, baseEntry('plan-1', 'planner_invocation'));
    appendDiaryEntry(saivageDir, baseEntry('plan-1', 'planner_decision'));

    const dirPath = join(saivageDir, 'diaries', 'plan-1');
    expect(existsSync(dirPath)).toBe(true);

    deleteDiary(saivageDir, 'plan-1');
    expect(existsSync(dirPath)).toBe(false);
  });

  it('silently succeeds when diary directory does not exist', () => {
    expect(() => deleteDiary(saivageDir, 'nonexistent-plan')).not.toThrow();
  });

  it('entries are no longer retrievable after deletion', () => {
    initDiary(saivageDir, 'plan-1');
    appendDiaryEntry(saivageDir, baseEntry('plan-1', 'planner_invocation'));

    expect(getDiaryEntries(saivageDir, 'plan-1').length).toBe(1);

    deleteDiary(saivageDir, 'plan-1');
    expect(getDiaryEntries(saivageDir, 'plan-1')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════════════════

describe('edge cases', () => {
  it('getDiaryEntries returns empty for missing diary directory', () => {
    const entries = getDiaryEntries(saivageDir, 'no-such-plan');
    expect(entries).toEqual([]);
  });

  it('appendDiaryEntry initializes diary implicitly', () => {
    // No initDiary call — append should still work because
    // readDiaryIndex returns defaults and writeDiaryIndexAtomic creates dirs
    const entry = appendDiaryEntry(saivageDir, {
      goal_card_id: 'plan-imp',
      invocation_id: 'inv-1',
      kind: 'planner_invocation',
    });

    expect(entry).toBeDefined();
    expect(entry.goal_card_id).toBe('plan-imp');

    const index = readIndexFile('plan-imp');
    expect(index!.sequence).toBe(1);
  });

  it('handles multiple diary entries with raw data', () => {
    initDiary(saivageDir, 'plan-1');

    appendDiaryEntry(saivageDir, {
      goal_card_id: 'plan-1',
      invocation_id: 'inv-1',
      kind: 'planner_invocation',
      raw: { model: 'gpt-4', temperature: 0.7 },
    });

    const entries = getDiaryEntries(saivageDir, 'plan-1');
    expect(entries.length).toBe(1);
    expect(entries[0].raw).toEqual({ model: 'gpt-4', temperature: 0.7 });
  });

  it('handles high sequence numbers with correct padding', () => {
    initDiary(saivageDir, 'plan-1');

    // Write 1500 entries to test padding
    for (let i = 0; i < 1500; i++) {
      appendDiaryEntry(saivageDir, baseEntry('plan-1', 'planner_invocation'));
    }

    const dirPath = join(saivageDir, 'diaries', 'plan-1');
    expect(existsSync(join(dirPath, '001500.planner_invocation.json'))).toBe(true);

    const index = readIndexFile('plan-1');
    expect(index!.sequence).toBe(1500);
  });

  it('different plan cards have independent diaries', () => {
    initDiary(saivageDir, 'plan-a');
    initDiary(saivageDir, 'plan-b');

    appendDiaryEntry(saivageDir, baseEntry('plan-a', 'planner_invocation'));
    appendDiaryEntry(saivageDir, baseEntry('plan-a', 'planner_decision'));
    appendDiaryEntry(saivageDir, baseEntry('plan-b', 'planner_invocation'));

    const entriesA = getDiaryEntries(saivageDir, 'plan-a');
    const entriesB = getDiaryEntries(saivageDir, 'plan-b');

    expect(entriesA.length).toBe(2);
    expect(entriesB.length).toBe(1);
    expect(entriesA[0].id).toBe('entry-1');
    expect(entriesB[0].id).toBe('entry-1');
  });

  it('preserves entry order matching index order', () => {
    initDiary(saivageDir, 'plan-1');

    const kinds = [
      'planner_invocation' as const,
      'planner_decision' as const,
      'card_mutation' as const,
      'failure_handling' as const,
    ];

    for (const kind of kinds) {
      appendDiaryEntry(saivageDir, { ...baseEntry('plan-1', kind) });
    }

    const entries = getDiaryEntries(saivageDir, 'plan-1');
    expect(entries.length).toBe(4);

    const index = readIndexFile('plan-1');
    const idxEntries = index!.entries as Array<{ id: string; kind: string }>;
    for (let i = 0; i < 4; i++) {
      expect(entries[i].kind).toBe(idxEntries[i].kind);
      expect(entries[i].id).toBe(idxEntries[i].id);
    }
  });
});
