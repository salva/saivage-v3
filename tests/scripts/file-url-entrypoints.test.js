import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SYSTEM_TEMPLATES } from '../../src/config/system-templates/registry.js';
import { collectTemplatePromptClosure } from '../../scripts/copy-system-template-prompts.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureInputs = [
  'src/', 'docs/', 'scripts/', 'README.md', 'package.json', 'tsconfig.json',
  'web/src/utils/tool-presenters/presenters.ts', 'web/src/api/client.ts', 'web/src/stores/cards.ts',
];

function runChild(label, cwd, command, args, expectedStatus = 0) {
  const result = spawnSync('timeout', ['--kill-after=5s', '60s', command, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const diagnostic = `${label}: status=${result.status} signal=${result.signal}\n${result.error?.message ?? ''}\nstdout:\n${result.stdout ?? ''}\nstderr:\n${result.stderr ?? ''}`;
  if (result.error || result.signal || result.status !== expectedStatus) throw new Error(diagnostic);
  return { ...result, diagnostic };
}

function createFixture(root, name, caller) {
  const fixture = join(root, name);
  mkdirSync(fixture);
  // Copy the selected working-tree source, including new nonignored source files
  // before staging. Ignored runtime/working artifacts are not fixture inputs.
  const listing = runChild(`${caller} (${name}) fixture source discovery`, repoRoot, 'git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...fixtureInputs]);
  const deleted = runChild(`${caller} (${name}) fixture source deletions`, repoRoot, 'git', ['ls-files', '-z', '--deleted', '--', ...fixtureInputs]);
  const deletedPaths = new Set(deleted.stdout.split('\0'));
  for (const path of listing.stdout.split('\0').filter((path) => path && !deletedPaths.has(path) && !path.startsWith('docs/working/'))) {
    const destination = join(fixture, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(repoRoot, path), destination);
  }
  symlinkSync(join(repoRoot, 'node_modules'), join(fixture, 'node_modules'), 'dir');
  return fixture;
}

function walkFiles(root, current = root) {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const path = join(current, entry.name);
    return entry.isDirectory() ? walkFiles(root, path) : [relative(root, path)];
  }).sort();
}

function assertSilentImports(fixture, script, caller, name) {
  const scriptURL = pathToFileURL(script).href;
  const source = `await import(${JSON.stringify(scriptURL)});\n`;
  const driver = join(fixture, 'import-driver.mjs');
  writeFileSync(driver, source);
  const registration = caller === 'packaging' ? ['--import', 'tsx'] : [];
  for (const [mode, args] of [
    ['distinct driver', [...registration, driver]],
    ['no argv entry', [...registration, '--input-type=module', '--eval', source]],
  ]) {
    const result = runChild(`${caller} (${name}) ${mode} import`, fixture, process.execPath, args);
    expect({ stdout: result.stdout, stderr: result.stderr }).toEqual({ stdout: '', stderr: '' });
    if (caller === 'packaging') expect(existsSync(join(fixture, 'dist'))).toBe(false);
  }
}

for (const name of ['checkout-ordinary', 'checkout café']) {
  test(`packaging entrypoint executes and imports silently in ${name}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-packaging-entrypoint-'));
    try {
      const fixture = createFixture(root, name, 'packaging');
      const script = join(fixture, 'scripts/copy-system-template-prompts.js');
      const args = [join(fixture, 'node_modules/tsx/dist/cli.mjs'), script];
      const distRoot = join(fixture, 'dist');
      expect(existsSync(distRoot)).toBe(false);
      const success = runChild(`packaging (${name}) direct invocation`, fixture, process.execPath, args);
      expect(SYSTEM_TEMPLATES.map((template) => template.name)).toEqual(['classic', 'classic-typed', 'paad-typed']);
      const summaries = [];
      for (const template of SYSTEM_TEMPLATES) {
        const sourceRoot = join(fixture, 'src/config/system-templates', template.name, 'prompts');
        const outputRoot = join(distRoot, 'src/config/system-templates', template.name, 'prompts');
        const sourceFiles = walkFiles(sourceRoot);
        expect(walkFiles(outputRoot)).toEqual(sourceFiles);
        for (const path of sourceFiles) {
          expect(readFileSync(join(outputRoot, path))).toEqual(readFileSync(join(sourceRoot, path)));
        }
        const sourceClosure = collectTemplatePromptClosure({ template, promptRoot: sourceRoot });
        expect(sourceFiles).toEqual(sourceClosure);
        expect(collectTemplatePromptClosure({ template, promptRoot: outputRoot })).toEqual(sourceClosure);
        summaries.push(`Copied ${sourceClosure.length} '${template.name}' prompt artifacts to ${relative(fixture, outputRoot)}`);
      }
      expect(success.stdout.trim()).toBe(summaries.join('\n'));

      rmSync(join(fixture, 'src/config/system-templates/classic/prompts/agents/_shared/analyst.md'));
      const failure = runChild(`packaging (${name}) missing selected prompt`, fixture, process.execPath, args, 1);
      expect(failure.stderr).toMatch(/ENOENT.*analyst\.md/u);
      rmSync(distRoot, { recursive: true });
      assertSilentImports(fixture, script, 'packaging', name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 360_000);
}

for (const name of ['checkout-ordinary', 'checkout café #?%20%']) {
  test(`docs entrypoint verifies drift and imports silently in ${name}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-docs-entrypoint-'));
    try {
      const fixture = createFixture(root, name, 'docs');
      const script = join(fixture, 'scripts/verify-doc-routes.js');
      const success = runChild(`docs (${name}) healthy direct invocation`, fixture, process.execPath, [script]);
      expect(success.stdout).toContain('==> Verifying active docs against source contracts...');
      expect(success.stdout).toContain('✓ current docs match routes, tools, config schema, anchors, errors, vocabularies, constants, shipped-tool contracts, identities, and card-diff pivots');

      const missingRoute = 'GET /api/portability-fixture-missing';
      appendFileSync(join(fixture, 'docs/spec/operator-ui-contracts.md'), `\nFixture public route: \`${missingRoute}\`.\n`);
      const failure = runChild(`docs (${name}) deliberate route drift`, fixture, process.execPath, [script], 1);
      expect(failure.stdout).toContain('documentation/source drift detected:');
      expect(failure.stdout).toContain(missingRoute);
      assertSilentImports(fixture, script, 'docs', name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 360_000);
}
