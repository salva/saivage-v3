import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyDocAuthorityMetadata } from '../../scripts/check-doc-authority-metadata.js';

function withFixture(files, testFn) {
  const root = mkdtempSync(join(tmpdir(), 'saivage-doc-authority-'));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = join(root, relativePath);
      mkdirSync(join(fullPath, '..'), { recursive: true });
      writeFileSync(fullPath, content);
    }
    testFn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const inventory = `# Documentation inventory

| Path | Classification | Justification | Primary code anchor | Disposition |
|---|---|---|---|---|
| \`README.md\` | current | Root landing page. | package.json:1 | keep |
| \`docs/index.md\` | current | Docs index. | docs/.vitepress/config.ts:1 | keep |
| \`docs/current.md\` | current | Current reference. | src/current.ts:1 | keep |
| \`docs/stale.md\` | stale | Stale context. | src/current.ts:1 | merge-into |
| \`docs/historical.md\` | historical | Historical provenance. | docs/current.md:1 | keep |
`;

const currentPage = `# Current

<!-- doc-authority
status: current
disposition: keep
owner: docs-maintainers
superseded_by: none
last_verified_against: src/current.ts:1
-->

Current guidance.
`;

const stalePage = `# Stale

<!-- doc-authority
status: stale
disposition: merge-into
owner: docs-maintainers
superseded_by: docs/current.md
last_verified_against: src/current.ts:1
-->

> **Authority status: stale.** This page is retained for context only. Prefer \`docs/current.md\` for current authority. See \`docs/documentation-inventory.md\` for disposition \`merge-into\`.

Old guidance.
`;

const historicalPage = `# Historical

<!-- doc-authority
status: historical
disposition: keep
owner: docs-maintainers
superseded_by: docs/current.md
last_verified_against: docs/current.md:1
-->

> **Authority status: historical.** This page is retained for provenance only. Prefer \`docs/current.md\` for current authority. See \`docs/documentation-inventory.md\` for disposition \`keep\`.

Old plan.
`;

const readme = `# Root

<!-- doc-authority
status: current
disposition: keep
owner: docs-maintainers
superseded_by: none
last_verified_against: package.json:1
-->

<!-- doc-authority-status:start -->
| Link | Authority status | Reader guidance |
|---|---|---|
| [Current](docs/current.md) | current authority | Prefer for implemented behavior. |
| [Stale](docs/stale.md) | stale context | Use only as context; prefer \`docs/current.md\`. |
| [Historical](docs/historical.md) | historical provenance | Provenance only; prefer \`docs/current.md\`. |
<!-- doc-authority-status:end -->
`;

const docsIndex = `# Docs

<!-- doc-authority
status: current
disposition: keep
owner: docs-maintainers
superseded_by: none
last_verified_against: docs/.vitepress/config.ts:1
-->

<!-- doc-authority-status:start -->
| Link | Authority status | Reader guidance |
|---|---|---|
| [Current](/current) | current authority | Prefer for implemented behavior. |
| [Stale](/stale) | stale context | Use only as context; prefer \`docs/current.md\`. |
| [Historical](/historical) | historical provenance | Provenance only; prefer \`docs/current.md\`. |
<!-- doc-authority-status:end -->
`;

function validFiles(overrides = {}) {
  return {
    'docs/documentation-inventory.md': inventory,
    'README.md': readme,
    'docs/index.md': docsIndex,
    'docs/current.md': currentPage,
    'docs/stale.md': stalePage,
    'docs/historical.md': historicalPage,
    ...overrides,
  };
}

describe('doc authority metadata guard', () => {
  it('passes when current and non-current metadata match inventory and status surfaces are labeled', () => {
    withFixture(validFiles(), (root) => {
      const result = verifyDocAuthorityMetadata({ root });
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.rowsChecked).toBe(5);
    });
  });

  it('fails clearly when stale metadata is missing superseded_by', () => {
    const badStale = stalePage.replace('superseded_by: docs/current.md\n', '');
    withFixture(validFiles({ 'docs/stale.md': badStale }), (root) => {
      const result = verifyDocAuthorityMetadata({ root });
      expect(result.ok).toBe(false);
      expect(result.errors.map((error) => error.message)).toContain('docs/stale.md: doc-authority metadata missing required field "superseded_by"');
    });
  });

  it('fails clearly when stale or historical pages are missing Authority status banners', () => {
    const badHistorical = historicalPage.replace(/> \*\*Authority status:[\s\S]*?\n\n/, '');
    withFixture(validFiles({ 'docs/historical.md': badHistorical }), (root) => {
      const result = verifyDocAuthorityMetadata({ root });
      expect(result.ok).toBe(false);
      expect(result.errors.map((error) => error.message)).toContain('docs/historical.md: non-current page must include a visible "Authority status:" banner within the first 35 lines');
    });
  });

  it('fails clearly when inventory classification and metadata status disagree', () => {
    const badCurrent = currentPage.replace('status: current', 'status: stale');
    withFixture(validFiles({ 'docs/current.md': badCurrent }), (root) => {
      const result = verifyDocAuthorityMetadata({ root });
      expect(result.ok).toBe(false);
      expect(result.errors.map((error) => error.message)).toContain('docs/current.md: metadata status "stale" must match inventory classification "current"');
    });
  });

  it('fails clearly when README or docs index links to non-current content without a status label', () => {
    const unlabeledReadme = readme.replace('| [Stale](docs/stale.md) | stale context | Use only as context; prefer `docs/current.md`. |', '- [Stale](docs/stale.md) — useful design details.');
    withFixture(validFiles({ 'README.md': unlabeledReadme }), (root) => {
      const result = verifyDocAuthorityMetadata({ root });
      expect(result.ok).toBe(false);
      expect(result.errors.map((error) => error.message)).toContain('README.md:15: link to non-current docs/stale.md must include status label "stale context" or explicit Authority status/See historical wording');
    });
  });

  it('documents strict verify mode by not rewriting invalid fixtures', () => {
    const missingSurface = readme.replace(/<!-- doc-authority-status:start -->[\s\S]*?<!-- doc-authority-status:end -->\n/, '');
    withFixture(validFiles({ 'README.md': missingSurface }), (root) => {
      const result = verifyDocAuthorityMetadata({ root });
      expect(result.ok).toBe(false);
      expect(result.errors.map((error) => error.message)).toContain('README.md: missing doc-authority-status delimited surface for prominent documentation links');
    });
  });
});
