import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sourceUrl = (path: string) => pathToFileURL(resolve('src', path)).href;

describe('fresh-process public entry evaluation', () => {
  for (const entry of ['tools/invocation.ts', 'persistence/index.ts', 'redaction/index.ts']) {
    it(`initializes the unsupported invocation policy when ${entry} is first`, () => {
      const script = `
        import ${JSON.stringify(sourceUrl(entry))};
        import { selectInvocationResultPolicy } from ${JSON.stringify(sourceUrl('runtime/actors/llm-delivery-log.ts'))};
        import { UNSUPPORTED_TOOL_RESULT_POLICY_TEMPLATE } from ${JSON.stringify(sourceUrl('tools/invocation.ts'))};
        import { canonicalJson } from ${JSON.stringify(sourceUrl('schemas/index.ts'))};
        import { createHash } from 'node:crypto';
        import assert from 'node:assert/strict';

        const policy = selectInvocationResultPolicy({ compiledToolContracts: [] }, 'unknown-tool');
        const bytes = canonicalJson(UNSUPPORTED_TOOL_RESULT_POLICY_TEMPLATE);
        assert.strictEqual(policy.resultPolicyTemplate, UNSUPPORTED_TOOL_RESULT_POLICY_TEMPLATE);
        assert.strictEqual(policy.resultPolicyTemplateBytes, bytes);
        assert.strictEqual(policy.resultPolicyTemplateSha256, createHash('sha256').update(bytes).digest('hex'));
      `;
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    });
  }
});
