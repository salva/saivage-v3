// MANAGER ONLY, after license gate. Standalone real-native API qualification, not product code.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import ts from 'typescript';
const root = path.dirname(fileURLToPath(import.meta.url));
const cwd = path.join(root, 'fixtures');
const require = createRequire(import.meta.url);
assert.equal(process.version, 'v24.22.0');
assert.equal(process.env.NODE_DISABLE_COMPILE_CACHE, '1', 'Disable CLI Node compile cache at launch');
assert.equal(ESLint.version, '10.13.0');
assert.equal(require('typescript-eslint/package.json').version, '8.72.0');
assert.equal(ts.version, '5.9.3');
assert.equal(tseslint.parser.meta.version, '8.72.0');
const results = [];
const expectedConfig = path.join(cwd, 'tsconfig.json');
function snapshot(dir) {
  const entries = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) entries.push(...snapshot(full));
    else entries.push([full, crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')]);
  }
  return entries.sort((a,b) => a[0].localeCompare(b[0]));
}
const before = snapshot(cwd);
const disabled = Object.fromEntries(['no-floating-promises', 'no-misused-promises', 'await-thenable'].map(r => [`typed/${r}`, 'off']));
function severity(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === 'error' ? 2 : raw === 'warn' ? 1 : raw === 'off' ? 0 : raw;
}
async function typedCase(name, files, extra, expected) {
  const observations = new Map();
  const observer = { meta: { schema: [] }, create(context) {
    return { Program() {
      const services = context.sourceCode.parserServices;
      const program = services.program;
      observations.set(path.resolve(context.filename), {
        program: !!program,
        source: !!program?.getSourceFile(context.filename),
        checker: !!program?.getTypeChecker(),
        maps: typeof services.esTreeNodeToTSNodeMap?.get === 'function' && typeof services.tsNodeToESTreeNodeMap?.get === 'function',
        configFile: program?.getCompilerOptions().configFilePath ?? null,
      });
    } };
  } };
  const eslint = new ESLint({ cwd, overrideConfigFile: path.join(cwd, 'eslint.config.mjs'),
    fix: false, cache: false, cacheLocation: path.join(root, 'unused-eslint-cache'), overrideConfig: [...extra, {
      files: ['**/*.ts'], plugins: { __coverage: { rules: { observe: observer } } },
      rules: { '__coverage/observe': 'error' },
    }] });
  const configs = new Map();
  for (const file of files) configs.set(path.join(cwd, file), await eslint.calculateConfigForFile(file));
  const native = await eslint.lintFiles(files);
  const coverage = native.map(result => {
    const config = configs.get(result.filePath);
    const options = config?.languageOptions?.parserOptions;
    const projects = typeof options?.project === 'string' ? [options.project] : options?.project;
    const explicitProject = Array.isArray(projects) && projects.length === 1 &&
      typeof options.tsconfigRootDir === 'string' &&
      path.resolve(options.tsconfigRootDir, projects[0]) === expectedConfig &&
      !options.projectService && !options.programs;
    const typedRules = Object.entries(config?.rules ?? {}).flatMap(([id, setting]) => {
      const slash = id.lastIndexOf('/');
      if (slash < 0 || !severity(setting)) return [];
      const plugin = config.plugins?.[id.slice(0, slash)];
      const ruleName = id.slice(slash + 1);
      const actual = plugin?.rules?.[ruleName];
      return actual && actual === tseslint.plugin.rules[ruleName] && actual.meta.docs?.requiresTypeChecking === true
        ? [{ id, severity: severity(setting) }] : [];
    });
    const observed = observations.get(result.filePath) ?? null;
    const parserIdentity = config?.languageOptions?.parser === tseslint.parser;
    const typed = parserIdentity && explicitProject && typedRules.length > 0 && observed?.program &&
      observed.source && observed.checker && observed.maps &&
      typeof observed.configFile === 'string' && path.resolve(observed.configFile) === expectedConfig &&
      result.fatalErrorCount === 0;
    return { file: result.filePath, parserIdentity, explicitProject, typedRules, observed, typed: !!typed };
  });
  const outcome = !coverage.length || coverage.some(x => !x.typed) ? 'analysis_failed'
    : native.some(x => x.messages.length > 0) ? 'findings' : 'clean';
  results.push({ name, expected, outcome, coverage, native });
  assert.equal(outcome, expected, name);
  return results.at(-1);
}
try {
  await typedCase('typed-clean', ['clean.ts'], [], 'clean');
  const defect = await typedCase('typed-semantic-defects', ['defect.ts'], [], 'findings');
  for (const rule of ['typed/no-floating-promises','typed/no-misused-promises','typed/await-thenable'])
    assert(defect.native[0].messages.some(x => x.ruleId === rule), rule);
  await typedCase('typed-rules-off', ['clean.ts'], [{ files:['**/*.ts'], rules:disabled }], 'analysis_failed');
  await typedCase('syntax-only', ['clean.ts'], [{ files:['**/*.ts'], rules:disabled,
    languageOptions:{parserOptions:{project:false}} }], 'analysis_failed');
  await typedCase('mixed-override', ['defect.ts','override.ts'], [{ files:['override.ts'], rules:disabled,
    languageOptions:{parserOptions:{project:false}} }], 'analysis_failed');
  await typedCase('private-observer-disabled', ['suppressed.ts'], [], 'analysis_failed');
  await typedCase('fatal-parse', ['parse.ts'], [], 'analysis_failed');
  const eslint = new ESLint({ cwd, overrideConfigFile:path.join(cwd,'eslint.config.mjs'), fix:false, cache:false,
    cacheLocation:path.join(root,'unused-eslint-cache') });
  for (const [file, count] of [['clean.js',0],['defect.js',3]]) {
    const native = await eslint.lintFiles([file]);
    assert.equal(native[0].messages.length, count);
    results.push({name:file,native});
  }
  const bin = path.join(root, 'node_modules/eslint/bin/eslint.js');
  for (const [name, args, code] of [
    ['native-clean',['clean.js'],0],
    ['native-findings',['defect.js'],1],
    ['native-warnings',['defect.js','--rule','no-undef:warn','--rule','no-unreachable:off'],0],
    ['native-bad-config',['--config','bad-eslint.config.mjs','clean.js'],2],
  ]) {
    const child = spawnSync(process.execPath,[bin,'--config','eslint.config.mjs','--cache-location',path.join(root,'unused-eslint-cache'),'--format','json',...args],
      {cwd,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
    if (child.error) throw child.error;
    results.push({name,status:child.status,stdout:child.stdout,stderr:child.stderr});
    assert.equal(child.status,code,name);
    if (name === 'native-warnings') assert(JSON.parse(child.stdout)[0].warningCount > 0);
  }
  assert.deepEqual(snapshot(cwd), before, 'fixture bytes/names unchanged');
  assert(!fs.existsSync(path.join(root,'.eslintcache')));
  console.log('ESLint native/API qualification passed');
} finally {
  fs.writeFileSync(path.join(root,'eslint-native-evidence.json'),JSON.stringify(results,null,2)+'\n');
}
