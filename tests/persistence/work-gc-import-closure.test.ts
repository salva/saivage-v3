import { expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = process.cwd();
const entries = [
  'src/contracts/process-result-validation.ts',
  'src/contracts/tool-result-projection.ts',
  'src/persistence/work-gc-protection.ts',
  'src/persistence/index.ts',
];
const forbidden = /^(?:src\/tools\/|src\/runtime\/actors\/context\/|src\/agents\/provider-exchange-recorder\.|src\/auth\/)|^node:dns(?:\/|$)/u;

it('keeps the source-transitive GC/pure-validation closure below executable tool and provider owners', () => {
  const visited = new Set<string>();
  function visit(file: string): void {
    if (visited.has(file)) return;
    visited.add(file);
    expect(relative(root, file)).not.toMatch(forbidden);
    const output = ts.transpileModule(readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, isolatedModules: true },
    }).outputText;
    const parsed = ts.createSourceFile(file, output, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    function walk(node: ts.Node): void {
      const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
      if (specifier && ts.isStringLiteral(specifier)) {
        expect(specifier.text).not.toMatch(forbidden);
        if (specifier.text.startsWith('.')) visit(resolve(dirname(file), specifier.text.replace(/\.js$/u, '.ts')));
      }
      ts.forEachChild(node, walk);
    }
    walk(parsed);
  }
  for (const entry of entries) visit(resolve(root, entry));
  expect(visited.has(resolve(root, 'src/contracts/process-result-validation.ts'))).toBe(true);
  expect(visited.has(resolve(root, 'src/contracts/tool-result-projection.ts'))).toBe(true);
});

it('imports the matching emitted foundational closure in a fresh process without executable preloads', () => {
  const urls = entries.map(entry => pathToFileURL(resolve(root, 'dist', entry.replace(/\.ts$/u, '.js'))).href);
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { registerHooks } from 'node:module';
    import { fileURLToPath } from 'node:url';
    import { relative } from 'node:path';
    const visited = new Set();
    const forbidden = ${forbidden.toString()};
    registerHooks({ resolve(specifier, context, next) {
      const result = next(specifier, context);
      const name = result.url.startsWith('file:')
        ? relative(${JSON.stringify(resolve(root, 'dist'))}, fileURLToPath(result.url)) : result.url;
      if (forbidden.test(name)) throw new Error('Unexpected executable preload: ' + name);
      visited.add(name);
      return result;
    }});
    const modules = [];
    for (const url of ${JSON.stringify(urls)}) modules.push(await import(url));
    // The complete newly published validator, including its head-size schema, needs no Buffer.
    globalThis.Buffer = undefined;
    const data = { process_id: 'proc-0123456789ab', exit_code: 0, status: 'exited', stdout: 'é'.repeat(1024), stderr: '',
      stdout_complete: true, stderr_complete: true, stdout_url: 'work:///processes/proc-0123456789ab/stdout.log',
      stderr_url: 'work:///processes/proc-0123456789ab/stderr.log', stdout_bytes: 2048, stderr_bytes: 0 };
    if (modules[0].validateProcessToolResult(data).stdout !== data.stdout) throw new Error('Validator changed data');
    console.log(JSON.stringify([...visited]));
  `], { cwd: root, encoding: 'utf8' });
  const loaded = JSON.parse(output.trim()) as string[];
  expect(loaded).toContain('src/persistence/index.js');
  expect(loaded).toContain('src/contracts/process-result-validation.js');
  expect(loaded).toContain('src/contracts/tool-result-projection.js');
  expect(loaded.every(name => !forbidden.test(name))).toBe(true);
});
