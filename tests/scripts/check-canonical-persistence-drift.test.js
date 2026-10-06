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
  'docs/spec/operator-ui-needs.md',
  'docs/spec/operator-ui-contracts.md',
  'docs/architecture/system-architecture.md',
  'docs/architecture/index.md',
  'docs/runbook/index.md',
];
const NONCANONICAL_DOCS = [
  'docs/spec/extra.md',
  'docs/architecture/extra.md',
  'docs/runbook/extra.md',
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
  ['optional existing-empty card/record authority', 'card index is strictly empty'],
  ['existing-empty app-log acceptance', 'missing or truly zero-byte'],
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
    write(root, 'src/persistence/layout.ts', "export function cardHeadFile() { return 'card-head.json'; }\nexport function cardHistoryRoot() { return 'card-history'; }\nexport function cardMailboxRoot() { return 'mailbox'; }\nexport function cardAcceptedRecordsRoot() { return 'accepted'; }\n");
    write(root, 'src/schemas/record-name.ts', 'export function recordHeadFilename(stem) { return `record-${stem}.json`; }\n');
    write(root, 'README.md', '# Fixture\n');
    write(root, 'README-IF-YOU-ARE-AN-AI.md', `${GUIDE_REQUIREMENTS.join('\n')}\n`);
    write(root, 'docs/spec/system-specification.md', '# Specification\n');
    write(root, 'docs/spec/operator-ui-needs.md', '# Operator UI needs\n');
    write(root, 'docs/spec/operator-ui-contracts.md', '# UI contracts\n');
    write(root, 'docs/architecture/system-architecture.md', '# Architecture\n');
    write(root, 'docs/architecture/index.md', '# Architecture\n');
    write(root, 'docs/runbook/index.md', '# Runbook\n');
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
  it.each([
    ['docs/spec/system-specification.md', "Initial card publication establishes sessions for the distinct card-scoped node agents in that card type's compiled workflow, not a fixed list of role names. Initial runtime publication additionally establishes the selected global Analyst conversation. The same layout requirement applies to selected global Oversight once an actual check establishes it; a never-established Oversight conversation remains legitimately absent. Required Analyst/card indexes remain required, and directories alone do not establish session identity or authorize discovering sessions."],
    ['docs/spec/system-specification.md', 'This is a producer layout requirement, not a runtime admission guarantee. Empty-index reads and startup can succeed without accessing `versions/`; file-content validation and readiness do not certify every future publication parent. First-segment and compacted-successor publication rely on the established directory and fail at actual use if it is missing. No directory sweep, append-time mkdir, automatic repair, stronger startup rejection, remembered admission, or storage coordination follows from this requirement.'],
    ['docs/architecture/system-architecture.md', 'An established index retains its root and `versions/` requirement even before any segment exists. Empty-index selection returns no segment without reading `versions/`; first ingress and compaction use exact segment paths and same-directory fresh publication without creating parents. The initially empty mailbox and the card-established accepted-record parent similarly support later direct publication. Missing parents fail at the consuming publication, not through a layout preflight or automatic repair. Optional record heads and provider evidence need not exist merely because their parent does.'],
  ])('accepts unchanged established-directory excerpt in %s: %s', (path, text) => {
    withRepository((root) => {
      append(root, path, text);
      const result = run(root);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    });
  });

  it.each([
    'Empty conversation catalogs are legitimate.',
    'The conversation index is strictly empty.',
    'Empty session catalogs select no current segment.',
    'The session index is strictly empty.',
    'Analyst/card indexes remain required.',
    'Empty-index selection returns no segment.',
    'The optional index is empty.',
    'The declared index is empty.',
    'Empty optional indexes select no segment.',
    'Empty declared indexes select no segment.',
    'The catalog is strictly empty.',
  ])('accepts non-card/record empty-catalog language: %s', (text) => {
    withRepository((root) => {
      append(root, 'README.md', text);
      const result = run(root);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    });
  });

  it.each([
    ['Card indexes are authoritative.', 'cumulative card/authored-record index/catalog authority'],
    ['Record indexes are authoritative.', 'cumulative card/authored-record index/catalog authority'],
    ['The card index is strictly empty.', 'optional existing-empty card/record authority'],
    ['The record index is strictly empty.', 'optional existing-empty card/record authority'],
    ['Empty card index is valid.', 'optional existing-empty card/record authority'],
    ['Empty record index is valid.', 'optional existing-empty card/record authority'],
    ['The authored-record catalog is empty.', 'optional existing-empty card/record authority'],
    ['Empty authored-record catalog is valid.', 'optional existing-empty card/record authority'],
    ['Analyst/card indexes and empty conversation catalogs use `versions/`; card indexes are authoritative.', 'cumulative card/authored-record index/catalog authority'],
    ['No card indexes are used. Record indexes are authoritative.', 'cumulative card/authored-record index/catalog authority'],
  ])('rejects explicit retired authority: %s', (text, label) => {
    withRepository((root) => {
      append(root, 'README.md', text);
      const result = run(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('README.md:');
      expect(result.stderr).toContain(label);
    });
  });

  it('keeps negation local to each index assertion', () => {
    withRepository((root) => {
      append(root, 'README.md', 'No card indexes are used.');
      const accepted = run(root);
      expect(accepted.status).toBe(0);
      expect(accepted.stderr).toBe('');
      append(root, 'README.md', 'No card indexes are used. Record indexes are authoritative.');
      const rejected = run(root);
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain('cumulative card/authored-record index/catalog authority');
      expect(rejected.stderr).toContain('README.md:3:');
    });
  });

  it.each([
    ['src/persistence/card-files.ts', 'readdirSync(root);', 'canonical version discovery is forbidden'],
    ['src/persistence/layout.ts', 'cardVersionIndexFile(root);', "retired card/authored-record identifier 'cardVersionIndexFile'"],
    ['src/persistence/provider-exchange-log.ts', 'readAppLogEntries(root);', 'selected provider evidence must use only its exact owner stream'],
  ])('retains exact source restrictions in %s', (path, text, label) => {
    withRepository((root) => {
      if (path === 'src/persistence/layout.ts') append(root, path, text);
      else write(root, path, `${text}\n`);
      const result = run(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${path}: ${label}`);
    });
  });

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

  it.each(['cardHeadFile', 'cardHistoryRoot', 'cardMailboxRoot', 'cardAcceptedRecordsRoot'])('requires owner path helper %s', (helper) => {
    withRepository((root) => {
      removeExact(root, 'src/persistence/layout.ts', helper);
      const result = run(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`missing exact owner path helper ${helper}`);
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
