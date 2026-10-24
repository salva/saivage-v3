import { expect, it } from '@jest/globals';
import { interpretRuffResult } from '../../src/quality/ruff-analysis.js';

const file = '/fixture/defect.py';
const finding = { cell: null, code: 'F821', end_location: { row: 1, column: 19 }, filename: file,
  fix: null, location: { row: 1, column: 7 }, message: 'Undefined name `missing_name`',
  name: 'undefined-name', noqa_row: 1, severity: 'error', url: 'https://docs.astral.sh/ruff/rules/undefined-name' };
it('preserves the qualified native severity/range and distinguishes findings from failed coverage', () => {
  expect(interpretRuffResult(1, JSON.stringify([finding]), [file], [file]))
    .toMatchObject({ disposition: 'findings', findings: [finding] });
  expect(interpretRuffResult(0, '[]', [file], [file]).disposition).toBe('clean');
  expect(interpretRuffResult(0, '[]', [], [file]).disposition).toBe('analysis_failed');
  expect(interpretRuffResult(0, '[]', [], []).disposition).toBe('analysis_failed');
  expect(interpretRuffResult(2, 'bad config, not JSON', [], [file]).disposition).toBe('analysis_failed');
  expect(interpretRuffResult(1, JSON.stringify([{ ...finding, code: 'invalid-syntax' }]), [file], [file]).disposition)
    .toBe('analysis_failed');
  expect(() => interpretRuffResult(0, JSON.stringify([finding]), [file], [file])).toThrow(/contradicts/);
  expect(() => interpretRuffResult(1, JSON.stringify([finding]), [], [file])).toThrow(/outside/);
  expect(() => interpretRuffResult(1, '[', [file], [file])).toThrow();
});
