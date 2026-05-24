import { describe, it, expect } from '@jest/globals';
import {
  extractJson,
  parsePlannerResult,
  parseExecutorResult,
  parseReviewerResult,
  ResultParseError,
  isRecoverableParseError,
  buildExecutorFallbackResult,
} from '../../src/agents/result-parser.js';
import type { AgentMessage } from '../../src/schemas/types.js';

describe('extractJson', () => {
  it('should parse raw JSON', () => {
    expect(extractJson('{"key": "value"}')).toEqual({ key: 'value' });
  });

  it('should extract JSON from markdown code block', () => {
    expect(extractJson('```json\n{"key": "value"}\n```')).toEqual({ key: 'value' });
  });

  it('should throw on non-JSON input', () => {
    expect(() => extractJson('no json here at all')).toThrow(ResultParseError);
  });
});

describe('parsePlannerResult', () => {
  it('parses valid planner results', () => {
    const raw = JSON.stringify({
      created_cards: [{ type: 'code', title: 'Implement X', description: 'Do it', status: 'backlog', depends_on: [], priority: 1 }],
      updated_cards: [],
      status: 'continue',
    });
    const result = parsePlannerResult(raw);
    expect(result.status).toBe('continue');
    expect(result.created_cards).toHaveLength(1);
  });

  it('parses blocked planner results', () => {
    const raw = JSON.stringify({ status: 'blocked', blocked_reason: 'Needs input', created_cards: [], updated_cards: [] });
    expect(parsePlannerResult(raw).blocked_reason).toBe('Needs input');
  });
});

describe('parseExecutorResult', () => {
  it('parses a valid executor result with required status_text', () => {
    const raw = JSON.stringify({
      card_id: 'code-1',
      status: 'done',
      status_text: 'Completed successfully',
      result: { output: 'success' },
      artifacts: [{ type: 'report', description: 'Test report', retain: true }],
      attachments: [],
    });
    const result = parseExecutorResult(raw);
    expect(result.status).toBe('done');
    expect(result.status_text).toBe('Completed successfully');
  });

  it('rejects executor results missing status_text', () => {
    const raw = JSON.stringify({ card_id: 'code-1', status: 'done', artifacts: [], attachments: [] });
    expect(() => parseExecutorResult(raw)).toThrow(ResultParseError);
  });
});

describe('buildExecutorFallbackResult', () => {
  function msg(overrides: Partial<AgentMessage>): AgentMessage {
    return {
      id: 'm',
      session_id: 's',
      role: 'tool',
      kind: 'tool_result',
      content: '{}',
      timestamp: new Date().toISOString(),
      ...overrides,
    };
  }

  it('preserves generated files and command evidence when executor output is malformed', () => {
    const sessionMessages: AgentMessage[] = [
      msg({ tool: 'write_project_file', content: JSON.stringify({ path: 'src/generated.txt', written: true, bytes: 10 }) }),
      msg({ tool: 'run_project_command', content: JSON.stringify({ id: 'proc-1', command: 'npm test', status: 'exited', exitCode: 0, timedOut: false, output: 'ok' }) }),
    ];
    const fallback = buildExecutorFallbackResult(JSON.stringify({ card_id: 'code-1', summary: 'malformed' }), { cardId: 'code-1', sessionMessages, reason: 'parse_failure' });
    expect(fallback).not.toBeNull();
    expect(fallback!.status).toBe('failed');
    expect(fallback!.status_text).toContain('malformed');
    expect(fallback!.artifacts).toEqual([]);
    expect(fallback!.result?.generated_files).toEqual(['src/generated.txt']);
    expect(fallback!.result?.artifact_paths).toEqual([]);
    expect(fallback!.fallback_with_evidence).toEqual({ reason: 'parse_failure' });
  });

  it('stamps fallback_with_evidence reason for each F20 fallback call site', () => {
    const sessionMessages: AgentMessage[] = [
      msg({ tool: 'write_project_file', content: JSON.stringify({ path: 'src/x.txt', written: true, bytes: 1 }) }),
    ];
    const reasons = ['tool_calls_envelope_recovery', 'self_check_recovery', 'parse_failure'] as const;
    for (const reason of reasons) {
      const fb = buildExecutorFallbackResult(JSON.stringify({ card_id: 'c', summary: 's' }), { cardId: 'c', sessionMessages, reason });
      expect(fb).not.toBeNull();
      expect(fb!.fallback_with_evidence).toEqual({ reason });
    }
  });
});

describe('parseReviewerResult', () => {
  it('parses canonical reviewer assessments through reviewerResultSchema', () => {
    const raw = JSON.stringify({ assessment: { result: 'needs_corrections', summary: 'One blocker remains', achieved: ['Feature mostly works'], issues: [{ summary: 'Need test evidence', severity: 'blocker', evidence_card_id: 'test-1', recommendation: 'Run focused tests' }], evidence_card_ids: ['code-1'] } });
    const parsed = parseReviewerResult(raw);
    expect(parsed.assessment.result).toBe('needs_corrections');
    expect(parsed.assessment.issues[0]).toEqual(expect.objectContaining({ severity: 'blocker', recommendation: 'Run focused tests' }));
  });

  it('rejects legacy reviewer fail and missing shapes with ResultParseError', () => {
    const legacy = JSON.stringify({ assessment: { result: 'fail', summary: 'Not done', achieved: [], missing: ['tests'], evidence_card_ids: ['code-1'] } });
    expect(() => parseReviewerResult(legacy)).toThrow(ResultParseError);
    try {
      parseReviewerResult(legacy);
    } catch (err) {
      expect(err).toBeInstanceOf(ResultParseError);
      expect((err as ResultParseError).issues.join('\n')).toMatch(/assessment\.(result|issues|missing)/);
    }
  });

  it('rejects otherwise canonical reviewer assessments that include legacy missing', () => {
    const legacy = JSON.stringify({ assessment: { result: 'needs_corrections', summary: 'Not done', achieved: [], issues: [], missing: ['tests'], evidence_card_ids: ['code-1'] } });
    expect(() => parseReviewerResult(legacy)).toThrow(ResultParseError);
  });
});

describe('isRecoverableParseError', () => {
  it('returns true for ResultParseError', () => {
    expect(isRecoverableParseError(new ResultParseError('test', {}, []))).toBe(true);
  });

  it('returns false for other errors', () => {
    expect(isRecoverableParseError(new Error('test'))).toBe(false);
  });
});
