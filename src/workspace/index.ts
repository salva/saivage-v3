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
  resolveRecordWriteTarget,
  scopedPathResolvers,
  validRecordSegment,
  workUrlFromAbsolutePath,
  type ResolvedScopedPath,
  type ScopedPathMode,
  type ScopedPathScheme,
} from './scoped-path-schemes.js';
export {
  displayPathForResolved,
  globScopedPath,
  globSegmentToRegExp,
  globToRegExp,
  isHiddenPath,
  listScopedPath,
  listVisibleDirectoryEntries,
  resolveScopedPath,
  scopedReadFilterRel,
  walkFiles,
  workRootOf,
  type RecordSummary,
  type VfsContext,
  type VfsEntry,
  type VfsListing,
  type VfsMode,
  type VfsResolved,
} from './vfs.js';
