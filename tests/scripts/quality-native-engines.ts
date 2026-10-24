import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { analyzeEslint } from '../../src/quality/eslint-analysis.js';
import { analyzeRuff } from '../../src/quality/ruff-analysis.js';

// Deliberate required prerequisite, not a skip or fallback to root lint packages.
function provisioned() {
  const root = process.env.SAIVAGE_QUALITY_NATIVE_ROOT;
  if (!root) throw new Error('Provision tests/tools/quality-native and set SAIVAGE_QUALITY_NATIVE_ROOT; see quality-tool-qualification.md.');
  return resolve(root);
}
async function eslintEvidence() {
  const root = provisioned();
  const cache = mkdtempSync(join(root, 'product-api-cache-'));
  const cwd = join(cache, 'fixtures');
  cpSync(join(root, 'fixtures'), cwd, { recursive: true });
  // M1's retained fixture disables its own __coverage/observe rule. This
  // product witness must disable the actual production-private observer.
  // Adapt only the disposable copy; preserve all original M1 evidence.
  writeFileSync(join(cwd, 'suppressed.ts'), '/* eslint __saivage_coverage/observe: off */\nexport const number = 42;\n');
  const files = ['clean.js', 'defect.js', 'clean.ts', 'defect.ts', 'parse.ts', 'suppressed.ts'];
  const before = files.map((file) => readFileSync(join(cwd, file)));
  const base = { cwd, nativeConfig: join(cwd, 'eslint.config.mjs'),
    eslintModule: join(root, 'node_modules/eslint'), cacheLocation: join(cache, 'unused') };
  try {
    const clean = await analyzeEslint({ ...base, typed: null, files: [join(cwd, 'clean.js')] });
    assert.equal(clean.disposition, 'clean');
    const defect = await analyzeEslint({ ...base, typed: null, files: [join(cwd, 'defect.js')] });
    assert.equal(defect.disposition, 'findings');
    assert(defect.native[0]!.messages.some((message) => message.ruleId === 'no-undef'));
    const warningConfig = join(cache, 'warning.mjs');
    writeFileSync(warningConfig, "export default [{files:['**/*.js'],rules:{'no-undef':'warn'}}];");
    const warning = await analyzeEslint({ ...base, nativeConfig: warningConfig, typed: null, files: [join(cwd, 'defect.js')] });
    assert.equal(warning.disposition, 'findings');
    assert.equal(warning.nativeExit, 0);
    assert(warning.native[0]!.messages.some((message) => message.severity === 1));
    const ignoredConfig = join(cache, 'ignored.mjs');
    writeFileSync(ignoredConfig, "export default [{ignores:['**/clean.js']}];");
    const ignored = await analyzeEslint({ ...base, nativeConfig: ignoredConfig, typed: null, files: [join(cwd, 'clean.js')] });
    assert.equal(ignored.disposition, 'analysis_failed');
    assert.equal(ignored.coverage[0]!.status, 'ignored');
    const brokenConfig = join(cache, 'broken.mjs');
    writeFileSync(brokenConfig, "throw new Error('synthetic native-config failure');");
    await assert.rejects(analyzeEslint({ ...base, nativeConfig: brokenConfig, typed: null, files: [join(cwd, 'clean.js')] }), /synthetic native-config failure/);
    await assert.rejects(analyzeEslint({ ...base, typed: null, files: [join(cwd, 'unmatched.js')] }));
    const typed = { module: join(root, 'node_modules/typescript-eslint'),
      typescriptModule: join(root, 'node_modules/typescript'), tsconfig: join(cwd, 'tsconfig.json') };
    const typedClean = await analyzeEslint({ ...base, typed, files: [join(cwd, 'clean.ts')] });
    assert.equal(typedClean.disposition, 'clean');
    const coverage = typedClean.coverage[0]!;
    assert.equal(coverage.status, 'typed');
    assert.equal(coverage.parserIdentity, true);
    assert.equal(coverage.explicitProject, true);
    assert(coverage.observed);
    for (const key of ['program', 'source', 'checker', 'maps'] as const)
      assert.equal(coverage.observed[key], true, key);
    assert(coverage.typedRules.length > 0);
    const typedDefect = await analyzeEslint({ ...base, typed, files: [join(cwd, 'defect.ts')] });
    assert.equal(typedDefect.disposition, 'findings');
    for (const rule of ['typed/no-floating-promises', 'typed/no-misused-promises', 'typed/await-thenable'])
      assert(typedDefect.native[0]!.messages.some((message) => message.ruleId === rule), rule);
    assert.equal((await analyzeEslint({ ...base, typed, files: [join(cwd, 'parse.ts')] })).disposition, 'analysis_failed', 'parse.ts');
    const suppressed = await analyzeEslint({ ...base, typed, files: [join(cwd, 'suppressed.ts')] });
    assert.equal(suppressed.disposition, 'analysis_failed', 'suppressed.ts');
    assert.equal(suppressed.coverage[0]!.observed, null);
    assert.equal(suppressed.coverage[0]!.status, 'untyped/config-mismatch');
    for (const [name, override] of [
      ['rules-off', "rules: { 'typed/no-floating-promises':'off', 'typed/no-misused-promises':'off', 'typed/await-thenable':'off' }"],
      ['syntax-only', "languageOptions:{parserOptions:{project:false}}, rules: { 'typed/no-floating-promises':'off', 'typed/no-misused-promises':'off', 'typed/await-thenable':'off' }"],
    ]) {
      const nativeConfig = join(cache, `${name}.mjs`);
      writeFileSync(nativeConfig, `import base from './fixtures/eslint.config.mjs'; export default [...base, {files:['**/*.ts'], ${override}}];`);
      assert.equal((await analyzeEslint({ ...base, nativeConfig, typed, files: [join(cwd, 'clean.ts')] })).disposition, 'analysis_failed', name);
    }
    const mixedConfig = join(cache, 'mixed.mjs');
    writeFileSync(mixedConfig, "import base from './fixtures/eslint.config.mjs'; export default [...base, {files:['**/override.ts'], languageOptions:{parserOptions:{project:false}}, rules:{'typed/no-floating-promises':'off','typed/no-misused-promises':'off','typed/await-thenable':'off'}}];");
    const mixed = await analyzeEslint({ ...base, nativeConfig: mixedConfig, typed, files: [join(cwd, 'defect.ts'), join(cwd, 'override.ts')] });
    assert.equal(mixed.disposition, 'analysis_failed');
    assert(mixed.native.some((file) => file.messages.length > 0));
    assert.equal((await analyzeEslint({ ...base, typed, files: [] })).disposition, 'analysis_failed');
    assert.deepEqual(files.map((file) => readFileSync(join(cwd, file))), before);
    assert.equal(existsSync(base.cacheLocation), false, 'ESLint cache must remain disabled');
  } finally { rmSync(cache, { recursive: true, force: true }); }
}

function ruffEvidence() {
  const root = provisioned();
  const cwd = join(root, 'fixtures');
  const names = ['clean.py', 'defect.py', 'parse.py', 'fixable.py'];
  const before = names.map((name) => readFileSync(join(cwd, name)));
  const config = { cwd: '.', native_config: 'ruff.toml', source_paths: ['src'], exclusions: [],
    ruff_binary: join(root, 'venv/bin/ruff'), timeout_ms: 30000, terminate_grace_ms: 2000 };
  const run = (name: string, nativeConfig = 'ruff.toml') => analyzeRuff({ config, cwd,
    nativeConfig: join(cwd, nativeConfig), files: [join(cwd, name)] });
  assert.equal(run('clean.py').disposition, 'clean');
  const defect = run('defect.py');
  assert.equal(defect.disposition, 'findings');
  for (const code of ['F821', 'B006']) assert(defect.findings.some((finding) => finding.code === code), code);
  assert.equal(run('parse.py').disposition, 'analysis_failed');
  assert.equal(run('clean.py', 'bad-ruff.toml').disposition, 'analysis_failed');
  assert.equal(run('fixable.py').disposition, 'findings');
  assert.deepEqual(names.map((name) => readFileSync(join(cwd, name))), before);
}

await eslintEvidence();
ruffEvidence();
console.log('Pinned JS, typed TS and Ruff semantic assertions passed.');
