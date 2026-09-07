#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileScript, parse as parseSfc } from '@vue/compiler-sfc';
import { SourceMapConsumer } from 'source-map-js';
import ts from 'typescript';

const TS_EXTENSIONS = /\.(?:ts|tsx|mts|cts)$/;
const DECLARATION_SUFFIX = /\.d\.(?:ts|mts|cts)$/;
const JS_EXTENSIONS = /\.(?:js|mjs|cjs)$/;
const SFC_EXTENSION = /\.vue$/;
const SFC_VIRTUAL_SUFFIX = '.__export_consumer__.ts';
const ALLOWLIST_KEYS = ['consumer', 'export', 'kind', 'module', 'reason'];
const ALLOWLIST_KINDS = new Set(['unobservable-entrypoint', 'reflective-consumer']);

function canonical(root, fileName) {
  return path.relative(root, path.resolve(fileName)).replaceAll(path.sep, '/');
}

function surfaceKey(module, name) {
  return `${module}\0${name}`;
}

function splitSurfaceKey(key) {
  const separator = key.indexOf('\0');
  return { module: key.slice(0, separator), export: key.slice(separator + 1) };
}

function isGovernedModule(file, candidates) {
  return candidates.has(file);
}

function isTestModule(file) {
  return file.startsWith('tests/') ||
    file.includes('/__tests__/') ||
    /\.(?:test|spec)\.(?:ts|tsx|mts|cts|js|mjs|cjs|vue)$/.test(file) ||
    /(?:^|\/)vitest\.config\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(file);
}

function location(root, sourceFile, node, virtualData) {
  const point = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const generated = canonical(root, sourceFile.fileName);
  const consumer = virtualData?.virtualToCanonical.get(generated) ?? generated;
  const synthetic = ts.isIdentifier(node) ? virtualData?.syntheticLocations.get(generated)?.get(node.text) : null;
  if (synthetic) return `${consumer}:${synthetic.line}:${synthetic.column}`;
  const map = virtualData?.sourceMaps.get(generated);
  if (map) {
    const original = map.originalPositionFor({ line: point.line + 1, column: point.character });
    if (original.line != null && original.column != null) return `${consumer}:${original.line}:${original.column + 1}`;
  }
  return `${consumer}:${point.line + 1}:${point.character + 1}`;
}

function readConfig(root, relativeConfig) {
  const configPath = path.join(root, relativeConfig);
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, path.dirname(configPath), undefined, configPath);
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  }
  return parsed;
}

function exactBrowserRootTarget(specifier, tracked) {
  if (!specifier.startsWith('/')) return null;
  if (!/^\/src\/(?:[^./?#\\][^/?#\\]*\/)*[^./?#\\][^/?#\\]*\.ts$/.test(specifier)) return false;
  const target = `web${specifier}`;
  const matches = [...tracked].filter((file) => file.replaceAll('\\', '/') === target);
  return matches.length === 1 ? target : false;
}

function originalScriptImportUses(file, content) {
  const sourceName = path.resolve(`/${file}.original-script.ts`);
  const options = { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, noResolve: true };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (name) => path.resolve(name) === sourceName;
  host.readFile = (name) => path.resolve(name) === sourceName ? content : undefined;
  host.getSourceFile = (name, languageVersion) => path.resolve(name) === sourceName
    ? ts.createSourceFile(sourceName, content, languageVersion, true, ts.ScriptKind.TS)
    : originalGetSourceFile(name, languageVersion);
  const program = ts.createProgram({ rootNames: [sourceName], options, host });
  const sourceFile = program.getSourceFile(sourceName);
  const checker = program.getTypeChecker();
  const uses = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const typeOnlyClause = statement.importClause.isTypeOnly;
    if (statement.importClause.name && bindingReferences(checker, statement.importClause.name).length > 0) uses.push({ name: statement.importClause.name.text, offset: statement.importClause.name.getStart(sourceFile), typeOnly: typeOnlyClause });
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) {
      if (bindingReferences(checker, element.name).length > 0) uses.push({ name: element.name.text, offset: element.name.getStart(sourceFile), typeOnly: typeOnlyClause || element.isTypeOnly });
    }
  }
  return uses;
}

function compileSfcModules(root, sfcFiles, failures) {
  const virtualSources = new Map();
  const virtualToCanonical = new Map();
  const explicitExports = new Map();
  const sourceMaps = new Map();
  const syntheticLocations = new Map();
  for (const file of sfcFiles) {
    const absolute = path.join(root, file);
    const source = readFileSync(absolute, 'utf8');
    const parsed = parseSfc(source, { filename: absolute, sourceMap: true });
    for (const error of parsed.errors) failures.push({ category: 'unsupported', module: file, export: '*', consumer: file, message: `SFC parse failed: ${typeof error === 'string' ? error : error.message}` });
    const descriptor = parsed.descriptor;
    if (descriptor.script?.src || descriptor.scriptSetup?.src || descriptor.template?.src) failures.push({ category: 'unsupported', module: file, export: '*', consumer: file, message: 'external SFC blocks are unsupported' });
    if (!descriptor.script && !descriptor.scriptSetup) failures.push({ category: 'unsupported', module: file, export: '*', consumer: file, message: 'SFC must contain a script block' });
    for (const block of [descriptor.script, descriptor.scriptSetup].filter(Boolean)) if (block.lang !== 'ts') failures.push({ category: 'unsupported', module: file, export: '*', consumer: file, message: 'SFC scripts must use lang="ts"' });
    if (descriptor.scriptSetup && /\bexport\s/.test(descriptor.scriptSetup.content)) failures.push({ category: 'unsupported', module: file, export: '*', consumer: file, message: 'script-setup exports are unsupported' });
    if (parsed.errors.length || failures.some((item) => item.module === file && item.category === 'unsupported')) continue;
    let compiled;
    try {
      compiled = compileScript(descriptor, {
        id: createHash('sha256').update(source).digest('hex').slice(0, 16),
        fs: {
          fileExists: (fileName) => existsSync(fileName),
          readFile: (fileName) => readFileSync(fileName, 'utf8'),
        },
        inlineTemplate: true,
        sourceMap: true,
      });
    } catch (error) {
      failures.push({ category: 'unsupported', module: file, export: '*', consumer: file, message: `SFC compilation failed: ${error.message}` });
      continue;
    }
    const originalScript = [descriptor.script?.content, descriptor.scriptSetup?.content].filter(Boolean).join('\n');
    const originalUses = originalScriptImportUses(file, originalScript);
    const useTuple = originalUses.length === 0 ? '' : `\ntype __SaivageOriginalScriptImportUses = [${originalUses.map((use) => use.typeOnly ? use.name : `typeof ${use.name}`).join(', ')}];\n`;
    const virtual = `${file}${SFC_VIRTUAL_SUFFIX}`;
    virtualSources.set(path.join(root, virtual), `${compiled.content}${useTuple}`);
    virtualToCanonical.set(virtual, file);
    const originalSourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const ordinaryLength = descriptor.script?.content.length ?? 0;
    const locations = new Map();
    for (const use of originalUses) {
      const absoluteOffset = descriptor.script && use.offset < ordinaryLength
        ? descriptor.script.loc.start.offset + use.offset
        : descriptor.scriptSetup.loc.start.offset + use.offset - (descriptor.script ? ordinaryLength + 1 : 0);
      const point = originalSourceFile.getLineAndCharacterOfPosition(absoluteOffset);
      locations.set(use.name, { line: point.line + 1, column: point.character + 1 });
    }
    syntheticLocations.set(virtual, locations);
    if (compiled.map) sourceMaps.set(virtual, new SourceMapConsumer(compiled.map));
    const names = new Set();
    if (descriptor.script) {
      const ordinary = ts.createSourceFile(`${file}.script.ts`, descriptor.script.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      for (const statement of ordinary.statements) {
        if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
        if (statement.name && ts.isIdentifier(statement.name)) names.add(statement.name.text);
        if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
    }
    explicitExports.set(file, names);
  }
  return { explicitExports, sourceMaps, syntheticLocations, virtualSources, virtualToCanonical };
}

function createProgramContext(root, rootFiles, options, tracked, candidates, virtualData, kind) {
  const host = ts.createCompilerHost(options);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  host.fileExists = (fileName) => virtualData.virtualSources.has(path.resolve(fileName)) || originalFileExists(fileName);
  host.readFile = (fileName) => virtualData.virtualSources.get(path.resolve(fileName)) ?? originalReadFile(fileName);
  host.resolveModuleNameLiterals = (literals, containingFile) => literals.map(({ text }) => {
    const browserTarget = exactBrowserRootTarget(text, tracked);
    if (browserTarget) return { resolvedModule: { resolvedFileName: path.join(root, browserTarget), extension: ts.Extension.Ts, isExternalLibraryImport: false } };
    if (text.endsWith('.vue')) {
      let target;
      if (text.startsWith('@/')) target = `web/src/${text.slice(2)}`;
      else if (text.startsWith('.')) target = canonical(root, path.resolve(path.dirname(containingFile.replace(SFC_VIRTUAL_SUFFIX, '')), text));
      if (target && tracked.has(target)) return { resolvedModule: { resolvedFileName: path.join(root, `${target}${SFC_VIRTUAL_SUFFIX}`), extension: ts.Extension.Ts, isExternalLibraryImport: false } };
    }
    if (kind === 'javascript' && text.startsWith('.')) {
      const absolute = path.resolve(path.dirname(containingFile), text);
      const relative = canonical(root, absolute);
      const match = /^dist\/src\/(.+)\.js$/.exec(relative);
      if (match) {
        const target = `src/${match[1]}.ts`;
        if (candidates.has(target)) return { resolvedModule: { resolvedFileName: path.join(root, target), extension: ts.Extension.Ts, isExternalLibraryImport: false } };
      }
    }
    const resolved = ts.resolveModuleName(text, containingFile.replace(SFC_VIRTUAL_SUFFIX, ''), options, host).resolvedModule;
    return resolved ? { resolvedModule: resolved } : { resolvedModule: undefined };
  });
  const program = ts.createProgram({ rootNames: rootFiles.map((file) => path.join(root, file)), options, host });
  return { checker: program.getTypeChecker(), host, kind, options, program, roots: rootFiles, virtualData };
}

function createPrograms(root, tracked, candidates, failures) {
  const tsFiles = [...tracked].filter((file) => TS_EXTENSIONS.test(file)).sort();
  const sfcFiles = [...tracked].filter((file) => SFC_EXTENSION.test(file) && file.startsWith('web/src/')).sort();
  const jsFiles = [...tracked].filter((file) => JS_EXTENSIONS.test(file)).sort();
  const rootFiles = tsFiles.filter((file) => file.startsWith('src/') || file.startsWith('tests/') || file.startsWith('scripts/'));
  const webFiles = tsFiles.filter((file) => file.startsWith('web/'));
  const docsFiles = tsFiles.filter((file) => file === 'docs/.vitepress/config.ts');
  const assigned = new Set([...rootFiles, ...webFiles, ...docsFiles]);
  for (const file of tsFiles) if (!assigned.has(file)) failures.push({ category: 'unsupported', module: file, export: '*', consumer: file, message: 'tracked TypeScript-family consumer has no semantic host' });
  const virtualData = compileSfcModules(root, sfcFiles, failures);
  const rootOptions = readConfig(root, 'tsconfig.json').options;
  const webOptions = readConfig(root, 'web/tsconfig.json').options;
  const rootContext = createProgramContext(root, rootFiles, rootOptions, tracked, candidates, virtualData, 'root');
  const webContext = createProgramContext(root, [...webFiles, ...sfcFiles.map((file) => `${file}${SFC_VIRTUAL_SUFFIX}`)], webOptions, tracked, candidates, virtualData, 'web');
  const docsContext = createProgramContext(root, docsFiles, rootOptions, tracked, candidates, virtualData, 'docs');
  const jsOptions = { ...rootOptions, allowJs: true, checkJs: false, noEmit: true, declaration: false, outDir: undefined };
  const jsContext = createProgramContext(root, jsFiles, jsOptions, tracked, candidates, virtualData, 'javascript');
  return { contexts: [rootContext, webContext, docsContext, jsContext], declarationFiles: tsFiles.filter((file) => DECLARATION_SUFFIX.test(file)), jsFiles, sfcFiles, tsFiles, virtualData };
}

function modulePath(root, checker, specifier, virtualData) {
  const symbol = checker.getSymbolAtLocation(specifier);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  const sourceFile = declaration && (ts.isSourceFile(declaration) ? declaration : declaration.getSourceFile());
  if (!sourceFile) return null;
  const found = canonical(root, sourceFile.fileName);
  return virtualData?.virtualToCanonical.get(found) ?? found;
}

function exportedName(element) {
  return element.name.text;
}

function importedName(element) {
  return element.propertyName?.text ?? element.name.text;
}

function getModuleExports(checker, sourceFile) {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  return moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : [];
}

function exportedNames(checker, sourceFile) {
  return getModuleExports(checker, sourceFile).map((symbol) => symbol.getName()).sort();
}

function unwrap(expression) {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAwaitExpression(current)) current = current.expression;
  return current;
}

function dynamicImportSpecifier(expression) {
  const current = unwrap(expression);
  if (!ts.isCallExpression(current) || current.expression.kind !== ts.SyntaxKind.ImportKeyword || current.arguments.length !== 1) return null;
  return ts.isStringLiteralLike(current.arguments[0]) ? current.arguments[0] : null;
}

function bindingReferences(checker, binding) {
  const symbol = checker.getSymbolAtLocation(binding);
  if (!symbol) return [];
  const references = [];
  const visit = (node) => {
    if (ts.isIdentifier(node) && node !== binding) {
      const direct = checker.getSymbolAtLocation(node);
      const value = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node ? checker.getShorthandAssignmentValueSymbol(node.parent) : direct;
      if (value === symbol) references.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(binding.getSourceFile());
  return references;
}

function directExportDeclarationName(node) {
  if (!node.parent) return false;
  if ((ts.isInterfaceDeclaration(node.parent) || ts.isTypeAliasDeclaration(node.parent) || ts.isClassDeclaration(node.parent) ||
      ts.isFunctionDeclaration(node.parent) || ts.isEnumDeclaration(node.parent) || ts.isModuleDeclaration(node.parent)) && node.parent.name === node) return true;
  if (ts.isVariableDeclaration(node.parent) && node.parent.name === node) return true;
  return ts.isExportSpecifier(node.parent) || ts.isImportSpecifier(node.parent) || ts.isImportClause(node.parent) || ts.isNamespaceImport(node.parent);
}

function ultimateSymbol(checker, symbol) {
  return symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function localUse(checker, sourceFile, exportSymbol) {
  const target = ultimateSymbol(checker, exportSymbol);
  if (!target) return [];
  const used = [];
  const visit = (node) => {
    if (ts.isIdentifier(node) && !directExportDeclarationName(node)) {
      const symbol = ultimateSymbol(checker, checker.getSymbolAtLocation(node));
      if (symbol === target) used.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return used;
}

function queryParts(text) {
  const index = text.indexOf('?');
  return index < 0 ? { base: text, query: null } : { base: text.slice(0, index), query: text.slice(index + 1) };
}

function resolveQueriedModule(root, sourceFile, specifier, options) {
  const { base, query } = queryParts(specifier.text);
  const resolved = ts.resolveModuleName(base, sourceFile.fileName, options, ts.sys).resolvedModule;
  return { module: resolved ? canonical(root, resolved.resolvedFileName) : null, query };
}

function reachesGoverned(start, routes, governedKeys) {
  const found = new Set();
  const pending = [start];
  const visited = new Set();
  while (pending.length > 0) {
    const key = pending.pop();
    if (visited.has(key)) continue;
    visited.add(key);
    if (governedKeys.has(key)) found.add(key);
    for (const target of routes.get(key) ?? []) pending.push(target);
  }
  return found;
}

function addRoute(routes, from, to) {
  const targets = routes.get(from) ?? new Set();
  targets.add(to);
  routes.set(from, targets);
}

function addUse(uses, key, kind, at) {
  const record = uses.get(key) ?? { production: new Set(), test: new Set() };
  record[kind].add(at);
  uses.set(key, record);
}

function isStringOnlyNegativeAssertion(node) {
  let current = node;
  while (current.parent && !ts.isStatement(current)) current = current.parent;
  const text = current.getText();
  return text.includes('toBeUndefined(') || (text.includes('.not.') && (text.includes('toHaveProperty(') || text.includes('toContain(') || text.includes('toBeDefined(')));
}

function isKnownNonConsumingReflection(node) {
  let current = node;
  for (let depth = 0; depth < 8 && current.parent; depth += 1) {
    current = current.parent;
    if (ts.isCallExpression(current) && current.expression.getText().includes('toHaveProperty')) return true;
    if (ts.isStatement(current)) return /expect\([^)]*\)\.toBe\(false\)/.test(current.getText()) && current.getText().includes(' in ');
  }
  return false;
}

function isImportOriginalType(node) {
  let current = node;
  for (let depth = 0; depth < 6 && current.parent; depth += 1) {
    current = current.parent;
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === 'importOriginal') return true;
  }
  return false;
}

function collectRouteDeclarations(root, tracked, candidates, context, routes, failures) {
  const { checker, program, virtualData } = context;
  const owned = new Set(context.roots.map((file) => file.endsWith(SFC_VIRTUAL_SUFFIX) ? file.slice(0, -SFC_VIRTUAL_SUFFIX.length) : file));
  for (const sourceFile of program.getSourceFiles()) {
    const generated = canonical(root, sourceFile.fileName);
    const fromModule = virtualData.virtualToCanonical.get(generated) ?? generated;
    if (!tracked.has(fromModule) || !owned.has(fromModule)) continue;
    const localImports = new Map();
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
      const targetModule = modulePath(root, checker, statement.moduleSpecifier, virtualData);
      if (!targetModule) continue;
      if (statement.importClause.name) localImports.set(statement.importClause.name.text, surfaceKey(targetModule, 'default'));
      const bindings = statement.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) localImports.set(element.name.text, surfaceKey(targetModule, importedName(element)));
    }
    for (const statement of sourceFile.statements) {
      if (!ts.isExportDeclaration(statement)) continue;
      if (statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        const targetModule = modulePath(root, checker, statement.moduleSpecifier, virtualData);
        if (!targetModule) {
          if (isGovernedModule(fromModule, candidates)) failures.push({ category: 'unresolved-edge', module: fromModule, export: '*', consumer: location(root, sourceFile, statement.moduleSpecifier, virtualData), message: `cannot resolve export edge ${statement.moduleSpecifier.text}` });
          continue;
        }
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) addRoute(routes, surfaceKey(fromModule, exportedName(element)), surfaceKey(targetModule, importedName(element)));
        } else if (!statement.exportClause) {
          const targetFile = program.getSourceFile(path.resolve(root, targetModule));
          if (targetFile) for (const name of exportedNames(checker, targetFile).filter((name) => name !== 'default')) addRoute(routes, surfaceKey(fromModule, name), surfaceKey(targetModule, name));
        } else {
          failures.push({ category: 'unsupported', module: fromModule, export: '*', consumer: location(root, sourceFile, statement, virtualData), message: 'namespace re-export is unsupported' });
        }
      } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const local = element.propertyName ?? element.name;
          const target = localImports.get(local.text);
          if (target) addRoute(routes, surfaceKey(fromModule, exportedName(element)), target);
        }
      }
    }
  }
}

function collectImports(root, tracked, candidates, context, routes, governedKeys, uses, failures, unsupported) {
  const { checker, options, program, virtualData } = context;
  const owned = new Set(context.roots.map((file) => file.endsWith(SFC_VIRTUAL_SUFFIX) ? file.slice(0, -SFC_VIRTUAL_SUFFIX.length) : file));
  for (const sourceFile of program.getSourceFiles()) {
    const generated = canonical(root, sourceFile.fileName);
    const consumer = virtualData.virtualToCanonical.get(generated) ?? generated;
    if (!tracked.has(consumer) || !owned.has(consumer)) continue;
    const kind = isTestModule(consumer) ? 'test' : 'production';
    const observe = (start, node) => {
      const pending = [start];
      const visited = new Set();
      while (pending.length > 0) {
        const key = pending.pop();
        if (visited.has(key)) continue;
        visited.add(key);
        if (governedKeys.has(key)) addUse(uses, key, kind, location(root, sourceFile, node, virtualData));
        for (const target of routes.get(key) ?? []) pending.push(target);
      }
    };
    const unsupportedUse = (module, exportName, node, message) => {
      if (exportName === '*') {
        const routedNames = [...routes.keys()].filter((key) => splitSurfaceKey(key).module === module);
        if (!isGovernedModule(module, candidates) && !routedNames.some((key) => reachesGoverned(key, routes, governedKeys).size > 0)) return;
        const item = { category: 'unsupported', module, export: '*', consumer: location(root, sourceFile, node, virtualData), message };
        failures.push(item);
        unsupported.push(item);
        return;
      }
      const startKeys = exportName === '*'
        ? [...governedKeys].filter((key) => splitSurfaceKey(key).module === module || reachesGoverned(surfaceKey(module, splitSurfaceKey(key).export), routes, governedKeys).has(key))
        : [surfaceKey(module, exportName)];
      const reached = new Set(startKeys.flatMap((key) => [...reachesGoverned(key, routes, governedKeys)]));
      for (const key of reached) {
        const item = { category: 'unsupported', ...splitSurfaceKey(key), consumer: location(root, sourceFile, node, virtualData), message };
        failures.push(item);
        unsupported.push(item);
      }
    };

    const visit = (node) => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1) {
        const argument = node.arguments[0];
        if (ts.isStringLiteralLike(argument) && argument.text.startsWith('/') && exactBrowserRootTarget(argument.text, tracked) === false) {
          const item = { category: 'unsupported', module: argument.text, export: '*', consumer: location(root, sourceFile, argument, virtualData), message: 'invalid or unresolved root-relative module specifier' };
          failures.push(item);
          unsupported.push(item);
          return;
        }
        if (!ts.isStringLiteralLike(argument) && ts.isIdentifier(argument)) {
          const symbol = checker.getSymbolAtLocation(argument);
          const declaration = symbol?.valueDeclaration;
          const initializer = declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : null;
          if (initializer && ts.isStringLiteralLike(initializer) && initializer.text.startsWith('/')) {
            const item = { category: 'unsupported', module: initializer.text, export: '*', consumer: location(root, sourceFile, argument, virtualData), message: 'computed root-relative dynamic import is unsupported' };
            failures.push(item);
            unsupported.push(item);
            return;
          }
        }
        if (!ts.isStringLiteralLike(argument)) {
          const item = { category: 'unsupported', module: '<computed-import>', export: '*', consumer: location(root, sourceFile, argument, virtualData), message: 'computed dynamic import is unsupported' };
          failures.push(item);
          unsupported.push(item);
          return;
        }
      }

      if (context.kind === 'javascript' && ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const targetModule = modulePath(root, checker, node.moduleSpecifier, virtualData) ?? resolveQueriedModule(root, sourceFile, node.moduleSpecifier, options).module;
        if (targetModule && isGovernedModule(targetModule, candidates)) {
          unsupportedUse(targetModule, '*', node, 'JavaScript re-exports from governed modules are unsupported');
          return;
        }
      }

      if (context.kind === 'javascript' && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
        const targetModule = resolveQueriedModule(root, sourceFile, node.arguments[0], options).module;
        if (targetModule && isGovernedModule(targetModule, candidates)) unsupportedUse(targetModule, '*', node, 'CommonJS require of a governed module is unsupported');
        return;
      }

      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'glob' && node.expression.expression.getText(sourceFile) === 'import.meta') {
        const text = node.getText(sourceFile);
        const exactRaw = /^import\.meta\.glob\(['"]\.\.\/components\/debug\/\*Panel\.vue['"],\s*\{[\s\S]*eager:\s*true,[\s\S]*query:\s*['"]\?raw['"],[\s\S]*import:\s*['"]default['"][\s\S]*\}\)$/.test(text);
        if (!exactRaw && text.includes('.vue')) {
          const item = { category: 'unsupported', module: 'web/src/**/*.vue', export: '*', consumer: location(root, sourceFile, node, virtualData), message: 'unsupported import.meta.glob form intersects governed SFC modules' };
          failures.push(item);
          unsupported.push(item);
        }
        return;
      }

      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const queried = resolveQueriedModule(root, sourceFile, node.moduleSpecifier, options);
         const resolvedModule = modulePath(root, checker, node.moduleSpecifier, virtualData) ?? queried.module;
        if (queried.query) {
           if (resolvedModule && queried.query !== 'raw' && isGovernedModule(resolvedModule, candidates)) unsupportedUse(resolvedModule, '*', node.moduleSpecifier, `unsupported query transform ?${queried.query}`);
          return;
        }
        if (!resolvedModule || !node.importClause) return;
        if (context.kind === 'javascript' && isGovernedModule(resolvedModule, candidates) && (node.importClause.name || (node.importClause.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings)))) {
          unsupportedUse(resolvedModule, '*', node, 'JavaScript default and namespace imports from governed modules are unsupported');
          return;
        }
        const routedLocalNames = new Set();
        for (const statement of sourceFile.statements) {
          if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
          for (const element of statement.exportClause.elements) routedLocalNames.add((element.propertyName ?? element.name).text);
        }
        if (node.importClause.name) {
          const key = surfaceKey(resolvedModule, 'default');
          const governed = reachesGoverned(key, routes, governedKeys);
          const references = bindingReferences(checker, node.importClause.name);
           if (governed.size > 0 && references.length === 0 && !routedLocalNames.has(node.importClause.name.text)) failures.push({ category: 'stale-import', ...splitSurfaceKey(key), consumer: location(root, sourceFile, node.importClause.name, virtualData), message: 'unused default import' });
          for (const reference of references) observe(key, reference);
        }
        const bindings = node.importClause.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const key = surfaceKey(resolvedModule, importedName(element));
            const governed = reachesGoverned(key, routes, governedKeys);
             if (isGovernedModule(resolvedModule, candidates) && !governedKeys.has(key) && governed.size === 0) failures.push({ category: 'unresolved-edge', module: resolvedModule, export: importedName(element), consumer: location(root, sourceFile, element, virtualData), message: 'governed import names no export' });
            const references = bindingReferences(checker, element.name);
             if (governed.size > 0 && references.length === 0 && !routedLocalNames.has(element.name.text)) failures.push({ category: 'stale-import', ...splitSurfaceKey(key), consumer: location(root, sourceFile, element, virtualData), message: 'import binding is never referenced' });
            for (const reference of references) observe(key, reference);
          }
        } else if (bindings && ts.isNamespaceImport(bindings)) {
          const names = new Set([...governedKeys].map((key) => splitSurfaceKey(key)).filter((part) => part.module === resolvedModule).map((part) => part.export));
          const references = bindingReferences(checker, bindings.name);
          if (names.size > 0 && references.length === 0) failures.push({ category: 'stale-import', module: resolvedModule, export: '*', consumer: location(root, sourceFile, bindings.name, virtualData), message: 'namespace import binding is never referenced' });
          for (const reference of references) {
            const parent = reference.parent;
            if (ts.isPropertyAccessExpression(parent) && parent.expression === reference) {
              observe(surfaceKey(resolvedModule, parent.name.text), parent.name);
            } else if (ts.isQualifiedName(parent) && parent.left === reference) {
              observe(surfaceKey(resolvedModule, parent.right.text), parent.right);
            } else if (ts.isElementAccessExpression(parent) && parent.expression === reference && parent.argumentExpression && ts.isStringLiteralLike(parent.argumentExpression)) {
              observe(surfaceKey(resolvedModule, parent.argumentExpression.text), parent.argumentExpression);
            } else if (ts.isVariableDeclaration(parent) && parent.initializer === reference && ts.isObjectBindingPattern(parent.name)) {
              for (const element of parent.name.elements) {
                const name = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : ts.isIdentifier(element.name) ? element.name.text : null;
                if (name) observe(surfaceKey(resolvedModule, name), element);
              }
            } else {
              let evidenceNode = parent;
              for (let depth = 0; depth < 4 && evidenceNode.parent && !ts.isStatement(evidenceNode); depth += 1) evidenceNode = evidenceNode.parent;
              const allLiterals = [];
              const collectLiterals = (candidate) => {
                if (ts.isStringLiteralLike(candidate)) allLiterals.push(candidate.text);
                ts.forEachChild(candidate, collectLiterals);
              };
              collectLiterals(evidenceNode);
              const literals = allLiterals.filter((name) => names.has(name));
              if (literals.length > 0) for (const name of literals) unsupportedUse(resolvedModule, name, parent, 'reflective namespace use does not establish semantic consumption');
              else if (allLiterals.length === 0 && !isStringOnlyNegativeAssertion(parent) && !isKnownNonConsumingReflection(parent)) unsupportedUse(resolvedModule, '*', parent, 'whole-module namespace use is unsupported');
            }
          }
        }
        return;
      }

      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
        if (isImportOriginalType(node)) return;
         const targetModule = modulePath(root, checker, node.argument.literal, virtualData) ?? resolveQueriedModule(root, sourceFile, node.argument.literal, options).module;
        if (targetModule && node.qualifier) {
          let qualifier = node.qualifier;
          while (ts.isQualifiedName(qualifier)) qualifier = qualifier.left;
          if (ts.isIdentifier(qualifier)) observe(surfaceKey(targetModule, qualifier.text), node.qualifier);
        } else if (targetModule) unsupportedUse(targetModule, '*', node, 'whole-module type query is unsupported');
        return;
      }

      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const expression = node.expression;
        const specifier = dynamicImportSpecifier(expression);
        if (specifier) {
           const targetModule = modulePath(root, checker, specifier, virtualData) ?? resolveQueriedModule(root, sourceFile, specifier, options).module;
          const name = ts.isPropertyAccessExpression(node) ? node.name.text : node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : null;
          if (targetModule && name) observe(surfaceKey(targetModule, name), node);
          else if (targetModule) unsupportedUse(targetModule, '*', node, 'computed dynamic-import member is unsupported');
          return;
        }
      }

      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'then') {
        const specifier = dynamicImportSpecifier(node.expression.expression);
        const callback = node.arguments[0];
        if (specifier && callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && callback.parameters.length === 1 && ts.isIdentifier(callback.parameters[0].name)) {
          const targetModule = modulePath(root, checker, specifier, virtualData) ?? resolveQueriedModule(root, sourceFile, specifier, options).module;
          if (targetModule) {
            for (const reference of bindingReferences(checker, callback.parameters[0].name)) {
              const parent = reference.parent;
              if (ts.isPropertyAccessExpression(parent) && parent.expression === reference) observe(surfaceKey(targetModule, parent.name.text), parent.name);
              else if (ts.isElementAccessExpression(parent) && parent.expression === reference && parent.argumentExpression && ts.isStringLiteralLike(parent.argumentExpression)) observe(surfaceKey(targetModule, parent.argumentExpression.text), parent.argumentExpression);
              else unsupportedUse(targetModule, '*', parent, 'dynamic-import callback must select an exact literal member');
            }
          }
        }
      }

      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
        let parent = node.parent;
        while (ts.isParenthesizedExpression(parent) || ts.isAwaitExpression(parent) || ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent)) parent = parent.parent;
         const targetModule = modulePath(root, checker, node.arguments[0], virtualData) ?? resolveQueriedModule(root, sourceFile, node.arguments[0], options).module;
        if (targetModule && ts.isVariableDeclaration(parent) && parent.initializer && parent.name && ts.isObjectBindingPattern(parent.name)) {
          for (const element of parent.name.elements) {
            const name = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : ts.isIdentifier(element.name) ? element.name.text : null;
            if (name) observe(surfaceKey(targetModule, name), element);
          }
        } else if (targetModule && ts.isVariableDeclaration(parent) && parent.initializer && parent.name && ts.isIdentifier(parent.name)) {
          if (context.kind === 'javascript') {
            unsupportedUse(targetModule, '*', parent, 'JavaScript dynamic-import namespace bindings are unsupported');
            return;
          }
          const exported = new Set([...governedKeys].map(splitSurfaceKey).filter((part) => part.module === targetModule).map((part) => part.export));
          const references = bindingReferences(checker, parent.name);
          if (references.length === 0) failures.push({ category: 'stale-import', module: targetModule, export: '*', consumer: location(root, sourceFile, parent.name, virtualData), message: 'dynamic-import namespace binding is never referenced' });
          for (const reference of references) {
            const referenceParent = reference.parent;
            if (ts.isPropertyAccessExpression(referenceParent) && referenceParent.expression === reference) observe(surfaceKey(targetModule, referenceParent.name.text), referenceParent.name);
            else if (ts.isElementAccessExpression(referenceParent) && referenceParent.expression === reference && referenceParent.argumentExpression && ts.isStringLiteralLike(referenceParent.argumentExpression)) observe(surfaceKey(targetModule, referenceParent.argumentExpression.text), referenceParent.argumentExpression);
            else {
              let evidenceNode = referenceParent;
              for (let depth = 0; depth < 4 && evidenceNode.parent && !ts.isStatement(evidenceNode); depth += 1) evidenceNode = evidenceNode.parent;
              const literals = [];
              const collectLiterals = (candidate) => {
                if (ts.isStringLiteralLike(candidate)) literals.push(candidate);
                ts.forEachChild(candidate, collectLiterals);
              };
              collectLiterals(evidenceNode);
              const literal = literals.find((child) => exported.has(child.text));
              if (literal) unsupportedUse(targetModule, literal.text, referenceParent, 'reflective dynamic-import use does not establish semantic consumption');
            }
          }
        }
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
}

function parseAllowlist(root, allowlistPath, tracked, candidates, surfaces, classifications, unsupported) {
  let value;
  try {
    value = JSON.parse(readFileSync(path.join(root, allowlistPath), 'utf8'));
  } catch (error) {
    return { entries: [], failures: [{ category: 'allowlist', module: allowlistPath, export: '*', consumer: allowlistPath, message: `cannot read strict allowlist: ${error.message}` }] };
  }
  const failures = [];
  if (!Array.isArray(value)) return { entries: [], failures: [{ category: 'allowlist', module: allowlistPath, export: '*', consumer: allowlistPath, message: 'allowlist must be a top-level array' }] };
  const entries = [];
  const seen = new Set();
  for (const [index, entry] of value.entries()) {
    const at = `${allowlistPath}[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).sort().join('\0') !== ALLOWLIST_KEYS.join('\0')) {
      failures.push({ category: 'allowlist', module: allowlistPath, export: '*', consumer: at, message: 'entry must contain exactly module, export, kind, consumer, reason' });
      continue;
    }
    if (![entry.module, entry.export, entry.consumer, entry.reason].every((field) => typeof field === 'string' && field.length > 0) || !ALLOWLIST_KINDS.has(entry.kind)) {
      failures.push({ category: 'allowlist', module: entry.module ?? allowlistPath, export: entry.export ?? '*', consumer: at, message: 'entry fields or kind are invalid' });
      continue;
    }
    const key = surfaceKey(entry.module, entry.export);
    if (seen.has(key)) failures.push({ category: 'allowlist', module: entry.module, export: entry.export, consumer: at, message: 'duplicate exact export entry' });
    seen.add(key);
    const classification = classifications.get(key);
    if (!surfaces.has(key)) failures.push({ category: 'allowlist-stale', module: entry.module, export: entry.export, consumer: entry.consumer, message: 'allowlisted export does not exist' });
    else if (!tracked.has(entry.consumer) || isGovernedModule(entry.consumer, candidates)) failures.push({ category: 'allowlist-stale', module: entry.module, export: entry.export, consumer: entry.consumer, message: 'consumer must be an exact tracked non-governed file' });
    else if (entry.reason.length < 20 || /(?:baseline|generic|test.only)/i.test(entry.reason)) failures.push({ category: 'allowlist', module: entry.module, export: entry.export, consumer: entry.consumer, message: 'reason must be concrete and cannot describe a baseline or test-only use' });
    else if (classification === 'production-consumed' || classification === 'test-only') failures.push({ category: 'allowlist-stale', module: entry.module, export: entry.export, consumer: entry.consumer, message: 'export has a compiler-visible external consumer' });
    else {
      const content = readFileSync(path.join(root, entry.consumer), 'utf8');
      const namesExactEvidence = content.includes(entry.module) && content.includes(entry.export);
      const reflectiveEvidence = unsupported.some((item) => item.module === entry.module && item.export === entry.export && item.consumer.startsWith(`${entry.consumer}:`));
      const executable = /(?:^|\/)(?:package\.json|[^/]+\.(?:js|cjs|mjs))$/.test(entry.consumer);
      if (entry.kind === 'reflective-consumer' && (!namesExactEvidence || !reflectiveEvidence)) failures.push({ category: 'allowlist-stale', module: entry.module, export: entry.export, consumer: entry.consumer, message: 'exact reflective evidence no longer exists' });
      if (entry.kind === 'unobservable-entrypoint' && (!executable || !namesExactEvidence)) failures.push({ category: 'allowlist-stale', module: entry.module, export: entry.export, consumer: entry.consumer, message: 'exact executable entrypoint evidence no longer exists' });
    }
    entries.push(entry);
  }
  return { entries, failures };
}

function declarationOptions(options) {
  return {
    ...options,
    composite: false,
    declaration: true,
    declarationMap: false,
    emitDeclarationOnly: true,
    incremental: false,
    noEmit: false,
    noEmitOnError: false,
    sourceMap: false,
    tsBuildInfoFile: undefined,
  };
}

function diagnosticLocation(root, diagnostic, outputOwners) {
  if (!diagnostic.file || diagnostic.start == null) return null;
  const outputOwner = outputOwners.get(path.resolve(diagnostic.file.fileName));
  if (outputOwner) {
    const point = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return `${outputOwner.module}#declaration:${point.line + 1}:${point.character + 1}`;
  }
  const point = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${canonical(root, diagnostic.file.fileName)}:${point.line + 1}:${point.character + 1}`;
}

function declarationDiagnosticFailure(root, diagnostic, contextKey, unit, outputOwners) {
  const primary = diagnosticLocation(root, diagnostic, outputOwners);
  const related = (diagnostic.relatedInformation ?? []).map((item) => diagnosticLocation(root, item, outputOwners)).filter(Boolean).sort();
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  return {
    category: 'declaration-diagnostic',
    module: unit ?? `@declaration-context/${contextKey}`,
    export: '*',
    consumer: primary ?? (unit ? `${unit}#declaration-emit` : `@declaration-context/${contextKey}`),
    message: `TS${diagnostic.code}: ${message}${related.length > 0 ? ` (related: ${related.join(', ')})` : ''}`,
  };
}

function diagnosticKey(root, diagnostic, outputOwners) {
  return [diagnostic.code, ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'), diagnosticLocation(root, diagnostic, outputOwners) ?? '',
    ...(diagnostic.relatedInformation ?? []).map((item) => diagnosticLocation(root, item, outputOwners) ?? '').sort()].join('\0');
}

function declarationMemberName(node) {
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (ts.isCallSignatureDeclaration(node)) return 'call';
  if (ts.isConstructSignatureDeclaration(node)) return 'construct';
  if (ts.isIndexSignatureDeclaration(node)) return 'index';
  if (ts.isGetAccessorDeclaration(node)) return `get:${node.name.getText()}`;
  if (ts.isSetAccessorDeclaration(node)) return `set:${node.name.getText()}`;
  if ((ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) && node.name) return `method:${node.name.getText()}`;
  if ((ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) && node.name) return `property:${node.name.getText()}`;
  if (ts.isParameter(node)) return `parameter:${node.name.getText()}`;
  if (ts.isTypeParameterDeclaration(node)) return `type-parameter:${node.name.text}`;
  return null;
}

function hasPrivateModifier(node) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword));
}

function firstEntityName(name) {
  let current = name;
  while (current && ts.isQualifiedName(current)) current = current.left;
  return current && ts.isIdentifier(current) ? current.text : null;
}

function createDeclarationClosure(root, tracked, candidates, ownership, surfaces, directClassifications, failures) {
  const ordinaryCandidates = [...candidates].filter((file) => TS_EXTENSIONS.test(file) && !DECLARATION_SUFFIX.test(file)).sort();
  const rootCandidates = ordinaryCandidates.filter((file) => file.startsWith('src/'));
  const webCandidates = ordinaryCandidates.filter((file) => file.startsWith('web/src/'));
  const rootOptions = declarationOptions(readConfig(root, 'tsconfig.json').options);
  const webOptions = declarationOptions(readConfig(root, 'web/tsconfig.json').options);
  const contexts = [
    createProgramContext(root, rootCandidates, rootOptions, tracked, candidates, ownership.virtualData, 'declaration-root'),
    createProgramContext(root, webCandidates, webOptions, tracked, candidates, ownership.virtualData, 'declaration-web'),
  ];
  const outputs = new Map();
  const outputOwners = new Map();
  const units = new Map();
  const diagnosticSeen = new Set();

  for (const context of contexts) {
    const contextKey = context.kind.replace('declaration-', '');
    for (const diagnostic of [...context.program.getOptionsDiagnostics(), ...context.program.getGlobalDiagnostics()].filter((item) => item.category === ts.DiagnosticCategory.Error)) {
      const key = `${contextKey}\0${diagnosticKey(root, diagnostic, outputOwners)}`;
      if (diagnosticSeen.has(key)) continue;
      diagnosticSeen.add(key);
      failures.push(declarationDiagnosticFailure(root, diagnostic, contextKey, null, outputOwners));
    }
    for (const module of context.roots) {
      const sourceFile = context.program.getSourceFile(path.join(root, module));
      if (!sourceFile) throw new Error(`ordinary declaration candidate is absent from owning program: ${module}`);
      const unitOutputs = [];
      const emit = context.program.emit(sourceFile, (fileName, text, _bom, _errors, sourceFiles) => {
        const absolute = path.resolve(fileName);
        const attributable = sourceFiles?.some((item) => path.resolve(item.fileName) === path.resolve(sourceFile.fileName)) ?? false;
        if (!attributable) return;
        unitOutputs.push({ absolute, fileName, text });
      }, undefined, true);
      const primary = unitOutputs.filter((item) => DECLARATION_SUFFIX.test(item.fileName));
      if (unitOutputs.some((item) => !DECLARATION_SUFFIX.test(item.fileName)) || primary.length !== 1) {
        failures.push({ category: 'declaration-diagnostic', module, export: '*', consumer: `${module}#declaration-emit`, message: `ordinary candidate emit produced ${primary.length} primary declaration outputs and ${unitOutputs.length - primary.length} unexpected outputs` });
      }
      if (primary.length === 1) {
        outputs.set(primary[0].absolute, primary[0].text);
        const owner = { context, module, sourceFile };
        outputOwners.set(primary[0].absolute, owner);
        units.set(module, { ...owner, output: primary[0].absolute });
      }
      const diagnostics = [
        ...context.program.getSyntacticDiagnostics(sourceFile),
        ...context.program.getSemanticDiagnostics(sourceFile),
        ...context.program.getDeclarationDiagnostics(sourceFile),
        ...emit.diagnostics,
      ].filter((item) => item.category === ts.DiagnosticCategory.Error);
      for (const diagnostic of diagnostics) {
        const locations = [diagnostic, ...(diagnostic.relatedInformation ?? [])].map((item) => item.file && path.resolve(item.file.fileName));
        const attributed = diagnostic.file == null || locations.includes(path.resolve(sourceFile.fileName)) || locations.some((file) => file && outputOwners.get(file)?.module === module);
        if (!attributed) continue;
        const key = `${module}\0${diagnosticKey(root, diagnostic, outputOwners)}`;
        if (diagnosticSeen.has(key)) continue;
        diagnosticSeen.add(key);
        failures.push(declarationDiagnosticFailure(root, diagnostic, contextKey, module, outputOwners));
      }
    }
  }

  const graphOptions = { ...rootOptions, noEmit: true, emitDeclarationOnly: false, allowJs: false };
  const graphHost = ts.createCompilerHost(graphOptions);
  const originalFileExists = graphHost.fileExists.bind(graphHost);
  const originalReadFile = graphHost.readFile.bind(graphHost);
  graphHost.fileExists = (fileName) => outputs.has(path.resolve(fileName)) || originalFileExists(fileName);
  graphHost.readFile = (fileName) => outputs.get(path.resolve(fileName)) ?? originalReadFile(fileName);
  graphHost.resolveModuleNameLiterals = (literals, containingFile) => literals.map(({ text }) => {
    const owner = outputOwners.get(path.resolve(containingFile));
    if (owner) {
      const resolved = owner.context.host.resolveModuleNameLiterals([{ text }], owner.sourceFile.fileName)[0]?.resolvedModule;
      if (resolved) {
        const generated = canonical(root, resolved.resolvedFileName);
        const sourceModule = ownership.virtualData.virtualToCanonical.get(generated) ?? generated;
        const targetOutput = units.get(sourceModule)?.output;
        if (targetOutput) return { resolvedModule: { resolvedFileName: targetOutput, extension: ts.Extension.Dts, isExternalLibraryImport: false } };
      }
    }
    const resolved = ts.resolveModuleName(text, containingFile, graphOptions, graphHost).resolvedModule;
    return { resolvedModule: resolved };
  });
  const declarationProgram = ts.createProgram({ rootNames: [...outputs.keys()].sort(), options: graphOptions, host: graphHost });
  const checker = declarationProgram.getTypeChecker();
  const outgoing = new Map([...surfaces.keys()].map((key) => [key, []]));

  const resolveSpecifier = (owner, specifier, exportName) => {
    const resolved = owner.context.host.resolveModuleNameLiterals([{ text: specifier }], owner.sourceFile.fileName)[0]?.resolvedModule;
    if (!resolved) return null;
    const generated = canonical(root, resolved.resolvedFileName);
    const module = ownership.virtualData.virtualToCanonical.get(generated) ?? generated;
    const key = surfaceKey(module, exportName);
    return surfaces.has(key) ? key : null;
  };

  for (const [sourceKey, sourceSurface] of surfaces) {
    const unit = units.get(sourceSurface.module);
    if (!unit) continue;
    const declarationFile = declarationProgram.getSourceFile(unit.output);
    if (!declarationFile) throw new Error(`in-memory declaration output is absent from declaration graph: ${sourceSurface.module}`);
    const moduleSymbol = checker.getSymbolAtLocation(declarationFile);
    const exportSymbol = moduleSymbol && checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.getName() === sourceSurface.export);
    if (!exportSymbol) {
      failures.push({ category: 'declaration-diagnostic', module: sourceSurface.module, export: sourceSurface.export, consumer: `${sourceSurface.module}#declaration-emit`, message: 'emitted declaration does not contain the governed export surface' });
      continue;
    }
    const imports = new Map();
    for (const statement of declarationFile.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (statement.importClause.name) imports.set(statement.importClause.name.text, { exportName: 'default', specifier });
      const bindings = statement.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) imports.set(element.name.text, { exportName: importedName(element), specifier });
      if (bindings && ts.isNamespaceImport(bindings)) imports.set(bindings.name.text, { exportName: '*', specifier });
    }
    const edgeIdentities = new Set();
    const addEdge = (targetKey, memberPath) => {
      if (!targetKey || targetKey === sourceKey) return;
      const identity = `${targetKey}\0${memberPath}`;
      if (edgeIdentities.has(identity)) return;
      edgeIdentities.add(identity);
      outgoing.get(sourceKey).push({
        sourceSurface,
        targetSurface: splitSurfaceKey(targetKey),
        memberPath,
      });
    };
    const walk = (node, memberPath, visitedDeclarations) => {
      if (hasPrivateModifier(node)) return;
      const label = declarationMemberName(node);
      const nextPath = label ? `${memberPath}.${label}` : memberPath;
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
        let exportName = firstEntityName(node.qualifier);
        if (!exportName && ts.isIndexedAccessTypeNode(node.parent) && node.parent.objectType === node && ts.isLiteralTypeNode(node.parent.indexType) && ts.isStringLiteralLike(node.parent.indexType.literal)) exportName = node.parent.indexType.literal.text;
        if (exportName) addEdge(resolveSpecifier(unit, node.argument.literal.text, exportName), nextPath);
      }
      if (ts.isIdentifier(node)) {
        const imported = imports.get(node.text);
        if (imported) {
          let exportName = imported.exportName;
          if (exportName === '*' && ts.isQualifiedName(node.parent) && node.parent.left === node) exportName = node.parent.right.text;
          if (exportName !== '*') addEdge(resolveSpecifier(unit, imported.specifier, exportName), nextPath);
        } else if (node.parent?.name !== node) {
          const symbol = checker.getSymbolAtLocation(node);
          for (const declaration of symbol?.declarations ?? []) {
            if (declaration.getSourceFile() !== declarationFile || visitedDeclarations.has(declaration)) continue;
            if (directExportDeclarationName(node) && declaration === node.parent) continue;
            walk(declaration, nextPath, new Set([...visitedDeclarations, declaration]));
          }
        }
      }
      ts.forEachChild(node, (child) => walk(child, nextPath, visitedDeclarations));
    };
    for (const declaration of exportSymbol.declarations ?? []) {
      walk(declaration, sourceSurface.export, new Set([declaration]));
    }
    outgoing.get(sourceKey).sort((a, b) => surfaceKey(a.targetSurface.module, a.targetSurface.export).localeCompare(surfaceKey(b.targetSurface.module, b.targetSurface.export)) || a.memberPath.localeCompare(b.memberPath));
  }

  const declarationPaths = new Map([...surfaces.keys()].map((key) => [key, []]));
  for (const [seedKey, classification] of directClassifications) {
    if (classification !== 'production-consumed' && classification !== 'test-only') continue;
    const seed = { ...splitSurfaceKey(seedKey), classification };
    const expanded = new Set([seedKey]);
    const visit = (currentKey, edges) => {
      for (const edge of outgoing.get(currentKey) ?? []) {
        const targetKey = surfaceKey(edge.targetSurface.module, edge.targetSurface.export);
        const pathRecord = { seed, edges: [...edges, edge] };
        declarationPaths.get(targetKey).push(pathRecord);
        if (expanded.has(targetKey)) continue;
        expanded.add(targetKey);
        visit(targetKey, pathRecord.edges);
      }
    };
    visit(seedKey, []);
  }
  for (const paths of declarationPaths.values()) {
    const unique = new Map(paths.map((item) => [JSON.stringify(item), item]));
    paths.splice(0, paths.length, ...[...unique.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  }
  return { declarationPaths, declarationUnitFiles: ordinaryCandidates, outgoing };
}

function discoverOwnership(trackedFiles) {
  const tracked = [...new Set(trackedFiles.map((file) => file.replaceAll('\\', '/')))];
  const typescriptCandidates = tracked.filter((file) =>
    TS_EXTENSIONS.test(file) &&
    !DECLARATION_SUFFIX.test(file) &&
    (file.startsWith('src/') || file.startsWith('web/src/')) &&
    !isTestModule(file));
  const sfcCandidates = tracked.filter((file) => file.startsWith('web/src/') && SFC_EXTENSION.test(file) && !isTestModule(file));
  if (typescriptCandidates.filter((file) => file.startsWith('src/')).length === 0) throw new Error('production root src must contain at least one tracked TypeScript-family module');
  if (typescriptCandidates.filter((file) => file.startsWith('web/src/')).length === 0 && sfcCandidates.length === 0) throw new Error('production root web/src must contain at least one tracked module');
  return {
    files: [...typescriptCandidates, ...sfcCandidates].sort(),
    sfcCandidates: sfcCandidates.sort(),
    typescriptCandidates: typescriptCandidates.sort(),
  };
}

export function checkExportConsumers({ root = process.cwd(), trackedFiles, allowlistPath = 'scripts/export-consumer-allowlist.json' } = {}) {
  const repositoryRoot = path.resolve(root);
  const tracked = new Set(trackedFiles ?? execFileSync('git', ['ls-files', '-z'], { cwd: repositoryRoot }).toString().split('\0').filter(Boolean));
  const discovery = discoverOwnership([...tracked]);
  const candidates = new Set(discovery.files);
  const surfaces = new Map();
  const local = new Map();
  const failures = [];
  const ownership = createPrograms(repositoryRoot, tracked, candidates, failures);
  const programs = ownership.contexts;
  for (const module of discovery.files) {
    const lookup = module.endsWith('.vue') ? `${module}${SFC_VIRTUAL_SUFFIX}` : module;
    const context = programs.find(({ program }) => program.getSourceFile(path.join(repositoryRoot, lookup)));
    if (!context) {
      if (module.endsWith('.vue') && failures.some((item) => item.module === module && item.category === 'unsupported')) continue;
      throw new Error(`governed module is absent from TypeScript programs: ${module}`);
    }
    const sourceFile = context.program.getSourceFile(path.join(repositoryRoot, lookup));
    const exported = getModuleExports(context.checker, sourceFile);
    let selected = exported;
    if (module.endsWith('.vue')) {
      const expected = new Set(['default', ...(ownership.virtualData.explicitExports.get(module) ?? [])]);
      selected = exported.filter((symbol) => expected.has(symbol.getName()));
      const actual = new Set(selected.map((symbol) => symbol.getName()));
      if (actual.size !== expected.size || [...expected].some((name) => !actual.has(name))) failures.push({ category: 'unsupported', module, export: '*', consumer: module, message: 'SFC effective export parity failed' });
    }
    for (const symbol of selected) {
      const key = surfaceKey(module, symbol.getName());
      surfaces.set(key, { module, export: symbol.getName() });
      const nodes = module.endsWith('.vue') && symbol.getName() === 'default' ? [] : localUse(context.checker, sourceFile, symbol);
      local.set(key, nodes.map((node) => location(repositoryRoot, sourceFile, node, context.virtualData)));
    }
  }
  for (const context of programs.filter((item) => item.kind !== 'javascript')) {
    for (const file of context.roots.filter((item) => TS_EXTENSIONS.test(item) && !item.endsWith(SFC_VIRTUAL_SUFFIX))) {
      const sourceFile = context.program.getSourceFile(path.join(repositoryRoot, file));
      if (!sourceFile) throw new Error(`tracked TypeScript-family root is absent from assigned host: ${file}`);
      if (sourceFile.isDeclarationFile !== DECLARATION_SUFFIX.test(file)) failures.push({ category: 'unsupported', module: file, export: '*', consumer: file, message: 'compiler declaration status disagrees with exact declaration suffix partition' });
    }
  }
  const governedKeys = new Set(surfaces.keys());
  const routes = new Map();
  for (const key of governedKeys) if (!routes.has(key)) routes.set(key, new Set());
  for (const context of programs) collectRouteDeclarations(repositoryRoot, tracked, candidates, context, routes, failures);
  const uses = new Map();
  const unsupported = [];
  for (const context of programs) collectImports(repositoryRoot, tracked, candidates, context, routes, governedKeys, uses, failures, unsupported);

  const directClassifications = new Map();
  for (const [key] of surfaces) {
    const use = uses.get(key) ?? { production: new Set(), test: new Set() };
    const localLocations = local.get(key) ?? [];
    const classification = use.production.size > 0 ? 'production-consumed' : use.test.size > 0 ? 'test-only' : localLocations.length > 0 ? 'local-only' : 'zero-use';
    directClassifications.set(key, classification);
  }
  const closure = createDeclarationClosure(repositoryRoot, tracked, candidates, ownership, surfaces, directClassifications, failures);
  const classifications = new Map();
  const records = [...surfaces.entries()].map(([key, surface]) => {
    const use = uses.get(key) ?? { production: new Set(), test: new Set() };
    const localLocations = local.get(key) ?? [];
    const declarationPaths = closure.declarationPaths.get(key) ?? [];
    const declarationProduction = declarationPaths.some((item) => item.seed.classification === 'production-consumed');
    const declarationTest = declarationPaths.some((item) => item.seed.classification === 'test-only');
    const directClassification = directClassifications.get(key);
    const classification = directClassification === 'production-consumed' || declarationProduction
      ? 'production-consumed'
      : directClassification === 'test-only' || declarationTest
        ? 'test-only'
        : directClassification;
    classifications.set(key, classification);
    return { ...surface, classification, directClassification, declarationPaths, localLocations: [...new Set(localLocations)].sort(), productionLocations: [...use.production].sort(), testLocations: [...use.test].sort() };
  }).sort((a, b) => a.module.localeCompare(b.module) || a.export.localeCompare(b.export));

  const allowlist = parseAllowlist(repositoryRoot, allowlistPath, tracked, candidates, governedKeys, classifications, unsupported);
  failures.push(...allowlist.failures);
  const excepted = new Set(allowlist.entries.map((entry) => surfaceKey(entry.module, entry.export)));
  for (const record of records) {
    if ((record.classification === 'local-only' || record.classification === 'zero-use') && !excepted.has(surfaceKey(record.module, record.export))) {
      failures.push({ category: record.classification, module: record.module, export: record.export, consumer: record.module, message: `export is ${record.classification}` });
    }
  }
  const activeFailures = failures.filter((failure) => {
    if (!['local-only', 'zero-use', 'unsupported'].includes(failure.category)) return true;
    return !allowlist.entries.some((entry) => entry.module === failure.module && entry.export === failure.export && (failure.category !== 'unsupported' || failure.consumer.startsWith(`${entry.consumer}:`)));
  });
  const uniqueFailures = [...new Map(activeFailures.map((failure) => [`${failure.module}\0${failure.export}\0${failure.category}\0${failure.consumer}\0${failure.message}`, failure])).values()];
  const sortedFailures = uniqueFailures.sort((a, b) => a.module.localeCompare(b.module) || a.export.localeCompare(b.export) || a.category.localeCompare(b.category) || a.consumer.localeCompare(b.consumer));
  const totals = Object.fromEntries(['production-consumed', 'test-only', 'local-only', 'zero-use'].map((name) => [name, records.filter((record) => record.classification === name).length]));
  return {
    ok: sortedFailures.length === 0,
    records,
    failures: sortedFailures,
    totals,
    staleImports: sortedFailures.filter((failure) => failure.category === 'stale-import').length,
    unsupported: sortedFailures.filter((failure) => failure.category === 'unsupported').length,
    allowlistEntries: allowlist.entries.length,
    ownership: {
      candidateFiles: discovery.files,
      declarationFiles: ownership.declarationFiles,
      jsConsumerFiles: ownership.jsFiles,
      sfcCandidateFiles: discovery.sfcCandidates,
      sfcConsumerFiles: ownership.sfcFiles,
      typescriptConsumerFiles: ownership.tsFiles,
      typescriptOrdinaryFiles: ownership.tsFiles.filter((file) => !DECLARATION_SUFFIX.test(file)),
      declarationUnitFiles: closure.declarationUnitFiles,
      hostAssignments: Object.fromEntries(programs.map((context) => [context.kind, context.roots])),
    },
  };
}

function parseArgs(argv) {
  let selfTest = false;
  let reportTestOnly = false;
  for (const argument of argv) {
    if (argument === '--self-test') selfTest = true;
    else if (argument === '--report-test-only') reportTestOnly = true;
    else if (argument === '--help' || argument === '-h') {
      console.log('Usage: node scripts/check-export-consumers.js [--self-test | --report-test-only]');
      console.log('Checks the fixed complete repository export boundary; no scope option is supported.');
      console.log('--report-test-only prints sorted direct and declaration-path evidence for test-only surfaces.');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (selfTest && reportTestOnly) throw new Error('--self-test and --report-test-only are mutually exclusive');
  return { reportTestOnly, selfTest };
}

function runSelfTest() {
  const discovery = discoverOwnership(['src/a.ts', 'src/a.test.ts', 'src/a.d.ts', 'web/src/b.ts', 'web/src/C.vue', 'web/src/C.test.vue']);
  if (discovery.files.join(',') !== 'src/a.ts,web/src/C.vue,web/src/b.ts') throw new Error('fixed complete candidate discovery failed');
  for (const argument of ['--scope=phase-one', '--phase-one', '--complete', '--root']) {
    try {
      parseArgs([argument]);
      throw new Error(`scope-changing argument was accepted: ${argument}`);
    } catch (error) {
      if (!error.message.includes('Unknown argument')) throw error;
    }
  }
  console.log('✓ complete repository export-consumer checker self-test passed');
}

function printResult(result, reportTestOnly) {
  console.log(`Export classifications: production-consumed=${result.totals['production-consumed']} test-only=${result.totals['test-only']} local-only=${result.totals['local-only']} zero-use=${result.totals['zero-use']}`);
  console.log(`Complete export boundary: candidates=${result.ownership.candidateFiles.length} TypeScript-family consumers=${result.ownership.typescriptConsumerFiles.length} SFC consumers=${result.ownership.sfcConsumerFiles.length} JavaScript-family consumers=${result.ownership.jsConsumerFiles.length}`);
  if (reportTestOnly) {
    for (const record of result.records.filter((item) => item.classification === 'test-only')) {
      console.log(`TEST-ONLY ${record.module} :: ${record.export}`);
      for (const consumer of record.testLocations) console.log(`  ${consumer}`);
      for (const declarationPath of record.declarationPaths.filter((item) => item.seed.classification === 'test-only')) {
        const edges = declarationPath.edges.map((edge) => `${edge.sourceSurface.module}::${edge.sourceSurface.export}.${edge.memberPath} -> ${edge.targetSurface.module}::${edge.targetSurface.export}`).join(' -> ');
        console.log(`  DECLARATION ${declarationPath.seed.module} :: ${declarationPath.seed.export} [test-only] ${edges}`);
      }
    }
  } else if (result.totals['test-only'] > 0) console.log('Run with --report-test-only for exact test-only consumers.');
  if (!result.ok) {
    console.error(`Export-consumer check failed with ${result.failures.length} finding(s):`);
    for (const failure of result.failures) console.error(`  ${failure.module} :: ${failure.export} [${failure.category}] ${failure.consumer} — ${failure.message}`);
  }
}

function main() {
  const { reportTestOnly, selfTest } = parseArgs(process.argv.slice(2));
  if (selfTest) return runSelfTest();
  const result = checkExportConsumers();
  printResult(result, reportTestOnly);
  if (!result.ok) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) main();
