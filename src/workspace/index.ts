export { looksLikeSecretPath } from './secret-paths.js';
export { inspectAgentReadPath } from './agent-read-path.js';
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
  globToRegExp,
  isHiddenPath,
  listScopedPath,
  listVisibleDirectoryEntries,
  resolveScopedPath,
  resolveAgentReadPath,
  visitScopedFiles,
  type VfsResolved,
} from './vfs.js';
