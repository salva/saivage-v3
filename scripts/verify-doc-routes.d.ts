export interface RouteMention {
  key: string;
  method: string;
  path: string;
  file: string;
  line: number;
}

export interface VerificationFailure {
  type: string;
  route?: string;
  role?: string;
  section?: string;
  claim?: string;
  block?: string;
  file?: string;
  line?: number;
  message: string;
}

export interface RouteInventoryRow {
  key: string;
  anchor: string;
  method?: string;
  path?: string;
  purpose?: string;
  file?: string;
  line?: number;
}

export interface ToolDocRow {
  tools: string[];
  anchor: string;
}

export interface ConfigDocRow {
  fields: string[];
  anchor: string;
}

export interface RouteVerificationResult {
  ok: boolean;
  failures: VerificationFailure[];
  documentedRoutes: RouteMention[];
  implementedRoutes: Set<string>;
  checkedDocs: string[];
  routeInventoryRows: RouteInventoryRow[];
  internalDebugRows: RouteInventoryRow[];
}

export interface VerifyDocRoutesOptions {
  projectRoot?: string;
  docPaths?: string[];
  implementedRoutes?: Set<string>;
  removedRoutes?: Set<string>;
  routeInventoryRows?: RouteInventoryRow[];
  internalDebugRows?: RouteInventoryRow[];
}

export interface AgentToolVerificationOptions {
  projectRoot?: string;
  expectedTools?: Map<string, string[]>;
  documentedTools?: Map<string, ToolDocRow>;
}

export interface ConfigVerificationOptions {
  projectRoot?: string;
  expectedConfig?: Map<string, string[]>;
  documentedConfig?: Map<string, ConfigDocRow>;
}

export interface GenericVerificationResult {
  ok: boolean;
  failures: VerificationFailure[];
  expected?: Map<string, unknown>;
  documented?: Map<string, unknown>;
}

export interface ConfigVerificationResult {
  ok: boolean;
  failures: VerificationFailure[];
  expected?: Map<string, string[]>;
  documented?: Map<string, Map<string, ConfigDocRow>>;
  checkedDocs: string[];
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface StrictErrorLiteralField {
  kind: 'literal';
  value: JsonValue;
}

export interface StrictErrorSchemaField {
  kind: 'schema';
  name: string;
}

export interface StrictErrorTypeField {
  kind: 'type';
  name: 'string' | 'number' | 'boolean';
}

export interface StrictErrorVariant {
  strict: true;
  fields: Record<string, StrictErrorLiteralField | StrictErrorSchemaField | StrictErrorTypeField>;
}

export interface StrictErrorClaimValue {
  strict: true;
  variants: StrictErrorVariant[];
}

export interface VocabularyClaimValue {
  members: string[];
}

export type ValueContractUnit = 'bytes' | 'characters' | 'logical invocations' | 'milliseconds' | 'segments' | 'tokens';

export interface SourceConstantClaimValue {
  unit: ValueContractUnit;
  value: number;
}

export interface ShippedRoleInventoriesClaimValue {
  templates: string[];
  agents: Array<{ name: string; tools: string[] }>;
}

export interface ProjectorPresenterEqualityClaimValue {
  names: string[];
  sources: string[];
  gates: string[];
}

export interface ExclusiveToolIdentitiesClaimValue {
  analystPresenterOnly: string[];
  plannerOnly: string[];
}

export interface RegexIdentityValue {
  source: string;
  flags: string;
  anchored: boolean;
}

export interface CardIdentityClaimValue {
  alternatives: Array<{ kind: 'literal'; value: string } | { kind: 'pattern'; source: string }>;
  pattern: RegexIdentityValue;
  segment: RegexIdentityValue;
  stem: string;
  separator: string;
  minimumSegments: number;
  maximumSegments: number;
}

export interface ConversationSessionIdentityClaimValue {
  inputGuard: 'string';
  pattern: RegexIdentityValue;
  captures: Array<{ index: number; meaning: string }>;
  nullTest: string;
  agentParser: string;
  scopeAlternatives: string[];
  constructors: Array<{ name: string; template: string }>;
  identityParser: string;
  operators: string[];
  grouping: string;
}

export interface CanonicalNumericPivotVariant {
  kind: 'canonical-positive-safe-integer';
}

export interface LiteralPivotVariant {
  kind: 'literal';
  value: 'current';
}

export interface BackendDiffFromPivotClaimValue {
  field: 'from';
  presence: 'required';
  variants: CanonicalNumericPivotVariant[];
  mapping: 'fromVersion';
  regex: string;
  refinement: string;
  transform: 'Number';
}

export interface BackendDiffToPivotClaimValue {
  field: 'to';
  presence: 'optional';
  variants: Array<LiteralPivotVariant | CanonicalNumericPivotVariant>;
  mapping: 'toVersion';
  regex: string;
  refinement: string;
  transform: 'Number';
  meanings: {
    numeric: 'historical-version';
    omitted: 'current-artifact';
    current: 'current-artifact';
  };
}

export interface DisplayedCurrentDiffPivotClaimValue {
  key: Array<{ name: string; type: string }>;
  selection: {
    construction: { cardId: string; fromSeq: string; to: 'current' };
    frozen: true;
    startArgument: string;
  };
  request: {
    operation: 'cards.diff';
    params: { id: string };
    query: { from: string; to: string };
    signal: 'forwarded';
  };
  currentness: {
    abortPreviousOwner: true;
    freshOwner: string[];
    fences: string[];
    selectionGuards: string[];
    acceptedSideCondition: string[];
    retainedKey: string;
  };
  reuse: {
    refresh: string;
    retry: string;
    invalidationGates: string[];
    reconnectGates: string[];
  };
}

export interface ValueContractClaimValueByKey {
  'constant.analyst-orientation-max-bytes': SourceConstantClaimValue;
  'constant.analyst-title-preview-max-bytes': SourceConstantClaimValue;
  'constant.app-cleanup-leaf-timeout-ms': SourceConstantClaimValue;
  'constant.compaction-refine-max-invocations': SourceConstantClaimValue;
  'constant.emit-result-summary-max-chars': SourceConstantClaimValue;
  'constant.managed-process-post-kill-verification-ms': SourceConstantClaimValue;
  'constant.managed-process-term-grace-ms': SourceConstantClaimValue;
  'constant.maximum-card-depth-segments': SourceConstantClaimValue;
  'constant.summarizer-completion-tokens': SourceConstantClaimValue;
  'constant.summarizer-output-max-bytes': SourceConstantClaimValue;
  'constant.sync-hub-debounce-ms': SourceConstantClaimValue;
  'constant.tool-result-envelope-max-bytes': SourceConstantClaimValue;
  'error.analyst-turn-busy': StrictErrorClaimValue;
  'error.cards-diff-404': StrictErrorClaimValue;
  'error.cards-history-404': StrictErrorClaimValue;
  'error.unauthorized': StrictErrorClaimValue;
  'error.unexpected-internal': StrictErrorClaimValue;
  'identity.card': CardIdentityClaimValue;
  'identity.conversation-session': ConversationSessionIdentityClaimValue;
  'pivot.cards-diff-from': BackendDiffFromPivotClaimValue;
  'pivot.cards-diff-to': BackendDiffToPivotClaimValue;
  'pivot.ui-cards-diff-current-request': DisplayedCurrentDiffPivotClaimValue;
  'tools.exclusive-identities': ExclusiveToolIdentitiesClaimValue;
  'tools.projector-presenter-equality': ProjectorPresenterEqualityClaimValue;
  'tools.shipped-role-inventories': ShippedRoleInventoriesClaimValue;
  'vocabulary.app-log-type': VocabularyClaimValue;
  'vocabulary.availability-component-source': VocabularyClaimValue;
  'vocabulary.availability-state': VocabularyClaimValue;
  'vocabulary.card-version-change-kind': VocabularyClaimValue;
  'vocabulary.lifecycle-status': VocabularyClaimValue;
  'vocabulary.logged-event-kind': VocabularyClaimValue;
}

export type ValueContractClaimKey = keyof ValueContractClaimValueByKey;
export type ValueContractFamily = 'errors' | 'vocabularies' | 'constants' | 'tools' | 'identities' | 'pivots';

export interface ValueContractManifestEntry {
  key: string;
  family: readonly ValueContractFamily[];
  file: string;
  heading: string;
  claims: readonly ValueContractClaimKey[];
}

export interface ValueContractFamilyResult {
  ok: boolean;
  failures: VerificationFailure[];
  checkedClaimKeys: ValueContractClaimKey[];
  checkedBlockKeys: string[];
  selectedSourcePaths: string[];
}

export interface ValueContractVerificationOptions {
  projectRoot?: string;
}

export interface DocSourceContractsResult {
  ok: boolean;
  failures: VerificationFailure[];
  routeResult: RouteVerificationResult;
  toolResult: GenericVerificationResult;
  configResult: ConfigVerificationResult;
  errorShapeResult: ValueContractFamilyResult;
  closedVocabularyResult: ValueContractFamilyResult;
  sourceConstantResult: ValueContractFamilyResult;
  toolContractResult: ValueContractFamilyResult;
  identityGrammarResult: ValueContractFamilyResult;
  cardDiffPivotResult: ValueContractFamilyResult;
}

export const VALUE_CONTRACT_MANIFEST: readonly ValueContractManifestEntry[];
export function serializeValueContractClaim<K extends ValueContractClaimKey>(key: K, value: ValueContractClaimValueByKey[K]): string;
export function verifyErrorShapeDocs(options?: ValueContractVerificationOptions): ValueContractFamilyResult;
export function verifyClosedVocabularyDocs(options?: ValueContractVerificationOptions): ValueContractFamilyResult;
export function verifySourceConstantDocs(options?: ValueContractVerificationOptions): ValueContractFamilyResult;
export function verifyToolContractDocs(options?: ValueContractVerificationOptions): ValueContractFamilyResult;
export function verifyIdentityGrammarDocs(options?: ValueContractVerificationOptions): ValueContractFamilyResult;
export function verifyCardDiffPivotDocs(options?: ValueContractVerificationOptions): ValueContractFamilyResult;

export function normalizeRoutePath(routePath: string): string;
export function routeKey(method: string, routePath: string): string;
export function discoverOperatorContractSourceFiles(projectRoot?: string): string[];
export function discoverOperatorContractRouteSources(projectRoot?: string): string[];
export function extractImplementedRoutes(projectRoot?: string): Set<string>;
export function activeOperatorDocPaths(projectRoot?: string): string[];
export function extractDocumentedRoutes(projectRoot?: string, docPaths?: string[]): RouteMention[];
export function verifyDocRoutes(options?: VerifyDocRoutesOptions): RouteVerificationResult;
export function verifyAgentToolDocs(options?: AgentToolVerificationOptions): GenericVerificationResult;
export function verifyConfigDocs(options?: ConfigVerificationOptions): ConfigVerificationResult;
export function verifyDocSourceContracts(options?: VerifyDocRoutesOptions): DocSourceContractsResult;
export function formatVerificationResult(result: DocSourceContractsResult, projectRoot?: string): string;
