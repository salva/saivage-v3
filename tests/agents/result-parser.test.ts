/**
 * Tests for result-parser.ts — structured result parsing
 */

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
    const result = extractJson('{"key": "value"}');
    expect(result).toEqual({ key: 'value' });
  });

  it('should extract JSON from markdown code block', () => {
    const result = extractJson('```json\n{"key": "value"}\n```');
    expect(result).toEqual({ key: 'value' });
  });

  it('should extract JSON from untyped code block', () => {
    const result = extractJson('```\n{"key": "value"}\n```');
    expect(result).toEqual({ key: 'value' });
  });

  it('should find first JSON object in text', () => {
    const result = extractJson('Some text before {"key": "value"} some text after');
    expect(result).toEqual({ key: 'value' });
  });

  it('should throw on non-JSON input', () => {
    expect(() => extractJson('no json here at all')).toThrow(ResultParseError);
  });
});

describe('parsePlannerResult', () => {
  it('should parse a valid planner result', () => {
    const raw = JSON.stringify({
      created_cards: [
        { type: 'code', title: 'Implement X', description: 'Do it', status: 'backlog', depends_on: [], priority: 1 },
      ],
      updated_cards: [],
      status: 'continue',
    });
    const result = parsePlannerResult(raw);
    expect(result.status).toBe('continue');
    expect(result.created_cards).toHaveLength(1);
    expect(result.created_cards[0].title).toBe('Implement X');
  });

  it('should parse done planner result', () => {
    const raw = JSON.stringify({ created_cards: [], updated_cards: [], status: 'done' });
    const result = parsePlannerResult(raw);
    expect(result.status).toBe('done');
  });

  it('should parse blocked planner result', () => {
    const raw = JSON.stringify({ status: 'blocked', blocked_reason: 'Needs parent planner input', created_cards: [], updated_cards: [] });
    const result = parsePlannerResult(raw);
    expect(result.status).toBe('blocked');
    expect(result.blocked_reason).toBe('Needs parent planner input');
  });

  it('should accept null blocked_reason for non-blocked planner results', () => {
    const raw = JSON.stringify({ status: 'continue', blocked_reason: null, created_cards: [], updated_cards: [], summary: 'Continue planning.' });
    const result = parsePlannerResult(raw);
    expect(result.status).toBe('continue');
    expect(result.blocked_reason).toBeUndefined();
  });

  it('should default empty fields', () => {
    const raw = JSON.stringify({ created_cards: [], updated_cards: [], status: 'continue' });
    const result = parsePlannerResult(raw);
    expect(result.created_cards).toEqual([]);
    expect(result.updated_cards).toEqual([]);
    expect(result.status).toBe('continue');
  });

  it('should throw on invalid planner result', () => {
    expect(() => parsePlannerResult('{"created_cards": "not-an-array"}')).toThrow(ResultParseError);
  });

  it('should handle partial output gracefully', () => {
    expect(() => parsePlannerResult('not json')).toThrow(ResultParseError);
  });
});

describe('parseExecutorResult', () => {
  it('should parse a valid executor result with done status', () => {
    const raw = JSON.stringify({
      card_id: 'code-1',
      status: 'done',
      result: { output: 'success' },
      artifacts: [{ type: 'report', description: 'Test report', retain: true }],
      attachments: [],
    });
    const result = parseExecutorResult(raw);
    expect(result.status).toBe('done');
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].type).toBe('report');
  });

  it('should parse a failed executor result', () => {
    const raw = JSON.stringify({ status: 'failed', error: 'Something went wrong', artifacts: [], attachments: [] });
    const result = parseExecutorResult(raw);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Something went wrong');
  });

  it('should throw on invalid status', () => {
    expect(() => parseExecutorResult(JSON.stringify({ status: 'invalid', artifacts: [], attachments: [] }))).toThrow(ResultParseError);
  });

  it('should throw on missing required fields', () => {
    expect(() => parseExecutorResult('{}')).toThrow(ResultParseError);
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

  it('preserves generated files, command evidence, and partial artifacts when status is missing', () => {
    const sessionMessages: AgentMessage[] = [
      msg({ tool: 'write_project_file', content: JSON.stringify({ path: 'src/generated.txt', written: true, bytes: 10 }) }),
      msg({ tool: 'run_project_command', content: JSON.stringify({ id: 'proc-1', command: 'npm test', status: 'exited', exitCode: 0, timedOut: false, output: 'ok' }) }),
    ];

    const fallback = buildExecutorFallbackResult(
      JSON.stringify({
        card_id: 'code-1',
        artifacts: [{ type: 'report', description: 'Generated report', retain: true, sourceFile: 'reports/out.txt' }],
        attachments: [{ mime: 'text/plain', title: 'stdout', sourceFile: 'reports/stdout.log' }],
        result: { note: 'partial' },
        summary: 'work finished but malformed',
      }),
      { cardId: 'code-1', sessionMessages },
    );

    expect(fallback).not.toBeNull();
    expect(fallback!.card_id).toBe('code-1');
    expect(fallback!.status).toBe('failed');
    expect(fallback!.artifacts.map((artifact) => artifact.sourceFile)).toEqual(expect.arrayContaining(['reports/out.txt', 'src/generated.txt']));
    expect(fallback!.attachments).toHaveLength(1);
    expect(fallback!.result?.generated_files).toEqual(['src/generated.txt']);
    expect(fallback!.result?.verification_commands).toEqual([
      expect.objectContaining({ command: 'npm test', process_id: 'proc-1', status: 'exited', exit_code: 0, timed_out: false }),
    ]);
    expect(fallback!.result?.parse_failure).toEqual(expect.objectContaining({ message: expect.stringContaining('preserved tool evidence') }));
  });

  it('returns null when there is no tool or partial evidence to preserve', () => {
    const fallback = buildExecutorFallbackResult('not json', { cardId: 'code-1', sessionMessages: [] });
    expect(fallback).toBeNull();
  });
});

describe('parseReviewerResult', () => {
  it('should parse a pass assessment', () => {
    const raw = JSON.stringify({ assessment: { result: 'pass', summary: 'All criteria met', achieved: ['Feature X works'], missing: [], evidence_card_ids: ['code-1'] } });
    const result = parseReviewerResult(raw);
    expect(result.assessment.result).toBe('pass');
    expect(result.assessment.achieved).toHaveLength(1);
    expect(result.assessment.missing).toHaveLength(0);
  });

  it('should parse a fail assessment', () => {
    const raw = JSON.stringify({ assessment: { result: 'fail', summary: 'Missing feature Y', achieved: ['Feature X works'], missing: ['Feature Y not implemented'], evidence_card_ids: ['code-1'] } });
    const result = parseReviewerResult(raw);
    expect(result.assessment.result).toBe('fail');
    expect(result.assessment.missing).toHaveLength(1);
  });

  it('should throw on invalid reviewer result', () => {
    expect(() => parseReviewerResult('{"assessment": {"result": "maybe"}}')).toThrow(ResultParseError);
  });

  it('should throw on missing assessment', () => {
    expect(() => parseReviewerResult('{}')).toThrow(ResultParseError);
  });
});

describe('isRecoverableParseError', () => {
  it('should return true for ResultParseError', () => {
    const err = new ResultParseError('test', {}, []);
    expect(isRecoverableParseError(err)).toBe(true);
  });

  it('should return false for other errors', () => {
    expect(isRecoverableParseError(new Error('test'))).toBe(false);
  });
});
