import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { pythonQualityConfigSchema } from '../schemas/index.js';

const position = z
  .object({ row: z.number().int().positive(), column: z.number().int().positive() })
  .strict();
const edit = z.object({ content: z.string(), location: position, end_location: position }).strict();
// Exact pinned0.17.2 JSON, including fix suggestions as evidence only; never apply them.
const diagnostic = z
  .object({
    cell: z.number().int().nonnegative().nullable(),
    code: z.string().min(1),
    end_location: position,
    filename: z.string().min(1),
    fix: z
      .object({
        applicability: z.enum(['safe', 'unsafe', 'display-only']),
        edits: z.array(edit),
        message: z.string(),
      })
      .strict()
      .nullable(),
    location: position,
    message: z.string(),
    name: z.string(),
    noqa_row: z.number().int().positive().nullable(),
    severity: z.enum(['error', 'warning']),
    url: z.string().nullable(),
  })
  .strict();
const diagnostics = z.array(diagnostic);
type RuffConfig = z.infer<typeof pythonQualityConfigSchema>;
interface NativeObservation {
  args: readonly string[];
  exit_code: number;
  stdout: string;
  stderr: string;
}

/** Native children run inside the single managed helper's process group, never detached. */
export function analyzeRuff(args: {
  config: RuffConfig;
  cwd: string;
  nativeConfig: string;
  // Already enumerated/admitted exact source files, excluding configured exclusions.
  files: readonly string[];
}): {
  observations: NativeObservation[];
  selectedFiles: string[];
  findings: z.infer<typeof diagnostics>;
  disposition: 'clean' | 'findings' | 'analysis_failed';
  diagnostic: string | null;
} {
  const config = pythonQualityConfigSchema.parse(args.config);
  const observations: NativeObservation[] = [];
  const run = (argv: string[]): NativeObservation => {
    const env = { ...process.env };
    delete env.RUFF_OUTPUT_FILE;
    delete env.RUFF_OUTPUT_FORMAT;
    const child = spawnSync(config.ruff_binary, argv, {
      cwd: args.cwd,
      env,
      encoding: 'buffer',
      maxBuffer: 16 * 1024 * 1024,
      // The outer managed helper owns the invocation deadline and group cleanup.
      timeout: config.timeout_ms,
    });
    if (child.error) throw child.error;
    if (child.signal || child.status === null)
      throw new Error(`Ruff child did not exit normally (${child.signal ?? 'no status'}).`);
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const value = {
      args: argv,
      exit_code: child.status,
      stdout: decoder.decode(child.stdout),
      stderr: decoder.decode(child.stderr),
    };
    observations.push(value);
    return value;
  };
  const version = run(['--version']);
  if (version.exit_code !== 0 || version.stdout.trim() !== 'ruff 0.17.2')
    throw new Error('Configured Ruff executable does not match qualified pin0.17.2.');
  if (args.files.length === 0)
    return {
      observations,
      selectedFiles: [],
      findings: [],
      disposition: 'analysis_failed',
      diagnostic: 'No supported source files selected.',
    };
  const base = [
    'check',
    '--config',
    args.nativeConfig,
    '--no-fix',
    '--no-fix-only',
    '--no-cache',
    '--force-exclude',
  ];
  const selection = run([...base, '--show-files', '--', ...args.files]);
  if (selection.exit_code !== 0)
    return {
      observations,
      selectedFiles: [],
      findings: [],
      disposition: 'analysis_failed',
      diagnostic: 'Native file selection failed; no scan coverage established.',
    };
  const selectedFiles = selection.stdout.split(/\r?\n/u).filter((line) => line.length > 0);
  if (
    new Set(selectedFiles).size !== selectedFiles.length ||
    selectedFiles.some((file) => !args.files.includes(file))
  )
    throw new Error('Native Ruff selection disagrees with admitted exact files.');
  const result = run([...base, '--output-format', 'json', '--', ...args.files]);
  try {
    const interpreted = interpretRuffResult(
      result.exit_code,
      result.stdout,
      selectedFiles,
      args.files,
    );
    return { observations, selectedFiles, ...interpreted };
  } catch (error) {
    return {
      observations,
      selectedFiles,
      findings: [],
      disposition: 'analysis_failed',
      diagnostic: `Native Ruff result could not be validated: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function interpretRuffResult(
  exitCode: number,
  stdout: string,
  selected: readonly string[],
  intended: readonly string[],
) {
  if (exitCode !== 0 && exitCode !== 1)
    return {
      findings: [],
      disposition: 'analysis_failed' as const,
      diagnostic: `Native Ruff execution/configuration failed (exit${exitCode}).`,
    };
  const findings = diagnostics.parse(JSON.parse(stdout));
  if (findings.some((finding) => !selected.includes(finding.filename)))
    throw new Error('Ruff diagnostic names a file outside its native selection.');
  if (exitCode === 0 && findings.some((finding) => finding.severity === 'error'))
    throw new Error('Ruff success exit contradicts error diagnostics.');
  const complete =
    selected.length > 0 &&
    intended.length === selected.length &&
    new Set(selected).size === selected.length &&
    intended.every((file) => selected.includes(file));
  const failed =
    !complete ||
    findings.some((finding) => finding.code === 'invalid-syntax') ||
    (exitCode === 1 && findings.length === 0);
  return {
    findings,
    disposition: failed
      ? ('analysis_failed' as const)
      : findings.length
        ? ('findings' as const)
        : ('clean' as const),
    diagnostic: failed
      ? 'Incomplete, ignored/empty scope, syntax failure or contradictory native result; not clean coverage.'
      : null,
  };
}
