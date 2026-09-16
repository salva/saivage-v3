const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const CHECKER = path.resolve(__dirname, '../../scripts/check-import-boundaries.cjs');
const ORIGINAL_TUPLE = ['src/agents/consumer.ts', 'cross-package-deep', 'cards/internal.js'];

function digest(tuples) {
  const serialized = tuples.map((tuple) => JSON.stringify(tuple)).sort();
  return createHash('sha256').update(JSON.stringify(serialized), 'utf8').digest('hex');
}

function baseline(totalViolations, violationDigest) {
  return `${JSON.stringify({ totalViolations, violationDigest })}\n`;
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'saivage-import-boundary-ratchet-'));
  mkdirSync(path.join(root, 'scripts'));
  mkdirSync(path.join(root, 'src/agents'), { recursive: true });
  mkdirSync(path.join(root, 'src/cards'), { recursive: true });
  cpSync(CHECKER, path.join(root, 'scripts/check-import-boundaries.cjs'));
  writeFileSync(path.join(root, 'src/agents/consumer.ts'), "import { value } from '../cards/internal.js';\nexport { value };\n");
  writeFileSync(path.join(root, 'src/cards/internal.ts'), 'export const value = 1;\n');
  writeFileSync(path.join(root, 'scripts/import-boundary-baseline.json'), baseline(1, digest([ORIGINAL_TUPLE])));
  return root;
}

function run(root) {
  return spawnSync(process.execPath, ['scripts/check-import-boundaries.cjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function output(result) {
  return `${result.stdout}${result.stderr}`;
}

function withFixture(fn) {
  const root = fixture();
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('unchanged violation identity succeeds', () => withFixture((root) => {
  const result = run(root);
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, new RegExp(digest([ORIGINAL_TUPLE])));
}));

test('equal-count target substitution fails with the actual digest', () => withFixture((root) => {
  writeFileSync(path.join(root, 'src/agents/consumer.ts'), "import { value } from '../cards/other.js';\nexport { value };\n");
  writeFileSync(path.join(root, 'src/cards/other.ts'), 'export const value = 2;\n');
  const actual = { totalViolations: 1, violationDigest: digest([['src/agents/consumer.ts', 'cross-package-deep', 'cards/other.js']]) };
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(output(result), new RegExp(`Actual: ${escapeRegExp(JSON.stringify(actual))}`));
  assert.match(output(result), /fix the new violations instead of blindly rebaselining/);
}));

test('line-only movement leaves the digest unchanged', () => withFixture((root) => {
  writeFileSync(path.join(root, 'src/agents/consumer.ts'), "\n\nimport { value } from '../cards/internal.js';\nexport { value };\n");
  const result = run(root);
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, new RegExp(digest([ORIGINAL_TUPLE])));
}));

test('equivalent alias and terminal TypeScript spellings retain identity', () => withFixture((root) => {
  for (const specifier of ['@saivage/cards/internal.js', '@saivage/cards/internal.ts']) {
    writeFileSync(path.join(root, 'src/agents/consumer.ts'), `import { value } from '${specifier}';\nexport { value };\n`);
    const result = run(root);
    assert.equal(result.status, 0, `${specifier}: ${output(result)}`);
    assert.match(result.stdout, new RegExp(digest([ORIGINAL_TUPLE])));
  }
}));

test('an added occurrence fails with actual and expected values and fix guidance', () => withFixture((root) => {
  writeFileSync(path.join(root, 'src/agents/consumer.ts'), "import { value } from '../cards/internal.js';\nimport { other } from '../cards/other.js';\nexport { value, other };\n");
  writeFileSync(path.join(root, 'src/cards/other.ts'), 'export const other = 2;\n');
  const tuples = [ORIGINAL_TUPLE, ['src/agents/consumer.ts', 'cross-package-deep', 'cards/other.js']];
  const actual = { totalViolations: 2, violationDigest: digest(tuples) };
  const expected = { totalViolations: 1, violationDigest: digest([ORIGINAL_TUPLE]) };
  const result = run(root);
  const combined = output(result);
  assert.notEqual(result.status, 0);
  assert.match(combined, new RegExp(`Actual: ${escapeRegExp(JSON.stringify(actual))}`));
  assert.match(combined, new RegExp(`Expected: ${escapeRegExp(JSON.stringify(expected))}`));
  assert.match(combined, /fix the new violations instead of blindly rebaselining/);
}));

test('a removal fails with an empty digest until both baseline fields are ratcheted down', () => withFixture((root) => {
  writeFileSync(path.join(root, 'src/agents/consumer.ts'), 'export const consumer = true;\n');
  const empty = { totalViolations: 0, violationDigest: digest([]) };
  const result = run(root);
  const combined = output(result);
  assert.notEqual(result.status, 0);
  assert.match(combined, new RegExp(`Actual: ${escapeRegExp(JSON.stringify(empty))}`));
  assert.match(combined, /ratchet down both totalViolations and violationDigest/);
  writeFileSync(path.join(root, 'scripts/import-boundary-baseline.json'), baseline(empty.totalViolations, empty.violationDigest));
  const ratcheted = run(root);
  assert.equal(ratcheted.status, 0, output(ratcheted));
}));

test('count-only and malformed digest baselines fail closed', () => withFixture((root) => {
  for (const invalid of [{ totalViolations: 1 }, { totalViolations: 1, violationDigest: 'ABC' }]) {
    writeFileSync(path.join(root, 'scripts/import-boundary-baseline.json'), `${JSON.stringify(invalid)}\n`);
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(output(result), /violationDigest of exactly 64 lowercase hexadecimal characters/);
  }
}));

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
