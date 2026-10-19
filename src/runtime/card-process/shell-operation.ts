import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { isSecretKey, redactTextForOutbound } from '../../redaction/index.js';
import type { OperationDefinition } from './operation-contract.js';

const safeLiteral = z
  .string()
  .refine((value) => Buffer.byteLength(value) <= 4096, 'Shell literal exceeds 4096 bytes.')
  .refine(
    (value) => redactTextForOutbound(value) === value,
    'Shell configuration is not a secret delivery channel.',
  );
const relativePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !isAbsolute(value) &&
      !value.split('/').some((part) => part === '..' || part === '' || part === '.'),
    'Expected an exact project-relative path.',
  );
export const shellOperationConfigSchema = z
  .object({
    script: safeLiteral.refine(
      (value) => value.trim().length > 0,
      'Shell script must not be empty.',
    ),
    cwd: z.union([z.literal('.'), relativePath]).default('.'),
    env: z
      .record(
        z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
          .refine(
            (name) => !isSecretKey(name) && name !== 'PROJECT_ROOT' && name !== 'SAIVAGE_ROOT',
            'Shell env cannot carry secrets or override root variables.',
          ),
        safeLiteral,
      )
      .default({}),
    timeout_ms: z.number().int().min(1).max(600000).default(120000),
    terminate_grace_ms: z.number().int().min(0).max(10000).default(2000),
    artifacts: z
      .array(
        relativePath.refine(
          (value) => !/[?*[\]{}]/u.test(value),
          'Artifacts are exact paths, not globs.',
        ),
      )
      .max(16)
      .refine((paths) => new Set(paths).size === paths.length, 'Duplicate artifact path.')
      .default([]),
  })
  .strict();
type ShellOperationConfig = z.infer<typeof shellOperationConfigSchema>;

export const shellRunOperation: OperationDefinition<ShellOperationConfig> = {
  id: 'shell.run',
  provider: { kind: 'builtin', name: 'shell' },
  contractVersion: 1,
  bindings: ['node', 'after_activation_commit'],
  config: shellOperationConfigSchema,
  inputs: { args: { type: 'strings', workflow: true } },
  outcomes: {
    passed: { exit_code: { type: 'integer', min: 0, max: 0, workflow: true } },
    failed: { exit_code: { type: 'integer', min: 1, workflow: true } },
    signalled: { signal: { type: 'string', workflow: true } },
    timed_out: { reason: { type: 'string', workflow: true } },
  },
  retainFields: ['exit_code', 'signal', 'reason'],
  async run(config, input, capabilities, signal) {
    if (!capabilities.command)
      throw new Error('shell.run requires the managed captured-command capability.');
    // The host constructs this capability with a fresh direct scope. Values never enter syntax.
    return capabilities.command(
      {
        script: config.script,
        args: input.args as readonly string[],
        cwd: config.cwd,
        env: config.env,
        timeoutMs: config.timeout_ms,
        terminateGraceMs: config.terminate_grace_ms,
      },
      signal,
    );
  },
};
