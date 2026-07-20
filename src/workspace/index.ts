export {
  SecretPathError,
  assertNotSecretPath,
  assertSafeShellCwd,
  directoryDirectlyExposesSecretChildren,
  looksLikeSecretPath,
} from './secret-paths.js';
export {
  isReadBlocked,
  isRedacted,
  isWriteBlocked,
  redactCommandForOperator,
  redactOperatorErrorMessage,
  resolveContainedProjectPath,
  toContainedRelativePath,
  assertAnalystInspectionTarget,
  isAnalystSecretPath,
  isSecretLikeKey,
  redactAnalystSecretValue,
  type SafeProjectPathResult,
} from './file-access-security.js';
export {
  classifyShellCommand,
  type ShellSafetyClass,
} from './shell-classifier.js';
export {
  listRecentReviews,
} from './quarantine.js';
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
  visitFiles,
  visitScopedFiles,
  workRootOf,
  type RecordSummary,
  type ScopedFileEntry,
  type VfsContext,
  type VfsEntry,
  type VfsListing,
  type VfsMode,
  type VfsResolved,
} from './vfs.js';
