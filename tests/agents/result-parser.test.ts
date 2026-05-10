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
} from '../../src/agents/result-parser.js';

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
      declare_done: false,
    });
    const result = parsePlannerResult(raw);
    expect(result.declare_done).toBe(false);
    expect(result.created_cards).toHaveLength(1);
    expect(result.created_cards[0].title).toBe('Implement X');
  });

  it('should parse declare_done planner result', () => {
    const raw = JSON.stringify({
      created_cards: [],
      updated_cards: [],
      declare_done: true,
    });
    const result = parsePlannerResult(raw);
    expect(result.declare_done).toBe(true);
  });

  it('should default empty fields', () => {
    const raw = JSON.stringify({
      created_cards: [],
      updated_cards: [],
      declare_done: false,
    });
    const result = parsePlannerResult(raw);
    expect(result.created_cards).toEqual([]);
    expect(result.updated_cards).toEqual([]);
    expect(result.declare_done).toBe(false);
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
      artifacts: [
        { type: 'report', description: 'Test report', retain: true },
      ],
      attachments: [],
    });
    const result = parseExecutorResult(raw);
    expect(result.status).toBe('done');
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].type).toBe('report');
  });

  it('should parse a failed executor result', () => {
    const raw = JSON.stringify({
      status: 'failed',
      error: 'Something went wrong',
      artifacts: [],
      attachments: [],
    });
    const result = parseExecutorResult(raw);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Something went wrong');
  });

  it('should throw on invalid status', () => {
    expect(() =>
      parseExecutorResult(JSON.stringify({ status: 'invalid', artifacts: [], attachments: [] })),
    ).toThrow(ResultParseError);
  });

  it('should throw on missing required fields', () => {
    expect(() => parseExecutorResult('{}')).toThrow(ResultParseError);
  });
});

describe('parseReviewerResult', () => {
  it('should parse a pass assessment', () => {
    const raw = JSON.stringify({
      assessment: {
        result: 'pass',
        summary: 'All criteria met',
        achieved: ['Feature X works'],
        missing: [],
        evidence_card_ids: ['code-1'],
      },
    });
    const result = parseReviewerResult(raw);
    expect(result.assessment.result).toBe('pass');
    expect(result.assessment.achieved).toHaveLength(1);
    expect(result.assessment.missing).toHaveLength(0);
  });

  it('should parse a fail assessment', () => {
    const raw = JSON.stringify({
      assessment: {
        result: 'fail',
        summary: 'Missing feature Y',
        achieved: ['Feature X works'],
        missing: ['Feature Y not implemented'],
        evidence_card_ids: ['code-1'],
      },
    });
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
