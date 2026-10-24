// MANAGER ONLY. Fresh additional scratch fixtures; originals/results are never changed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.resolve(process.argv[2] ?? '.');
const suffix = process.argv[3] ?? '';
assert(suffix === '' || /^[a-z][a-z0-9-]*$/.test(suffix), 'Use a lowercase run suffix');
const runSuffix = suffix ? `-${suffix}` : '';
assert.equal(process.env.NODE_DISABLE_COMPILE_CACHE, '1', 'Launch with Node compile cache disabled');
const require = createRequire(path.join(root, 'package.json'));
const { ESLint } = require('eslint');
const tseslint = require('typescript-eslint');
assert.equal(ESLint.version, '10.13.0');
assert.equal(tseslint.parser.meta.version, '8.72.0');
const base = path.join(root, `extra-fixtures${runSuffix}`);
fs.mkdirSync(base);
const cwd = path.join(base, 'project');
const outside = path.join(base, 'outside');
const python = path.join(base, 'python');
for (const dir of [cwd, outside, python, path.join(base, 'empty')]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(cwd, 'clean.ts'), 'export const answer = 42;\n');
fs.writeFileSync(path.join(cwd, 'ignored.ts'), 'missingName();\n');
fs.writeFileSync(path.join(cwd, 'unsupported.txt'), 'not TypeScript\n');
fs.writeFileSync(path.join(outside, 'outside.ts'), 'export const answer = 42;\n');
fs.writeFileSync(path.join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict:true, noEmit:true, target:'ES2022' }, include:['*.ts'] }));
fs.writeFileSync(path.join(cwd, '.eslintcache'), 'pre-existing target-owned sentinel\n');
const moduleURL = pathToFileURL(require.resolve('typescript-eslint')).href;
fs.writeFileSync(path.join(cwd, 'eslint.config.mjs'), `import t from ${JSON.stringify(moduleURL)};
export default [{ignores:['**/ignored.ts']},{files:['**/*.ts'],languageOptions:{parser:t.parser,parserOptions:{project:'./tsconfig.json',tsconfigRootDir:${JSON.stringify(cwd)}}},plugins:{typed:t.plugin},rules:{'typed/no-floating-promises':'error'}}];\n`);
fs.writeFileSync(path.join(python, 'clean.py'), 'answer = 42\n');
fs.writeFileSync(path.join(python, 'ignored.py'), 'missing_name()\n');
fs.writeFileSync(path.join(python, 'fixable.py'), 'import os\nanswer = 42\n');
fs.writeFileSync(path.join(python, 'unsupported.txt'), 'answer = 42\n');
fs.writeFileSync(path.join(python, 'ruff.toml'), 'target-version = "py311"\nfix = true\nfix-only = true\nunsafe-fixes = true\nexclude = ["ignored.py"]\n[lint]\nselect = ["E", "F", "B"]\n');
fs.mkdirSync(path.join(python, '.ruff_cache'));
fs.writeFileSync(path.join(python, '.ruff_cache', 'sentinel'), 'pre-existing target-owned sentinel\n');
function snapshot(dir) {
  return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry => {
    const full = path.join(dir,entry.name);
    return entry.isDirectory() ? snapshot(full) : [[full,crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')]];
  }).sort((a,b)=>a[0].localeCompare(b[0]));
}
const before = snapshot(base);
const results = [];
const eslint = new ESLint({cwd,overrideConfigFile:path.join(cwd,'eslint.config.mjs'),fix:false,cache:false,
   cacheLocation:path.join(root,`unused-extra-eslint-cache${runSuffix}`),passOnNoPatterns:true});
async function lint(name,files) {
  const native = await eslint.lintFiles(files);
  results.push({name,native});
  return native;
}
function ruff(name,args) {
  const p = spawnSync(path.join(root,'venv/bin/ruff'),['check','--config',path.join(python,'ruff.toml'),
    '--no-fix','--no-fix-only','--no-cache','--force-exclude',...args],{cwd:python,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
  if(p.error) throw p.error;
  const result = {name,code:p.status,signal:p.signal,stdout:p.stdout,stderr:p.stderr};
  results.push(result);
  return result;
}
try {
  // Place the out-of-project file inside native matching scope but outside tsconfig include.
  // Parent cwd covers both roots; explicit project remains the original bound project.
  const outer = new ESLint({cwd:base,overrideConfigFile:path.join(cwd,'eslint.config.mjs'),fix:false,cache:false,
    cacheLocation:path.join(root,`unused-extra-eslint-cache${runSuffix}`)});
  const projectError = await outer.lintFiles([path.join(outside,'outside.ts')]);
  results.push({name:'out-of-project-ts',native:projectError});
  assert(projectError.some(x=>x.fatalErrorCount>0),'valid TS outside bound project must fail typed parsing');
  const empty = await lint('empty-pattern-array',[]);
  assert.equal(empty.length,0);
  results.at(-1).coverage='analysis_failed: empty intended scope, not clean';
  let unmatched;
  try { await eslint.lintFiles(['does-not-exist/**/*.ts']); } catch(error) { unmatched=error; }
  assert(unmatched instanceof Error,'unmatched scope must not silently succeed');
  results.push({name:'unmatched',message:unmatched.message,template:unmatched.messageTemplate,coverage:'analysis_failed'});
  for(const file of ['ignored.ts','unsupported.txt']) {
    assert.equal(await eslint.isPathIgnored(path.join(cwd,file)),true);
    await lint(file,[file]);
    results.at(-1).coverage='not analyzed; must not be labeled clean';
  }
  const excluded = await lint('explicit-exclusion',['*.ts']);
  assert.deepEqual(excluded.map(x=>path.basename(x.filePath)),['clean.ts']);
  assert.equal(excluded[0].messages.length,0);
  results.at(-1).intentionalExclusions=['ignored.ts'];
  const clean = ruff('ruff-clean',['--output-format','json','clean.py']);
  assert.equal(clean.code,0); assert.deepEqual(JSON.parse(clean.stdout),[]);
  const fix = ruff('ruff-fix-only-disabled',['--output-format','json','fixable.py']);
  assert.equal(fix.code,1); assert(JSON.parse(fix.stdout).some(x=>x.code==='F401'));
  const excludedPy = ruff('ruff-explicit-exclusion',['--show-files','clean.py','ignored.py']);
  assert.equal(excludedPy.code,0);
  assert.deepEqual(excludedPy.stdout.trim().split('\n'),[path.join(python,'clean.py')]);
  const ignored = ruff('ruff-ignored',['--show-files','ignored.py']);
  assert.equal(ignored.code,0); assert.equal(ignored.stdout.trim(),'');
  results.at(-1).coverage='empty excluded selection; not clean';
  const emptyPy = ruff('ruff-empty',['--show-files',path.join(base,'empty')]);
  assert.equal(emptyPy.code,0); assert.equal(emptyPy.stdout.trim(),'');
  results.at(-1).coverage='analysis_failed: empty supported scope';
  const missing = ruff('ruff-unmatched',['--output-format','json','does-not-exist.py']);
  assert.notEqual(missing.code,0);
  results.at(-1).coverage='analysis_failed: missing source, not ordinary clean';
  const selected = ruff('ruff-supported-discovery',['--show-files',python]);
  assert.equal(selected.code,0);
  assert(!selected.stdout.includes('unsupported.txt'));
  results.at(-1).unsupported=['unsupported.txt'];
  assert.deepEqual(snapshot(base),before,'source/cache sentinel bytes and names unchanged');
  console.log('Additional native scope/no-source-write qualification passed');
} finally {
  fs.writeFileSync(path.join(root,`extra-qualification${runSuffix}.json`),JSON.stringify(results,null,2)+'\n',{flag:'wx'});
}
