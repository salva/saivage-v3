# Saivage v3 Subsystem Map

Generated: 2026-06-06

## Architecture Overview

Saivage v3 is a card-centered autonomous AI software engineering runtime with an operator control room. The system has two major surfaces: a Node.js backend runtime and a Vue 3 web UI.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Web UI (Vue 3/Pinia)                       │
│  Views ← Stores ← API Client ← WebSocket ← SyncClient            │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ HTTP / WebSocket
┌──────────────────────────────┴──────────────────────────────────────┐
│                        Server (Fastify)                              │
│  Routes ← Contracts ← AuthPolicy ← ContractRuntime                 │
│  WebSocket ← SyncHub ← LiveSyncSocket                               │
│  Composition ← MCP Lifecycle ← Telegram Lifecycle                    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────┴──────────────────────────────────────┐
│                        Runtime Engine                                │
│  RuntimeCore ← StateMachine ← Dispatchers ← Phases                 │
│  PlannerDispatcher ← ReviewerDispatcher ← ActivationDispatcher      │
│  ProcessRunner ← StuckAgentSupervisor ← CrashRecovery               │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────┴──────────────────────────────────────┐
│                        Agent System                                  │
│  AgentAdapter ← LlmGateway ← ProviderGateway ← Transport            │
│  AnalystHandler ← LlmResolver (parallel path)                       │
│  ToolExecutor ← ToolCatalog ← RoleToolPolicy                         │
│  SessionCoordinator ← Compaction ← SkillsEngine                     │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────┴──────────────────────────────────────┐
│                        Data & Infrastructure                         │
│  CardStore ← CardStoreState ← Mutations ← ApplyMutation            │
│  Persistence ← AtomicJsonFile ← JsonlLedger ← ProjectLock           │
│  Workspace ← ContentSupervisor ← Quarantine ← HeuristicScanner      │
│  Events ← EventBus ← Projections ← EventLogger                      │
│  Notifications ← NotificationCenter ← TelegramBot                   │
└──────────────────────────────────────────────────────────────────────┘
```

## Subsystems

### 1. Runtime Engine (`src/runtime/`, 79 files)

**Purpose:** Card-centered autonomous runtime: state machine, planner/executor/reviewer phase dispatchers, activation lifecycle, crash recovery, terminal commit logic.

**Key files:**
- `runtime-core.ts` — Pure state patch construction, invariants, preconditions, reconciliation
- `state.ts` — Runtime state persistence (`RuntimeState` read/write/mutate)
- `state-machine.ts` — Periodic tick-driven state machine
- `runtime.ts` — Top-level `Runtime` class wiring all collaborators
- `runtime-services.ts` — `RuntimeServices` dependency interface
- `runtime-dispatch-composition.ts` — Factory wiring all dispatchers
- `lifecycle.ts` — Resource lifecycle scope (timers, listeners, processes)
- `control.ts` — Pause/resume for offline operations
- `runtime-pause-resume.ts` — Pause/resume for live runtime (parallel path)
- `phases/` — 13 files for planner, executor, reviewer phase runners and failure handlers
- `stuck-agent-supervisor.ts` — Background stuck-agent detection
- `process-runner.ts` — 1086-line managed process lifecycle
- `terminal-commit/` — Card lifecycle commit protocols

**Public surface:** `Runtime`, `RuntimeServices`, `StatePort`, `MutationPort`, `processApi`, `controlApi`

**Dependencies:** agents, cards, contracts, events, notifications, persistence, schemas, workspace

### 2. Agent System (`src/agents/`, 58 files)

**Purpose:** LLM invocation, tool dispatch, session management, compaction, skill loading.

**Key files:**
- `agent-adapter.ts` — 1340-line god class: agent invocation, recovery, tool dispatch, compaction
- `agent-loop-driver.ts` — Agent loop state machine (well-designed)
- `agent-llm-gateway.ts` — LLM invocation facade
- `llm-openai-chat-gateway.ts`, `llm-openai-codex-gateway.ts` — Provider gateways
- `llm-transport.ts` — Transport config + OAuth token refresh
- `llm-provider-gateway.ts` — Provider resolution
- `model-router.ts` — Model routing with failover
- `analyst-handler.ts` — Analyst chat agent (parallel invocation path)
- `analyst-llm-resolver.ts` — Analyst LLM resolution (duplicates AgentLlmInvocationGateway)
- `compaction.ts` — Context compaction
- `skills-engine.ts` — 427-line skill loading with glob-to-regex and caching
- `agent-tool-executor.ts` — Tool dispatch
- `agent-session-coordinator.ts` — Session lifecycle

**Public surface:** `AgentAdapter`, `AgentLoopDriver`, `AnalystHandler`, `ModelRouter`, `SkillsEngine`

**Dependencies:** cards, contracts, mcp, persistence, runtime, workspace

### 3. Card Model (`src/cards/`, 11 files)

**Purpose:** Card state, lifecycle, mutation, position management, persistence.

**Key files:**
- `state.ts` — `CardStoreState` (547 lines): in-memory read model + validation + I/O loading
- `card-store.ts` — `CardStore` (750 lines): god class with CRUD, archiving, lifecycle, notifications
- `apply-mutation.ts` — On-disk write sequence with crash recovery
- `lifecycle.ts` — Lifecycle transition validation
- `diary.ts` — Card diary with two-index pattern
- `artifacts.ts` — Artifact registration and management

**Public surface:** `CardStore`, `CardStoreState`, `applyMutation`, `loadCardStoreState`

**Dependencies:** persistence, schemas

### 4. Contracts (`src/contracts/`, 31 files)

**Purpose:** Typed API contracts for operator HTTP routes, agent execution envelopes, and LLM exchange validation.

**Key files:**
- `operator-api*.ts` — 8 files of route contract definitions with Zod schemas
- `planner-contract.ts`, `executor-contract.ts`, `reviewer-contract.ts` — Agent output contracts
- `contract.ts` — Base `Contract<Envelope, TypedResult>` generic
- `system-prompt.ts` — System prompt construction (misplaced)
- `session-stamper.ts` — Round/message stamping (mixed concerns)
- `json-schema-to-prose.ts` — JSON Schema to human-readable prose

**Public surface:** All operator API contracts, agent contracts, envelope types

**Dependencies:** schemas, cards

### 5. Server (`src/server/`, 29 files)

**Purpose:** Fastify HTTP + WebSocket server with auth, route composition, and service lifecycle.

**Key files:**
- `server.ts` — Entry point with overloaded signature
- `contract-runtime.ts` — Contract validation + auth + permission enforcement
- `auth.ts`, `auth-policy.ts` — Dual auth system
- `websocket.ts` — 142-line multi-concern WebSocket handler
- `sync-hub.ts` — WebSocket broadcast hub
- `composition/` — 6 files for Fastify, routes, runtime, MCP, Telegram, shutdown
- `routes/` — 12 handler files for operator API routes

**Public surface:** `createServer`, `ContractRuntime`, `registerWebSocket`

**Dependencies:** runtime, agents, contracts, events, persistence

### 6. Persistence (`src/persistence/`, 9 files)

**Purpose:** Durable JSON storage, JSONL ledger, file locking, project discovery.

**Key files:**
- `atomic-json-file.ts` — Atomic write-with-rename
- `jsonl-ledger.ts` — Append-only JSONL storage
- `project-lock.ts` — File-based exclusive lock
- `persistent-queue.ts` — Atomic file queue
- `file-tree.ts` — Project tree initialization + atomic writes
- `control-action-audit.ts` — Audit log

**Public surface:** `AtomicJsonFile`, `JsonlLedger`, `ProjectLock`, `withLock`, `withLockSync`

**Dependencies:** None (foundational)

### 7. MCP (`src/mcp/`, 13 files)

**Purpose:** Model Context Protocol integration: server lifecycle, tool discovery, invocation.

**Key files:**
- `mcp-manager.ts` — 626-line monolithic manager
- `stdio-transport.ts`, `streamable-http-transport.ts` — Transport implementations
- `mcp-argument-validator.ts` — Argument validation
- `server-registry.ts` — Server configuration
- `protocol.ts` — Protocol types and limits

**Public surface:** `McpManager`, `McpServerConfig`, `McpToolInvocationResult`

**Dependencies:** events, workspace

### 8. Workspace Security (`src/workspace/`, 10 files)

**Purpose:** Content supervision, secret scanning, path security, write territory validation.

**Key files:**
- `content-supervisor.ts` — Content scanning orchestration
- `heuristic-scanner.ts` — 662-line regex pattern scanner
- `llm-scanner.ts` — LLM-based content scanning
- `secret-redaction.ts` — Outbound secret redaction
- `quarantine.ts` — Quarantine system (sync I/O)
- `write-territories.ts` — Write zone validation
- `shell-classifier.ts` — Shell command classification

**Public surface:** `ContentSupervisor`, `screenContent`, `quarantineContent`

**Dependencies:** None (foundational)

### 9. Web UI (`web/src/`, ~190 source files)

**Purpose:** Operator control room for cards, agents, runtime, and analyst chat.

**Key subsystems:**
- `stores/` — 11 Pinia stores (agents, analystChat, cards, debug, files, mcp, runtime, sync, workspaceRoute, card-detail-view-model, card-presentation)
- `views/` — Dashboard, Cards, Agents, Debug, Files
- `components/cards/` — Tree, Timeline, Board, Leaderboard, Detail views
- `components/chat/` — Analyst chat panel
- `components/conversation/` — Message rendering
- `api/` — HTTP + WebSocket clients (with `../../../src/` contract imports)
- `sync/` — WebSocket sync client

**Public surface:** Vue components, Pinia stores, API client

**Dependencies:** contracts (via relative path imports)

### 10. Supporting Modules

| Module | Files | Purpose |
|--------|-------|---------|
| `src/events/` | 4 | EventBus, event registry, event logger |
| `src/notifications/` | 4 | NotificationCenter, delivery, triggers |
| `src/config/` | 4 | Environment config, validation |
| `src/lessons/` | 6 | Lesson/TTS artifact production |
| `src/permissions/` | 2 | Card permission rules |
| `src/projections/` | 2 | Ledger-based read projections |
| `src/lifecycle/` | 2 | Resource scope management |
| `src/schemas/` | 10 | Zod/JSON schema definitions and validators |
| `src/tools/` | 16 | Tool definitions for planner, executor, analyst |
| `src/utils/` | 1 | Shared utilities |
| `src/application/` | 12 | Read models and runtime composition |
| `src/auth/` | 4 | Auth profiles, OAuth |
| `src/redaction/` | 1 | Redaction port |

## Cross-Subsystem Dependencies

```
Server → Runtime, Agents, Cards, Contracts, Events, MCP, Persistence
Runtime → Agents, Cards, Contracts, Events, Notifications, Persistence, Schemas, Workspace
Agents → Cards, Contracts, Events, MCP, Persistence, Runtime, Workspace
Cards → Persistence, Schemas
Persistence → (none, foundational)
Web → Contracts (via relative imports), Server (via HTTP/WS)
```