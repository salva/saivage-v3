declare const opaqueIdentityBrand: unique symbol;
declare const mutationAuthorityBrand: unique symbol;

export type OpaqueId<Kind extends string> = string & { readonly [opaqueIdentityBrand]: Kind };

export type RootGeneration = OpaqueId<'root-generation'>;
export type LeafActivationId = OpaqueId<'leaf-activation'>;
export type AnalystTurnId = OpaqueId<'analyst-turn'>;
export type McpRevisionId = OpaqueId<'mcp-revision'>;

export interface CompositionMutationAuthority {
  readonly kind: 'composition';
  readonly [mutationAuthorityBrand]: never;
}

export interface RootAuthority {
  readonly kind: 'root';
  readonly root: RootGeneration;
  readonly [mutationAuthorityBrand]: never;
}

export interface RootLeafAuthority {
  readonly kind: 'root_leaf';
  readonly root: RootGeneration;
  readonly leaf: LeafActivationId;
  readonly [mutationAuthorityBrand]: never;
}

export interface AnalystTurnAuthority {
  readonly kind: 'analyst_turn';
  readonly turn: AnalystTurnId;
  readonly [mutationAuthorityBrand]: never;
}

export interface McpRevisionAuthority {
  readonly kind: 'mcp_revision';
  readonly serverName: string;
  readonly revision: McpRevisionId;
  readonly [mutationAuthorityBrand]: never;
}

export type McpInvocationCaller =
  | { readonly kind: 'autonomous'; readonly authority: RootLeafAuthority }
  | { readonly kind: 'analyst'; readonly authority: AnalystTurnAuthority };

export interface McpInvocationAuthority {
  readonly kind: 'mcp_invocation';
  readonly caller: McpInvocationCaller;
  readonly revision: McpRevisionAuthority;
  readonly [mutationAuthorityBrand]: never;
}

export type MutationAuthority =
  | CompositionMutationAuthority
  | RootAuthority
  | RootLeafAuthority
  | AnalystTurnAuthority
  | McpRevisionAuthority
  | McpInvocationAuthority;

type AuthorityMetadata = {
  readonly current: () => boolean;
  readonly mcpCallerKind?: McpInvocationCaller['kind'];
};

const authorityMetadata = new WeakMap<object, AuthorityMetadata>();
let nextIdentity = 0;

function identity<Kind extends string>(kind: Kind): OpaqueId<Kind> {
  nextIdentity += 1;
  return `${kind}:${nextIdentity}` as OpaqueId<Kind>;
}

function authority<T extends MutationAuthority>(value: Omit<T, typeof mutationAuthorityBrand>, metadata: AuthorityMetadata): T {
  const issued = Object.freeze(value) as T;
  authorityMetadata.set(issued, metadata);
  return issued;
}

export function issueCompositionMutationAuthority(): CompositionMutationAuthority {
  return authority<CompositionMutationAuthority>({ kind: 'composition' }, { current: () => true });
}

export class RootCurrentness {
  #root: RootGeneration | null = null;
  #leaf: LeafActivationId | null = null;

  installRoot(): RootAuthority {
    const root = identity('root-generation');
    this.#root = root;
    this.#leaf = null;
    return authority<RootAuthority>({ kind: 'root', root }, { current: () => this.#root === root });
  }

  currentRoot(): RootAuthority | null {
    const root = this.#root;
    return root === null ? null : authority<RootAuthority>({ kind: 'root', root }, { current: () => this.#root === root });
  }

  installLeaf(rootAuthority: RootAuthority): RootLeafAuthority {
    assertIssuedAuthority(rootAuthority);
    if (!isAuthorityCurrent(rootAuthority)) throw new Error('Cannot install a leaf under a stale root.');
    const leaf = identity('leaf-activation');
    this.#leaf = leaf;
    return authority<RootLeafAuthority>(
      { kind: 'root_leaf', root: rootAuthority.root, leaf },
      { current: () => this.#root === rootAuthority.root && this.#leaf === leaf },
    );
  }

  clearLeaf(authorityToClear?: RootLeafAuthority): void {
    if (authorityToClear !== undefined) {
      assertIssuedAuthority(authorityToClear);
      if (this.#root !== authorityToClear.root || this.#leaf !== authorityToClear.leaf) return;
    }
    this.#leaf = null;
  }

  clearRoot(rootAuthority?: RootAuthority): void {
    if (rootAuthority !== undefined) {
      assertIssuedAuthority(rootAuthority);
      if (this.#root !== rootAuthority.root) return;
    }
    this.#leaf = null;
    this.#root = null;
  }
}

export class AnalystTurnCurrentness {
  #turn: AnalystTurnId | null = null;

  begin(): AnalystTurnAuthority {
    if (this.#turn !== null) throw new Error('An Analyst turn is already current.');
    const turn = identity('analyst-turn');
    this.#turn = turn;
    return authority<AnalystTurnAuthority>({ kind: 'analyst_turn', turn }, { current: () => this.#turn === turn });
  }

  clear(turnAuthority: AnalystTurnAuthority): void {
    assertIssuedAuthority(turnAuthority);
    if (this.#turn === turnAuthority.turn) this.#turn = null;
  }
}

export class McpRevisionCurrentness {
  readonly #revisions = new Map<string, McpRevisionId>();

  install(serverName: string): McpRevisionAuthority {
    const revision = identity('mcp-revision');
    this.#revisions.set(serverName, revision);
    return authority<McpRevisionAuthority>(
      { kind: 'mcp_revision', serverName, revision },
      { current: () => this.#revisions.get(serverName) === revision },
    );
  }

  remove(serverName: string): void {
    this.#revisions.delete(serverName);
  }
}

export function createMcpInvocationAuthority(
  caller: McpInvocationCaller,
  revision: McpRevisionAuthority,
): McpInvocationAuthority {
  assertIssuedAuthority(caller.authority);
  assertIssuedAuthority(revision);
  if (caller.kind === 'autonomous' && caller.authority.kind !== 'root_leaf') throw new Error('Invalid autonomous MCP caller authority.');
  if (caller.kind === 'analyst' && caller.authority.kind !== 'analyst_turn') throw new Error('Invalid Analyst MCP caller authority.');
  return authority<McpInvocationAuthority>(
    { kind: 'mcp_invocation', caller: Object.freeze({ ...caller }), revision },
    { current: () => isAuthorityCurrent(caller.authority) && isAuthorityCurrent(revision), mcpCallerKind: caller.kind },
  );
}

export function assertIssuedAuthority(value: MutationAuthority): void {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null || !authorityMetadata.has(value)) {
    throw new Error('Mutation authority is foreign or invalid.');
  }
}

export function isAuthorityCurrent(value: MutationAuthority): boolean {
  assertIssuedAuthority(value);
  return authorityMetadata.get(value)!.current();
}

export function mcpInvocationCallerKind(value: McpInvocationAuthority): McpInvocationCaller['kind'] {
  assertIssuedAuthority(value);
  const kind = authorityMetadata.get(value)!.mcpCallerKind;
  if (kind === undefined || value.kind !== 'mcp_invocation' || value.caller.kind !== kind) {
    throw new Error('MCP invocation authority has an invalid caller shape.');
  }
  return kind;
}
