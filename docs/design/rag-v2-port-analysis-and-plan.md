# Saivage v2 RAG Port Analysis and Plan

Date: 2026-06-07

Status: design analysis and implementation plan, not yet implementation authority.

## Executive Summary

Saivage v2 has a substantial, working RAG subsystem. It is not just a set of seven model-facing tools. It includes project-local dataset configuration, vector-store lifecycle, provider-stamped embedding generation, cache-aware ingestion, secret-aware filesystem walking, chunkers, query filtering, watcher/reconcile control, config persistence helpers, an in-process MCP registration path, and a separate knowledge/librarian layer that uses RAG as a backing store for skills and memories.

Saivage v3 currently has no RAG runtime. The config schema accepts `rag` as `unknown`, the tool catalog does not expose RAG tools, package dependencies needed by v2 RAG are absent, and runtime composition has no place where a RAG manager is constructed or disposed. That means the port should be treated as a first-class subsystem integration, not a file-copy exercise.

The recommended path is to port v2 RAG into v3 as a v3-native unified tool subsystem with the same model-facing tool names (`rag_list`, `rag_stats`, `rag_query`, `rag_register`, `rag_ingest`, `rag_drop`, `rag_admin`) but not as an in-process MCP service. v3 already has a unified tool catalog, role policy, content-supervised dispatch path, operator HTTP contracts, runtime lifecycle composition, and project-local state rules. RAG should use those seams directly.

The first implementation wave should deliver read/query RAG plus explicit operator/admin ingestion over configured collections. The v2 knowledge store and librarian role should be deferred. They are valuable but they would add a new v3 role and memory lifecycle at the same time as the RAG storage port, which would make the first port harder to verify and easier to miswire.

## Current v2 RAG Inventory

### Config Surface

v2 defines `ragSchema` in `/home/salva/g/ml/saivage/src/config/schema/rag.ts`.

The persisted shape is:

```ts
type RagConfig = {
  enabled: boolean;
  datasets: Array<{
    id: string;
    source: 'skill' | 'memory' | 'doc' | 'code';
    provider: {
      kind: 'openai';
      model: string;
      dim: number;
    };
    store: { kind: 'sqlite-vec' };
    chunker: {
      kind: 'markdown' | 'code' | 'memory';
      chunkSize?: number;
      overlap?: number;
    };
    exclusions: string[];
    sources: Array<{
      root: string;
      include?: string[];
      exclude?: string[];
    }>;
    watch: false | true | { usePolling: true; interval?: number };
  }>;
};
```

Important properties:

- RAG defaults to disabled.
- Dataset storage is explicitly `sqlite-vec`.
- The only embedding provider kind is `openai`.
- Datasets are project-local and include source roots and watch/reconcile settings.
- The config permits skill and memory datasets, but the agent-facing admin registration tool only allows `doc` and `code` for newly registered datasets.

### Core Data Types

v2 public RAG types live in `/home/salva/g/ml/saivage/src/rag/types.ts`.

Important types:

- `ProviderStamp`: `{ provider, model, dim, releaseFingerprint }`.
- `DatasetConfig`: config plus project id.
- `ChunkMetadata`: path, source, chunk index, line range, content hash, source hash, mtime, language, heading, symbol, scope, role, lifecycle, and supersession fields.
- `QueryFilter`: `eq`, `and`, `or`, numeric `gt`/`lt`, `pathGlob`, and `in` filters.
- `IngestInput`: filesystem roots or synthetic records.
- `IngestReport`: scanned/changed/upserted/deleted/secret-dropped/token/timing counters.
- `DatasetStats`: chunk/file/disk/provider/last-ingest/secret counters.

This is a reusable domain model and should largely survive the port, with naming reviewed for v3 style and tests converted from Vitest to Jest.

### Dataset Manager

v2 `createRagManager` lives in `/home/salva/g/ml/saivage/src/rag/manager.ts`.

Responsibilities:

- Returns a no-op manager when disabled.
- Materializes one `Dataset` per configured dataset.
- Opens datasets lazily and caches them.
- Maintains `.saivage/rag/registry.json` as an operator-visible cache.
- Enforces provider dimension drift checks against prior registry entries.
- Exposes `list`, `get`, `register`, `ingest`, `query`, `stats`, `drop`, and `close`.

The manager's state root is `.saivage/rag/<datasetId>/`. This is compatible with the workspace rule to keep Saivage runtime state project-local, but v3's current docs treat `.saivage/` as generated/internal state and block agent file tools from touching it. That is a good default: RAG stores should remain runtime-owned, not agent-editable files.

### Dataset Facade

v2 `Dataset` lives in `/home/salva/g/ml/saivage/src/rag/dataset.ts`.

Responsibilities:

- Binds store, provider, chunker, and watcher controller.
- Opens `.saivage/rag/<datasetId>/store.db`.
- Validates provider stamp through store open.
- Runs ingestion and query pipelines.
- Provides stats, drop, close, watch, unwatch, and reconcile.

Design notes:

- The dataset owns store and watcher lifecycle.
- The provider is instantiated at open time.
- The current v2 comments mention `rebuild`, but implementation in the examined file does not include a public rebuild method. If v3 needs rebuild, design it explicitly rather than assuming v2 has it.
- The dataset does not read `.saivage/auth-profiles.json`; provider options are supplied by the manager/bootstrap seam.

### Ingest Pipeline

v2 ingest lives in `/home/salva/g/ml/saivage/src/rag/pipeline.ts`.

The ingest flow:

1. Ensure/acquire a per-dataset cross-process lock with `proper-lockfile`.
2. Load inputs either from filesystem walking or synthetic records.
3. Compare file state against previous source hashes.
4. Chunk changed inputs.
5. Drop chunks that match secret heuristics.
6. Reuse cached embeddings by provider stamp plus content hash.
7. Embed cache misses in batches.
8. Delete prior chunks for changed paths.
9. Upsert new chunks and update file state.
10. Delete chunks/file-state for removed paths.
11. Persist last ingest and secret-drop counters.
12. Release lock.

Important properties:

- The pipeline is incremental and hash-based.
- It supports both file ingestion and record ingestion. Record ingestion is important for the v2 knowledge store but can be deferred in v3's first wave if only project docs/code collections are supported.
- Secret filtering happens both by path and by chunk content.
- The embedding cache key is `sha256(provider:model:dim:releaseFingerprint + NUL + contentHash)`.
- The pipeline assumes a vector store that stores chunk rows, vector rows, embedding cache, file state, and metadata.

### Query Pipeline

v2 query lives in `/home/salva/g/ml/saivage/src/rag/query/pipeline.ts`.

The query flow:

1. Open the store against the current provider stamp, surfacing embedding drift if the store stamp differs.
2. Embed the query string.
3. Run vector KNN with optional filters.
4. Return score-sorted hydrated hits.

Default `topK` is 8. Agent-facing `rag_query` caps `topK` at 100 and truncates each hit text to 2 KiB.

### Vector Store

v2 vector storage lives in `/home/salva/g/ml/saivage/src/rag/store/sqlite-vec.ts`.

Core properties:

- Uses `better-sqlite3` and `sqlite-vec`.
- Enables WAL and `synchronous=NORMAL`.
- Runs `PRAGMA integrity_check` before touching schema.
- Writes a `.corrupted` sentinel if open/init/integrity fails.
- Stores provider stamp in `meta` and refuses mismatched provider/model/dim/release fingerprints.
- Uses table `chunk` for metadata/text and virtual table `vec_chunk` for vectors.
- Stores `embedding_cache` and `file_state` in the same SQLite file.
- Supports pre-filtering for eligible filters and post-filter overshoot for others.
- Converts sqlite-vec distance to similarity score using `1 - distance^2 / 2`.

Dependencies absent from v3:

- `better-sqlite3`
- `sqlite-vec`
- `@types/better-sqlite3`

Native dependency risk:

- `better-sqlite3` and `sqlite-vec` are native or native-adjacent dependencies. They can complicate container builds, Node 24 compatibility, and deployment reproducibility. v2 already runs these dependencies locally, but v3 currently keeps a smaller dependency surface. The port plan must include dependency installation/build verification and deployment verification in LXC if the live deployment is updated.

### Embedding Provider

v2 provider code lives in `/home/salva/g/ml/saivage/src/rag/provider/index.ts` and `/home/salva/g/ml/saivage/src/rag/provider/openai.ts`.

Important properties:

- Uses the `openai` SDK directly, not `@mariozechner/pi-ai`.
- Defaults API key to `process.env.OPENAI_API_KEY`.
- Supports optional `baseUrl`.
- Has a test injection seam for a fake embeddings client.
- Default batch size is 96.
- Retries 429, 5xx, and network errors with exponential backoff and `Retry-After` support.
- Validates response count and vector dimensionality.
- Derives release fingerprint as `sha256(openai:model:dim).slice(0, 16)`.

Dependencies absent from v3:

- `openai`

Architectural mismatch:

- v3 has a provider registry and auth-profile handling for LLM calls. RAG embeddings should not invent a completely separate credential model unless this is explicitly intended. The clean v3 design should route embedding credentials through a v3 RAG provider resolver that can read redacted config safely and, where applicable, use existing provider/account/baseUrl/apiKey fields without leaking credentials into tool schemas or logs.

### Filesystem Walker and Secret Guard

v2 walker lives in `/home/salva/g/ml/saivage/src/rag/walker.ts`.

Important behavior:

- Uses `picomatch` include/exclude globs.
- Hard excludes `.git`, `node_modules`, and `.saivage`.
- Delegates path safety to RAG secret guard.
- Canonicalizes paths through `realpath`.
- Skips symlinks that escape the canonical root.
- Tracks directory inodes to avoid cycles.

v2 secret guard lives in `/home/salva/g/ml/saivage/src/rag/security/secrets.ts`.

Important behavior:

- Delegates to app-wide secret scanner for blocked paths and secret shapes.
- Adds RAG-specific blocked path globs: PEM/key files, SSH, AWS credentials, `.netrc`, `secrets`, and auth profiles.
- Adds provider-shape secret patterns for Slack, Anthropic, and AWS secret access keys.
- Treats false positives as acceptable and skips chunks/files when unsure.

v3 already has `src/workspace/secret-paths.ts`, `src/workspace/file-access-security.ts`, `src/workspace/heuristic-scanner.ts`, and related redaction/supervision modules. The port should reuse v3 workspace security primitives instead of importing v2's canonical scanner directly. The extra RAG-specific globs/patterns are still valuable and should be added as a RAG guard layered on top of v3 primitives.

### Chunkers

v2 has markdown, code, memory, and token-counting chunkers under `/home/salva/g/ml/saivage/src/rag/chunker/`.

Dependencies absent from v3:

- `js-tiktoken`
- `tree-sitter`
- `tree-sitter-python`
- `tree-sitter-typescript`

Porting considerations:

- Markdown/doc chunking is likely safe to port early.
- Code chunking may carry native/tree-sitter dependency risk and should be isolated behind a chunker seam.
- Memory chunking is tied to v2's knowledge/memory records and can be deferred unless v3 ports the knowledge store.
- If the first wave supports `doc` and `code`, decide whether `code` initially uses a simple text/line chunker or imports tree-sitter immediately. Given AGENTS.md favors clean architecture over compatibility shims, the better option is to preserve the chunker seam and implement code chunking fully or explicitly keep `code` datasets out of wave 1.

### Watcher and Reconcile

v2 watcher code lives under `/home/salva/g/ml/saivage/src/rag/watcher/` and uses `chokidar`.

Important behavior:

- Dataset `watch` may be disabled, native-events enabled, or polling enabled.
- Watcher reconcile routes changes through normal ingest.
- Polling is useful for LXC bind mounts, NFS, and FUSE.

Dependency absent from v3:

- `chokidar`

Porting concern:

- v3 runtime is deliberately runtime-owned and card-centered. Background watchers are a different scheduling model. If they mutate RAG stores while an agent is running, the results of `rag_query` can change between turns without an explicit tool/action record. That can be acceptable for RAG, but only if the operator and docs describe it as an index freshness process, not runtime planning state.

Recommended decision:

- First port should support `rag_admin action=reconcile` and `rag_ingest`, but leave auto-watch disabled or optional and off by default.
- Add watcher support in a later wave after lifecycle/disposal/readiness events are wired.

### Tool Surface

v2 agent-facing RAG tools are defined in `/home/salva/g/ml/saivage/src/server/rag/handler.ts` and `/home/salva/g/ml/saivage/src/server/rag/service.ts`.

Tools:

- `rag_list({})`: list registered collections.
- `rag_stats({ collection_id })`: read collection stats.
- `rag_query({ collection_id, text, topK?, filter? })`: semantic search.
- `rag_register({ collection_id, source, provider?, chunker, exclusions?, sources, watch?, persist? })`: register and initially ingest a collection.
- `rag_ingest({ collection_id })`: ingest a registered collection.
- `rag_drop({ collection_id, persist? })`: drop a collection.
- `rag_admin({ collection_id, action })`: `reconcile`, `watch_arm`, or `watch_disarm`.

v2 access control:

- Read/query tools are broadly available through the MCP service.
- Admin-scope tools require operator context or a role in `adminRoles`.
- The only non-operator v2 admin role is `librarian`.
- Register/drop/admin use a single control mutex.
- Ingest is not under the global control mutex because per-dataset ingest locks already serialize same-dataset ingestion and unrelated datasets should ingest concurrently.

v2 error model:

- Tools return `{ ok: true, data }` or `{ ok: false, code, message, details? }` envelopes.
- Handler maps `RagError` into stable `RAG_*` codes.
- Tool schemas deliberately do not expose raw provider secrets.

### In-Process MCP Registration

v2 registers the RAG service through `/home/salva/g/ml/saivage/src/mcp/builtins/rag.ts` into an in-process MCP runtime server named `rag`.

This is not the best v3 target. v3 has an external MCP manager plus an agent-facing `mcp_tool_call` wrapper, but recent v3 tool work favors first-class unified tool executors for built-in capabilities. RAG is a Saivage-owned built-in capability. It should not require agents to call `mcp_tool_call({ serverName: 'rag', toolName: 'rag_query', ... })`.

### Knowledge Store and Librarian Layer

v2 has a knowledge sidecar and librarian agent:

- `/home/salva/g/ml/saivage/src/knowledge/init.ts`
- `/home/salva/g/ml/saivage/src/knowledge/sidecar.ts`
- `/home/salva/g/ml/saivage/src/agents/librarian.ts`

The knowledge store requires `rag.enabled = true`, opens a sidecar, ensures protected datasets, upserts built-in skills, and reingests knowledge kinds. The librarian is a non-worker agent that can curate RAG collections and records.

This layer is not required for a first v3 RAG port. v3 already has a skill loader and no librarian role. Porting knowledge/librarian together with storage/tools would add scope and policy complexity. It should be a later phase after the RAG manager and query/admin tools are stable.

## Current v3 Situation

### Architecture Authority

The active v3 architecture is card-centered and runtime-owned. The key current authority is `docs/agents.md`.

Relevant invariants:

- The runtime is the only dispatcher.
- Planners own goal subtrees and call `activate_card` for child work.
- Tool surfaces are role-bound and source-verified by tests/docs.
- Agent-visible messages must contain only information the agent can act on.
- Workspace tools are project-contained and secret-protected.
- `.saivage/` and `.saivage-work/` are internal/generated state and blocked from normal agent file tools.
- Old state formats and compatibility shims have no design weight.

AGENTS.md adds specific principles:

- Simple and clean architecture.
- No backward compatibility or compatibility shims.
- Fail fast for impossible states.
- No over-defensive code.
- Brave refactoring when the clean design requires it.
- Remove dead code aggressively.

### Config Gap

v3 `src/agents/config-schema.ts` currently has:

```ts
rag: z.unknown().optional()
```

Docs list `rag` as a top-level section but do not define its fields. This means any RAG implementation must first replace `unknown` with a strict schema and update docs/source verification output.

Recommended v3 config shape:

```ts
type RagSection = {
  enabled: boolean;
  providers?: Record<string, RagEmbeddingProviderConfig>;
  datasets: RagDatasetConfig[];
};
```

However, to minimize unnecessary divergence from v2 and avoid inventing a large provider abstraction too early, the first v3 implementation can keep the v2 dataset-level provider shape while adding an explicit provider credential resolution rule:

```ts
type RagEmbeddingProviderConfig =
  | {
      kind: 'openai';
      model: string;
      dim: number;
      provider?: string;
      account?: string;
      baseUrl?: string;
      apiKey?: string;
    };
```

Design decision needed:

- Option A: preserve v2 `provider.kind/model/dim` only and resolve credentials from `OPENAI_API_KEY`. This is simple but not aligned with v3's provider/account config.
- Option B: allow RAG provider entries to reference v3 providers/accounts. This is cleaner for v3 and avoids another credential namespace, but needs more design/testing.

Recommendation: implement Option B with fallback to `OPENAI_API_KEY` only when no provider/account reference is configured. The fallback is not a compatibility shim; it is a valid simple configuration path.

### Dependency Gap

v3 dependencies currently include only core server/runtime libraries plus `zod`. It does not include v2 RAG dependencies.

Required for a direct v2-quality port:

- Runtime dependencies: `better-sqlite3`, `sqlite-vec`, `openai`, `picomatch`, `proper-lockfile`, `js-tiktoken`.
- Optional/runtime dependencies if watcher or full code chunking is included: `chokidar`, `tree-sitter`, `tree-sitter-python`, `tree-sitter-typescript`.
- Type dependencies: `@types/better-sqlite3`, `@types/picomatch`, `@types/proper-lockfile`.

Port sequencing should minimize native dependency blast radius:

- If wave 1 includes SQLite vector search, `better-sqlite3` and `sqlite-vec` are unavoidable.
- If wave 1 excludes watcher and tree-sitter code chunking, defer `chokidar` and tree-sitter packages.
- If wave 1 uses a simpler token estimator, defer `js-tiktoken`; if exact v2 token metrics are important, include it.

### Tool Catalog Gap

v3's current unified tool catalog lives in `src/tools/definitions/index.ts` and `src/tools/tool-catalog.ts`. Tool dispatch is handled by `src/agents/tool-dispatcher.ts` adapters and role policy in `src/agents/role-tool-policy.ts`.

Current role tools in `docs/agents.md` do not include RAG.

The earlier v2 tool-interface plan already notes RAG as optional and absent:

- `rag_list`
- `rag_stats`
- `rag_query`
- `rag_register`
- `rag_ingest`
- `rag_drop`
- `rag_admin`

RAG should enter v3 as a new unified tool family, not through `mcp_tool_call`.

### Runtime Composition Gap

v3 runtime composition is in `src/application/runtime-composition.ts`. It constructs:

- `SkillsEngine`
- `ContextCompactor`
- `FsCandidateAvailability`
- `AgentAdapter`
- `RuntimeCore`
- optional external `McpManager`

No service slot currently exists for RAG. A port must add:

- `RagManager` construction from config.
- Lifecycle disposal on `runtimeApi.shutdown()`.
- A way for agent tool dispatch to access the manager/service.
- Optional operator read models and readiness diagnostics.

### Security and Content Supervision Gap

v3 already screens MCP tool output in `McpAdapter` using `ContentSupervisor`, and workspace/file tools use project containment/secret checks.

RAG must satisfy both:

- Ingest must not embed secret-bearing paths or chunks.
- Query output should be content-supervised before it is persisted as an agent-visible tool result.

The v2 RAG query path truncates hit text but does not use v3's content supervisor. In v3, the RAG adapter should screen serialized query results like MCP output does. If blocked, it should return a tool error and include a redacted/summarized reason.

### Operator/API Gap

v3 currently exposes MCP status/tools, files, events, providers, runtime status, agents, and cards. There is no RAG operator API.

For first implementation, operator RAG APIs are not strictly required if tools are enough, but the control room will be blind to collections, ingest freshness, and failures. At minimum, RAG status should appear in readiness/diagnostics or an operator read model later.

Recommended first operator surfaces:

- `GET /api/rag/collections`: collection list plus stats, no hit text.
- `GET /api/rag/collections/:id`: dataset config summary and stats.
- `POST /api/rag/collections/:id/ingest` or equivalent local CLI/operator command only if the current operator API pattern accepts mutating controls.

Given `docs/operation.md` currently states the mounted operator HTTP surface is mostly observation routes and not mutating runtime controls, mutating RAG APIs should either be deferred or routed through the same explicit runtime/control-action architecture used for other operator mutations.

## Strategic Design Decisions

### Decision 1: Built-In Unified Tools vs In-Process MCP

Recommendation: built-in unified tools.

Reasons:

- RAG is Saivage-owned infrastructure, not an external MCP server.
- v3's role policy and tool docs are source-verified around unified tools.
- Built-in tools can cleanly participate in v3 content supervision and stable role matrices.
- Agents should call `rag_query`, not nested `mcp_tool_call` wrappers.
- The recent priority tool port established the pattern of first-class tool executors for built-ins.

Implementation implication:

- Add `src/tools/rag-tools.ts` with `UnifiedToolDefinition`s.
- Add a `RagAdapter` or runtime-tool executor path that has access to `RagService`.
- Extend `RoleToolPolicySurface` with `'rag'` or classify RAG as `'agent-runtime'`. A distinct `'rag'` surface is clearer for audit tags and role policy.

### Decision 2: Preserve v2 Tool Names

Recommendation: preserve exact v2 RAG tool names.

Reasons:

- Names are already clear and specific.
- The previous v2/v3 tool plan identified these exact names as optional RAG tools.
- No v3 tools currently conflict with them.
- This avoids aliases and compatibility shims while still adopting v2's vocabulary.

### Decision 3: Role Access

Recommended role matrix:

| Tool | Planner | Executor | Reviewer | Analyst | Operator |
|---|---:|---:|---:|---:|---:|
| `rag_list` | yes | yes | yes | yes | yes |
| `rag_stats` | yes | yes | yes | yes | yes |
| `rag_query` | yes | yes | yes | yes | yes |
| `rag_ingest` | no | yes | no | no by default | yes |
| `rag_register` | no | no by default | no | no by default | yes |
| `rag_drop` | no | no | no | no | yes |
| `rag_admin` | no | no by default | no | no by default | yes |

Rationale:

- Planners/reviewers benefit from read-only semantic retrieval.
- Executors can read/query and may run ingestion as part of an explicit card if the task is to build/update an index.
- Admin registration/drop/watch actions are control-plane operations and should not be autonomous planner tools.
- v3 has no librarian role today, so v2's `adminRoles = ['librarian']` has no direct mapping.
- Analyst access to admin tools should be introduced only through explicit operator-confirmed controls, not casual chat.

Potential alternate:

- Allow `rag_register` and `rag_ingest` for executors only when invoked from a card tagged `ops` or `data`. This is attractive but introduces context-sensitive role policy. Defer unless needed.

### Decision 4: Storage Location

Recommendation: keep `.saivage/rag/<datasetId>/`.

Reasons:

- It is project-local and consistent with workspace rules.
- It is runtime-owned internal state, like other `.saivage/` runtime records.
- Agent file tools already block `.saivage/`, which prevents accidental edits to SQLite stores.

Open detail:

- v3 currently has newer runtime state under `.saivage/tmp/state/`. RAG is not runtime state in the same sense as active card runs; `.saivage/rag/` is a reasonable separate concern. Do not put RAG stores under `.saivage-work/`, because `.saivage-work/` is for generated process/artifact workspace output, not durable indexes.

### Decision 5: Config Persistence

Recommendation: strict config schema, no automatic migration from v2 state.

Reasons:

- AGENTS.md explicitly says no backward compatibility and no migration code.
- v3's `rag` was `unknown`, not a shipped v3 RAG config.
- If a project has old RAG state, the operator should register/rebuild datasets under the new v3 config.

For `rag_register(persist: true)`, v2 mutates `.saivage/saivage.json`. In v3, this is sensitive because config changes are operator-significant. Implement this only for operator context at first. Executor card work can propose config changes through normal file edits if authorized, but RAG admin tools should not silently persist config from autonomous roles.

### Decision 6: Provider Credential Resolution

Recommendation: a v3 `RagEmbeddingProviderResolver`.

Resolution order:

1. Explicit RAG provider config references `providers.<name>.accounts.<account>`.
2. Explicit RAG provider config references `providers.<name>`.
3. Explicit RAG provider config supplies `apiKey`/`baseUrl` directly.
4. Environment fallback `OPENAI_API_KEY` for `kind: 'openai'`.

Rules:

- Tool schemas must never accept API keys.
- Tool outputs and errors must not print resolved keys, auth profile values, or raw provider config.
- OAuth-backed profiles require careful handling. For wave 1, support API-key provider/account entries and document OAuth embeddings as deferred unless v3 provider auth refresh can be reused safely.

### Decision 7: Watchers

Recommendation: defer auto-watch; support explicit ingest/reconcile first.

Reasons:

- Watchers are background mutation processes.
- v3's runtime architecture is explicit and event-ledger-driven.
- LXC bind mounts often require polling, which has resource implications.
- Query freshness is useful, but explicit `rag_ingest`/`rag_admin reconcile` is enough to validate the core port.

Later watcher phase should:

- Start watchers only from runtime application lifecycle.
- Emit runtime events for watch armed/disarmed/reconcile failures.
- Expose operator status.
- Dispose watchers on shutdown.
- Keep watchers disabled by default.

### Decision 8: Knowledge Store and Librarian

Recommendation: defer.

Reasons:

- v3 has no librarian role.
- v3 skill loading is currently direct, deterministic, and not RAG-backed.
- Memory semantics are not part of current v3 architecture authority.
- Adding a new autonomous curation role would affect prompts, routing, role policy, docs, tests, and runtime scheduling.

Future phase:

- Introduce a `knowledge` subsystem only after RAG query/admin works.
- Decide whether v3 needs memory records, skill semantic search, or both.
- If adding a librarian, define whether it is operator-invoked, runtime-invoked, or analyst-invoked, and ensure it does not bypass card-centered execution.

## Proposed v3 Architecture

### Module Layout

Recommended new files/directories:

```text
src/rag/
  types.ts
  errors.ts
  manager.ts
  dataset.ts
  pipeline.ts
  lock.ts
  registry.ts
  walker.ts
  cache/embedding-cache.ts
  chunker/index.ts
  chunker/markdown.ts
  chunker/code.ts          # optional in first wave
  chunker/memory.ts        # deferred unless knowledge store lands
  provider/index.ts
  provider/openai.ts
  query/pipeline.ts
  security/secrets.ts
  store/index.ts
  store/sql.ts
  store/metadata.ts
  store/sqlite-vec.ts

src/tools/rag-tools.ts
src/agents/rag-tool-adapter.ts      # or class inside tool-dispatcher.ts initially
src/application/rag-composition.ts  # optional helper if composition grows
```

Keep the RAG domain under `src/rag/`, not `src/server/rag/`. Tool wrapping belongs under `src/tools/` and dispatch under `src/agents/`.

### Service Shape

Recommended v3 service:

```ts
type RagService = {
  enabled: boolean;
  projectRoot: string;
  manager: RagManager;
  control: { busy: boolean };
  watchStatus: Map<string, 'off' | 'armed'>;
  contentSupervisor?: ContentSupervisor;
  eventLogger?: EventLogger;
};
```

Differences from v2:

- Do not include `adminRoles` inside the service. Role policy belongs in v3 `RoleToolPolicy` and source-verified role matrices.
- Do not bind to an MCP `ToolCallContext`; v3 dispatch context already has role/session/surface.
- Include optional observability dependencies if needed for events.

### Tool Result Shape

Use v3 adapter result conventions while preserving stable RAG envelopes in `data`.

Recommended tool output:

```ts
type RagToolSuccess<T> = {
  ok: true;
  data: T;
};

type RagToolError = {
  ok: false;
  code: RagErrorCode;
  message: string;
  details?: Record<string, unknown>;
};
```

The adapter should return `success: envelope.ok` and `data: envelope`. This lets model-facing content remain explicit (`ok`, `code`) while v3 persistence classifies the tool call as `tool_result` or `tool_error`.

### Error Codes

Preserve v2-style stable codes where still valid:

- `RAG_DISABLED`
- `RAG_UNAUTHORIZED_ROLE`
- `RAG_DATASET_NOT_FOUND`
- `RAG_INVALID_ARGS`
- `RAG_CONTROL_BUSY`
- `RAG_PROTECTED_DATASET`
- `RAG_BLOCKED_PATH`
- `RAG_WATCH_DISABLED`
- `RAG_WATCHER_UNAVAILABLE`
- `RAG_INGEST_LOCKED`
- `RAG_EMBEDDING_DRIFT`
- `RAG_PROVIDER_UNAVAILABLE`
- `RAG_CORRUPTED_STORE`
- `RAG_PERSIST_FAILED`
- `RAG_INTERNAL`

v3-specific additions:

- `RAG_CONTENT_BLOCKED` when query output is blocked by content supervisor.
- `RAG_CONFIG_INVALID` for strict config validation failures.
- `RAG_PROVIDER_CONFIG_UNAVAILABLE` when the configured embedding provider/account cannot resolve credentials.

### Tool Schemas

Use v2 schemas as the baseline, but tighten where v3 policy requires.

Recommended first-wave schemas:

```ts
rag_list: {}

rag_stats: {
  collection_id: string;
}

rag_query: {
  collection_id: string;
  text: string;
  topK?: number;       // int, 1..50 or 1..100
  filter?: QueryFilter;
}

rag_ingest: {
  collection_id: string;
}

rag_register: {
  collection_id: string;
  source: 'doc' | 'code';
  chunker: ChunkerRef;
  sources: [{ root: string; include?: string[]; exclude?: string[] }];
  provider?: { model?: string; dim?: number; provider?: string; account?: string };
  exclusions?: string[];
  persist?: boolean;
}

rag_drop: {
  collection_id: string;
  persist?: boolean;
}

rag_admin: {
  collection_id: string;
  action: 'reconcile'; // watch actions deferred in wave 1
}
```

Do not expose API keys, base URLs with embedded credentials, env values, or auth profile contents in any tool schema.

### Role Policy Surface

Add a RAG policy surface:

```ts
type RoleToolPolicySurface =
  | 'planner-control'
  | 'agent-runtime'
  | 'workspace'
  | 'external-mcp'
  | 'skill'
  | 'rag'
  | 'contract-terminal';
```

Add `RAG_TOOL_NAMES` from the unified catalog and policy logic:

- Reject unknown RAG tools.
- Allow read tools to roles that list them.
- Allow admin tools only to explicit roles/operator surfaces.

This keeps RAG policy auditable and avoids hiding admin decisions inside service code.

### Runtime Composition

`createRuntimeApplication()` should construct RAG if `config.rag.enabled` is true.

Suggested steps:

1. Parse `config.rag` strictly in config schema before composition.
2. Create a `RagManager` with `projectRoot`, project id, datasets, and provider resolver.
3. Create `RagService` with control mutex and watch status.
4. Pass service into `AgentAdapter` or `ToolDispatcher` construction.
5. Dispose/close manager during `runtimeApi.shutdown()`.
6. Optionally include RAG status in server availability/readiness.

Fail-fast rule:

- If `rag.enabled` is true and the RAG manager cannot initialize because dependencies are unavailable, config is invalid, provider cannot be resolved, or a configured store is corrupt, v3 should fail startup or mark readiness unavailable according to the existing startup composition policy. Do not silently disable RAG.

Disabled rule:

- If `rag.enabled` is false or omitted, RAG tools may still be listed if compiled into role catalog, but calls should return `RAG_DISABLED`. Alternatively, hide RAG tools unless enabled. Hiding tools dynamically complicates source-verified role matrices, so prefer listing compiled tools and returning `RAG_DISABLED` when disabled.

### Content Supervision

RAG query output should be screened because retrieved text can contain prompt injection or sensitive content that survived ingest heuristics.

Screening policy:

- Screen serialized `rag_query` envelope after truncation and before persistence.
- If blocked, return `RAG_CONTENT_BLOCKED` as a tool error with the supervisor summary.
- Consider screening `rag_list` and `rag_stats` unnecessary unless dataset ids/config summaries include free-form paths. If paths are included, screen or redact.

Ingest policy:

- Keep path and chunk secret scans before embedding.
- Never embed chunks that match secret heuristics.
- Record `chunksDroppedSecrets` and expose only counts, not raw matches.

### Observability

Add event kinds later or in the first implementation if low overhead:

- `rag_collection_registered`
- `rag_ingest_started`
- `rag_ingest_completed`
- `rag_ingest_failed`
- `rag_query_invoked`
- `rag_collection_dropped`
- `rag_reconcile_completed`
- `rag_store_corrupted`

Events must not include query text verbatim by default. A hashed or truncated summary is safer. Hit paths and scores may be acceptable if path secret checks are enforced.

### Operator UX

First useful UI/read model:

- Show whether RAG is enabled.
- List collections with source, provider model/dim, chunk count, file count, disk bytes, last ingest time, secret-drop count, watch status.
- Show recent RAG events/errors.
- Provide an operator-only ingest/reconcile action later if current runtime-control UX supports it.

Avoid showing hit text in operator diagnostics unless using the same preview safety model as file browsing.

## Implementation Plan

### Phase 0: Dependency and Build Spike

Goal: prove v3 can install/build the minimal RAG dependency set on Node 24 and in the target LXC-like environment.

Tasks:

1. Add minimal dependencies: `better-sqlite3`, `sqlite-vec`, `openai`, `picomatch`, `proper-lockfile`; type packages as needed.
2. Add a small Jest smoke test that imports and opens an empty sqlite-vec store with a fake provider stamp.
3. Run `npm run typecheck`, focused Jest, and `npm run build`.
4. If native dependency installation fails, stop and decide between fixing native build prerequisites, using a different vector store, or deferring RAG.

Exit criteria:

- v3 can import sqlite-vec and create a test store under a temporary directory.
- No runtime code paths are exposed to agents yet.

### Phase 1: Domain Port Without Agent Tools

Goal: port reusable RAG domain modules and tests in isolation.

Tasks:

1. Port `src/rag/types.ts`, `errors.ts`, `cache/embedding-cache.ts`, `store/metadata.ts`, `store/sql.ts`, `store/index.ts`, and `store/sqlite-vec.ts`.
2. Port tests from Vitest to Jest.
3. Replace v2 secret guard dependencies with v3 workspace/security primitives.
4. Port provider seam with fake embedding client tests.
5. Add a provider resolver stub that can use direct API key/env for tests and provider/account config for production.

Exit criteria:

- Store, metadata, SQL filter, embedding cache, provider, and error tests pass.
- No config schema or agent tool changes yet.

### Phase 2: Config Schema and Manager

Goal: make RAG a strict v3 config section and construct a manager in tests.

Tasks:

1. Replace `rag: z.unknown().optional()` with a strict `ragSectionSchema`.
2. Update `docs/configuration.md` and `docs/design/configuration.md` schema inventory/docs.
3. Port `registry.ts`, `manager.ts`, `dataset.ts`, and lock handling.
4. Add tests for enabled/disabled manager behavior, config validation, registry writes, provider drift, and disabled calls.
5. Decide and implement config save helper for `rag_register(persist: true)` or defer persistence to operator-only phase.

Exit criteria:

- `loadConfig()` validates RAG sections strictly.
- Docs verifier accepts schema inventory updates.
- Manager tests pass.

### Phase 3: Ingest and Query Pipelines

Goal: provide project-local ingestion and semantic query with fake providers.

Tasks:

1. Port markdown/doc chunker and token counting or implement a clean v3 equivalent.
2. Port walker with v3 containment and secret-path integration.
3. Port ingest pipeline and query pipeline.
4. Add tests for incremental ingest, deleted files, cached embeddings, secret chunk drops, query filtering, and result ordering.
5. Add e2e test using fake embeddings and a temporary project root.

Exit criteria:

- A test can register/open a dataset, ingest files, query, update files, reingest, and observe changed/deleted chunks.
- Secret-bearing paths/chunks are skipped.

### Phase 4: Unified RAG Tools and Role Policy

Goal: expose RAG read/query/admin tools through v3's unified tool system.

Tasks:

1. Add `src/tools/rag-tools.ts` definitions.
2. Add `RagAdapter` to tool dispatch or a separate runtime-tool executor that accepts `RagService`.
3. Add RAG surface to `RoleToolPolicy`.
4. Add tool names to stable tool order.
5. Update phase runners and prompts if RAG tools should be present in planner/executor/reviewer contexts.
6. Update `docs/agents.md` tool matrix and active architecture text.
7. Add tests for role matrices, policy denials, schemas, dispatch, disabled RAG, and content-supervision blocking.

Exit criteria:

- Source-verified docs/tool parity passes.
- Planner/executor/reviewer can call read RAG tools according to the final role matrix.
- Admin tools are denied to unauthorized roles with stable errors.

### Phase 5: Runtime Composition and Lifecycle

Goal: construct, wire, and dispose RAG in real v3 runtime startup.

Tasks:

1. Add RAG service construction in `createRuntimeApplication()` or a helper.
2. Pass service into `AgentAdapter`/tool dispatcher.
3. Close manager on shutdown.
4. Add readiness/diagnostic summaries if enabled.
5. Ensure startup fails loudly for invalid enabled config.
6. Add tests for startup with RAG disabled, enabled with fake provider, and shutdown closing stores.

Exit criteria:

- Runtime application can start with RAG disabled and enabled.
- Enabled misconfiguration fails fast and safely.
- Shutdown disposes open stores/watchers.

### Phase 6: Operator Read Models

Goal: make RAG observable to the operator without exposing secrets or raw indexed text.

Tasks:

1. Add operator contracts for RAG collection list/detail.
2. Add handlers and route docs.
3. Add UI panel or debug read model if desired.
4. Add tests for redaction, route inventory, and no hit text leakage.

Exit criteria:

- Operator can see RAG enabled status and collection stats.
- Docs route inventory passes.

### Phase 7: Optional Watcher Support

Goal: reintroduce v2 watcher/reconcile behavior with v3 lifecycle control.

Tasks:

1. Add `chokidar` dependency.
2. Port watcher controller/reconcile/debouncer/flood/exclusion modules.
3. Start configured watchers only during runtime application startup when enabled.
4. Emit RAG watcher events and expose status.
5. Dispose watchers on shutdown.
6. Add LXC bind-mount polling tests or manual validation notes.

Exit criteria:

- Watchers are off by default.
- Explicitly enabled watchers start, reconcile, report errors, and stop cleanly.

### Phase 8: Optional Knowledge Store and Librarian

Goal: decide whether v3 needs RAG-backed knowledge/memory and a librarian role.

Tasks:

1. Design v3 knowledge semantics separately from v2.
2. Decide if skills should be searchable via RAG or continue direct `skill` loading only.
3. If adding memory, define persistence, role access, lifecycle, and operator controls.
4. If adding librarian, define role, prompt, tool surface, invocation path, and runtime/card relationship.

Exit criteria:

- Knowledge/librarian are either explicitly implemented as v3-native concepts or explicitly rejected/deferred.

## Testing Plan

### Unit Tests

- Config schema: defaults, invalid provider/store/chunker/source/watch values, provider/account references.
- Embedding cache: deterministic key, stamp sensitivity, content hash sensitivity.
- Provider: batch splitting, dimensionality validation, retry handling, fake client injection.
- Store: open, stamp persistence, drift refusal, upsert/query/delete, metadata round-trip, file state, embedding cache, corruption sentinel.
- SQL filters: `eq`, `and`, `or`, `gt`/`lt`, `pathGlob`, `in`, pre/post filter classification.
- Walker/security: hard excludes, symlink escape skip, secret path skip, secret chunk drop.
- Chunkers: markdown headings/line ranges, code chunk metadata if included, memory chunking if included.
- Manager: disabled behavior, registry, register/drop, close, stats.
- Tools: schemas, role policy, disabled service, query output truncation, admin denials.

### Integration Tests

- Register a temp doc collection with fake embeddings, ingest, query, modify file, reingest, query again.
- Drop collection and verify store removal and registry update.
- Query with filters and confirm score ordering.
- Runtime composition starts with enabled fake RAG and closes manager on shutdown.
- Content supervisor blocks a malicious retrieved chunk and tool returns `RAG_CONTENT_BLOCKED`.

### Documentation and Contract Tests

- `npm run docs:verify` after updating active docs.
- Agent tool parity tests for added RAG tools.
- Config source inventory tests after replacing `rag: unknown`.
- Operator route inventory if RAG HTTP routes are added.

### Deployment Validation

For code changes in Saivage v3:

```bash
npm run validate:routine
npm test -- --runInBand --forceExit
npm run build
```

If deployed to the Saivage v3 GetRich-v2 container, follow the Saivage development validation workflow: build on host, restart service, and probe health. Avoid printing tokens or provider config values.

## Risks and Mitigations

### Native Dependency Risk

Risk: `better-sqlite3` or `sqlite-vec` fails to install/build under Node 24 or LXC deployment.

Mitigation:

- Run dependency spike first.
- Keep dependencies minimal in wave 1.
- Verify in the deployment environment before declaring release readiness.

### Credential Namespace Risk

Risk: RAG embedding provider reads credentials differently from v3 LLM providers, causing confusion or secret leakage.

Mitigation:

- Add a v3 provider resolver.
- Never expose credentials in tool schemas.
- Redact provider errors and config read models.

### Secret Embedding Risk

Risk: RAG stores sensitive content permanently in embeddings and text chunks.

Mitigation:

- Reuse v3 secret path and scanner primitives.
- Keep v2's extra RAG blocked globs/provider patterns.
- Skip when unsure.
- Expose secret-drop counts only.
- Block `.saivage/`, `.saivage-work/`, env files, key files, auth profiles, backups, and secrets directories.

### Prompt Injection Retrieval Risk

Risk: RAG returns hostile instructions from indexed docs into model context.

Mitigation:

- Content-supervise `rag_query` output.
- Keep hit text bounded and metadata explicit.
- Prompt agents that RAG hit text is untrusted project content, not instructions.

### Background Mutation Risk

Risk: Watchers mutate indexes while agents are reasoning, producing nondeterministic retrieval.

Mitigation:

- Defer watchers.
- Use explicit ingest/reconcile first.
- Add events/status when watchers land.

### Tool-Surface Bloat Risk

Risk: RAG adds too many tools to all roles and hurts model behavior.

Mitigation:

- Add only read/query tools to planner/reviewer.
- Keep admin tools operator/executor-gated.
- Consider hiding admin tools from normal executor contexts unless cards require RAG maintenance.

### Store Drift and Corruption Risk

Risk: Provider model/dim changes silently invalidate existing vectors, or store corruption causes bad results.

Mitigation:

- Preserve provider stamps and drift refusal.
- Preserve corruption sentinel behavior.
- Fail fast when enabled datasets cannot open.

### Documentation Drift Risk

Risk: Active docs mention RAG fields/tools that source does not expose, or vice versa.

Mitigation:

- Update docs/source inventories with each phase.
- Keep RAG plan document separate from active authority until implementation lands.
- Use docs verifier and tool parity tests.

## Recommended First Wave Scope

First wave should include:

- Strict `rag` config schema.
- RAG domain modules for doc collections.
- SQLite vector store.
- OpenAI embedding provider with fake-client tests and v3 provider resolver.
- Markdown/doc chunker.
- Filesystem walker with v3 secret/containment policy.
- `rag_list`, `rag_stats`, `rag_query`, and `rag_ingest`.
- `rag_register` and `rag_drop` only for operator context, or implemented but denied to all autonomous roles until operator APIs exist.
- Runtime composition and manager disposal.
- Content-supervised query output.

First wave should not include:

- Watchers.
- Memory datasets.
- Skill semantic search.
- Librarian role.
- Tree-sitter code chunking unless dependency spike proves it is cheap and reliable.
- Migration of v2 RAG stores or config.

## Open Questions

1. Should v3 allow executor access to `rag_ingest`, or should ingestion be operator-only until RAG operator controls exist?
2. Should `rag_register(persist: true)` be available through tools at all, or should config edits remain explicit file changes plus server restart/reload?
3. Should wave 1 support `code` datasets, or only `doc` datasets to avoid tree-sitter dependency risk?
4. Should RAG tools be visible when `rag.enabled=false`, returning `RAG_DISABLED`, or should the tool catalog become runtime-config-dependent? Static visibility is simpler for v3 docs/tool parity.
5. How should RAG embedding provider references map to v3 provider/account config when providers use OAuth `authProfile` rather than API keys?
6. Should query text be logged as a hash only, or omitted entirely from events?
7. Should `rag_query` return raw hit text, excerpts with line refs, or stash large hits into a unified spill/stash mechanism once v3 has one?

## Final Recommendation

Port RAG as a v3-native built-in subsystem, not as an MCP compatibility layer. Preserve v2's proven domain internals where they are clean: provider stamps, sqlite-vec store, incremental ingest, embedding cache, secret-aware walking, and stable RAG error envelopes. Replace v2's integration shell with v3-native config validation, role policy, unified tools, content supervision, runtime lifecycle ownership, and source-verified docs/tests.

Do the port in phases. Start with dependencies and isolated domain tests, then config/manager, then ingest/query, then tools/policy, then runtime composition. Defer watcher, knowledge store, memory, and librarian until the core RAG subsystem is stable and observable.
