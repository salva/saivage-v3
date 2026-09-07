export {
  looksLikeSecretPath,
} from './secret-paths.js';
export {
  hasParentPathSegment,
  isReadBlocked,
  isRedacted,
  isWriteBlocked,
  redactCommandForOperator,
  redactOperatorErrorMessage,
  resolveContainedProjectPath,
  toContainedRelativePath,
} from './file-access-security.js';
export {
  assertRecordWrite,
  parseScopedPathScheme,
  resolveRecordWriteTarget,
  workUrlFromAbsolutePath,
} from './scoped-path-schemes.js';
export {
  displayPathForResolved,
  globScopedPath,
  globToRegExp,
  isHiddenPath,
  listScopedPath,
  listVisibleDirectoryEntries,
  resolveScopedPath,
  scopedReadFilterRel,
  walkFiles,
  visitFiles,
  visitScopedFiles,
  type VfsResolved,
} from './vfs.js';
