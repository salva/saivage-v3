#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const GOVERNED_ROOTS = Object.freeze(['src/contracts', 'src/schemas']);
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

function isGovernedModule(file) {
  return GOVERNED_ROOTS.some((root) => file.startsWith(`${root}/`)) && file.endsWith('.ts');
}

function isTestModule(file) {
  return file.startsWith('tests/') ||
    file.includes('/__tests__/') ||
    (/^web\/src\//.test(file) && /\.(?:test|spec)\.ts$/.test(file));
}

function location(root, sourceFile, node) {
  const point = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${canonical(root, sourceFile.fileName)}:${point.line + 1}:${point.character + 1}`;
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

function createPrograms(root) {
  return ['tsconfig.json', 'web/tsconfig.json'].map((config) => {
    const parsed = readConfig(root, config);
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
    return { checker: program.getTypeChecker(), options: parsed.options, program };
  });
}

function modulePath(root, checker, specifier) {
  const symbol = checker.getSymbolAtLocation(specifier);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  const sourceFile = declaration && (ts.isSourceFile(declaration) ? declaration : declaration.getSourceFile());
  return sourceFile ? canonical(root, sourceFile.fileName) : null;
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
    if (ts.isIdentifier(node) && node !== binding && checker.getSymbolAtLocation(node) === symbol) references.push(node);
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
  if (!target) return false;
  let used = false;
  const visit = (node) => {
    if (used) return;
    if (ts.isIdentifier(node) && !directExportDeclarationName(node)) {
      const symbol = ultimateSymbol(checker, checker.getSymbolAtLocation(node));
      if (symbol === target) used = true;
    }
    if (!used) ts.forEachChild(node, visit);
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

function collectRouteDeclarations(root, tracked, context, routes, failures) {
  const { checker, program } = context;
  for (const sourceFile of program.getSourceFiles()) {
    const fromModule = canonical(root, sourceFile.fileName);
    if (!tracked.has(fromModule)) continue;
    const localImports = new Map();
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
      const targetModule = modulePath(root, checker, statement.moduleSpecifier);
      if (!targetModule) continue;
      if (statement.importClause.name) localImports.set(statement.importClause.name.text, surfaceKey(targetModule, 'default'));
      const bindings = statement.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) localImports.set(element.name.text, surfaceKey(targetModule, importedName(element)));
    }
    for (const statement of sourceFile.statements) {
      if (!ts.isExportDeclaration(statement)) continue;
      if (statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        const targetModule = modulePath(root, checker, statement.moduleSpecifier);
        if (!targetModule) {
          if (isGovernedModule(fromModule)) failures.push({ category: 'unresolved-edge', module: fromModule, export: '*', consumer: location(root, sourceFile, statement.moduleSpecifier), message: `cannot resolve export edge ${statement.moduleSpecifier.text}` });
          continue;
        }
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) addRoute(routes, surfaceKey(fromModule, exportedName(element)), surfaceKey(targetModule, importedName(element)));
        } else if (!statement.exportClause) {
          const targetFile = program.getSourceFile(path.resolve(root, targetModule));
          if (targetFile) for (const name of exportedNames(checker, targetFile).filter((name) => name !== 'default')) addRoute(routes, surfaceKey(fromModule, name), surfaceKey(targetModule, name));
        } else {
          failures.push({ category: 'unsupported', module: fromModule, export: '*', consumer: location(root, sourceFile, statement), message: 'namespace re-export is unsupported' });
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

function collectImports(root, tracked, context, routes, governedKeys, uses, failures, unsupported) {
  const { checker, options, program } = context;
  for (const sourceFile of program.getSourceFiles()) {
    const consumer = canonical(root, sourceFile.fileName);
    if (!tracked.has(consumer)) continue;
    const kind = isTestModule(consumer) ? 'test' : 'production';
    const observe = (start, node) => {
      const pending = [start];
      const visited = new Set();
      while (pending.length > 0) {
        const key = pending.pop();
        if (visited.has(key)) continue;
        visited.add(key);
        if (governedKeys.has(key)) addUse(uses, key, kind, location(root, sourceFile, node));
        for (const target of routes.get(key) ?? []) pending.push(target);
      }
    };
    const unsupportedUse = (module, exportName, node, message) => {
      if (exportName === '*') {
        const routedNames = [...routes.keys()].filter((key) => splitSurfaceKey(key).module === module);
        if (!isGovernedModule(module) && !routedNames.some((key) => reachesGoverned(key, routes, governedKeys).size > 0)) return;
        const item = { category: 'unsupported', module, export: '*', consumer: location(root, sourceFile, node), message };
        failures.push(item);
        unsupported.push(item);
        return;
      }
      const startKeys = exportName === '*'
        ? [...governedKeys].filter((key) => splitSurfaceKey(key).module === module || reachesGoverned(surfaceKey(module, splitSurfaceKey(key).export), routes, governedKeys).has(key))
        : [surfaceKey(module, exportName)];
      const reached = new Set(startKeys.flatMap((key) => [...reachesGoverned(key, routes, governedKeys)]));
      for (const key of reached) {
        const item = { category: 'unsupported', ...splitSurfaceKey(key), consumer: location(root, sourceFile, node), message };
        failures.push(item);
        unsupported.push(item);
      }
    };

    const visit = (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const queried = resolveQueriedModule(root, sourceFile, node.moduleSpecifier, options);
        const resolvedModule = modulePath(root, checker, node.moduleSpecifier) ?? queried.module;
        if (queried.query) {
          if (resolvedModule && queried.query !== 'raw' && isGovernedModule(resolvedModule)) unsupportedUse(resolvedModule, '*', node.moduleSpecifier, `unsupported query transform ?${queried.query}`);
          return;
        }
        if (!resolvedModule || !node.importClause) return;
        const routedLocalNames = new Set();
        for (const statement of sourceFile.statements) {
          if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
          for (const element of statement.exportClause.elements) routedLocalNames.add((element.propertyName ?? element.name).text);
        }
        if (node.importClause.name) {
          const key = surfaceKey(resolvedModule, 'default');
          const governed = reachesGoverned(key, routes, governedKeys);
          const references = bindingReferences(checker, node.importClause.name);
          if (governed.size > 0 && references.length === 0 && !routedLocalNames.has(node.importClause.name.text)) failures.push({ category: 'stale-import', ...splitSurfaceKey(key), consumer: location(root, sourceFile, node.importClause.name), message: 'unused default import' });
          for (const reference of references) observe(key, reference);
        }
        const bindings = node.importClause.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const key = surfaceKey(resolvedModule, importedName(element));
            const governed = reachesGoverned(key, routes, governedKeys);
            if (isGovernedModule(resolvedModule) && !governedKeys.has(key) && governed.size === 0) failures.push({ category: 'unresolved-edge', module: resolvedModule, export: importedName(element), consumer: location(root, sourceFile, element), message: 'governed import names no export' });
            const references = bindingReferences(checker, element.name);
            if (governed.size > 0 && references.length === 0 && !routedLocalNames.has(element.name.text)) failures.push({ category: 'stale-import', ...splitSurfaceKey(key), consumer: location(root, sourceFile, element), message: 'import binding is never referenced' });
            for (const reference of references) observe(key, reference);
          }
        } else if (bindings && ts.isNamespaceImport(bindings)) {
          const names = new Set([...governedKeys].map((key) => splitSurfaceKey(key)).filter((part) => part.module === resolvedModule).map((part) => part.export));
          for (const reference of bindingReferences(checker, bindings.name)) {
            const parent = reference.parent;
            if (ts.isPropertyAccessExpression(parent) && parent.expression === reference) {
              observe(surfaceKey(resolvedModule, parent.name.text), parent.name);
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
              else if (allLiterals.length === 0 && !isStringOnlyNegativeAssertion(parent)) unsupportedUse(resolvedModule, '*', parent, 'whole-module namespace use is unsupported');
            }
          }
        }
        return;
      }

      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
        const targetModule = modulePath(root, checker, node.argument.literal) ?? resolveQueriedModule(root, sourceFile, node.argument.literal, options).module;
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
          const targetModule = modulePath(root, checker, specifier) ?? resolveQueriedModule(root, sourceFile, specifier, options).module;
          const name = ts.isPropertyAccessExpression(node) ? node.name.text : node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : null;
          if (targetModule && name) observe(surfaceKey(targetModule, name), node);
          else if (targetModule) unsupportedUse(targetModule, '*', node, 'computed dynamic-import member is unsupported');
          return;
        }
      }

      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
        let parent = node.parent;
        while (ts.isParenthesizedExpression(parent) || ts.isAwaitExpression(parent) || ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent)) parent = parent.parent;
        const targetModule = modulePath(root, checker, node.arguments[0]) ?? resolveQueriedModule(root, sourceFile, node.arguments[0], options).module;
        if (targetModule && ts.isVariableDeclaration(parent) && parent.initializer && parent.name && ts.isObjectBindingPattern(parent.name)) {
          for (const element of parent.name.elements) {
            const name = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : ts.isIdentifier(element.name) ? element.name.text : null;
            if (name) observe(surfaceKey(targetModule, name), element);
          }
        } else if (targetModule && ts.isVariableDeclaration(parent) && parent.initializer && parent.name && ts.isIdentifier(parent.name)) {
          const exported = new Set([...governedKeys].map(splitSurfaceKey).filter((part) => part.module === targetModule).map((part) => part.export));
          for (const reference of bindingReferences(checker, parent.name)) {
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
        } else if (targetModule && !ts.isPropertyAccessExpression(parent) && !ts.isElementAccessExpression(parent) && !isStringOnlyNegativeAssertion(parent)) {
          unsupportedUse(targetModule, '*', node, 'bare dynamic import is unsupported');
        }
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
}

function parseAllowlist(root, allowlistPath, tracked, surfaces, classifications, unsupported) {
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
    else if (!tracked.has(entry.consumer) || isGovernedModule(entry.consumer)) failures.push({ category: 'allowlist-stale', module: entry.module, export: entry.export, consumer: entry.consumer, message: 'consumer must be an exact tracked non-governed file' });
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

export function discoverGovernedFiles(trackedFiles) {
  const normalized = [...new Set(trackedFiles.map((file) => file.replaceAll('\\', '/')))];
  const byRoot = Object.fromEntries(GOVERNED_ROOTS.map((root) => [root, normalized.filter((file) => file.startsWith(`${root}/`) && file.endsWith('.ts')).sort()]));
  for (const root of GOVERNED_ROOTS) if (byRoot[root].length === 0) throw new Error(`governed root ${root} must contain at least one tracked .ts module`);
  return { byRoot, files: GOVERNED_ROOTS.flatMap((root) => byRoot[root]).sort() };
}

export function checkExportConsumers({ root = process.cwd(), trackedFiles, allowlistPath = 'scripts/export-consumer-allowlist.json' } = {}) {
  const repositoryRoot = path.resolve(root);
  const tracked = new Set(trackedFiles ?? execFileSync('git', ['ls-files', '-z'], { cwd: repositoryRoot }).toString().split('\0').filter(Boolean));
  const discovery = discoverGovernedFiles([...tracked]);
  const programs = createPrograms(repositoryRoot);
  const surfaces = new Map();
  const local = new Map();
  const failures = [];
  for (const module of discovery.files) {
    const context = programs.find(({ program }) => program.getSourceFile(path.join(repositoryRoot, module)));
    if (!context) throw new Error(`governed module is absent from TypeScript programs: ${module}`);
    const sourceFile = context.program.getSourceFile(path.join(repositoryRoot, module));
    for (const symbol of getModuleExports(context.checker, sourceFile)) {
      const key = surfaceKey(module, symbol.getName());
      surfaces.set(key, { module, export: symbol.getName() });
      local.set(key, localUse(context.checker, sourceFile, symbol));
    }
  }
  const governedKeys = new Set(surfaces.keys());
  const routes = new Map();
  for (const key of governedKeys) if (!routes.has(key)) routes.set(key, new Set());
  for (const context of programs) collectRouteDeclarations(repositoryRoot, tracked, context, routes, failures);
  const uses = new Map();
  const unsupported = [];
  for (const context of programs) collectImports(repositoryRoot, tracked, context, routes, governedKeys, uses, failures, unsupported);

  const classifications = new Map();
  const records = [...surfaces.entries()].map(([key, surface]) => {
    const use = uses.get(key) ?? { production: new Set(), test: new Set() };
    const classification = use.production.size > 0 ? 'production-consumed' : use.test.size > 0 ? 'test-only' : local.get(key) ? 'local-only' : 'zero-use';
    classifications.set(key, classification);
    return { ...surface, classification, productionLocations: [...use.production].sort(), testLocations: [...use.test].sort() };
  }).sort((a, b) => a.module.localeCompare(b.module) || a.export.localeCompare(b.export));

  const allowlist = parseAllowlist(repositoryRoot, allowlistPath, tracked, governedKeys, classifications, unsupported);
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
  return { ok: sortedFailures.length === 0, governedFiles: discovery.files, governedByRoot: discovery.byRoot, records, failures: sortedFailures, totals, staleImports: sortedFailures.filter((failure) => failure.category === 'stale-import').length, unsupported: sortedFailures.filter((failure) => failure.category === 'unsupported').length };
}

function parseArgs(argv) {
  let selfTest = false;
  let reportTestOnly = false;
  for (const argument of argv) {
    if (argument === '--self-test') selfTest = true;
    else if (argument === '--report-test-only') reportTestOnly = true;
    else if (argument === '--help' || argument === '-h') {
      console.log('Usage: node scripts/check-export-consumers.js [--self-test | --report-test-only]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (selfTest && reportTestOnly) throw new Error('--self-test and --report-test-only are mutually exclusive');
  return { reportTestOnly, selfTest };
}

function runSelfTest() {
  if (GOVERNED_ROOTS.length !== 2 || GOVERNED_ROOTS[0] !== 'src/contracts' || GOVERNED_ROOTS[1] !== 'src/schemas') throw new Error('fixed governed roots changed');
  const discovery = discoverGovernedFiles(['src/contracts/a.ts', 'src/schemas/b.ts', 'src/other/c.ts']);
  if (discovery.files.join(',') !== 'src/contracts/a.ts,src/schemas/b.ts') throw new Error('fixed-root discovery failed');
  try {
    parseArgs(['--root', 'elsewhere']);
    throw new Error('scope-changing argument was accepted');
  } catch (error) {
    if (!error.message.includes('Unknown argument')) throw error;
  }
  console.log('✓ export-consumer checker self-test passed');
}

function printResult(result, reportTestOnly) {
  console.log(`Export classifications: production-consumed=${result.totals['production-consumed']} test-only=${result.totals['test-only']} local-only=${result.totals['local-only']} zero-use=${result.totals['zero-use']}`);
  console.log(`Governed modules: src/contracts=${result.governedByRoot['src/contracts'].length} src/schemas=${result.governedByRoot['src/schemas'].length} total=${result.governedFiles.length}`);
  if (reportTestOnly) {
    for (const record of result.records.filter((item) => item.classification === 'test-only')) {
      console.log(`TEST-ONLY ${record.module} :: ${record.export}`);
      for (const consumer of record.testLocations) console.log(`  ${consumer}`);
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
