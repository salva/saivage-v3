export {
  SecretPathError,
  assertNotSecretPath,
  assertSafeShellCwd,
  directoryDirectlyExposesSecretChildren,
  looksLikeSecretPath,
} from './secret-paths.js';
export {
  getSafeFileForAgent,
  isReadBlocked,
  isWriteBlocked,
  redactCommandForOperator,
  redactOperatorErrorMessage,
  resolveContainedProjectPath,
  toContainedRelativePath,
  assertAnalystInspectionTarget,
  isAnalystSecretPath,
  isSecretLikeKey,
  redactAnalystSecretValue,
  type SafeFileResult,
  type SafeProjectPathResult,
} from './file-access-security.js';
export {
  classifyShellCommand,
  type ShellSafetyClass,
} from './shell-classifier.js';
export {
  listQuarantineIndex,
  listRecentReviews,
} from './quarantine.js';
export {
  buildScopedPathUrl,
  parseScopedPathUrl,
  type ParsedScopedPathUrl,
} from './scoped-path-url.js';
export {
  assertRecordWrite,
  parseScopedPathScheme,
  resolveRecordSearchTarget,
  resolveRecordWriteTarget,
  scopedPathResolvers,
  validRecordSegment,
  type ResolvedScopedPath,
  type ScopedPathMode,
  type ScopedPathScheme,
} from './scoped-path-schemes.js';
