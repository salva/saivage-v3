export interface RouteMention {
  key: string;
  method: string;
  path: string;
  file: string;
  line: number;
}

export interface RouteVerificationFailure {
  type: 'removed-route' | 'missing-route';
  route: string;
  file: string;
  line: number;
  message: string;
}

export interface RouteVerificationResult {
  ok: boolean;
  failures: RouteVerificationFailure[];
  documentedRoutes: RouteMention[];
  implementedRoutes: Set<string>;
  checkedDocs: string[];
}

export interface VerifyDocRoutesOptions {
  projectRoot?: string;
  docPaths?: string[];
  implementedRoutes?: Set<string>;
  removedRoutes?: Set<string>;
}

export function normalizeRoutePath(routePath: string): string;
export function routeKey(method: string, routePath: string): string;
export function extractImplementedRoutes(projectRoot?: string): Set<string>;
export function activeOperatorDocPaths(projectRoot?: string): string[];
export function extractDocumentedRoutes(projectRoot?: string, docPaths?: string[]): RouteMention[];
export function verifyDocRoutes(options?: VerifyDocRoutesOptions): RouteVerificationResult;
export function formatVerificationResult(result: RouteVerificationResult, projectRoot?: string): string;
