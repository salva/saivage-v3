import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(process.cwd(), 'scripts/check-canonical-persistence-drift.js');
const CARD_RECORD_DOCS = [
  'README.md',
  'README-IF-YOU-ARE-AN-AI.md',
  'docs/spec/system-specification.md',
  'docs/spec/operator-ui.md',
  'docs/architecture/system-architecture.md',
  'docs/architecture/index.md',
  'docs/runbook/index.md',
];
const NONCANONICAL_DOCS = [
  'docs/spec/extra.md',
  'docs/architecture/extra.md',
  'docs/runbook/extra.md',
];
const POSITIVE_OWNERS = [
  ['docs/spec/system-specification.md', 'card.jsonl'],
  ['docs/spec/system-specification.md', 'record-<stem>.jsonl'],
  ['docs/architecture/system-architecture.md', 'card.jsonl'],
  ['docs/architecture/system-architecture.md', 'record-<stem>.jsonl'],
  ['docs/runbook/index.md', 'card.jsonl'],
  ['docs/runbook/index.md', 'record-<stem>.jsonl'],
  ['docs/spec/operator-ui.md', 'one strict stream'],
];
const GUIDE_REQUIREMENTS = [
  '## Stage 4 — Initialize and configure',
  '## Stage 5 — Confine access, install, and start',
  '## Stage 6 — Verify and teach first use',
  '## Stage 7 — Hand off and present later options',
  'docs/spec/system-specification.md#9-direct-file-persistence',
  'docs/runbook/index.md#storage-and-interruption',
  'no live lifecycle owner',
  'four generated roots wholesale',
  'permanently destroys generated cards, records, conversations, and history',
  'before the first listener',
  'Requires=nftables.service',
  'After that actual restart, prove all of the following again:',
  'stop and disable',
  'Authorization header',
  'never in a URL',
];
const CARD_RECORD_CATEGORIES = [
  ['card/authored-record index.json authority', 'card index.json'],
  ['card/authored-record index/head selection authority', 'indexed head'],
  ['random immutable card/record artifact naming', 'N-<uuid>.json'],
  ['cumulative card/authored-record index/catalog authority', 'card cumulative index'],
  ['optional existing-empty card/record authority', 'strictly empty'],
  ['existing-empty app-log acceptance', 'missing or truly zero-byte'],
  ['positive migration instruction', 'migrate'],
  ['positive fallback instruction', 'falls back to'],
  ['positive compatibility/probing/old-layout instruction', 'format probing'],
  ['positive mixed-format/dual-path instruction', 'mixed-format'],
  ['unprefixed physical record-name-to-.jsonl mapping', '${stem}.jsonl'],
  ['head-token/prior-head mutation authority', 'expected_head'],
  ['retired card/record historical-unavailability and unindexed-artifact language', 'historical-unavailable'],
];

function write(root, path, content) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function run(root) {
  return spawnSync(process.execPath, ['scripts/check-canonical-persistence-drift.js'], { cwd: root, encoding: 'utf8' });
}

function withRepository(testFn) {
  const root = mkdtempSync(join(tmpdir(), 'saivage-persistence-drift-'));
  try {
    write(root, 'scripts/check-canonical-persistence-drift.js', readFileSync(SCRIPT, 'utf8'));
    write(root, 'src/persistence/layout.ts', "export function cardStreamFile() { return 'card.jsonl'; }\n");
    write(root, 'src/schemas/record-name.ts', 'export function recordStreamFilename(stem) { return `record-${stem}.jsonl`; }\n');
    write(root, 'README.md', '# Fixture\n');
    write(root, 'README-IF-YOU-ARE-AN-AI.md', `${GUIDE_REQUIREMENTS.join('\n')}\n`);
    write(root, 'docs/spec/system-specification.md', 'card.jsonl\nrecord-<stem>.jsonl\n');
    write(root, 'docs/spec/operator-ui.md', 'one strict stream\n');
    write(root, 'docs/architecture/system-architecture.md', 'card.jsonl\nrecord-<stem>.jsonl\n');
    write(root, 'docs/architecture/index.md', '# Architecture\n');
    write(root, 'docs/runbook/index.md', 'card.jsonl\nrecord-<stem>.jsonl\n');
    for (const path of NONCANONICAL_DOCS) write(root, path, '# Extra\n');
    const initialized = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
    expect(initialized.status).toBe(0);
    const added = spawnSync('git', ['add', '.'], { cwd: root, encoding: 'utf8' });
    expect(added.status).toBe(0);
    expect(run(root).status).toBe(0);
    testFn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function append(root, path, content) {
  writeFileSync(join(root, path), `${readFileSync(join(root, path), 'utf8')}${content}\n`);
}

function removeExact(root, path, phrase) {
  const target = join(root, path);
  const content = readFileSync(target, 'utf8');
  expect(content).toContain(phrase);
  writeFileSync(target, content.replace(phrase, 'removed-fixture-phrase'));
}

describe('canonical persistence drift documentation scopes', () => {
  it.each(CARD_RECORD_DOCS)('applies cardRecordDocRules to exact canonical path %s', (path) => {
    withRepository((root) => {
      append(root, path, 'card index.json');
      const result = run(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`${path}:`);
      expect(result.stderr).toContain('card/authored-record index.json authority');
    });
  });

  it.each(NONCANONICAL_DOCS)('does not broaden cardRecordDocRules to %s', (path) => {
    withRepository((root) => {
      append(root, path, 'card index.json');
      expect(run(root).status).toBe(0);
    });
  });

  it.each([
    'README.md',
    'README-IF-YOU-ARE-AN-AI.md',
    'docs/spec/system-specification.md',
    'docs/spec/extra.md',
    'docs/architecture/system-architecture.md',
    'docs/architecture/extra.md',
    'docs/runbook/index.md',
    'docs/runbook/extra.md',
  ])('applies allDocRules across the full documentation universe at %s', (path) => {
    withRepository((root) => {
      append(root, path, 'latest closed');
      const result = run(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`${path}:`);
      expect(result.stderr).toContain('retired model-tool/old-contract guidance');
    });
  });

  it('applies allDocRules to an included untracked document', () => {
    withRepository((root) => {
      write(root, 'docs/spec/untracked.md', 'latest closed\n');
      const result = run(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('docs/spec/untracked.md:');
      expect(result.stderr).toContain('retired model-tool/old-contract guidance');
    });
  });

  it('ignores documents outside both documentation scopes', () => {
    withRepository((root) => {
      write(root, 'notes/outside.md', 'card index.json\nlatest closed\n');
      expect(run(root).status).toBe(0);
    });
  });

  it.each(CARD_RECORD_CATEGORIES)('retains the %s prohibited category', (label, text) => {
    withRepository((root) => {
      append(root, 'README.md', text);
      const result = run(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(label);
    });
  });

  it('retains the all-document prohibited category', () => {
    withRepository((root) => {
      append(root, 'docs/spec/extra.md', 'latest closed');
      expect(run(root).stderr).toContain('retired model-tool/old-contract guidance');
    });
  });

  it('does not require persistence definitions in README or the AI guide', () => {
    withRepository((root) => {
      expect(readFileSync(join(root, 'README.md'), 'utf8')).not.toContain('card.jsonl');
      expect(readFileSync(join(root, 'README-IF-YOU-ARE-AN-AI.md'), 'utf8')).not.toContain('card.jsonl');
      expect(run(root).status).toBe(0);
    });
  });

  it.each(POSITIVE_OWNERS)('requires positive canonical phrase in %s: %s', (path, phrase) => {
    withRepository((root) => {
      removeExact(root, path, phrase);
      const result = run(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`${path}: missing required exact-stream assertion '${phrase}'`);
    });
  });

  it.each(GUIDE_REQUIREMENTS)('requires independent AI-guide procedure phrase %s', (phrase) => {
    withRepository((root) => {
      removeExact(root, 'README-IF-YOU-ARE-AN-AI.md', phrase);
      const result = run(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`missing required Stage 4-7 assertion '${phrase}'`);
    });
  });
});
