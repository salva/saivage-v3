# Pending-active architecture proposals (from review-2026-05-22)

These 14 proposals come from `architecture-audit/review-2026-05-22/`. Each
was accepted by the audit pack's design guidelines (no-overfeaturism,
no-backward-compatibility, JSON/JSONL coherence) but is **not yet landed in
current source**. Source-line evidence supporting "not landed" is included
per item.

Scaffolds these depend on are already in code: typed `EventBus` (`src/events/`),
`ResourceScope` (`src/lifecycle/resource-scope.ts`), JSON persistence
primitives (`src/persistence/atomic-json-file.ts`, `jsonl-ledger.ts`,
`persistent-queue.ts`, `project-lock.ts`), `ToolRuntime`
(`src/tools/runtime.ts`), composition root (`src/boot/app.ts`),
permissions matrix (`src/permissions/card-permissions.ts`), redaction port
(`src/redaction/index.ts`), environment gateway (`src/config/environment.ts`),
projections (`src/projections/`), contract runtime
(`src/server/contract-runtime.ts`).

## F06 — Event-kind drift

Derive `runtimeEventKindValues` / `agentEventKindValues` from a single
registry instead of hand-coded filters. `TRACKED_EVENT_KIND_VALUES` has
already been removed; the remaining drift is at
`src/events/registry.ts:74-75`, which still uses literal
`startsWith('session_')` / `.includes(...)` lists. Small finishing touch on
R01 (~30 lines: add a `domain: 'agent' | 'runtime'` field to each registry
entry).

## F07 — `Runtime` constructor + typed error channels

Decompose the mega-statement constructor at `src/runtime/runtime.ts:108` and
split the diagnostic `error` channel into typed channels. `Runtime` still
`extends EventEmitter` at `src/runtime/runtime.ts:97`. The
`emitRuntimeDiagnostic` half of the error-channel split is partly done
(referenced at `src/runtime/runtime.ts:715`); constructor decomposition is
the unfinished half. Blocks C02 and the F10 shrink.

## F08 — Typed tool-call message shapes

Replace ad-hoc property access in `repairOrphanActivateCardToolCalls` and
`appendChildUnwindToolResult` (`src/runtime/runtime.ts:187-300`, also
referenced at 664/703/715/744) with typed `StoredAgentMessage[]`
operations. Stored-message schema half can land independently of the MCP
JSON-RPC schema (which is blocked on F15).

## F10 — `AgentAdapter` god class

Shrink `src/agents/agent-adapter.ts` (currently 622 LOC) to a ~150 LOC
run-host. `ToolRuntime` already owns tools (wired at
`src/agents/agent-adapter.ts:168,180`); the class still owns `eventLogger`,
recovery wiring, `roundCounters`, `applySelfCheck` (L249), abort
controllers, model selection, and a residual `role as unknown as AgentRole`
cast cluster at L249, L468, L473, L490, L495, L520, L536, L569, L580.
`RUNTIME_AGENT_TOOL_REGISTRY` literal is gone. Pair with F17.

## F14 — Routes from contracts

Migrate every route to `mountContract`; no `app.<method>(...)` in handler
code. `src/server/contract-runtime.ts` exists and
`src/server/routes/operator-contracts.ts` uses it.
`src/server/routes/cards.ts` and `src/server/routes/runtime-config-notes.ts`
are in transition. Pair with R05.

## F15 — Split `src/mcp/mcp-manager.ts`

`src/mcp/mcp-manager.ts` is **1915 LOC**. Split into `errors.ts`,
`jsonrpc.ts`, `transports/{stdio,sse}.ts`, `catalog.ts`, `validators.ts`,
`lifecycle.ts`, `manager.ts`. Share a single SSE parser
(`src/streaming/sse-parser.ts`) with `src/agents/llm-client.ts` (which
currently duplicates SSE parsing). No `transports/` or `src/streaming/`
directory exists yet. **Largest single un-landed item.** Blocks F08 and
parts of C01.

## F17 — Restart / lifecycle source of truth

`src/permissions/card-permissions.ts` matrix shipped and `TOOL_TO_CARD_ACTION`
is imported by `src/agents/role-tool-policy.ts`, but the latter still
exists with its own `RoleToolPolicyRole` / `RoleToolPolicySurface` /
`RoleToolPolicyReasonCode` types and switch interpreter, imported by
`src/agents/agent-adapter.ts`. Two sources of truth coexist (collision
risk). Delete the switch interpreter and route AgentAdapter through
`ToolRuntime` + `permissions/` only.

## C01 — Cache lifetime tied to `ResourceScope`

Long-lived `Map` caches in `src/agents/agent-adapter.ts` and
`src/mcp/mcp-manager.ts` are still bare. `ResourceScope` exists. Falls out
for free once F10 and F15 are tackled.

## C02 — Mega one-liners

Enable `max-statements-per-line: 1` and rewrite offenders (canonical:
`src/runtime/runtime.ts:108` constructor body; `applySelfCheck` at
`src/agents/agent-adapter.ts:249`). No `max-statements-per-line` rule
visible. Gated on F07/F10 actually shrinking the constructors.

## C03 — JSONL ledger consolidation

Collapse 5 hand-rolled JSONL helpers into `JsonlLedger<T>` +
`PersistentQueue<T>`. Primitives exist. Hand-rolled append/read still in
`src/observability/event-logger.ts`, `src/observability/error-logger.ts`,
`src/notifications/notification-center.ts`,
`src/persistence/control-action-audit.ts`, and the analyst queue. Same
five files as R03 — treat as one workstream.

## C04 — Atomic JSON files

Replace `writeFileAtomic` callers with `AtomicJsonFile<T>` under
`ProjectLock`. Three call sites remain: `src/runtime/state.ts`,
`src/runtime/freeze-manifest.ts`, `src/cards/card-store.ts`.
`auth-profile-store.ts` already migrated. Mechanical change.

## C05 — Cast cluster cleanup

Delete residual `as unknown as` casts and add a `no-restricted-syntax`
rule. Remaining sites: 1 in `src/runtime/runtime.ts:108`; 8 in
`src/agents/agent-adapter.ts` (all `role as unknown as AgentRole`,
solvable by aligning the `AgentRole` type between `src/schemas/types.ts`
and `src/agents/`); 5 in `src/observability/event-logger.ts`; a few in
`card-store.ts` and `control-action-audit.ts`.

## C06 — `process.env` outside `boot/`

Only `boot/` should read `process.env`; rest receive a typed
`Environment` via DI. Direct reads still in `src/cli.ts` (boot-adjacent,
acceptable), `src/workspace/shell-classifier.ts`,
`src/runtime/process-runner.ts`, `src/mcp/mcp-manager.ts`,
`src/server/routes/cards.ts`, `src/agents/config-schema.ts`. Add a
`no-restricted-globals` lint rule. Migrate the five non-boot sites.

## R03 + R05 (joint) — Projections + contract runtime adoption

`src/projections/{index.ts,ledger-projections.ts}` exists and
`registerEventLogProjection` is imported by
`src/observability/event-logger.ts`, but the hand-rolled JSONL writers in
event-logger, error-logger, and `src/notifications/notification-center.ts`
are still in place — projections were added on top rather than replacing
them. Similarly `src/server/contract-runtime.ts` exists with partial route
adoption (see F14). Treat as one workstream that completes the replacement.

## Items the 2026-05-22 pack explicitly rejected

- **R02-B** — SQLite event store. Rejected in favor of JSON/JSONL coherence.
- **F16-event-sourced-cards** — Parked.

These are recorded here only so future readers know they were considered
and rejected.
