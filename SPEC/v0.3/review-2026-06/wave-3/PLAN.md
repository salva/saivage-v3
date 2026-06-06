# Wave 3: Architecture Boundaries — Implementation Plan

**Issues:** F09 (web imports server internals), F08 (dual auth system), F34 (misplaced files in contracts/)
**Principle:** Zero backward-compatibility weight. One owner per concern. Delete parallel paths.

---

## Design

### F09: Web Imports Backend Source Internals

#### Problem

`web/src/api/contracts.ts` and `web/src/api/types.ts` import directly from `../../../src/contracts/*` and `../../../src/schemas`. The web `tsconfig.json` whitelists `../src/contracts/**/*.ts` and `../src/schemas/**/*.ts` in `include`. The web build is tightly coupled to the server source tree, so any server refactor silently breaks the web build.

`types.ts` also re-exports and aliases many contract types, adding local overrides (e.g., `AgentSession`, `ConversationEntry`, `ControlActionAuditEntry`, `ActionableErrorEnvelope`, `DebugError`, `DebugTimelineEvent`, `NoteRecord`, `NoteKind`) that silently diverge from the server contract shapes.

#### Approach Analysis

**Option A — `@saivage/contracts` shared npm package:**
Requires a separate `packages/contracts` directory, its own `package.json`, `tsconfig.json`, and build pipeline. Significant infra overhead for what is in practice a single consumer (the web app). The server doesn't need this package — it already owns the source.

**Option B — Build step that copies/exports to `web/src/api/`:**
Adds a coupling-masking layer. Copies go stale, and the build step must run before `vue-tsc` or `vite build`. Obscures the real dependency.

**Option C — TypeScript path aliases (virtual shared package):**
Maps `@saivage/contracts` to `src/contracts` in the root `tsconfig.json`, and the web `tsconfig.json` maps it to `../src/contracts`. Vite resolves the alias at dev time. No new packages, no build step, no copy. The alias makes the dependency explicit and grepable. If a file moves, the alias target changes in one place. The web build stays self-contained — it just uses a different alias mapping.

#### Recommended: Option C — TypeScript path aliases

**Why:**
- Zero infra overhead. Two `paths` entries, one in each `tsconfig.json`.
- Makes the cross-boundary dependency explicit and grepable (`@saivage/contracts` vs `../../../src/contracts`).
- Vite and `vue-tsc` both resolve path aliases natively.
- The server continues importing from `./contracts/` (relative). No change to server code.
- When a shared package is genuinely needed (e.g., third-party consumers), the alias resolves to the package instead — a one-line change per `tsconfig.json`.

**Important:** This is a **web-only source-alias transitional boundary**, not a shared npm package. It does not make web independent from server source — it makes the dependency explicit and grepable. Use exact and wildcard aliases (`@saivage/contracts` and `@saivage/contracts/*`) to support subpath imports like `@saivage/schemas/event-catalog`.

#### New module structure

The root `tsconfig.json` already has `"@saivage/*": ["./src/*"]` — no changes needed to the root tsconfig.

```
web/tsconfig.json:
  paths: {
    "@saivage/contracts": ["../src/contracts"],
    "@saivage/contracts/*": ["../src/contracts/*"],
    "@saivage/schemas": ["../src/schemas"],
    "@saivage/schemas/*": ["../src/schemas/*"],
    "@/*": ["./src/*"]
  }

web/vite.config.ts:
  resolve.alias: {
    "@saivage/contracts": resolve(__dirname, "../src/contracts"),
    "@saivage/contracts/*": resolve(__dirname, "../src/contracts"),
    "@saivage/schemas": resolve(__dirname, "../src/schemas"),
    "@saivage/schemas/*": resolve(__dirname, "../src/schemas")
  }
```

#### New API surface

The `@saivage/contracts` alias exposes the same barrel that `src/contracts/index.ts` already exports. The web imports:

```ts
import { operatorApiContracts, type OperatorApiSuccess, ... } from '@saivage/contracts';
import type { CardType, CardStatus, ... } from '@saivage/schemas';
```

#### Direct type deduplication

`web/src/api/types.ts` currently re-aliases many contract types with no transformation:
- `AgentStatus = SessionStatus` → delete, use `SessionStatus` directly
- `AgentSession = AgentSessionSummary & { role; status }` → keep (adds fields)
- `ConversationEntry = AgentConversationEntry` → delete, use `AgentConversationEntry` directly
- `ActivityStatusKind = ...` → keep (adds semantic meaning)
- `McpToolInvocationStats = McpInvocationStat` → delete
- `McpStatusKind = McpStatusState` → delete
- `McpTransportKind = McpTransport` → delete
- `McpTool = McpToolDefinition` → delete
- `CardListResponse`, `CardDetailResponse`, etc. → keep (they extract from `OperatorApiSuccess<'cards.list'>` which adds semantic clarity)
- `ChatSession = ContractChatSession` → delete alias, use directly
- `ContentReview`, `QuarantineSummaryEntry`, `SupervisionStats` → **keep** — these extract from schema types and add semantic meaning, even though they are type aliases.

Types that add local fields (e.g., `NoteRecord`, `ActionableErrorEnvelope`, `DebugError`, `DebugTimelineEvent`, `DebugState`) are legitimate web-only types and stay in `types.ts`. The principle: if a type alias adds zero transformation (just renames), delete it and use the canonical name from `@saivage/contracts`. Type aliases that extract from schema types and add semantic meaning (like `ContentReview`, `QuarantineSummaryEntry`, `SupervisionStats`) should be kept.

The `debug-read-model.ts` import of `../../../src/schemas/event-catalog` becomes `@saivage/schemas/event-catalog`.

#### Migration path

1. Add aliases to web `tsconfig.json` and `web/vite.config.ts`. The root `tsconfig.json` already has `@saivage/*` wildcards and needs no changes.
2. Update all `../../../src/contracts` and `../../../src/schemas` imports in `web/` to use aliases.
3. Remove the `../src/contracts/**/*.ts` and `../src/schemas/**/*.ts` entries from web's `tsconfig.json` `include`.
4. Simplify `types.ts`: delete pure re-alias types, import canonical names directly, but keep `ContentReview`, `QuarantineSummaryEntry`, and `SupervisionStats`.
5. Keep `web/src/api/contracts.ts` as the curated web-facing barrel. Import from subpath aliases (`@saivage/contracts`, `@saivage/contracts/*`), not from the root contracts barrel. Do not delete `web/src/api/contracts.ts` in Wave 3 — alias cleanup is a separate step.

---

### F08: Dual Auth System

#### Problem

Every `/api/*` request runs auth twice:
1. `auth.ts` Fastify plugin hooks `onRoute` to inject `authenticate()` as `preHandler` on all `/api` routes (lines 47–83). This plugin also manually chains `existingPreHandler` handlers, bypassing Fastify's normal hook lifecycle and sending responses directly instead of using Fastify error lifecycle.
2. `contract-runtime.ts` `validateAuth()` runs auth again inside each contract handler (line 133–139), calling `getAuthPolicy().validateHttpRequest()`.

The Fastify plugin preHandler runs first. When it rejects, it sends a response directly and returns — so `ContractRuntime.validateAuth()` never runs. When the preHandler passes, `ContractRuntime.validateAuth()` runs and does the exact same `getAuthPolicy().validateHttpRequest()` call again. The result is: two auth checks on every protected route, and the plugin preHandler's manual chaining bypasses Fastify's hook system.

#### Design: Make ContractRuntime the single auth authority

**Delete `auth.ts`** entirely. Remove the plugin registration from `fastify-app.ts`.

Move the two concerns that `auth.ts` currently owned:
1. **Auth enforcement** → already handled by `ContractRuntime.validateAuth()` using contract declarations. Public routes get `auth: 'public'` in their contract definition and skip auth. Protected routes get `auth: 'operator-session'` and run auth once.
2. **WebSocket ticket route** `/api/auth/ws-ticket` → This is currently registered via `registerAuthRoutes()` in `/routes/auth.ts`. It calls `getAuthPolicy().issueWebSocketTicket()` directly. Currently this route would also be covered by the auth plugin (it's an `/api` route), which means you'd need auth to get a ticket — that's wrong. The route registration already bypasses auth via the plugin's exclude list, but with the plugin removed, we need to ensure this route has explicit auth in its contract definition.

**WebSocket auth** in `websocket.ts` calls `getAuthPolicy().validateWebSocketRequest()` — this is unaffected because it's a different code path (not HTTP routes).

**Auth route (`/api/auth/ws-ticket`)**: Add it as a contract route with `auth: 'operator-session'` in the operator API contracts. This keeps all auth in one place. The contract schema should align with the existing `IssuedWebSocketTicket` type from `auth-policy.ts`.

#### Changes to `contract-runtime.ts`

Make auth explicit on `OperatorRouteContract`:
- **Remove `requiresAuth`** from the `OperatorRouteContract` type definition — it is a duplicate of `auth`.
- **Remove `requiresAuth`** from `operatorSessionContract` and `publicContract` constants.
- **Update `operatorRouteInventory()`** to derive `requiresAuth` from `contract.auth !== 'public'` instead of reading the field.
- **Remove `authClassFor()` fallback** — auth is now explicit on every contract. If a contract lacks `auth`, the system should fail loudly rather than falling back.

#### New module structure

```
src/server/
  auth.ts                 ← DELETE (entire file)
  auth-policy.ts          ← KEEP (single auth policy authority)
  contract-runtime.ts     ← KEEP (single route auth authority)
  routes/auth.ts          ← DELETE (replaced by contract route in Step 5)
  contracts/operator-api-auth.ts ← ADD (ws-ticket contract definition)
  routes/operator-contracts.ts    ← ADD ws-ticket handler
```

#### Migration path

1. Add `/api/auth/ws-ticket` as a contract route with `auth: 'operator-session'`, schema aligned with `IssuedWebSocketTicket` from `auth-policy.ts`. Handler receives `ContractRequestContext` (`{ request, reply }`), calls `getAuthPolicy().issueWebSocketTicket()`.
2. Verify all existing contract definitions set `auth` explicitly. Remove `requiresAuth` from `OperatorRouteContract` type, from `operatorSessionContract` and `publicContract` constants, and update `operatorRouteInventory()` to derive `requiresAuth` from `contract.auth !== 'public'`. Remove `authClassFor()` fallback.
3. Delete `src/server/auth.ts` and remove plugin import from `fastify-app.ts`. Delete `src/server/routes/auth.ts` and remove `registerAuthRoutes` from Fastify composition.
4. Update 7 test files that import `authPlugin` (`tests/analyst.test.ts`, `tests/e2e/hardening-e2e.test.ts`, `tests/integration/cards-shuffled-subtree.test.ts`, `tests/api/cards-history.test.ts`, `tests/server/generated-file-inspection.test.ts`, `tests/server/agents-detail-route.test.ts`, `tests/server/agents-llm-exchange-route.test.ts`) to use `ContractRuntime.validateAuth()` or `configureAuthPolicy()`.
5. Verify auth works for: public routes (health), protected API routes, ws-ticket route.

---

### F34: Misplaced Files in contracts/

#### Problem

Files in `src/contracts/` that are not API/envelope/cross-boundary contracts:

| File | Current location | Misplaced because |
|------|-----------------|-------------------|
| `session-stamper.ts` | `src/contracts/` | Mutable runtime state (`SessionStampCounter` with `Map<string, SessionRoundState>`). Not a contract. |
| `candidate-availability.ts` | `src/contracts/` | In-memory availability with persistence hooks. Runtime provider routing concern. |
| `provider-candidate.ts` | `src/contracts/` | Provider routing data (`Candidate` interface, `candidateKey()`) — agent/provider domain. |
| `system-prompt.ts` | `src/contracts/` | 200 lines of prompt string templates. Agent behavior concern. |
| `llm-failure.ts` | `src/contracts/` | Error taxonomy — cross-boundary, but already has an identical copy at `src/agents/llm-failure.ts`. The `contracts/` copy is the canonical one for the error type used in both contract verification and agent code. |
| `persisted-tool-call.ts` | `src/contracts/` | Wire-format parsing for tool calls — cross-boundary contract type, legitimately belongs here. |

#### Note: The duplication problem for `llm-failure.ts` and `candidate-availability.ts`

There are ALREADY duplicate files:
- `src/contracts/llm-failure.ts` and `src/agents/llm-failure.ts` are independent files with identical content (same `LlmTransportFailure` type and `LlmRequestError` class). `src/agents/llm-failure.ts` was created as a copy. The `agents/` copy is the one used by agent code, and the `contracts/` copy is used by `contracts/verify-against-terminals.ts` and `runtime/phases/planner-invocation-failure.ts`.
- `src/contracts/candidate-availability.ts` and `src/agents/candidate-availability.ts` are similarly duplicated. The `agents/` version imports from `./provider.js` (a local alias), while the `contracts/` version imports from `./provider-candidate.js`.

The `agents/candidate-availability.ts` is the one actually imported by agent code. The `contracts/` copy exists to re-export through `contracts/index.ts`.

Strategy: For `llm-failure.ts`, keep the canonical location in contracts (it is a cross-boundary error type) and delete the agents copy. For `candidate-availability.ts` and `provider-candidate.ts`, **do not delete** them until runtime boundary ownership is redesigned — move only mutable implementations out and keep interface/types in contracts.

#### Exact file moves

| What | From | To | Action |
|------|------|----|--------|
| Session stamper | `src/contracts/session-stamper.ts` | `src/runtime/session-stamper.ts` | Move whole file. Split mutable `SessionStampCounter` out to runtime and keep pure ports/types in a neutral module as a **follow-up**. |
| Candidate availability (mutable impl) | `src/contracts/candidate-availability.ts` | Keep `CandidateAvailability` interface and types in `src/contracts/`; move `MemoryCandidateAvailability` to `src/agents/candidate-availability.ts` (merge with existing) | Extract mutable implementation only. Do not delete the contracts file. |
| Provider candidate | `src/contracts/provider-candidate.ts` | Keep in `src/contracts/` | **Deferred** until runtime boundary ownership is redesigned. |
| System prompt | `src/contracts/system-prompt.ts` | `src/agents/prompts/system-prompt.ts` | Move implementation. Keep `src/agents/system-prompt.ts` as public barrel (re-exports from `./prompts/system-prompt.js`). Two consumers: `agent-adapter.ts` and `execution-api.ts` both import via the barrel. |
| LLM failure (agents copy) | `src/agents/llm-failure.ts` | DELETE | Canonical copy stays in `src/contracts/`. Update agent imports to `../contracts/llm-failure.js`. |
| Persisted tool call | `src/contracts/persisted-tool-call.ts` | **KEEP** in `contracts/` | Wire format definition — cross-boundary contract. Legitimate. |

**For `system-prompt.ts`**: `src/agents/system-prompt.ts` is a re-export barrel that re-exports from `../contracts/system-prompt.ts`. After moving the implementation to `src/agents/prompts/system-prompt.ts`, update the barrel to re-export from `./prompts/system-prompt.js`. Two server-side consumers import via this barrel: `src/agents/agent-adapter.ts` and `src/agents/execution-api.ts` (which re-exports `buildExecutorPrompt`, `buildPlannerPrompt`, `buildReviewerPrompt`). After the move, both consumers continue importing via the barrel — no import changes needed for them. Three prompt `.md` docs under `src/prompts/` reference the old path and also need updating.

Direct consumers that bypass the barrel:
- `src/runtime/phases/planner-phase-runner.ts` imports from `../../contracts/system-prompt.js`
- `src/runtime/phases/executor-phase-runner.ts` imports from `../../contracts/system-prompt.js`
- `src/runtime/phases/reviewer-phase-runner.ts` imports from `../../contracts/system-prompt.js`

These need to update their imports to `../../agents/prompts/system-prompt.js` (or via the barrel `../../agents/system-prompt.js`).

**For `session-stamper.ts`**: All consumers are in `src/runtime/` (17 files) plus `src/agents/analyst-handler.ts` and `src/agents/fake-agent.ts`. Move to `src/runtime/session-stamper.ts`. The test file `tests/runtime/active-runtime-round-id.test.ts` imports `SessionStampCounter` from `../../src/contracts/session-stamper.js` and needs its import updated to `../../src/runtime/session-stamper.js`. Do not add runtime root-barrel exports for the moved file.

#### `contracts/index.ts` cleanup

After removing the misplaced files, update `contracts/index.ts` to:
1. Remove re-exports of `session-stamper` types (they move to `runtime/`).
2. Keep re-exports of `candidate-availability` types — `CandidateAvailability` interface and related types remain in contracts. `MemoryCandidateAvailability` moves to `agents/`; update the barrel export to re-export from the new location or remove it if no external consumer needs it.
3. Keep re-exports of `provider-candidate` types — file stays in contracts for now.
4. `systemPromptBuilder` and `buildPlannerPrompt`/`buildExecutorPrompt`/`buildReviewerPrompt` are **not** currently in the `contracts/index.ts` barrel — no cleanup needed for these.
5. Keep `llm-failure` types — canonical location stays in `contracts/`.
6. Keep `persisted-tool-call` — it stays in contracts.

---

## Step-by-step Implementation Sequence

Each step is a minimal, compilable commit.

### Step 1: Add path aliases for `@saivage/contracts` and `@saivage/schemas` (F09 foundation)

**Files changed:** `web/tsconfig.json`, `web/vite.config.ts`

The root `tsconfig.json` already has `"@saivage/*": ["./src/*"]` — no changes needed there. Only web `tsconfig.json` and `web/vite.config.ts` need new alias entries.

- Add `paths` entries in `web/tsconfig.json`: both exact and wildcard aliases:
  ```json
  "@saivage/contracts": ["../src/contracts"],
  "@saivage/contracts/*": ["../src/contracts/*"],
  "@saivage/schemas": ["../src/schemas"],
  "@saivage/schemas/*": ["../src/schemas/*"]
  ```
  Subpath imports like `@saivage/schemas/event-catalog` require the wildcard pattern to resolve.
- Add `resolve.alias` in `web/vite.config.ts` for `@saivage/contracts` → `resolve(__dirname, '../src/contracts')` and `@saivage/schemas` → `resolve(__dirname, '../src/schemas')`.
- Validate: `npm run typecheck` passes, `cd web && npm run typecheck` passes, `npm run build` passes.

### Step 2: Replace all `../../../src/contracts` imports in web (F09)

**Files changed:** `web/src/api/contracts.ts`, `web/src/api/types.ts`, `web/src/stores/debug-read-model.ts`, and any other web files with direct server imports.

- Replace all `from '../../../src/contracts/*'` → `from '@saivage/contracts/*'` or `from '@saivage/contracts'`.
- Replace all `from '../../../src/schemas'` and `from '../../../src/schemas/event-catalog'` → `from '@saivage/schemas'` and `from '@saivage/schemas/event-catalog'`.
- Remove `../src/contracts/**/*.ts` and `../src/schemas/**/*.ts` from `web/tsconfig.json` `include`.
- Validate: `cd web && npm run typecheck && npm run build`.

### Step 3: Simplify `types.ts` — delete pure re-aliases (F09)

**Files changed:** `web/src/api/types.ts`, and any web stores that reference the deleted alias names.

- Delete type aliases that add no transformation: `AgentStatus`, `ConversationEntry`, `PendingCall`, `McpToolInvocationStats`, `McpStatusKind`, `McpTransportKind`, `McpTool`, `ChatSession` alias, `CardUrgency` alias, `CardCreator` alias, `DiaryEntryKind`, etc.
- Replace usages with the canonical names imported from `@saivage/contracts`.
- **Keep** `ContentReview`, `QuarantineSummaryEntry`, and `SupervisionStats` — these extract from schema types and add semantic meaning. Do not delete them.
- Keep types that add fields (e.g., `NoteRecord`, `AgentSession`, `ActionableErrorEnvelope`, `DebugError`, `DebugTimelineEvent`, `DebugState`, `RuntimeSummary`, `RuntimeCommandErrorResponse`, `CardRecord`, `CardDiffRow`, `DetailErrorState`, `DetailFreshnessState`, `FreshnessState`, `WsConnectionState`, `DataAuthority`, `FileEntry`).
- Validate: `cd web && npm run typecheck && npm run build`.

### Step 4: Simplify `contracts.ts` barrel — path changes only (F09 cleanup)

**Files changed:** `web/src/api/contracts.ts`, any web files that import from `./contracts` or `../api/contracts`.

Update `web/src/api/contracts.ts` to import from `@saivage/contracts` and `@saivage/contracts/*` subpath aliases instead of `../../../src/contracts`. Keep the file as the curated web-facing barrel — do not delete it in Wave 3. Alias cleanup is a separate follow-up step.

- Validate: `cd web && npm run typecheck && npm run build && npm run test`.

### Step 5: Add ws-ticket contract route (F08 prerequisite)

**Files changed:** New `src/contracts/operator-api-auth.ts`, `src/server/routes/auth.ts` (convert to contract handler), `src/contracts/operator-api.ts` (register the new contract).

- Create `operator-api-auth.ts` contract defining `POST /api/auth/ws-ticket` with `auth: 'operator-session'`, success schema aligned with the existing `IssuedWebSocketTicket` type from `auth-policy.ts`, no body schema.
- In `routes/auth.ts`, convert the standalone Fastify route to a contract handler. The handler receives `ContractRequestContext` (`{ request, reply }`), not `(FastifyRequest, FastifyReply)`. It calls `getAuthPolicy().issueWebSocketTicket()`.
- Register the handler in `operator-contracts.ts`.
- Validate: `npm run typecheck`, `npm test`. Manually verify that `POST /api/auth/ws-ticket` with a valid Bearer token returns a ticket, and without a token returns 401.

### Step 6: Make auth explicit on `OperatorRouteContract` — remove `requiresAuth` field (F08 prerequisite)

**Files changed:** `src/contracts/operator-api-core.ts`, individual `operator-api-*.ts` files, `src/server/contract-runtime.ts`.

- Audit all contract definitions in `operator-api.ts` and `operator-api-*.ts` files to ensure every contract has an explicit `auth` field (not relying on `requiresAuth` fallback).
- If any route needs to be public, set `auth: 'public'` explicitly.
- **Remove `requiresAuth`** from the `OperatorRouteContract` type definition.
- **Remove `requiresAuth`** from `operatorSessionContract` and `publicContract` constants.
- **Update `operatorRouteInventory()`** to derive `requiresAuth` from `contract.auth !== 'public'` instead of reading the field.
- **Remove `authClassFor()` fallback** — auth is now explicit on every contract.
- Validate: `npm run typecheck`, `npm test`.

### Step 7: Remove `auth.ts` plugin and standalone auth route (F08)

**Files changed:** `src/server/auth.ts` (DELETE), `src/server/routes/auth.ts` (DELETE), `src/server/composition/fastify-app.ts` (remove plugin registration and `registerAuthRoutes`), and 7 test files.

- Delete `src/server/auth.ts` entirely.
- Delete `src/server/routes/auth.ts` (replaced by the contract route in Step 5).
- Remove `import authPlugin from '../auth.js'` and `await fastify.register(authPlugin)` from `fastify-app.ts`.
- Remove `registerAuthRoutes` from Fastify composition.
- Update 7 test files that import `authPlugin` to use `ContractRuntime.validateAuth()` or `configureAuthPolicy()`:
  - `tests/analyst.test.ts`
  - `tests/e2e/hardening-e2e.test.ts`
  - `tests/integration/cards-shuffled-subtree.test.ts`
  - `tests/api/cards-history.test.ts`
  - `tests/server/generated-file-inspection.test.ts`
  - `tests/server/agents-detail-route.test.ts`
  - `tests/server/agents-llm-exchange-route.test.ts`
- Remove the `authenticate` export if anything else imports it (should be none since `contract-runtime.ts` calls `getAuthPolicy()` directly).
- Validate: `npm run typecheck`, `npm test`. Manually verify:
  - `/health` returns 200 without auth.
  - `/api/auth/ws-ticket` without Bearer token returns 401.
  - `/api/auth/ws-ticket` with valid Bearer token returns a ticket.
  - Any `/api/*` route without auth returns 401.
  - Any `/api/*` route with valid auth returns data.

### Step 8: Move `session-stamper.ts` to `src/runtime/` (F34)

**Files changed:** Move `src/contracts/session-stamper.ts` → `src/runtime/session-stamper.ts`, update all ~17 consumer imports, update `src/contracts/index.ts`.

- Move the whole file. Split of mutable `SessionStampCounter` (to runtime) from pure ports/types (to a neutral module) is deferred as a follow-up.
- Update every consumer import path from `../contracts/session-stamper.js` or `../../contracts/session-stamper.js` to the new relative path.
- Update `tests/runtime/active-runtime-round-id.test.ts` import from `../../src/contracts/session-stamper.js` to `../../src/runtime/session-stamper.js`.
- Remove `SessionStampCounter`, `ActivityStatus`, `PendingCall`, `RoundStamp`, `SessionStamper`, `SessionActivity`, `SessionRoundState`, `RuntimeAppendRecorder` re-exports from `src/contracts/index.ts`.
- Do not add runtime root-barrel exports for the moved file. Let consumers import directly.
- Validate: `npm run typecheck`, `npm test`.

### Step 9: Extract mutable implementation from `candidate-availability.ts` (F34 — partial)

**Files changed:** `src/contracts/candidate-availability.ts`, `src/agents/candidate-availability.ts`, `src/contracts/index.ts`.

- Move `MemoryCandidateAvailability` (the mutable class) out of `src/contracts/candidate-availability.ts`. Merge into or co-locate with `src/agents/candidate-availability.ts`.
- Keep the `CandidateAvailability` interface and related pure types in `src/contracts/candidate-availability.ts`.
- Leave `src/contracts/provider-candidate.ts` in place — full move is deferred until runtime boundary ownership is redesigned.
- Leave `candidateKey`, `parseCandidateKey`, `Candidate`, `MemoryCandidateAvailability` barrel exports in `src/contracts/index.ts` for now. If `MemoryCandidateAvailability` moves to `src/agents/`, update the barrel to re-export from the new location or remove if no external consumer needs it.
- Verify no consumer imports `MemoryCandidateAvailability` directly from `contracts/` path — update any that do to import from `agents/` or the barrel.
- Validate: `npm run typecheck`, `npm test`.

### Step 10: Move `system-prompt.ts` to `src/agents/prompts/` (F34)

**Files changed:** Move `src/contracts/system-prompt.ts` → `src/agents/prompts/system-prompt.ts`, update `src/agents/system-prompt.ts` barrel, update runtime phase runner imports, update 3 prompt `.md` docs.

- Create `src/agents/prompts/` directory.
- Move `src/contracts/system-prompt.ts` → `src/agents/prompts/system-prompt.ts`.
- Update `src/agents/system-prompt.ts` (the re-export barrel) to point to `./prompts/system-prompt.js`. Keep the barrel — two consumers (`src/agents/agent-adapter.ts` and `src/agents/execution-api.ts`) import via it and do not need import changes.
- Update `src/runtime/phases/planner-phase-runner.ts`, `executor-phase-runner.ts`, `reviewer-phase-runner.ts` to import from `../../agents/prompts/system-prompt.js` (they currently import directly from `../../contracts/system-prompt.js`).
- Update 3 prompt `.md` docs under `src/prompts/` that reference the old path.
- `systemPromptBuilder` and `buildPlannerPrompt`/`buildExecutorPrompt`/`buildReviewerPrompt` are **not** in `src/contracts/index.ts` barrel — skip barrel cleanup for these.
- Validate: `npm run typecheck`, `npm test`.

### Step 11: Delete `src/agents/llm-failure.ts` (the duplicate), not the contracts copy (F34)

**Files changed:** Delete `src/agents/llm-failure.ts`, update `src/agents/llm-errors.ts`, update `src/agents/llm-failure-classifiers.ts`, update other `src/agents/` imports.

- Delete `src/agents/llm-failure.ts`.
- Update `src/agents/llm-errors.ts` to re-export from `../contracts/llm-failure.js`.
- Update `src/agents/llm-failure-classifiers.ts` to import from `../contracts/llm-failure.js`.
- Update all other `src/agents/` imports from `./llm-failure.js` to `../contracts/llm-failure.js` (agent-adapter, invocation-recovery-policy, invocation-outcome).
- Update test imports similarly.
- Validate: `npm run typecheck`, `npm test`.

### Step 12: Clean up `contracts/index.ts` — remove stale re-exports (F34 final)

**Files changed:** `src/contracts/index.ts`.

- After steps 8–11, remove `session-stamper` re-exports (moved to `runtime/`).
- Keep `candidate-availability` re-exports — `CandidateAvailability` interface and types remain in contracts. `MemoryCandidateAvailability` barrel export may need updating or removal if it moved to `agents/`.
- Keep `provider-candidate` re-exports — file stays in contracts for now (deferred until runtime boundary ownership is redesigned).
- `systemPromptBuilder`/`buildPlannerPrompt`/`buildExecutorPrompt`/`buildReviewerPrompt` are **not** in the barrel — skip cleanup.
- Keep `llm-failure` types — canonical location stays in `contracts/`.
- Keep `persisted-tool-call` — stays in contracts.
- Verify no consumer breaks from removed re-exports by grepping for `from './contracts'` or `from '../contracts'` imports that reference removed symbols.
- Validate: `npm run typecheck`, `npm test`.

---

## Validation

### Per-step validation

| Step | Validation |
|------|------------|
| 1 | `cd web && npm run typecheck && npm run build` (root tsconfig unchanged) |
| 2 | `cd web && npm run typecheck && npm run build` |
| 3 | `cd web && npm run typecheck && npm run build && npm run test` |
| 4 | `cd web && npm run typecheck && npm run build && npm run test` |
| 5 | `npm run typecheck`, `npm test`, manual: `curl -X POST http://localhost:8080/api/auth/ws-ticket` → 401; with token → 200 + ticket |
| 6 | `npm run typecheck`, `npm test` |
| 7 | `npm run typecheck`, `npm test`, manual: `/health` → 200, `/api/*` without auth → 401, `/api/*` with auth → data |
| 8 | `npm run typecheck`, `npm test` |
| 9 | `npm run typecheck`, `npm test` |
| 10 | `npm run typecheck`, `npm test` |
| 11 | `npm run typecheck`, `npm test` |
| 12 | `npm run typecheck`, `npm test` |

### Full wave validation

```bash
npm run validate:routine
npm test
npm run validate:ui-smoke
```

**Manual checks:**

1. **No `../../../src/` imports in web/**:
   ```bash
   grep -r "../../../src/" web/src/ | grep -v node_modules
   ```
   Should return zero results.

2. **Auth works**: Start server with `SAIVAGE_API_TOKEN=test`:
   ```bash
   curl -s http://localhost:8080/health                    # 200
   curl -s http://localhost:8080/api/runtime/status        # 401
   curl -s -H "Authorization: Bearer test" http://localhost:8080/api/runtime/status  # 200
   curl -s -X POST -H "Authorization: Bearer test" http://localhost:8080/api/auth/ws-ticket  # 200 + ticket
   ```

3. **No file in `contracts/` is misplaced**: Every remaining file in `src/contracts/` is either an API contract, envelope schema, contract verification helper, or a cross-boundary type definition legitimately needed by both server and web. `candidate-availability.ts` and `provider-candidate.ts` remain for now with only mutable implementations extracted.

4. **Web builds independently**: `cd web && npm run build` succeeds without referencing `../src/` paths (only through `@saivage/contracts` and `@saivage/schemas` aliases).

5. **`src/server/auth.ts` and `src/server/routes/auth.ts` do not exist**: Both deleted.

6. **7 test files updated**: None of the test files listed in Step 7 still reference `authPlugin` or `../../src/server/auth.js`.