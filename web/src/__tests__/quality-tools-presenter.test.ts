import { expect, it } from 'vitest';
import { presentToolResult } from '../utils/tool-presenters';

it('shows quality coverage, omissions and mutable work evidence without implying acceptance', () => {
  const view = presentToolResult(JSON.stringify({ success: false, error: 'Incomplete typed coverage', data: {
    operation: 'code-quality.typescript.eslint', contract_version: 1, invocation_id: 'fixture',
    outcome: 'analysis_failed', summary: 'Incomplete typed coverage',
    values: { finding_count: 4, coverage_complete: false },
    report: 'Shown findings:2; omitted findings:2. Full evidence is linked.',
    artifacts: [{ path: 'work:///quality/fixture/findings.json', size_bytes: 1200 }],
  } }), { tool: 'code_quality_typescript_eslint' });
  const text = JSON.stringify(view);
  expect(text).toContain('Analysis evidence');
  expect(text).toContain('not acceptance');
  expect(text).toContain('omitted findings:2');
  expect(text).toContain('coverage_complete');
  expect(text).toContain('work:///quality/fixture/findings.json');
});
