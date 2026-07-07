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

export interface DocSourceContractsResult {
  ok: boolean;
  failures: VerificationFailure[];
  routeResult: RouteVerificationResult;
  toolResult: GenericVerificationResult;
  configResult: ConfigVerificationResult;
}

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
