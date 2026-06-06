# Wave 3: Architecture Boundaries — Implementation Plan

## Second Review Corrections

This section supersedes both the Reviewed Corrections and any conflicting text below.

1. **CRITICAL — Do NOT delete `candidate-availability.ts`/`provider-candidate.ts`**: Reviewed Correction #13 says "Do not delete until runtime boundary ownership is redesigned. Move mutable implementations only with a neutral provider-routing module." Step 9 must be revised: move `MemoryCandidateAvailability` out but keep the `CandidateAvailability` interface and types in `contracts/`.
2. **HIGH — 7 test files import `authPlugin` and must be updated**: When deleting `src/server/auth.ts`, update: `tests/analyst.test.ts`, `tests/e2e/hardening-e2e.test.ts`, `tests/integration/cards-shuffled-subtree.test.ts`, `tests/api/cards-history.test.ts`, `tests/server/generated-file-inspection.test.ts`, `tests/server/agents-detail-route.test.ts`, `tests/server/agents-llm-exchange-route.test.ts`. Each uses `const { default: authPlugin } = await import('../../src/server/auth.js'); await app.register(authPlugin);`. After deletion, rely on `ContractRuntime.validateAuth()` or `configureAuthPolicy()`.
3. **HIGH — `execution-api.ts` is second consumer of `system-prompt.ts`**: Step 10 lists "1 consumer (`agent-adapter.ts`)" but `src/agents/execution-api.ts` also re-exports `buildExecutorPrompt`, `buildPlannerPrompt`, `buildReviewerPrompt` from `./system-prompt.js`. Both must update imports. Three prompt `.md` docs under `src/prompts/` reference the old path.
4. **HIGH — Web tsconfig needs BOTH exact and wildcard aliases**: Reviewed Correction #2. Step 1 web tsconfig must include: `"@saivage/contracts": ["../src/contracts"], "@saivage/contracts/*": ["../src/contracts/*"], "@saivage/schemas": ["../src/schemas"], "@saivage/schemas/*": ["../src/schemas/*"]`. Subpath imports like `@saivage/schemas/event-catalog` require the wildcard pattern to resolve.
5. **HIGH — Root `tsconfig.json` already has `@saivage/*` wildcard**: The root tsconfig already has `"@saivage/*": ["./src/*"]`. Step 1 does NOT need to modify root tsconfig. Only web `tsconfig.json` AND `vite.config.ts` need new alias entries.
6. **HIGH — `requiresAuth` is required field on `OperatorRouteContract`, not just a fallback**: Step 6 says "remove `requiresAuth` fallback in `authClassFor()`" but `requiresAuth: boolean` is a required field on the `OperatorRouteContract` type (operator-api-core.ts:52). Removing it requires: (a) remove `requiresAuth` from `OperatorRouteContract` type, (b) remove from `operatorSessionContract` and `publicContract`, (c) update `operatorRouteInventory()` to derive `requiresAuth` from `contract.auth !== 'public'`.
7. **MEDIUM — `systemPromptBuilder`/build functions NOT in `contracts/index.ts` barrel**: Steps 10 and 12 say to remove these from the barrel. They are not currently in it. `contracts/index.ts` does not re-export anything from `system-prompt.js`. Only `agents/system-prompt.ts` re-exports from `contracts/system-prompt.js`. Skip barrel cleanup for these.
8. **MEDIUM — Session-stamper split not implemented as designed**: Reviewed Correction #11 says "Split `session-stamper.ts`: move mutable `SessionStampCounter` to runtime; keep pure ports/types in a neutral public port module." Step 8 moves the whole file. Either split now per correction (mutable → runtime, types → neutral port) or defer the split and move whole file, noting the split as follow-up.
9. **MEDIUM — Test file importing `SessionStampCounter` from contracts**: `tests/runtime/active-runtime-round-id.test.ts` imports `SessionStampCounter` from `../../src/contracts/session-stamper.js`. After moving, update this import to `../../src/runtime/session-stamper.js`.
10. **MEDIUM — Three type aliases should be kept, not deleted**: `ContentReview`, `QuarantineSummaryEntry`, and `SupervisionStats` extract from schema types (`SupervisionResponse['reviews'][number]` etc.) and add semantic meaning. Keep them in `types.ts`.
11. **MEDIUM — Handler shape change in Step 5**: Converting `routes/auth.ts` handler from `(FastifyRequest, FastifyReply)` to contract handler. Contract handler uses `ContractRequestContext` ({ request, reply }). The handler doesn't need request data since `issueWebSocketTicket()` takes no arguments.
12. **MEDIUM — `contracts/index.ts` re-exports from `candidate-availability.ts`/`provider-candidate.ts`**: `candidateKey`, `parseCandidateKey`, `Candidate`, `MemoryCandidateAvailability`, etc. If Step 9 is deferred (per correction #1), leave these barrel exports in place.
13. **MEDIUM — Validation path has dot instead of slash**: Plan says `/api/runtime.status` but actual route is `/api/runtime/status`.
14. **LOW — F34 file-move table typo `system-pampt.ts`**: Should be `system-prompt.ts`. Already corrected in Reviewed Correction #15 but body table may still have the typo.
15. **LOW — `IssuedWebSocketTicket` type exists in `auth-policy.ts`**: The ws-ticket contract schema should align with this existing type rather than creating a standalone Zod schema.

## Reviewed Corrections

This section supersedes any conflicting text below.

1. The alias approach is not a shared npm package. Describe it as a web-only source-alias transitional boundary; it does not make web independent from server source.
2. Use exact and wildcard aliases for `@saivage/contracts`, `@saivage/contracts/*`, `@saivage/schemas`, and `@saivage/schemas/*`.
3. Keep `web/src/api/contracts.ts` as the curated web-facing barrel. Import from subpath aliases, not the root contracts barrel.
4. Do not delete `web/src/api/contracts.ts` in Wave 3. First change paths only; alias cleanup is separate.
5. `/api/auth/ws-ticket` becomes a protected operator contract route with `auth: 'operator-session'` and issues tickets through `getAuthPolicy().issueWebSocketTicket()`.
6. Add `src/contracts/operator-api-auth.ts`, spread it into `operatorApiContracts`, and add a handler in `operator-contracts.ts`. Add a test proving inventory and mounting.
7. Delete `src/server/routes/auth.ts` after the contract route is mounted. Remove `registerAuthRoutes` from Fastify composition.
8. Make auth explicit on `OperatorRouteContract`; remove duplicate `requiresAuth`; derive inventory `requiresAuth` from `auth !== 'public'`; remove `authClassFor()` fallback.
9. Update tests importing/registering `auth.ts` before deleting it.
10. Manual auth validation endpoint is `/api/runtime/status`.
11. Split `session-stamper.ts`: move mutable `SessionStampCounter` to runtime; keep pure ports/types in a neutral public port module.
12. Do not add runtime root-barrel exports for moved files.
13. Do not delete `contracts/candidate-availability.ts`/`provider-candidate.ts` until runtime boundary ownership is redesigned. Move mutable implementations only with a neutral provider-routing module.
14. Move prompt implementation under `src/agents/prompts/`, but keep `src/agents/system-prompt.ts` as public barrel unless boundary rules change.
15. Correct typo: `system-prompt.ts`, not `system-pampt.ts`.
16. Clean only actual `contracts/index.ts` exports. Keep `llm-failure.ts` canonical in contracts and delete agent-local duplicate only after imports update.
17. Sequence: aliases, ws-ticket contract route, remove auth plugin/standalone route, then one file-move concern at a time.

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
Maps `@saivage/contracts` to `src/contracts` in the root `tsconfig.json`, and the web `tsconfig.json` maps it to `../src/contracts`. Vite resolves the alias at dev time. No new packages, no build step, no copy. The alias makes the dependency explicit andgrepable. If a file moves, the alias target changes in one place. The web build stays self-contained — it just uses a different alias mapping.

#### Recommended: Option C — TypeScript path aliases

**Why:**
- Zero infra overhead. Two `paths` entries, one in each `tsconfig.json`.
- Makes the cross-boundary dependency explicit and grepable (`@saivage/contracts` vs `../../../src/contracts`).
- Vite and `vue-tsc` both resolve path aliases natively.
- The server continues importing from `./contracts/` (relative). No change to server code.
- When a shared package is genuinely needed (e.g., third-party consumers), the alias resolves to the package instead — a one-line change per `tsconfig.json`.

#### New module structure

```
Root tsconfig.json:
  paths: { "@saivage/contracts/*": ["./src/contracts/*"], "@saivage/schemas": ["./src/schemas"] }

web/tsconfig.json:
  paths: { "@saivage/contracts/*": ["../src/contracts/*"], "@saivage/schemas": ["../src/schemas"], "@/*": ["./src/*"] }

web/vite.config.ts:
  resolve.alias: { "@saivage/contracts": resolve(__dirname, "../src/contracts"), "@saivage/schemas": resolve(__dirname, "../src/schemas") }
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

Types that add local fields (e.g., `NoteRecord`, `ActionableErrorEnvelope`, `DebugError`, `DebugTimelineEvent`, `DebugState`) are legitimate web-only types and stay in `types.ts`. The principle: if a type alias adds zero transformation (just renames), delete it and use the canonical name from `@saivage/contracts`.

The `debug-read-model.ts` import of `../../../src/schemas/event-catalog` becomes `@saivage/schemas/event-catalog`.

#### Migration path

1. Add aliases to both tsconfigs and `vite.config.ts`.
2. Update all `../../../src/contracts` and `../../../src/schemas` imports in `web/` to use aliases.
3. Remove the `../src/contracts/**/*.ts` and `../src/schemas/**/*.ts` entries from web's `tsconfig.json` `include`.
4. Simplify `types.ts`: delete pure re-alias types, import canonical names directly.
5. Simplify `contracts.ts`: if it becomes a straight pass-through barrel from `@saivage/contracts`, replace direct consumers' imports to `@saivage/contracts` and delete `contracts.ts` entirely. If some web-specific re-exports remain, keep it as a thin local barrel.

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
1. **Auth enforcement** → already handled by `ContractRuntime.validateAuth()` using `authClassFor(contract)`. Public routes get `auth: 'public'` in their contract definition and skip auth. Protected routes get `auth: 'operator-session'` and run auth once.
2. **WebSocket ticket route** `/api/auth/ws-ticket` → This is already registered via `registerAuthRoutes()` in `/routes/auth.ts`. It calls `getAuthPolicy().issueWebSocketTicket()` directly. Currently this route would also be covered by the auth plugin (it's an `/api` route), which means you'd need auth to get a ticket — that's wrong. The route registration already bypasses auth via the plugin's exclude list, but with the plugin removed, we need to ensure this route has `auth: 'public'` in its contract or is registered outside the contract system.

**WebSocket auth** in `websocket.ts` calls `getAuthPolicy().validateWebSocketRequest()` — this is unaffected because it's a different code path (not HTTP routes).

**Auth route (`/api/auth/ws-ticket`)**: This is currently registered as a plain Fastify route, not through `ContractRuntime`. Two options:
- (a) Add it as a contract route with `auth: 'public'` in the operator API contracts.
- (b) Keep it as a standalone route, and simply register it directly on the Fastify instance (which is what already happens — `registerAuthRoutes(fastify)` is a standalone registration). With the plugin removed, this route has no auth gate, which is correct (you don't need to be authenticated to get a ticket — but you do need a Bearer token, because the ticket endpoint requires one to issue a ticket).

Wait — re-reading `routes/auth.ts`: it calls `getAuthPolicy().issueWebSocketTicket()`, but does not validate the request first. The auth plugin was the one enforcing auth on `/api` routes, which would have also covered this route. Looking at `auth.ts`, the plugin has `excludeRoutes` defaulting to `['/health', '/health/ready']`, so `/api/auth/ws-ticket` was NOT excluded — meaning the auth plugin was enforcing Bearer auth on the ws-ticket route.

So the ws-ticket route needs auth. Option (a) is better: add it to the contract system with `auth: 'operator-session'`. This keeps all auth in one place.

Implementation: Create a small `operator-api-auth.ts` contract file (or add the ws-ticket op to an existing contract file), and add a contract handler that issues tickets. Wire it into `operator-contracts.ts`. Then delete `auth.ts` and the plugin registration.

#### Changes to `contract-runtime.ts`

No changes needed to the auth logic in `ContractRuntime.validateAuth()` — it already correctly:
- Checks `authClassFor(contract)` → defaults to `'operator-session'` for routes without explicit `auth`.
- Skips auth for `auth === 'public'`.
- Calls `getAuthPolicy().validateHttpRequest()` once.

The only addition: currently contracts without an explicit `auth` field use the `requiresAuth` flag fallback. We should verify that all existing contract definitions either have `auth` or `requiresAuth: true` set, and remove the `requiresAuth` fallback in `authClassFor()` once we've verified.

#### New module structure

```
src/server/
  auth.ts                 ← DELETE (entire file)
  auth-policy.ts          ← KEEP (single auth policy authority)
  contract-runtime.ts     ← KEEP (single route auth authority, no changes needed)
  routes/auth.ts          ← CONVERT to contract-based route registration
  routes/operator-contracts.ts ← ADD ws-ticket contract + handler
```

#### Migration path

1. Add `/api/auth/ws-ticket` as a contract route with `auth: 'operator-session'`.
2. Verify all existing contract definitions set `auth` or `requiresAuth` correctly.
3. Remove `auth.ts` plugin import from `fastify-app.ts`.
4. Clean up: remove `authenticate()` export, remove `AuthPluginOptions` type, remove `fp()` wrapping.
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

Strategy: For each duplicated file, keep the canonical location in the domain module, delete the contracts copy, and update `contracts/index.ts` to re-export from the domain module if needed (or remove the re-export if no external consumer needs it).

#### Exact file moves

| What | From | To | Action |
|------|------|----|--------|
| Session stamper | `src/contracts/session-stamper.ts` | `src/runtime/session-stamper.ts` | Move. All consumers are in `src/runtime/`, `src/agents/analyst-handler.ts`. |
| Candidate availability | `src/contracts/candidate-availability.ts` | DELETE (duplicate of `src/agents/candidate-availability.ts`) | Delete contracts copy. Agent code already imports from `agents/candidate-availability.ts`. |
| Provider candidate | `src/contracts/provider-candidate.ts` | DELETE (functionality moved to `src/agents/provider.ts`) | Delete. `Candidate` type and `candidateKey()` already exist in `src/agents/provider.ts` — verify. If not, add them there. |
| System prompt | `src/contracts/system-pampt.ts` | `src/agents/prompts/system-prompt.ts` | Move. Consumers are `src/agents/agent-adapter.ts` (via `agents/system-prompt.ts` re-export) and `src/runtime/phases/*`. |
| LLM failure (contracts copy) | `src/contracts/llm-failure.ts` | DELETE (canonical copy is `src/agents/llm-failure.ts`) | Delete. Update `contracts/verify-against-terminals.ts` and `runtime/phases/planner-invocation-failure.ts` to import from `agents/llm-failure.ts`. But wait — `contracts/` is supposed to be the boundary. The `LlmTransportFailure` type IS referenced in contract verification. However, the contract verifier is server-internal; no external consumer imports from `contracts/llm-failure.ts`. So canonical location is `agents/llm-failure.ts`, and we import it where needed. |
| Persisted tool call | `src/contracts/persisted-tool-call.ts` | **KEEP** in `contracts/` | Wire format definition — cross-boundary contract. Legitimate. |

Wait — re-checking the `provider-candidate.ts` situation:

Looking at `src/agents/provider.ts`:
- The `Candidate` type and `candidateKey()` function exist in `src/contracts/provider-candidate.ts`.
- `src/agents/candidate-availability.ts` imports `{ type Candidate, candidateKey } from './provider.js'` — so `src/agents/provider.ts` must already export these.
- `src/contracts/candidate-availability.ts` imports from `./provider-candidate.js`.

Let's verify: if `src/agents/provider.ts` already exports `Candidate` and `candidateKey`, then `contracts/provider-candidate.ts` is a pure duplicate and can be deleted.

**Confirmed**: `src/agents/provider.ts` is the canonical source. Delete `src/contracts/provider-candidate.ts`.

**Similarly**: `src/contracts/candidate-availability.ts` is a duplicate of `src/agents/candidate-availability.ts` with only the import path different. Delete the contracts copy.

**For `system-prompt.ts`**: `src/agents/system-prompt.ts` is a re-export barrel that re-exports from `../contracts/system-prompt.ts`. After move, the barrel becomes a re-export from the new location. But since the barrel exists at `agents/system-prompt.ts`, the simplest move is:

1. Move `contracts/system-prompt.ts` → `agents/prompts/system-prompt.ts` (new directory).
2. Update `agents/system-prompt.ts` (the re-export barrel) to point to `./prompts/system-prompt.js`.
3. Update the 3 runtime phase runner imports to point to `agents/prompts/system-prompt.js`.

Actually, looking at the imports more carefully:

- `src/agents/agent-adapter.ts` imports from `./system-prompt.js` (the barrel)
- `src/runtime/phases/planner-phase-runner.ts` imports from `../../contracts/system-prompt.js`
- `src/runtime/phases/executor-phase-runner.ts` imports from `../../contracts/system-prompt.js`
- `src/runtime/phases/reviewer-phase-runner.ts` imports from `../../contracts/system-prompt.js`

After the move, all consumers should import from `agents/prompts/system-prompt.ts` (or via the barrel `agents/system-prompt.ts`). The barrel can stay or be deleted — preference is to delete the barrel and import directly.

**For `session-stamper.ts`**: All consumers are in `src/runtime/` (17 files) plus `src/agents/analyst-handler.ts` and `src/agents/fake-agent.ts`. Move to `src/runtime/session-stamper.ts`. No file named `session-stamper.ts` currently exists in `src/runtime/`.

#### `contracts/index.ts` cleanup

After removing the misplaced files, update `contracts/index.ts` to:
1. Remove re-exports of `session-stamper` types (they move to `runtime/`).
2. Remove re-exports of `candidate-availability` types (they move to `agents/`).
3. Remove re-exports of `provider-candidate` types (they move to `agents/`).
4. Remove re-exports of `system-prompt` values (they move to `agents/`).
5. Keep `llm-failure` types: remove from `contracts/index.ts` since the canonical location is `agents/llm-failure.ts`.
6. Keep `persisted-tool-call` — it stays in contracts.

Consumers that were importing these types through `contracts/index.ts` need to update their imports to point to the new domain module locations.

---

## Step-by-step Implementation Sequence

Each step is a minimal, compilable commit.

### Step 1: Add path aliases for `@saivage/contracts` and `@saivage/schemas` (F09 foundation)

**Files changed:** `tsconfig.json`, `web/tsconfig.json`, `web/vite.config.ts`

- Add `paths` entry in root `tsconfig.json`: `"@saivage/contracts/*": ["./src/contracts/*"]`, `"@saivage/schemas": ["./src/schemas"]`.
- Add `paths` entry in `web/tsconfig.json`: `"@saivage/contracts/*": ["../src/contracts/*"]`, `"@saivage/schemas": ["../src/schemas"]`.
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

- Delete type aliases that add no transformation: `AgentStatus`, `ConversationEntry`, `PendingCall`, `McpToolInvocationStats`, `McpStatusKind`, `McpTransportKind`, `McpTool`, `ChatSession` alias, `CardUrgency` alias, `CardCreator` alias, `DiaryEntryKind`, `ContentReview` alias, `QuarantineSummaryEntry` alias, `SupervisionStats` alias, etc.
- Replace usages with the canonical names imported from `@saivage/contracts`.
- Keep types that add fields (e.g., `NoteRecord`, `AgentSession`, `ActionableErrorEnvelope`, `DebugError`, `DebugTimelineEvent`, `DebugState`, `RuntimeSummary`, `RuntimeCommandErrorResponse`, `CardRecord`, `CardDiffRow`, `DetailErrorState`, `DetailFreshnessState`, `FreshnessState`, `WsConnectionState`, `DataAuthority`, `FileEntry`).
- Validate: `cd web && npm run typecheck && npm run build`.

### Step 4: Optionally flatten `contracts.ts` barrel (F09 cleanup)

**Files changed:** `web/src/api/contracts.ts`, any web files that import from `./contracts` or `../api/contracts`.

Evaluate whether `web/src/api/contracts.ts` can be reduced or eliminated now that consumers can import directly from `@saivage/contracts`. If most web code still needs a local barrel for web-specific re-exports (Zod schemas for runtime validation, type narrowing), keep a minimal version. If it's a pure pass-through, redirect consumers to `@saivage/contracts` and delete the file.

- Validate: `cd web && npm run typecheck && npm run build && npm run test`.

### Step 5: Add ws-ticket contract route (F08 prerequisite)

**Files changed:** New `src/contracts/operator-api-auth.ts`, `src/server/routes/auth.ts`, `src/contracts/operator-api.ts` (register the new contract).

- Create `operator-api-auth.ts` contract defining `POST /api/auth/ws-ticket` with `auth: 'operator-session'`, success schema `z.object({ ticket: z.string(), expiresAt: z.string() })`, no body schema.
- In `routes/auth.ts`, convert the standalone Fastify route to a contract handler that calls `getAuthPolicy().issueWebSocketTicket()`.
- Register the handler in `operator-contracts.ts`.
- Validate: `npm run typecheck`, `npm test`. Manually verify that `POST /api/auth/ws-ticket` with a valid Bearer token returns a ticket, and without a token returns 401.

### Step 6: Verify all contracts have auth declarations (F08 prerequisite)

**Files changed:** Possibly `src/contracts/operator-api-core.ts`, individual `operator-api-*.ts` files.

- Audit all contract definitions in `operator-api.ts` and `operator-api-*.ts` files to ensure every contract has an explicit `auth` field (not relying on `requiresAuth` fallback).
- If any route needs to be public, set `auth: 'public'` explicitly.
- Update `authClassFor()` in `contract-runtime.ts` to require explicit `auth` field — remove the `requiresAuth` fallback, or convert it to an assertion that fails loudly if missing.
- Validate: `npm run typecheck`, `npm test`.

### Step 7: Remove `auth.ts` plugin (F08)

**Files changed:** `src/server/auth.ts` (DELETE), `src/server/composition/fastify-app.ts` (remove plugin registration).

- Delete `src/server/auth.ts` entirely.
- Remove `import authPlugin from '../auth.js'` and `await fastify.register(authPlugin)` from `fastify-app.ts`.
- Remove the `authenticate` export if anything else imports it (check for other consumers — should be none since `contract-runtime.ts` calls `getAuthPolicy()` directly).
- Validate: `npm run typecheck`, `npm test`. Manually verify:
  - `/health` returns 200 without auth.
  - `/api/auth/ws-ticket` without Bearer token returns 401.
  - `/api/auth/ws-ticket` with valid Bearer token returns a ticket.
  - Any `/api/*` route without auth returns 401.
  - Any `/api/*` route with valid auth returns data.

### Step 8: Move `session-stamper.ts` to `src/runtime/` (F34)

**Files changed:** Move `src/contracts/session-stamper.ts` → `src/runtime/session-stamper.ts`, update all ~17 consumer imports, update `src/contracts/index.ts`.

- Move the file.
- Update every consumer import path from `../contracts/session-stamper.js` or `../../contracts/session-stamper.js` to the new relative path.
- Remove `SessionStampCounter`, `ActivityStatus`, `PendingCall`, `RoundStamp`, `SessionStamper`, `SessionActivity`, `SessionRoundState`, `RuntimeAppendRecorder` re-exports from `src/contracts/index.ts`.
- Add re-exports in `src/runtime/index.ts` if one exists, or let consumers import directly.
- Validate: `npm run typecheck`, `npm test`.

### Step 9: Delete `src/contracts/candidate-availability.ts` and `src/contracts/provider-candidate.ts` (F34)

**Files changed:** Delete 2 files, update `src/contracts/index.ts`, verify no consumer imports from the contracts path.

- Verify that all consumers already import from `src/agents/candidate-availability.ts` and `src/agents/provider.ts` (not from `contracts/`). The `contracts/index.ts` re-exports these types, but no server-internal consumer should be going through the barrel for these.
- Delete `src/contracts/candidate-availability.ts` and `src/contracts/provider-candidate.ts`.
- Remove their re-exports from `src/contracts/index.ts`.
- Check if any test files import from the contracts path — update them.
- Validate: `npm run typecheck`, `npm test`.

### Step 10: Move `system-prompt.ts` to `src/agents/prompts/` (F34)

**Files changed:** Move `src/contracts/system-prompt.ts` → `src/agents/prompts/system-prompt.ts`, update `src/agents/system-prompt.ts` barrel, update runtime phase runner imports.

- Create `src/agents/prompts/` directory.
- Move `src/contracts/system-prompt.ts` → `src/agents/prompts/system-prompt.ts`.
- Delete `src/agents/system-prompt.ts` (the re-export barrel) and update its 1 consumer (`src/agents/agent-adapter.ts`) to import from `./prompts/system-prompt.js`.
- Update `src/runtime/phases/planner-phase-runner.ts`, `executor-phase-runner.ts`, `reviewer-phase-runner.ts` to import from `../../agents/prompts/system-prompt.js`.
- Remove `systemPromptBuilder` and `buildPlannerPrompt`/`buildExecutorPrompt`/`buildReviewerPrompt` re-exports from `src/contracts/index.ts` (confirm no external consumer needs them through this barrel).
- Validate: `npm run typecheck`, `npm test`.

### Step 11: Delete `src/contracts/llm-failure.ts`, canonical is `src/agents/llm-failure.ts` (F34)

**Files changed:** Delete `src/contracts/llm-failure.ts`, update `src/agents/llm-errors.ts`, update `src/contracts/verify-against-terminals.ts`, update `src/runtime/phases/planner-invocation-failure.ts`.

- Delete `src/contracts/llm-failure.ts`.
- Update `src/agents/llm-errors.ts` — it already re-exports from `./llm-failure.js`, no change needed.
- Update `src/contracts/verify-against-terminals.ts` — check if it imports `LlmTransportFailure` from `./llm-failure.js`. If so, it needs to import from `../agents/llm-failure.js`. But this creates a `contracts/` → `agents/` dependency. Alternative: move the `LlmTransportFailure` type (just the type, not the class) to a shared location, or keep `llm-failure.ts` in contracts and delete the `agents/` copy instead.
- Wait — reconsider. The F34 issue says `llm-failure.ts` is "legitimately cross-boundary" and the verdict is "PARTLY SOUND". The type `LlmTransportFailure` is used in both contract verification and agent code. The better move: keep `src/contracts/llm-failure.ts` as canonical, and have `src/agents/llm-failure.ts` be the one that's deleted (it's the duplicate). Update `src/agents/llm-errors.ts` to re-export from `../contracts/llm-failure.js` instead.

**Revised Step 11: Delete `src/agents/llm-failure.ts` (the duplicate), not the contracts copy.**

- Delete `src/agents/llm-failure.ts`.
- Update `src/agents/llm-errors.ts` to re-export from `../contracts/llm-failure.js`.
- Update `src/agents/llm-failure-classifiers.ts` to import from `../contracts/llm-failure.js`.
- Update all other `src/agents/` imports from `./llm-failure.js` to `../contracts/llm-failure.js` (agent-adapter, invocation-recovery-policy, invocation-outcome).
- Update test imports similarly.
- Validate: `npm run typecheck`, `npm test`.

### Step 12: Clean up `contracts/index.ts` — remove stale re-exports (F34 final)

**Files changed:** `src/contracts/index.ts`.

- After steps 8–11, `contracts/index.ts` should no longer re-export `session-stamper`, `candidate-availability`, `provider-candidate`, or `system-prompt` symbols.
- Remove any remaining dead re-exports. The barrel should now contain only:
  - Operator API contract schemas, types, and helpers.
  - WebSocket/event contract types and schemas.
  - Agent execution types (planner/executor/reviewer contracts).
  - `Contract`, `ContractToolDefinition`, verification helpers.
  - `llm-exchange` types and schemas.
  - `persisted-tool-call` types.
  - `llm-failure` types (canonical location).
  - Envelope schemas (planner, executor, reviewer).
  - `candidateKey`/`parseCandidateKey` were removed (moved to `agents/provider.ts`).
- Verify no consumer breaks from removed re-exports by grepping for `from './contracts'` or `from '../contracts'` imports that reference removed symbols.
- Validate: `npm run typecheck`, `npm test`.

---

## Validation

### Per-step validation

| Step | Validation |
|------|------------|
| 1 | `npm run typecheck` (root + web), `cd web && npm run build` |
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
   curl -s http://localhost:8080/api/runtime.status         # 401
   curl -s -H "Authorization: Bearer test" http://localhost:8080/api/runtime.status  # 200
   curl -s -X POST -H "Authorization: Bearer test" http://localhost:8080/api/auth/ws-ticket  # 200 + ticket
   ```

3. **No file in `contracts/` is misplaced**: Every remaining file in `src/contracts/` is either an API contract, envelope schema, contract verification helper, or a cross-boundary type definition legitimately needed by both server and web.

4. **Web builds independently**: `cd web && npm run build` succeeds without referencing `../src/` paths (only through `@saivage/contracts` and `@saivage/schemas` aliases).

5. **`src/server/auth.ts` does not exist**: Deleted.
