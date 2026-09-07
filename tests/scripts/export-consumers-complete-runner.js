#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RUNNER_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(RUNNER_PATH), '../..');
const ANALYZER_PATH = path.join(REPOSITORY_ROOT, 'scripts/check-export-consumers.js');
const PRIVATE_EXPORT = '__saivageCompleteExportConsumers';
const require = createRequire(import.meta.url);

async function importedModule(specifier, parentIdentifier, context, cache) {
  const key = specifier.startsWith('.') || specifier.startsWith('/')
    ? new URL(specifier, parentIdentifier).href
    : specifier;
  if (cache.has(key)) return cache.get(key);
  const loaded = require(key);
  const namespace = loaded && typeof loaded === 'object' ? { default: loaded.default ?? loaded, ...loaded } : { default: loaded };
  const names = Object.keys(namespace).sort();
  const module = new vm.SyntheticModule(names, function initialize() {
    for (const name of names) this.setExport(name, namespace[name]);
  }, { context, identifier: key });
  cache.set(key, module);
  await module.link(() => { throw new Error(`unexpected dependency import from synthetic module ${key}`); });
  await module.evaluate();
  return module;
}

async function loadCompleteAnalyzer() {
  const context = vm.createContext({ Buffer, URL, console, process, setTimeout, clearTimeout, TextDecoder, TextEncoder });
  const cache = new Map();
  const identifier = pathToFileURL(ANALYZER_PATH).href;
  const source = `${readFileSync(ANALYZER_PATH, 'utf8')}\nexport { analyzeCompleteExportConsumers as ${PRIVATE_EXPORT} };\n`;
  const module = new vm.SourceTextModule(source, {
    context,
    identifier,
    initializeImportMeta(meta) { meta.url = identifier; },
  });
  await module.link((specifier, referencingModule) => importedModule(specifier, referencingModule.identifier, context, cache));
  await module.evaluate();
  return module.namespace[PRIVATE_EXPORT];
}

export async function runCompleteExportConsumers({ root, trackedFiles, allowlistPath } = {}) {
  const analyze = await loadCompleteAnalyzer();
  return analyze({ root, trackedFiles, allowlistPath });
}

function directTotals(records) {
  return Object.fromEntries(['production-consumed', 'test-only', 'local-only', 'zero-use'].map((classification) => [
    classification,
    records.filter((record) => record.directClassification === classification).length,
  ]));
}

function printJsonl(result) {
  const ownership = result.ownership;
  console.log(JSON.stringify({
    type: 'summary',
    candidateFiles: ownership.candidateFiles.length,
    typescriptConsumerFiles: ownership.typescriptConsumerFiles.length,
    sfcConsumerFiles: ownership.sfcConsumerFiles.length,
    jsConsumerFiles: ownership.jsConsumerFiles.length,
    declarationUnitFiles: ownership.declarationUnitFiles.length,
    surfaces: result.records.length,
    directTotals: directTotals(result.records),
    totals: result.totals,
    staleImports: result.staleImports,
    unsupported: result.unsupported,
    allowlistEntries: result.allowlistEntries,
  }));
  for (const record of result.records) {
    console.log(JSON.stringify({
      type: 'surface',
      module: record.module,
      export: record.export,
      directClassification: record.directClassification,
      classification: record.classification,
      productionLocations: record.productionLocations,
      testLocations: record.testLocations,
      localLocations: record.localLocations,
      declarationPaths: record.declarationPaths.map((item) => ({
        seed: { module: item.seed.module, export: item.seed.export, classification: item.seed.classification },
        edges: item.edges.map((edge) => ({
          source: { module: edge.sourceSurface.module, export: edge.sourceSurface.export },
          memberPath: edge.memberPath,
          target: { module: edge.targetSurface.module, export: edge.targetSurface.export },
        })),
      })),
    }));
  }
  for (const failure of result.failures) console.log(JSON.stringify({
    type: 'failure',
    module: failure.module,
    export: failure.export,
    category: failure.category,
    consumer: failure.consumer,
    message: failure.message,
  }));
}

async function main() {
  if (process.argv.length !== 2) throw new Error('export-consumers-complete-runner accepts no arguments');
  const trackedFiles = execFileSync('git', ['ls-files', '-z'], { cwd: REPOSITORY_ROOT }).toString().split('\0').filter(Boolean);
  const result = await runCompleteExportConsumers({ root: REPOSITORY_ROOT, trackedFiles });
  printJsonl(result);
}

if (process.argv[1] && path.resolve(process.argv[1]) === RUNNER_PATH) await main();
