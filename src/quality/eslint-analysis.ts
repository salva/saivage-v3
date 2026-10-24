import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const fix = z
  .object({
    range: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
    text: z.string(),
  })
  .strict();
const messageFields = {
  ruleId: z.string().nullable(),
  severity: z.number().int().min(0).max(2),
  message: z.string(),
  line: z.number().int().nonnegative().optional(),
  column: z.number().int().nonnegative().optional(),
  endLine: z.number().int().nonnegative().optional(),
  endColumn: z.number().int().nonnegative().optional(),
  nodeType: z.string().nullable().optional(),
  messageId: z.string().optional(),
  fatal: z.boolean().optional(),
  fix: fix.optional(),
  suggestions: z
    .array(
      z
        .object({
          desc: z.string(),
          messageId: z.string().optional(),
          data: z.record(z.unknown()).optional(),
          fix,
        })
        .strict(),
    )
    .optional(),
};
const nativeResults = z.array(
  z
    .object({
      filePath: z.string(),
      messages: z.array(z.object(messageFields).strict()),
      suppressedMessages: z.array(
        z
          .object({
            ...messageFields,
            suppressions: z.array(
              z.object({ kind: z.string(), justification: z.string() }).strict(),
            ),
          })
          .strict(),
      ),
      errorCount: z.number().int().nonnegative(),
      warningCount: z.number().int().nonnegative(),
      fatalErrorCount: z.number().int().nonnegative(),
      fixableErrorCount: z.number().int().nonnegative(),
      fixableWarningCount: z.number().int().nonnegative(),
      source: z.string().optional(),
      output: z.string().optional(),
      // Full native rule metadata is preserved, not interpreted as finding/coverage authority.
      usedDeprecatedRules: z.array(z.unknown()),
    })
    .strict(),
);

interface Rule {
  meta?: { docs?: { requiresTypeChecking?: boolean } };
}
interface TypedModule {
  parser: { meta: { version: string } };
  plugin: { rules: Record<string, Rule> };
}
interface EffectiveConfig {
  languageOptions?: {
    parser?: unknown;
    parserOptions?: {
      project?: unknown;
      tsconfigRootDir?: unknown;
      projectService?: unknown;
      programs?: unknown;
    };
  };
  plugins?: Record<string, { rules?: Record<string, Rule> }>;
  rules?: Record<string, unknown>;
}
interface Program {
  getSourceFile(file: string): unknown;
  getTypeChecker(): unknown;
  getCompilerOptions(): { configFilePath?: unknown };
}
interface ObserverContext {
  filename: string;
  sourceCode: {
    parserServices: {
      program?: Program;
      esTreeNodeToTSNodeMap?: { get?: unknown };
      tsNodeToESTreeNodeMap?: { get?: unknown };
    };
  };
}
interface EslintInstance {
  lintFiles(files: readonly string[]): Promise<unknown>;
  calculateConfigForFile(file: string): Promise<EffectiveConfig | undefined>;
  isPathIgnored(file: string): Promise<boolean>;
}
interface EslintModule {
  ESLint: { new (options: Record<string, unknown>): EslintInstance; version: string };
}
interface TypedObservation {
  program: boolean;
  source: boolean;
  checker: boolean;
  maps: boolean;
  configFile: string | null;
}
interface FileCoverage {
  file: string;
  status:
    | 'analyzed'
    | 'typed'
    | 'untyped/config-mismatch'
    | 'parse-or-execution-failed'
    | 'ignored';
  parserIdentity: boolean;
  explicitProject: boolean;
  typedRules: Array<{ id: string; severity: number }>;
  observed: TypedObservation | null;
}

function packageMetadata(directory: string): unknown {
  return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
}
async function loadModule(directory: string, entry: string): Promise<unknown> {
  // Consume the qualified package's exact public entry, not Node's legacy
  // absolute-directory lookup (which does not interpret package exports).
  const root = realpathSync(directory);
  const file = realpathSync(resolve(root, entry));
  const within = relative(root, file);
  if (isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`))
    throw new Error('Native package entry escapes the selected package directory.');
  const module: { default?: unknown } = await import(pathToFileURL(file).href);
  return module.default ?? module;
}
function severity(value: unknown): number {
  const level: unknown = Array.isArray(value) ? value[0] : value;
  if (level === 'error' || level === 2) return 2;
  if (level === 'warn' || level === 1) return 1;
  if (level === 'off' || level === 0) return 0;
  throw new Error('Unexpected effective ESLint rule severity.');
}

/** Only called inside the isolated packaged helper, never in the Saivage server. */
export async function analyzeEslint(args: {
  cwd: string;
  nativeConfig: string;
  eslintModule: string;
  files: readonly string[];
  cacheLocation: string;
  typed: null | { module: string; typescriptModule: string; tsconfig: string };
}) {
  if (process.env.NODE_DISABLE_COMPILE_CACHE !== '1')
    throw new Error('Analysis helper must launch with Node compile cache disabled.');
  // These are exact pinned external API boundaries. API members are consumed directly,
  // not wrapped in alternate implementations or inferred from module display names.
  const eslintMetadata = z
    .object({
      name: z.literal('eslint'),
      version: z.literal('10.13.0'),
      exports: z
        .object({ '.': z.object({ default: z.literal('./lib/api.js') }).passthrough() })
        .passthrough(),
    })
    .passthrough()
    .parse(packageMetadata(args.eslintModule));
  const { ESLint } = (await loadModule(
    args.eslintModule,
    eslintMetadata.exports['.'].default,
  )) as EslintModule;
  if (ESLint.version !== '10.13.0') throw new Error('ESLint does not match qualified pin10.13.0.');
  let typed: TypedModule | null = null;
  if (args.typed) {
    const metadata = z
      .object({
        name: z.literal('typescript-eslint'),
        version: z.literal('8.72.0'),
        exports: z
          .object({ '.': z.object({ default: z.literal('./dist/index.js') }).passthrough() })
          .passthrough(),
      })
      .passthrough()
      .parse(packageMetadata(args.typed.module));
    typed = (await loadModule(args.typed.module, metadata.exports['.'].default)) as TypedModule;
    const tsMetadata = z
      .object({
        name: z.literal('typescript'),
        version: z.literal('5.9.3'),
        main: z.literal('./lib/typescript.js'),
      })
      .passthrough()
      .parse(packageMetadata(args.typed.typescriptModule));
    const typescript = (await loadModule(args.typed.typescriptModule, tsMetadata.main)) as {
      version: string;
    };
    if (typed.parser.meta.version !== metadata.version || typescript.version !== '5.9.3')
      throw new Error('TypeScript/parser modules do not match qualified pins.');
  }
  const observations = new Map<string, TypedObservation>();
  const observer = {
    meta: { schema: [] },
    create(context: ObserverContext) {
      return {
        Program() {
          const services = context.sourceCode.parserServices;
          const program = services.program;
          const configFile = program?.getCompilerOptions().configFilePath;
          observations.set(resolve(context.filename), {
            program: !!program,
            source: !!program?.getSourceFile(context.filename),
            checker: !!program?.getTypeChecker(),
            maps:
              typeof services.esTreeNodeToTSNodeMap?.get === 'function' &&
              typeof services.tsNodeToESTreeNodeMap?.get === 'function',
            configFile: typeof configFile === 'string' ? realpathSync(configFile) : null,
          });
        },
      };
    },
  };
  const eslint = new ESLint({
    cwd: args.cwd,
    overrideConfigFile: args.nativeConfig,
    fix: false,
    cache: false,
    cacheLocation: args.cacheLocation,
    ...(typed
      ? {
          overrideConfig: [
            {
              files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
              plugins: { __saivage_coverage: { rules: { observe: observer } } },
              rules: { '__saivage_coverage/observe': 'error' },
            },
          ],
        }
      : {}),
  });
  const configs = new Map<string, EffectiveConfig | undefined>();
  const ignored = new Set<string>();
  for (const file of args.files) {
    configs.set(file, await eslint.calculateConfigForFile(file));
    if (await eslint.isPathIgnored(file)) ignored.add(file);
  }
  // lintFiles([]) defaults to cwd in some native surfaces: never invoke it for empty scope.
  const native = args.files.length ? nativeResults.parse(await eslint.lintFiles(args.files)) : [];
  if (
    native.some((result) => !args.files.includes(result.filePath)) ||
    new Set(native.map((result) => result.filePath)).size !== native.length
  )
    throw new Error(
      'ESLint returned files outside the exact admitted selection or duplicate files.',
    );
  const expectedProject = args.typed ? realpathSync(args.typed.tsconfig) : null;
  const coverage: FileCoverage[] = args.files.map((file) => {
    const result = native.find((item) => item.filePath === file);
    const config = configs.get(file);
    const options = config?.languageOptions?.parserOptions;
    const projects = typeof options?.project === 'string' ? [options.project] : options?.project;
    const explicitProject =
      Array.isArray(projects) &&
      projects.length === 1 &&
      typeof projects[0] === 'string' &&
      typeof options?.tsconfigRootDir === 'string' &&
      !options.projectService &&
      !options.programs &&
      resolve(options.tsconfigRootDir, projects[0]) === expectedProject;
    const typedRules = Object.entries(config?.rules ?? {}).flatMap(([id, setting]) => {
      const slash = id.lastIndexOf('/');
      const level = severity(setting);
      if (!typed || slash < 0 || !level) return [];
      const name = id.slice(slash + 1);
      const rule = config?.plugins?.[id.slice(0, slash)]?.rules?.[name];
      return rule &&
        rule === typed.plugin.rules[name] &&
        rule.meta?.docs?.requiresTypeChecking === true
        ? [{ id, severity: level }]
        : [];
    });
    const observed = observations.get(file) ?? null;
    const parserIdentity = !!typed && config?.languageOptions?.parser === typed.parser;
    const typedCoverage =
      parserIdentity &&
      explicitProject &&
      typedRules.length > 0 &&
      observed?.program &&
      observed.source &&
      observed.checker &&
      observed.maps &&
      observed.configFile === expectedProject;
    const status =
      !config || ignored.has(file)
        ? 'ignored'
        : !result || result.fatalErrorCount || result.messages.some((item) => item.fatal)
          ? 'parse-or-execution-failed'
          : typed
            ? typedCoverage
              ? 'typed'
              : 'untyped/config-mismatch'
            : 'analyzed';
    return { file, status, parserIdentity, explicitProject, typedRules, observed };
  });
  const complete =
    coverage.length > 0 &&
    coverage.every((item) => item.status === 'analyzed' || item.status === 'typed');
  const count = native.reduce((sum, result) => sum + result.messages.length, 0);
  return {
    native,
    coverage,
    nativeExit: native.some((result) => result.errorCount > 0) ? 1 : 0,
    disposition: !complete
      ? ('analysis_failed' as const)
      : count
        ? ('findings' as const)
        : ('clean' as const),
    limitations: [
      'Native inline suppressions remain configured policy; full suppressedMessages are retained.',
      'Lint is not a TypeScript compiler-diagnostics or complete correctness guarantee.',
    ],
  };
}
