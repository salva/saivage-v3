# What is Saivage

Status: orientation summary. This page introduces the system and its vocabulary
for readers. It owns no contract; every statement below is derived from the
linked authorities — the [System specification](spec/system-specification.md),
[Operator UI specification](spec/operator-ui.md),
[System architecture](architecture/system-architecture.md), and
[Operator runbook](runbook/index.md).

## What it does for you

Saivage is autonomous software engineering built for the long run. Its aim is
to carry a software project all the way — from a specification to an accepted,
evidenced delivery — with minimal user intervention. You describe what the
project must achieve; Saivage turns that specification into its own plan and
work tree, then implements, tests, reviews, and integrates the work, hour
after hour and day after day, escalating to you only when a real decision,
resource, or input is genuinely missing.

Bounded work — a defect fix, a feature, a codebase translation, a research
question answered with evidence — is simply the small end of that range. The
same runtime is designed to hold a multi-week objective: it keeps its plan
current as findings arrive, repairs its own completed work when review
requires it, and records every command, change, test run, and decision
durably, so you can watch the work live or audit it afterwards.

You stay in charge throughout. You steer the project through a single
conversation, you can pause, resume, or stop the work at any time, and
planning results are accepted only through independent review against their
stated brief.

## How it works

Under the hood, an objective becomes a visible tree of **cards**: planner
agents decompose the work, executor agents perform the terminal cards, reviewer
agents assess results, and the runtime alone dispatches work between them. The
human operator observes everything through a web control room and steers
through one conversation with the global Analyst agent. The rest of this page
introduces that machinery.

Saivage runs inside an externally isolated LXC container in which trusted
agents may have root access; the deployment, not Saivage, supplies that
isolation. See the [trust model](architecture/system-architecture.md#deployment-and-trust-model).

## The card model

All work is represented as **cards** in one rooted tree:

- The fixed root is the `project` card; every other card is its descendant.
- **Planning cards** (`project`, `goal` in the bundled templates) are owned by
  a Planner and decompose work into child cards.
- **Terminal cards** (`code`, `test`, `doc`, `data`, `research`, `ops`, and in
  one bundled template `architecture`) are owned by an Executor and perform the
  actual work.
- Each card carries configured **records** — always `brief.md` as the bootstrap
  record, plus `status.md`, and `review.md` for the types that declare it
  (`project`, `goal`, and `architecture` in the bundled templates). Records
  are strict append-only versioned streams, and additional names can be
  configured.
- Each card runs a configured **workflow graph** whose nodes are agent sessions
  and whose edges are validated outcomes. For example, bundled terminal `code`
  cards use a red/green/refactor loop; `test` cards use
  diagnose/add-coverage/repair/verify.
- Card identity is hierarchical and immutable (`project`, `card-a`,
  `card-a-b`, …); display names and ordering are separate mutable data.

Cards have an exact lifecycle vocabulary:
`backlog`, `changed`, `running`, `blocked`, `stopped`, `done`, `failed`,
`cancelled` — see the
[exact lifecycle contract](spec/system-specification.md#exact-card-lifecycle-vocabulary).
`done` and `failed` can be reopened by their owning Planner; `cancelled` is
terminal forever.

## Agent roles

| Role | What it does |
| --- | --- |
| **Planner** | Owns planning cards. Decomposes objectives into children, orders them, notifies and activates children, and may reopen its own done/failed children for correction. Does not implement, build, or test itself. |
| **Executor** | Owns terminal cards. Performs the work of each workflow node: code, tests, documents, research, data work, or operations. |
| **Reviewer** | Assesses completed planning work against its brief and records; accepts or requires revision. |
| **Analyst** | The single global agent the human operator talks to. It is the ordinary operator surface: it can create and reopen cards, edit records, read state, and drive runtime control, all inside one conversation. |
| **Oversight** | An optional periodic (default two-hour) read-only check by its own global agent. Its only project effect is an evidenced notification to a planning-capable card. See [Project Oversight](spec/system-specification.md#project-oversight). |

Each named agent gets an exact compiled prompt, tool inventory, and model route
from the selected configuration; creation, activation, and reopening authority
is configured per role and per card type, never inferred from a role label.

## The run loop

1. An operator (or startup) starts a **Run**; the root planning card activates
   and its Planner works its graph.
2. The Planner creates child cards, notifies them with context, and activates
   them; activation ownership is tracked exactly by the supervisor.
3. Executors and Reviewers run their nodes; tool calls and provider exchanges
   are recorded as durable evidence.
4. Terminal outcomes settle each card (`done`, `failed`, `blocked`); the parent
   Planner reacts — accepting, correcting via reopen, replanning, or blocking —
   until the root objective is accepted by review.
5. The operator can **Pause**, **Resume**, or **Stop** the run at any time;
   after interruption, an explicit Run owns full-chain stopped recovery. See
   [Run, Pause, Resume, Stop, and Restart](spec/system-specification.md#7-run-pause-resume-stop-and-restart).

Long agent conversations are kept viable by **conversation compaction**: when a
session's context approaches its model's window, the runtime summarizes covered
history into a new segment under exact admission and coverage rules. See the
[runbook compaction section](runbook/index.md#prepared-conversation-compaction).

## Operator surfaces

- **Web control room** — dashboard, card tree and card detail, agent sessions
  and conversations, files, processes, and debug state. See the
  [Operator UI specification](spec/operator-ui.md).
- **CLI** — `init`, `start`, `status`, `pause`, `resume`, `stop`,
  `restart_server`, `reset`. See
  [Lifecycle Lock and CLI](spec/system-specification.md#8-lifecycle-lock-and-cli)
  and the [runbook](runbook/index.md#startup-command-inputs).
- **REST API and WebSocket** — authenticated operator and live-sync surfaces;
  bearer tokens are sent only in the `Authorization` header, never in URLs.
- **This documentation site** — served by every running instance at `/docs/`.

## Persistence and reset

Saivage stores all durable state as ordinary files under the target project's
`.saivage/` tree: append-only JSONL streams with strict envelopes for cards,
records, conversations, logs, and work artifacts. There is no database, no
migration, and no compatibility reader. When a durable format changes
incompatibly, the cutover is **reset-only**: stop, rewrite configuration, reset
generated state (preserving configuration, credentials, operator inputs,
source, and docs), and start the current binary. See
[Direct File Persistence](spec/system-specification.md#9-direct-file-persistence)
and the [reset procedures](runbook/index.md#invalid-or-non-continuable-global-analyst-history).

## Glossary

- **Card** — one node of the work tree; the unit of planning, execution,
  review, and history.
- **Record** — a versioned Markdown document owned by a card as a strict
  append-only stream. Names come from the card type's configuration —
  `brief.md` is always the bootstrap record; `status.md` and `review.md` are
  the other common defaults, and additional names such as `review-*.md` can
  be configured.
- **Analyst** — the global operator-conversation agent; the ordinary operator
  mutation surface.
- **Session** — one conversation owned by a named agent: card-scoped agents
  get one session per card (`agent:<name>:<card-id>`); global agents (the
  Analyst, Oversight) get one project-wide session.
- **Notification** — context durably queued for a card (`queue_notification`).
  Queueing is not delivery: the card type's designated recipient consumes the
  pending context when it next runs, and a terminal or cancelled card may
  clear undelivered notifications instead.
- **Activation** — one live execution of a card's compiled workflow graph,
  from a lifecycle entry (`BACKLOG`, `CHANGED`, `BLOCKED`, or `STOPPED`) to a
  terminal outcome or cancellation, coordinated exclusively by the supervisor.
- **Prepared request** — the frozen request blocks of a card node — static
  role instruction and tools, the canonical card block (id, type, title,
  brief), and the compiled current-node prompt. Prepared once per node and
  reused unchanged across all of that node's continuations; prepared anew
  for the next node.
- **Exact admission** — the strict check that a candidate's complete
  serialized provider request fits that candidate's own usable input capacity
  before anything is sent.
- **Compaction** — summarizing covered conversation history into a new
  immutable segment (with a replaced cumulative index) when a session
  approaches its model window; only validated coverage omits rows.
- **Outcome-unknown** — a durable publication whose result cannot be known
  after a failure or interruption. It is never inspected, retried, or
  compensated; the process fails at the fatal boundary instead, and strict
  canonical reads govern any later start.
- **Tombstone** — a deleted card's retained terminal link; traversal stops
  there, evidence stays readable.
- **Cutover / reset-only** — an incompatible durable-format change; no
  migration path exists, generated state is reset deliberately.
- **Lifecycle lock** — the process-exclusion lock owning a project's runtime;
  the runtime-control CLI commands (`status`, `pause`, `resume`, `stop`,
  `restart_server`) delegate only through a verified live lock record.
- **Service epoch** — one lifetime of a server process; some schedules and
  transient states reset per epoch.

## Where to go next

- Run your first instance: the [Getting started](guides/getting-started.md)
  guide, then [Configuration](guides/configuration.md) and
  [Operating a project](guides/operating.md).
- Deploy or operate a deployment: the [Operator runbook](runbook/index.md).
- Understand the internals: the
  [System architecture](architecture/system-architecture.md).
- Check exact behavior: the [System specification](spec/system-specification.md).
- Customize agent prompts: the
  [prompt handling guide](architecture/prompts.md).
