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

test('runtime leaves require owner public surfaces in the real CLI', () => withFixture((root) => {
  writeFileSync(path.join(root, 'src/agents/consumer.ts'), 'export const consumer = true;\n');
  for (const owner of ['runtime', 'persistence', 'contracts', 'schemas', 'workspace', 'tools']) {
    mkdirSync(path.join(root, `src/${owner}`), { recursive: true });
  }
  const cases = [
    ['../persistence/conversation-file.js', false],
    ['../persistence/session-api.js', true],
    ['../persistence/index.js', true],
    ['../contracts/tool-result.js', false],
    ['../contracts/index.js', true],
    ['../schemas/card-id.js', false],
    ['../schemas/index.js', true],
    ['../workspace/operator-command.js', false],
    ['../workspace/index.js', true],
    ['../tools/invocation.js', false],
    ['../tools/tool-api.js', true],
    ['./actors/llm-actor.js', true],
    ['../schemas/round-id-server.js', true],
    ['../schemas/round-id-server.ts', true],
    ['@saivage/schemas/round-id-server.ts', true],
    ['../schemas/round-id.js', false],
    ['../schemas/nested/round-id-server.js', false],
    ['../schemas/other-server.js', false],
    ['../tools/round-id-server.js', false],
  ];
  for (const [specifier, allowed] of cases) {
    writeFileSync(path.join(root, 'src/runtime/consumer.ts'), `import { value } from '${specifier}';\n`);
    const target = specifier.startsWith('@saivage/')
      ? specifier.slice('@saivage/'.length)
      : path.posix.normalize(`runtime/${specifier}`);
    const tuples = allowed ? [] : [['src/runtime/consumer.ts', 'cross-package-deep', target.replace(/\.ts$/, '.js')]];
    writeFileSync(path.join(root, 'scripts/import-boundary-baseline.json'), baseline(tuples.length, digest(tuples)));
    const result = run(root);
    assert.equal(result.status, 0, `${specifier}: ${output(result)}`);
    assert.match(result.stdout, new RegExp(digest(tuples)));
  }
}));

test('exact round-ID server owner API is public to another backend package', () => withFixture((root) => {
  mkdirSync(path.join(root, 'src/schemas'));
  writeFileSync(path.join(root, 'scripts/import-boundary-baseline.json'), baseline(0, digest([])));
  for (const specifier of ['../schemas/round-id-server.js', '../schemas/round-id-server.ts', '@saivage/schemas/round-id-server.ts']) {
    writeFileSync(path.join(root, 'src/agents/consumer.ts'), `import { value } from '${specifier}';\n`);
    const result = run(root);
    assert.equal(result.status, 0, `${specifier}: ${output(result)}`);
  }
}));

test('runtime and agents directional denials override public API admission', () => withFixture((root) => {
  mkdirSync(path.join(root, 'src/runtime'));
  writeFileSync(path.join(root, 'scripts/import-boundary-baseline.json'), baseline(0, digest([])));
  writeFileSync(path.join(root, 'src/agents/consumer.ts'), "import { value } from '../runtime/runtime-api.js';\n");
  writeFileSync(path.join(root, 'src/runtime/consumer.ts'), "import { value } from '../agents/execution-api.js';\n");
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(output(result), /agents must not import runtime/);
  assert.match(output(result), /runtime must not import agents/);
}));

test('overlapping prohibitions select exactly one precedence rule per occurrence', () => withFixture((root) => {
  writeFileSync(path.join(root, 'src/agents/consumer.ts'), 'export const consumer = true;\n');
  for (const owner of ['runtime', 'contracts', 'schemas', 'tools', 'server', 'boot', 'workspace', 'redaction', 'config', 'application', 'observability', 'persistence', 'mcp']) {
    mkdirSync(path.join(root, `src/${owner}`), { recursive: true });
  }
  const cases = [
    ['agents', 'runtime/index.js', 'agents-runtime'],
    ['agents', 'runtime/runtime-api.js', 'agents-runtime'],
    ['agents', 'runtime/internal.js', 'agents-runtime'],
    ['runtime', 'agents/internal.js', 'runtime-agents'],
    ['runtime', 'agents/execution-api.js', 'runtime-agents'],
    ['contracts', 'server/internal.js', 'contracts-declarative'],
    ['contracts', 'server/server-api.js', 'contracts-declarative'],
    ['schemas', 'server/internal.js', 'schemas-bottom-layer'],
    ['schemas', 'server/server-api.js', 'schemas-bottom-layer'],
    ['redaction', 'config/index.js', 'redaction-primitive'],
    ['redaction', 'application/index.js', 'redaction-primitive'],
    ['redaction', 'observability/index.js', 'redaction-primitive'],
    ['redaction', 'persistence/index.js', 'redaction-primitive'],
    ['redaction', 'cards/status-api.js', 'redaction-primitive'],
    ['redaction', 'mcp/tool-api.js', 'redaction-primitive'],
    ['redaction', 'agents/execution-api.js', 'redaction-primitive'],
    ['redaction', 'tools/tool-api.js', 'redaction-primitive'],
    ['redaction', 'server/server-api.js', 'redaction-primitive'],
    ['redaction', 'runtime/runtime-api.js', 'redaction-primitive'],
    ['tools', 'server/internal.js', 'server-import'],
    ['boot', 'server/internal.js', 'cross-package-deep'],
    ['workspace', 'runtime', 'workspace-runtime'],
    ['workspace', 'runtime/index.js', 'workspace-runtime'],
    ['workspace', 'runtime/runtime-api.js', 'workspace-runtime'],
    ['workspace', 'runtime/command-policy.js', 'workspace-runtime'],
    ['server', 'boot', 'server-boot'],
    ['server', 'boot/index.js', 'server-boot'],
    ['server', 'boot/app.js', 'server-boot'],
  ];
  for (const [owner, target, rule] of cases) {
    const source = `src/${owner}/consumer.ts`;
    for (const statement of [
      `import { value } from '../${target}';`,
      `import type { Value } from '../${target}';`,
      `import { value } from '@saivage/${target.replace(/\.js$/, '.ts')}';`,
      `import type { Value } from '@saivage/${target.replace(/\.js$/, '.ts')}';`,
      `export { value } from '@saivage/${target.replace(/\.js$/, '.ts')}';`,
    ]) {
      writeFileSync(path.join(root, source), `${statement}\n`);
      const actual = { totalViolations: 1, violationDigest: digest([[source, rule, target]]) };
      writeFileSync(path.join(root, 'scripts/import-boundary-baseline.json'), baseline(0, digest([])));
      const rejected = run(root);
      assert.notEqual(rejected.status, 0, `${statement}: ${output(rejected)}`);
      assert.match(output(rejected), new RegExp(`Actual: ${escapeRegExp(JSON.stringify(actual))}`));
      assert.equal(rejected.stderr.split('\n').filter((line) => line.startsWith('- ')).length, 1);
      writeFileSync(path.join(root, 'scripts/import-boundary-baseline.json'), baseline(actual.totalViolations, actual.violationDigest));
      const admitted = run(root);
      assert.equal(admitted.status, 0, `${statement}: ${output(admitted)}`);
      writeFileSync(path.join(root, source), 'export const consumer = true;\n');
    }
  }
  for (const [owner, target] of [
    ['workspace', 'redaction'],
    ['workspace', 'redaction/index.js'],
    ['server', 'contracts'],
    ['server', 'contracts/index.js'],
    ['boot', 'server/server-api.js'],
    ['server', 'server/internal.js'],
    ['redaction', 'schemas/index.js'],
    ['redaction', 'contracts/index.js'],
    ['redaction', 'redaction/text.js'],
  ]) {
    const source = `src/${owner}/consumer.ts`;
    writeFileSync(path.join(root, 'scripts/import-boundary-baseline.json'), baseline(0, digest([])));
    for (const statement of [
      `import { value } from '../${target}';`,
      `import type { Value } from '@saivage/${target.replace(/\.js$/, '.ts')}';`,
      `export { value } from '../${target}';`,
    ]) {
      writeFileSync(path.join(root, source), `${statement}\n`);
      const result = run(root);
      assert.equal(result.status, 0, `${statement}: ${output(result)}`);
      assert.match(result.stdout, new RegExp(digest([])));
    }
    writeFileSync(path.join(root, source), 'export const consumer = true;\n');
  }
}));

test('public entry admission rejects invented and neighboring API paths with an empty baseline', () => withFixture((root) => {
  mkdirSync(path.join(root, 'src/server'));
  mkdirSync(path.join(root, 'src/config'));
  mkdirSync(path.join(root, 'src/tools'));
  writeFileSync(path.join(root, 'src/agents/consumer.ts'), 'export const consumer = true;\n');
  writeFileSync(path.join(root, 'scripts/import-boundary-baseline.json'), baseline(0, digest([])));
  for (const target of [
    'cards/artifact-api', 'config/artifact-api', 'agents/artifact-api',
    'cards/tool-api', 'config/config-api', 'tools/status-api',
    'cards/nested/store-api', 'cards/store-api-neighbor',
    'runtime/nested/runtime-api', 'runtime/control-api',
  ]) {
    for (const extension of ['js', 'ts']) {
      const source = 'src/server/consumer.ts';
      const normalized = `${target}.js`;
      writeFileSync(path.join(root, source), `import type { Value } from '@saivage/${target}.${extension}';\n`);
      const result = run(root);
      const actual = { totalViolations: 1, violationDigest: digest([[source, 'cross-package-deep', normalized]]) };
      assert.notEqual(result.status, 0, `${target}.${extension}: ${output(result)}`);
      assert.match(output(result), new RegExp(`Actual: ${escapeRegExp(JSON.stringify(actual))}`));
    }
  }
}));

test('direct owner projector surfaces remain admitted with normalized spellings', () => withFixture((root) => {
  writeFileSync(path.join(root, 'src/agents/consumer.ts'), 'export const consumer = true;\n');
  for (const owner of ['server', 'observability', 'config', 'persistence', 'application', 'tools', 'mcp', 'runtime']) {
    mkdirSync(path.join(root, `src/${owner}`), { recursive: true });
  }
  writeFileSync(path.join(root, 'scripts/import-boundary-baseline.json'), baseline(0, digest([])));
  const projectors = [
    ['agents/execution-api', 'projectProviderExchange'],
    ['observability/index', 'projectLoggedEvent'],
    ['config/index', 'projectEffectiveConfigForOutbound'],
    ['persistence/index', 'projectControlAction'],
    ['application/index', 'projectCardDiff'],
    ['tools/tool-api', 'projectToolInvocation'],
    ['mcp/tool-api', 'projectMcpToolsForOutbound'],
  ];
  for (const extension of ['js', 'ts']) {
    writeFileSync(path.join(root, 'src/server/consumer.ts'), projectors.map(([entry, name]) =>
      `import { ${name} } from '../${entry}.${extension}';`).join('\n'));
    writeFileSync(path.join(root, 'src/tools/consumer.ts'), `import { projectCardDiff } from '../application/index.${extension}';\n`);
    writeFileSync(path.join(root, 'src/server/runtime-consumer.ts'), `import type { RuntimeControl } from '../runtime/runtime-api.${extension}';\n`);
    const result = run(root);
    assert.equal(result.status, 0, `${extension}: ${output(result)}`);
    assert.match(result.stdout, new RegExp(digest([])));
  }
}));

test('repeated normalized edges remain a multiset of offending occurrences', () => withFixture((root) => {
  writeFileSync(path.join(root, 'src/agents/consumer.ts'), [
    "import { value } from '../cards/internal.js';",
    "import type { Other } from '@saivage/cards/internal.ts';",
    "export { value as repeated } from '../cards/internal.js';",
    '',
  ].join('\n'));
  const tuples = [ORIGINAL_TUPLE, ORIGINAL_TUPLE, ORIGINAL_TUPLE];
  const actual = { totalViolations: 3, violationDigest: digest(tuples) };
  const rejected = run(root);
  assert.notEqual(rejected.status, 0);
  assert.match(output(rejected), new RegExp(`Actual: ${escapeRegExp(JSON.stringify(actual))}`));
  assert.equal(rejected.stderr.split('\n').filter((line) => line.startsWith('- ')).length, 3);
  assert.notEqual(actual.violationDigest, digest([ORIGINAL_TUPLE]));
  writeFileSync(path.join(root, 'scripts/import-boundary-baseline.json'), baseline(actual.totalViolations, actual.violationDigest));
  const admitted = run(root);
  assert.equal(admitted.status, 0, output(admitted));
  assert.match(admitted.stdout, new RegExp(`3 violations and digest ${actual.violationDigest}`));
}));
