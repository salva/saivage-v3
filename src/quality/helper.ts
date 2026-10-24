import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { qualityHelperRequestSchema, qualityHelperResultSchema } from './helper-contract.js';
import { analyzeEslint } from './eslint-analysis.js';
import { analyzeRuff } from './ruff-analysis.js';

// Fixed packaged entrypoint. Native imports/config execute only in this child.
// It publishes no files: the runtime owner publishes complete artifacts after
// actual command settlement. Pipe/file publication uncertainty stays host-owned.
async function main() {
  if (process.argv.length !== 3) throw new Error('Expected one host-owned request file.');
  const request = qualityHelperRequestSchema.parse(
    JSON.parse(readFileSync(process.argv[2]!, 'utf8')),
  );
  const gitRead = (args: string[]) =>
    spawnSync('/usr/bin/git', ['--no-optional-locks', '-C', request.projectRoot, ...args], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
  const head = gitRead(['rev-parse', '--verify', 'HEAD']);
  const status =
    head.status === 0 ? gitRead(['status', '--porcelain=v1', '--untracked-files=normal']) : null;
  const git =
    head.status === 0 && status?.status === 0
      ? {
          head: head.stdout.trim(),
          status: status.stdout,
          applicability: 'observed',
          diagnostic: null,
        }
      : {
          head: null,
          status: null,
          applicability: 'unknown',
          diagnostic: 'Git attribution unavailable or not a Git project.',
        };
  let result;
  try {
    if (request.language === 'python') {
      const analysis = analyzeRuff({
        config: request.config,
        cwd: request.paths.cwd,
        nativeConfig: request.paths.native_config,
        files: request.paths.files,
      });
      result = {
        invocation: request.invocation,
        outcome: analysis.disposition,
        native_exit: analysis.observations.at(-1)?.exit_code ?? null,
        tool_versions: { ruff: '0.17.2', helper_node: process.version },
        diagnostic: analysis.diagnostic,
        native: analysis.observations,
        findings: analysis.findings.map((finding) => ({
          file: finding.filename,
          rule: finding.code,
          message: finding.message,
          severity: finding.severity,
          start: { line: finding.location.row, column: finding.location.column },
          end: { line: finding.end_location.row, column: finding.end_location.column },
        })),
        coverage: request.paths.files.map((file) => ({
          file,
          status: analysis.selectedFiles.includes(file)
            ? analysis.disposition === 'analysis_failed'
              ? 'parse-or-execution-failed'
              : 'analyzed'
            : 'ignored',
          detail: null,
        })),
        limitations: [
          'Ruff file selection and check are separate observations; sources may change between them.',
          'Native configured rule suppressions/exclusions remain policy, not exhaustive unsuppressed checking.',
        ],
      };
    } else {
      const analysis = await analyzeEslint({
        cwd: request.paths.cwd,
        nativeConfig: request.paths.native_config,
        eslintModule: request.paths.eslint_module!,
        files: request.paths.files,
        cacheLocation: request.paths.cache,
        typed:
          request.language === 'typescript'
            ? {
                module: request.paths.typescript_eslint_module!,
                typescriptModule: request.paths.typescript_module!,
                tsconfig: request.paths.tsconfig!,
              }
            : null,
      });
      result = {
        invocation: request.invocation,
        outcome: analysis.disposition,
        native_exit: analysis.nativeExit,
        tool_versions: {
          eslint: '10.13.0',
          helper_node: process.version,
          ...(request.language === 'typescript'
            ? { typescript_eslint: '8.72.0', parser: '8.72.0', typescript: '5.9.3' }
            : {}),
        },
        diagnostic:
          analysis.disposition === 'analysis_failed'
            ? 'Incomplete supported analysis/typed coverage.'
            : null,
        native: analysis.native,
        findings: analysis.native.flatMap((file) =>
          file.messages.map((message) => ({
            file: file.filePath,
            rule: message.ruleId,
            message: message.message,
            severity:
              message.severity === 2 ? 'error' : message.severity === 1 ? 'warning' : 'info',
            start:
              message.line === undefined
                ? null
                : { line: message.line, column: message.column ?? 0 },
            end:
              message.endLine === undefined
                ? null
                : { line: message.endLine, column: message.endColumn ?? 0 },
          })),
        ),
        coverage: analysis.coverage.map((file) => ({
          file: file.file,
          status: file.status,
          detail: file,
        })),
        limitations: analysis.limitations,
      };
    }
  } catch (error) {
    result = {
      invocation: request.invocation,
      outcome: 'analysis_failed',
      native_exit: null,
      tool_versions: {},
      diagnostic: error instanceof Error ? error.message : String(error),
      native: null,
      findings: [],
      coverage: request.paths.files.map((file) => ({
        file,
        status: 'parse-or-execution-failed',
        detail: null,
      })),
      limitations: ['No complete native result was obtained; diagnostic is not scan coverage.'],
    };
  }
  const text = JSON.stringify(qualityHelperResultSchema.parse({ ...result, git }));
  if (Buffer.byteLength(text) > 16 * 1024 * 1024)
    throw new Error('Complete analysis exceeds16MiB transport limit.');
  process.stdout.write(text);
}
await main();
