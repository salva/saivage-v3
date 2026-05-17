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
    const fallback = buildExecutorFallbackResult(JSON.stringify({ card_id: 'code-1', summary: 'malformed' }), { cardId: 'code-1', sessionMessages });
    expect(fallback).not.toBeNull();
    expect(fallback!.status).toBe('failed');
    expect(fallback!.status_text).toContain('malformed');
  });
});

describe('parseReviewerResult', () => {
  it('parses reviewer assessments', () => {
    const raw = JSON.stringify({ assessment: { result: 'pass', summary: 'All criteria met', achieved: ['Feature works'], missing: [], evidence_card_ids: ['code-1'] } });
    expect(parseReviewerResult(raw).assessment.result).toBe('pass');
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
