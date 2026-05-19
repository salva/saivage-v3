import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyRunbookExamples } from '../../scripts/check-runbook-curl-examples.js';

function withRunbook(markdown, testFn) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-runbook-test-'));
  try {
    mkdirSync(join(projectRoot, 'docs', 'runbook'), { recursive: true });
    writeFileSync(join(projectRoot, 'docs', 'runbook', 'operations.md'), markdown);
    testFn(projectRoot);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

const ROUTES = new Set([
  'GET /health',
  'GET /api/state',
  'POST /api/runtime/pause',
  'POST /api/runtime/resume',
  'POST /api/runtime/freeze',
  'POST /api/runtime/resume-from-freeze',
]);

const VALID_MARKDOWN = `# Fixture runbook

\`\`\`bash
curl http://localhost:8080/health
\`\`\`

Expected status: \`200\`.

Expected top-level JSON keys: \`status\`, \`version\`, \`project\`, \`runtime\`.

\`\`\`bash
curl -H "Authorization: Bearer $SAIVAGE_API_TOKEN" http://localhost:8080/api/state
\`\`\`

Expected status: \`200\`.

Expected top-level JSON keys: \`runtime\`, \`cardIndex\`.

\`\`\`bash
curl -X POST http://localhost:8080/api/runtime/pause -H "Authorization: Bearer $SAIVAGE_API_TOKEN"
\`\`\`

Expected status: \`200\`.

Expected top-level JSON keys: \`status\`, \`project_id\`, \`pid\`, \`started_at\`, \`paused\`, \`queue\`, \`running_processes\`, \`updated_at\`.

\`\`\`bash
curl -X POST http://localhost:8080/api/runtime/resume -H "Authorization: Bearer $SAIVAGE_API_TOKEN"
\`\`\`

Expected status: \`200\`.

Expected top-level JSON keys: \`status\`, \`project_id\`, \`pid\`, \`started_at\`, \`paused\`, \`queue\`, \`running_processes\`, \`updated_at\`.

\`\`\`bash
curl -X POST http://localhost:8080/api/runtime/freeze -H "Authorization: Bearer $SAIVAGE_API_TOKEN" -d '{"reason":"test"}'
\`\`\`

Expected status: \`200\`.

Expected top-level JSON keys: \`status\`, \`freeze_id\`, \`reason\`, \`created_at\`.

\`\`\`bash
curl -X POST http://localhost:8080/api/runtime/resume-from-freeze -H "Authorization: Bearer $SAIVAGE_API_TOKEN"
\`\`\`

Expected status: \`200\`.

Expected top-level JSON keys: \`status\`, \`freeze_id\`, \`restored_queue\`, \`restored_processes\`, \`restored_card_id\`.
`;

describe('runbook curl/http example checker', () => {
  it('passes for documented runtime control examples with semantic top-level keys', () => {
    withRunbook(VALID_MARKDOWN, (projectRoot) => {
      const result = verifyRunbookExamples({ projectRoot, implementedRoutes: ROUTES });
      expect(result.ok).toBe(true);
      expect(result.failures).toEqual([]);
    });
  });

  it('fails stale endpoint examples whose route is not implemented', () => {
    withRunbook(`${VALID_MARKDOWN}\n\`\`\`bash\ncurl http://localhost:8080/api/runtime/dispatch\n\`\`\`\n`, (projectRoot) => {
      const result = verifyRunbookExamples({ projectRoot, implementedRoutes: ROUTES });
      expect(result.ok).toBe(false);
      expect(result.failures).toContainEqual(expect.stringContaining('documents GET /api/runtime/dispatch, but no matching Fastify route exists'));
    });
  });

  it('fails wrong methods for existing paths', () => {
    const markdown = VALID_MARKDOWN.replace('curl -X POST http://localhost:8080/api/runtime/pause', 'curl -X GET http://localhost:8080/api/runtime/pause');
    withRunbook(markdown, (projectRoot) => {
      const result = verifyRunbookExamples({ projectRoot, implementedRoutes: ROUTES });
      expect(result.ok).toBe(false);
      expect(result.failures).toContainEqual(expect.stringContaining('documents GET /api/runtime/pause, but no matching Fastify route exists'));
      expect(result.failures).toContain('docs/runbook/*.md must include a curl/http example for POST /api/runtime/pause');
    });
  });

  it('fails mismatched documented top-level response keys', () => {
    const markdown = VALID_MARKDOWN.replace('Expected top-level JSON keys: `runtime`, `cardIndex`.', 'Expected top-level JSON keys: `runtime`, `missingKey`.');
    withRunbook(markdown, (projectRoot) => {
      const result = verifyRunbookExamples({ projectRoot, implementedRoutes: ROUTES });
      expect(result.ok).toBe(false);
      expect(result.failures).toContainEqual(expect.stringContaining('GET /api/state response missing top-level key(s): missingKey'));
    });
  });
});
