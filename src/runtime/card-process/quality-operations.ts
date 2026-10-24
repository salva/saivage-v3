import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { publishFreshFile } from '../../persistence/index.js';
import {
  javascriptQualityConfigSchema,
  typescriptQualityConfigSchema,
  pythonQualityConfigSchema,
  sha256Hex,
} from '../../schemas/index.js';
import {
  qualityHelperRequestSchema,
  qualityHelperResultSchema,
  selectQualityScope,
  renderQualityReport,
} from '../../quality/index.js';
import type { OperationDefinition, OperationPlugin } from './operation-contract.js';

const schemas = {
  javascript: javascriptQualityConfigSchema,
  typescript: typescriptQualityConfigSchema,
  python: pythonQualityConfigSchema,
};
const artifactNames = [
  'request.json',
  'native.json',
  'findings.json',
  'metadata.json',
  'report.md',
] as const;
const helperFile = fileURLToPath(new URL('../../quality/helper.js', import.meta.url));
const rootFor = (invocation: string) => `.saivage/work/quality/${invocation}`;
const facts = {
  finding_count: { type: 'integer', min: 0, workflow: true },
  error_count: { type: 'integer', min: 0, workflow: true },
  warning_count: { type: 'integer', min: 0, workflow: true },
  analyzed_files: { type: 'integer', min: 0, workflow: true },
  coverage_complete: { type: 'boolean', workflow: true },
} as const;

function operation(language: keyof typeof schemas): OperationDefinition {
  const id = `code-quality.${language}.${language === 'python' ? 'ruff' : 'eslint'}`;
  return {
    id,
    provider: { kind: 'plugin', name: 'code-quality' },
    contractVersion: 1,
    bindings: ['node'],
    config: schemas[language],
    inputs: {},
    output: 'returned-text',
    outcomes: {
      clean: facts,
      findings: facts,
      analysis_failed: facts,
      timed_out: facts,
      signalled: facts,
    },
    retainFields: Object.keys(facts),
    artifacts: (_config, invocation) =>
      artifactNames.map((name) => `${rootFor(invocation)}/${name}`),
    async run(rawConfig, _input, capabilities, signal) {
      if (
        !capabilities.command ||
        !capabilities.projectRoot ||
        !capabilities.resolveReadablePath ||
        !capabilities.readCommandStdout
      )
        throw new Error(
          'Quality analysis requires host path admission and settled captured-command capabilities.',
        );
      const config = schemas[language].parse(rawConfig);
      const typedConfig =
        language === 'typescript' ? typescriptQualityConfigSchema.parse(rawConfig) : null;
      const root = capabilities.projectRoot;
      const scope = selectQualityScope({
        root,
        language,
        sourcePaths: config.source_paths,
        exclusions: config.exclusions,
        resolveReadablePath: capabilities.resolveReadablePath,
      });
      const nativeConfig = scope.admit(config.native_config);
      const cwd = scope.admit(config.cwd);
      if (!statSync(cwd).isDirectory() || !statSync(nativeConfig).isFile())
        throw new Error('Quality cwd/config must select a directory and a regular file.');
      const artifactRoot = rootFor(capabilities.invocationId);
      // Fresh owner-local work only. No collision retry or cleanup; never borrow a retained directory.
      mkdirSync(join(root, '.saivage/work/quality'), { recursive: true });
      mkdirSync(join(root, artifactRoot));
      const request = qualityHelperRequestSchema.parse({
        language,
        invocation: capabilities.invocationId,
        projectRoot: root,
        config,
        paths: {
          cwd,
          native_config: nativeConfig,
          files: scope.files,
          cache: join(root, artifactRoot, 'unused-eslint-cache'),
          eslint_module: 'eslint_module' in config ? scope.admit(config.eslint_module) : null,
          typescript_eslint_module: typedConfig
            ? scope.admit(typedConfig.typescript_eslint_module)
            : null,
          typescript_module: typedConfig ? scope.admit(typedConfig.typescript_module) : null,
          tsconfig: typedConfig ? scope.admit(typedConfig.tsconfig) : null,
        },
      });
      const publish = (name: (typeof artifactNames)[number], content: string) =>
        publishFreshFile(join(root, artifactRoot, name), Buffer.from(content));
      const input = JSON.stringify(request);
      if (Buffer.byteLength(input) > 1024 * 1024)
        throw new Error('Quality helper input exceeds1MiB.');
      publish('request.json', input);
      const started = new Date().toISOString();
      const native = await capabilities.command(
        {
          script: 'exec "$1" "$2" "$3"',
          args: [
            'node_binary' in config ? config.node_binary : process.execPath,
            helperFile,
            join(root, artifactRoot, 'request.json'),
          ],
          cwd: config.cwd,
          env: { NODE_DISABLE_COMPILE_CACHE: '1' },
          timeoutMs: config.timeout_ms,
          terminateGraceMs: config.terminate_grace_ms,
        },
        signal,
      );
      signal.throwIfAborted();
      const ended = new Date().toISOString();
      const bytes = capabilities.readCommandStdout();
      const captured = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      let result: z.infer<typeof qualityHelperResultSchema>;
      const interrupted = native.outcome === 'timed_out' || native.outcome === 'signalled';
      try {
        if (interrupted || native.outcome !== 'passed')
          throw new Error(`Helper ${native.outcome}; no complete analysis certified.`);
        result = qualityHelperResultSchema.parse(JSON.parse(captured));
        if (result.invocation !== capabilities.invocationId)
          throw new Error('Helper invocation identity mismatch.');
        if (
          result.coverage.length !== scope.files.length ||
          new Set(result.coverage.map((item) => item.file)).size !== scope.files.length ||
          result.coverage.some((item) => !scope.files.includes(item.file)) ||
          result.findings.some((item) => !scope.files.includes(item.file))
        )
          throw new Error('Helper result disagrees with exact admitted source files.');
      } catch (error) {
        result = {
          invocation: capabilities.invocationId,
          outcome: 'analysis_failed',
          native_exit: null,
          tool_versions: {},
          diagnostic: error instanceof Error ? error.message : String(error),
          native: null,
          findings: [],
          coverage: scope.files.map((file) => ({
            file,
            status: 'parse-or-execution-failed',
            detail: null,
          })),
          limitations: [
            'Helper failure/partial bytes do not establish native findings or complete coverage.',
          ],
          git: {
            head: null,
            status: null,
            applicability: 'unknown',
            diagnostic: 'No complete helper attribution.',
          },
        };
      }
      const complete =
        scope.files.length > 0 &&
        !scope.skipped.some((item) => item.reason !== 'excluded') &&
        result.coverage.every(
          (item) => item.status === (language === 'typescript' ? 'typed' : 'analyzed'),
        ) &&
        result.outcome !== 'analysis_failed';
      const outcome = interrupted
        ? native.outcome
        : !complete
          ? 'analysis_failed'
          : result.findings.length
            ? 'findings'
            : 'clean';
      const findings = [...result.findings].sort(
        (a, b) =>
          a.file.localeCompare(b.file) ||
          (a.start?.line ?? 0) - (b.start?.line ?? 0) ||
          (a.start?.column ?? 0) - (b.start?.column ?? 0) ||
          (a.rule ?? '').localeCompare(b.rule ?? ''),
      );
      const hashes: Array<{ path: string; sha256: string; size_bytes: number }> = [];
      for (const path of [
        config.native_config,
        ...(typedConfig ? [typedConfig.tsconfig] : []),
        'package-lock.json',
        'pnpm-lock.yaml',
        'yarn.lock',
        'uv.lock',
        'requirements.txt',
      ]) {
        let body: Buffer;
        try {
          body = readFileSync(scope.admit(path));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        hashes.push({ path, sha256: sha256Hex(body), size_bytes: body.byteLength });
      }
      const nativeArtifact = JSON.stringify({
        helper_disposition: native,
        complete_helper_result: result.native,
        captured_stdout: result.native === null ? captured : null,
      });
      const findingsArtifact = JSON.stringify(findings);
      const metadata = JSON.stringify({
        operation: id,
        contract_version: 1,
        invocation: capabilities.invocationId,
        started_at: started,
        ended_at: ended,
        outcome,
        coverage_complete: complete,
        source_paths: config.source_paths,
        exclusions: config.exclusions,
        files: scope.files.map(scope.display),
        skipped: scope.skipped,
        coverage: result.coverage,
        input_hashes: hashes,
        diagnostic: result.diagnostic,
        limitations: result.limitations,
        git: result.git,
        observed_tool_versions: result.tool_versions,
        expected_tool_pins:
          language === 'python'
            ? { ruff: '0.17.2' }
            : {
                eslint: '10.13.0',
                ...(language === 'typescript'
                  ? { typescript_eslint: '8.72.0', typescript: '5.9.3' }
                  : {}),
              },
        source_applicability:
          'Observed mutable files; no frozen snapshot or hermetic native-config dependency closure.',
        artifacts: [
          {
            path: `${artifactRoot}/native.json`,
            sha256: sha256Hex(nativeArtifact),
            size_bytes: Buffer.byteLength(nativeArtifact),
          },
          {
            path: `${artifactRoot}/findings.json`,
            sha256: sha256Hex(findingsArtifact),
            size_bytes: Buffer.byteLength(findingsArtifact),
          },
        ],
      });
      for (const text of [nativeArtifact, findingsArtifact, metadata])
        if (Buffer.byteLength(text) > 32 * 1024 * 1024)
          throw new Error('Complete quality artifact exceeds32MiB.');
      const report = renderQualityReport({
        operation: id,
        invocation: capabilities.invocationId,
        outcome,
        result: { ...result, findings },
        files: scope.files,
        skipped: scope.skipped,
        artifactRoot,
      });
      signal.throwIfAborted();
      publish('native.json', nativeArtifact);
      publish('findings.json', findingsArtifact);
      publish('metadata.json', metadata);
      publish('report.md', report);
      return {
        result: {
          outcome,
          summary: `Quality analysis ${outcome}; ${findings.length} findings. Not product acceptance.`,
          values: {
            finding_count: findings.length,
            error_count: findings.filter((item) => item.severity === 'error').length,
            warning_count: findings.filter((item) => item.severity === 'warning').length,
            analyzed_files: result.coverage.filter(
              (item) => item.status === 'typed' || item.status === 'analyzed',
            ).length,
            coverage_complete: complete,
          },
        },
        output: Buffer.from(report),
      };
    },
  };
}

export const qualityOperationPlugin: OperationPlugin = {
  namespace: 'code-quality',
  operations: {
    'javascript.eslint': operation('javascript'),
    'typescript.eslint': operation('typescript'),
    'python.ruff': operation('python'),
  },
};
