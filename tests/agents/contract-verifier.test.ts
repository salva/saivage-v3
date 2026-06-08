import { describe, it, expect } from '@jest/globals';
import { createContractVerifier } from '../../src/agents/contract-verifier.js';
import { createExecutorContract } from '../../src/contracts/executor-contract.js';
import { createPlannerContract } from '../../src/contracts/planner-contract.js';

const verifier = createContractVerifier();
const exec = createExecutorContract();
const planner = createPlannerContract();

describe('contract verifier', () => {
  describe('parseDoneArgs', () => {
    it('parses well-formed JSON arguments into an args record', () => {
      const parse = verifier.parseDoneArgs('tc-1', 'emit_executor_result', '{"status":"completed"}');
      expect(parse.kind).toBe('ok');
      if (parse.kind !== 'ok') return;
      expect(parse.toolCallId).toBe('tc-1');
      expect(parse.toolName).toBe('emit_executor_result');
      expect(parse.args).toEqual({ status: 'completed' });
    });

    it('rejects non-object JSON terminal args instead of coercing to empty args object', () => {
      const arr = verifier.parseDoneArgs('tc-2', 'emit_executor_result', '[1,2,3]');
      expect(arr.kind).toBe('not_object');
      if (arr.kind !== 'not_object') return;
      expect(arr.detail).toMatch(/JSON object/);
    });

    it('reports invalid_json when arguments are malformed', () => {
      const parse = verifier.parseDoneArgs('tc-3', 'emit_executor_result', '{not json');
      expect(parse.kind).toBe('invalid_json');
      if (parse.kind !== 'invalid_json') return;
      expect(parse.toolName).toBe('emit_executor_result');
      expect(parse.detail).toMatch(/JSON|token|Unexpected/);
    });
  });

  describe('check', () => {
    it('returns satisfied with envelope+terminalName when args match the executor contract', () => {
      const parse = verifier.parseDoneArgs(
        'tc-1',
        'emit_executor_result',
        JSON.stringify({ status: 'done', status_text: 'ok', summary: 'ok', card_id: 'c1' }),
      );
      const verdict = verifier.check(exec, parse);
      expect(verdict.kind).toBe('satisfied');
      if (verdict.kind !== 'satisfied') return;
      expect(verdict.terminalName).toBe('emit_executor_result');
      expect(verdict.envelope.status).toBe('done');
    });

    it('returns violated with envelope_schema_violation on bad envelope shape', () => {
      const parse = verifier.parseDoneArgs(
        'tc-1',
        'emit_executor_result',
        JSON.stringify({ status: 'no_such_status' }),
      );
      const verdict = verifier.check(exec, parse);
      expect(verdict.kind).toBe('violated');
      if (verdict.kind !== 'violated') return;
      expect(verdict.report.contractId).toBe('executor');
      expect(verdict.report.toolName).toBe('emit_executor_result');
      expect(verdict.report.proposed).toEqual({ status: 'no_such_status' });
      expect(verdict.report.obligations[0].code).toBe('envelope_schema_violation');
    });

    it('returns violated with envelope_invalid_json when parse failed', () => {
      const parse = verifier.parseDoneArgs('tc-1', 'emit_executor_result', '{nope');
      const verdict = verifier.check(exec, parse);
      expect(verdict.kind).toBe('violated');
      if (verdict.kind !== 'violated') return;
      expect(verdict.report.proposed).toBeNull();
      expect(verdict.report.obligations[0].code).toBe('envelope_invalid_json');
    });

    it('returns violated with terminal_args_not_object when terminal args are arrays/null/primitives', () => {
      for (const raw of ['[1,2,3]', 'null', 'true', '42', '"text"']) {
        const parse = verifier.parseDoneArgs('tc-1', 'emit_executor_result', raw);
        const verdict = verifier.check(exec, parse);
        expect(verdict.kind).toBe('violated');
        if (verdict.kind !== 'violated') continue;
        expect(verdict.report.proposed).toBeNull();
        expect(verdict.report.obligations[0].code).toBe('terminal_args_not_object');
      }
    });

    it('returns violated with envelope_field_invalid when tool name is not a contract terminal', () => {
      const parse = verifier.parseDoneArgs('tc-1', 'not_a_terminal', '{}');
      const verdict = verifier.check(exec, parse);
      expect(verdict.kind).toBe('violated');
      if (verdict.kind !== 'violated') return;
      expect(verdict.report.obligations[0].code).toBe('envelope_field_invalid');
    });

    it('accepts both planner terminals (multi-terminal contract)', () => {
      const r1 = verifier.check(
        planner,
        verifier.parseDoneArgs('tc-1', 'emit_planner_result', JSON.stringify({ status: 'continue', summary: 's' })),
      );
      expect(r1.kind).toBe('satisfied');
    });
  });

  describe('renderRepairMessage', () => {
    it('starts with the contract-rejection preamble and lists obligation codes', () => {
      const parse = verifier.parseDoneArgs('tc-1', 'emit_executor_result', '{nope');
      const verdict = verifier.check(exec, parse);
      if (verdict.kind !== 'violated') throw new Error('expected violated');
      const msg = verifier.renderRepairMessage(verdict.report);
      expect(msg).toMatch(/^Contract 'executor' rejected your last terminal signal/);
      expect(msg).toMatch(/\[envelope_invalid_json\]/);
    });
  });
});
