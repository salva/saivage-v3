# Saivage v3 UX Design

## Purpose

Saivage v3 is a dense control room for supervising an autonomous
runtime, not a marketing-style app. The UI provides a left navigation
rail, live dashboard, chat command stream, card tree/plan view, agent
conversation inspector, file browser, and debug console. The card
tree from the functional analysis is the primary navigation model.

The core UX principle is: **every important runtime fact is inspectable
from a card**. Cards link to their plan diary, review results,
processes, logs, artifacts, notes, and related cards.

---

## UX Goals

- Make the current runtime state obvious: running card, current agent,
  queued work, failures, blocked work, and global pause state.
- Let users talk to the analyst without losing operational context.
- Make the card tree the primary navigation model.
- Provide rich inspection tools: agent conversations, file
  browser, debug state, errors, timeline, and artifacts view.
- Support safe intervention: pause globally, abort/restart goals,
  kill processes, add directives, inspect outputs.
- Keep attachments rendered in the web UI only; Telegram links to cards
  or notifies that attachments exist.
- Avoid hidden system state: plan cards are visible in the tree.

---

## Application Shell

The application shell follows a standard operational-console pattern:

- **Left rail**: primary sections with icon + label + hotkey.
- **Workspace header**: current section title, project path/name, live
  status chip, global pause chip if paused.
- **Main workspace**: tab-specific view.
- **Keyboard shortcuts**: numeric section shortcuts and `/`
  to focus chat.
- **API token handling**: local token entry for secured
  deployments.

Recommended v3 navigation:

| Section | Purpose |
|---|---|
| Dashboard | Live command room: analyst chat plus runtime summary. |
| Cards | Recursive card tree, board, detail, diary, review, process views. |
| Agents | Planner/executor/reviewer/analyst conversations and tool traces. |
| Files | Browse `.saivage/` metadata and `.saivage-work/` outputs safely. |
| Debug | Runtime state, errors, timeline, raw JSON, health diagnostics. |
| Docs | Open generated docs/reference. |

```mermaid
flowchart LR
    Rail[Left Rail] --> Dash[Dashboard]
    Rail --> Cards[Cards]
    Rail --> Agents[Agents]
    Rail --> Files[Files]
    Rail --> Debug[Debug]
    Dash --> Chat[Analyst Chat]
    Dash --> Status[Runtime Status]
    Cards --> Tree[Card Tree]
    Cards --> Detail[Card Detail]
    Agents --> Conversations[Agent Conversations]
    Files --> Browser[Metadata / Output Browser]
    Debug --> Diagnostics[State / Errors / Timeline]
```

---

## Dashboard

The dashboard is the default control room, combining the analyst chat
stream and the runtime status panel.

### Analyst Chat

The analyst chat is a persistent command stream.

- WebSocket connection with visible state: connected, connecting,
  offline, unauthorized.
- API token entry for secured deployments.
- Chat history stored in agent session records, recoverable on reload.
- Markdown rendering of analyst responses.
- System/event messages inline in the stream.
- Send on Enter, multiline with Shift+Enter, `/` focuses input.
- Scroll-to-latest affordance when new messages arrive offscreen.

V3 analyst capabilities shown in chat:

- Create/edit/move/delete cards at any level.
- Add notes/directives to cards.
- Inspect cards, plan diary, review results, process outputs, artifacts,
  active agents, and runtime state.
- Control runtime: global pause/resume, abort/restart goal,
  restart task card, kill process.

Chat should include structured action previews before destructive
actions, for example aborting a goal or killing a process.

### Runtime Status Panel

The runtime status panel is card-aware.

Metrics:

- Runtime status: running, idle, paused, error, unauthorized.
- Current active card.
- Running process count.
- Queued ready tasks.
- Done goals.
- Failed/blocked cards.
- Active agent count, excluding analyst.

Sections:

- **Current Work**: active card title, type, parent goal, elapsed time.
- **Workers**: planner/executor/reviewer currently active, if any.
- **Queue**: next ready cards in priority order.
- **Recent History**: recent completed goals/tasks, failures,
  reviewer results, escalations.

---

## Cards Section

The Cards section is the primary workspace. It supports four
presentations over the same card model:

- **Tree**: recursive project -> goal -> plan -> sub-goals/tasks.
- **Board**: status columns (`drafting`, `backlog`, `active`,
  `running`, `blocked`, `done`, `failed`, `cancelled`).
- **Leaderboard**: query over done result cards sorted by a selected
  metric.
- **Timeline**: duration-focused view for cards/processes.

### Tree View

Tree requirements:

- Project card is root.
- Plan cards are visible.
- Maximum goal depth is configurable, default 5 levels.
- Use type icons for goal, plan, architecture, code, test, doc, data,
  research, ops.
- Show status, priority, blocked/dependency markers, active agent, and
  unread notes/review markers.
- Support focus by card ID from dashboard, agents, files, debug, and
  Telegram links.

Tree actions:

- Create child card.
- Edit card while not scheduled.
- Add note/directive.
- Move/reparent valid cards.
- Abort goal.
- Restart task/goal.
- Open plan diary.
- Open related process output.
- Open artifacts/attachments.

### Card Detail

Card detail is the central inspection surface.

Sections:

- Header: title, type, status, parent, priority, urgency, created by,
  updated time.
- Description and acceptance criteria.
- Dependencies and blocked-by/blocks graph.
- Notes/activity log with mutable-until-handled behavior.
- Results and metrics.
- Artifacts and attachments. Attachments render inline in the web UI.
- Process list: async commands launched for this card, state, elapsed,
  tail output, kill/wait controls.
- Related agent conversation links.

Goal cards additionally show:

- Child card summary.
- Plan card link.
- Latest reviewer assessment.
- Goal completion gate: reviewer pass required.

Plan cards additionally show:

- Planner diary rendered from structured JSON as Markdown.
- Planner invocations: initial, all tasks complete, review rejection,
  failure.
- Card mutations requested by planner.
- Reviewer assessments appended to the diary.

Terminal task cards additionally show:

- Executor result.
- Process output files and tails.
- Artifacts generated by the task.
- Skill file loaded/linked for the card type.

### Board View

The board is a compact operational view for scanning state. Cards are
grouped by status. It should support filtering by type, parent goal,
tag, priority, and text search.

### Leaderboard View

The leaderboard is a saved query over done result cards. It is not a
separate data model. Rows link to card detail and expose the same
artifacts, metrics, process logs, and review history.

### Timeline View

Timeline combines card duration and process duration:

- Card started/completed times.
- Process start/end and still-running markers.
- Review and planner invocation markers.
- Global pause intervals.

---

## Agents Section

The Agents section shows all active and historical agent conversations
scoped to their roles.

Agent list:

- Analyst conversations (chat sessions).
- Planner for active goal.
- Executor for active goal.
- Reviewer when active.
- Content supervisor events when it blocks or quarantines content.

Conversation detail:

- Messages grouped into reasoning/tool-call/tool-result steps.
- Tool calls expandable by default for current work, collapsed for old
  history.
- Model/provider metadata.
- Runtime events, model repair/recovery events, tool errors.
- Links from tool calls to affected cards, processes, files, artifacts,
  and quarantined content.

The analyst is always available concurrently with the runtime. Other
agents do not run in parallel by default.

---

## Files Section

The Files section separates persistent state from generated outputs.

Panels:

- Metadata browser (`.saivage/`).
- Work/output browser (`.saivage-work/`).
- Notes queue / directives.
- Quarantine browser for content-supervisor blocks.

Behaviors:

- Breadcrumb navigation.
- Directory stats.
- JSON highlighting.
- Markdown rendering where appropriate.
- Safe file reads through MCP; dangerous/external provenance is routed
  through content supervision.
- Downloaded files must enter through `download_file`, not arbitrary
  writes.

---

## Debug Section

The Debug section exposes raw runtime internals:

- **State**: runtime state, card index, active agents, process registry,
  global pause state, configuration.
- **Errors**: source, type, severity, message, details, timestamp.
- **Timeline**: runtime events, card transitions, process events,
  planner/reviewer invocations, content-supervisor events.

Debug is for inspection, not normal operation. Actions should link back
to the relevant card or process instead of duplicating controls.

---

## Notifications

- Notify when goals are done.
- Depth-0 planner escalation must notify via Telegram and be visible in
  the web UI.
- Telegram notifications should link to the relevant card. Attachments
  are not rendered in Telegram; Telegram can say attachments exist.

---

## Data Model

All entities are stored as JSON. Markdown is a rendering format, not the
source of truth for structured records such as plan diary entries.

### Entity Overview

```mermaid
erDiagram
    CARD ||--o{ CARD : children
    CARD ||--o{ NOTE : has
    CARD ||--o{ ARTIFACT : registers
    CARD ||--o{ ATTACHMENT : displays
    CARD ||--o{ PROCESS : launches
    CARD ||--o{ DIARY_ENTRY : plan_diary
    CARD ||--o{ REVIEW_ASSESSMENT : reviewed_by
    CARD }o--o{ CARD : depends_on
    CARD ||--o{ AGENT_SESSION : scopes
    AGENT_SESSION ||--o{ AGENT_MESSAGE : contains
    CONTENT_REVIEW ||--o{ QUARANTINE_ITEM : blocks
```

The project card (`type: "project"`) is the tree root. Project-wide
configuration (context, constraints, planner settings) is stored in a
separate `ProjectConfig` record, not in the card fields.

### Project Configuration

Project-wide settings stored in `.saivage/project.json`. This is
**not** the project card — the project card is a regular `CardRecord`
with `type: "project"` stored alongside other cards.

```ts
interface ProjectConfig {
  id: "project";
  name: string;
  context: string;
  goals_summary: string;
  constraints: string[];
  max_goal_depth: number; // default 5
  planner_enabled: boolean;
  created_at: string;
  updated_at: string;
}
```

### Card

```ts
type CardType =
  | "project"
  | "goal"
  | "plan"
  | "architecture"
  | "code"
  | "test"
  | "doc"
  | "data"
  | "research"
  | "ops";

type CardStatus =
  | "drafting"
  | "backlog"
  | "active"
  | "running"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";

interface CardRecord {
  id: string;
  type: CardType;
  parent: string | null;
  depth: number;
  title: string;
  description: string;
  status: CardStatus;
  subtype?: string | null;
  tags: string[];
  priority: number;
  urgency: "low" | "normal" | "high" | "critical";
  created_by: "user" | "analyst" | "planner";
  created_at: string;
  updated_at: string;
  assigned_to?: string | null;
  depends_on: string[];
  blocks: string[];
  related: string[];
  acceptance: string;
  result?: Record<string, unknown> | null;
  metrics?: Record<string, number | string | boolean | null> | null;
  artifacts: ArtifactRef[];
  attachments: AttachmentRef[];
  estimate?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  duration_ms?: number | null;
  error?: string | null;
  retries: number;
}
```

Rules:

- Project and goal cards get exactly one plan child.
- Terminal cards are leaves.
- Cards are editable while not scheduled (`drafting` or `backlog`).
- Goal `done` requires reviewer pass.
- Task `done` is set when the executor reports completion.

### Plan Diary Entry

```ts
interface DiaryEntry {
  id: string;
  plan_card_id: string;
  invocation_id: string;
  kind:
    | "planner_invocation"
    | "planner_decision"
    | "card_mutation"
    | "review_assessment"
    | "failure_handling";
  timestamp: string;
  input_summary?: string;
  decision?: string;
  rationale?: string;
  created_cards?: string[];
  updated_cards?: string[];
  reviewed_cards?: string[];
  assessment?: ReviewAssessment;
  raw?: Record<string, unknown>;
}
```

Diary entries are stored as JSON and rendered as Markdown on the fly.

### Review Assessment

```ts
interface ReviewAssessment {
  id: string;
  goal_card_id: string;
  plan_card_id: string;
  reviewer_session_id: string;
  result: "pass" | "fail";
  summary: string;
  achieved: string[];
  missing: string[];
  evidence_card_ids: string[];
  created_at: string;
}
```

Review assessments are appended to the plan diary.

### Note

```ts
interface NoteRecord {
  id: string;
  card_id: string;
  author: "user" | "analyst" | "planner" | "executor" | "reviewer" | "runtime";
  timestamp: string;
  content: string;
  kind: "comment" | "progress" | "directive" | "escalation";
  handled: boolean;
  handled_at?: string | null;
}
```

### Process

```ts
interface ProcessRecord {
  id: string;
  card_id: string;
  command: string;
  cwd: string;
  status: "running" | "exited" | "failed" | "killed";
  pid?: number | null;
  started_at: string;
  completed_at?: string | null;
  exit_code?: number | null;
  required_for_card_completion: boolean;
  output_dir: string;
  stdout_path: string;
  stderr_path: string;
  combined_log_path: string;
}
```

Processes are external programs launched asynchronously while executing
terminal cards.

### Artifact and Attachment

```ts
interface ArtifactRef {
  id: string;
  card_id: string;
  path: string;
  type: "model" | "data" | "config" | "log" | "report" | "other";
  description: string;
  retain: boolean;
  created_at: string;
}

interface AttachmentRef {
  id: string;
  card_id: string;
  path: string;
  mime: string;
  title: string;
  description?: string;
  created_at: string;
}
```

Attachments render inline only in the web UI.

### Agent Session and Messages

```ts
interface AgentSession {
  id: string;
  role: "analyst" | "planner" | "executor" | "reviewer" | "content_supervisor";
  goal_card_id?: string | null;
  card_id?: string | null;
  status: "active" | "done" | "failed";
  started_at: string;
  completed_at?: string | null;
  model?: string;
}

interface AgentMessage {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "system" | "tool";
  kind:
    | "text"
    | "activity"
    | "tool_call"
    | "tool_result"
    | "tool_error"
    | "model_issue"
    | "model_repair"
    | "model_recovered";
  content: string;
  tool?: string;
  timestamp: string;
  links?: EntityLink[];
}

interface EntityLink {
  entity_type: "card" | "process" | "artifact" | "attachment" | "quarantine";
  entity_id: string;
  label?: string;
}
```

### Runtime State

```ts
interface RuntimeState {
  status: "idle" | "running" | "paused" | "error";
  project_id: "project";
  current_card_id?: string | null;
  current_agent_session_id?: string | null;
  paused: boolean;
  paused_at?: string | null;
  queue: string[];
  running_processes: string[];
  updated_at: string;
}
```

### Content Supervision

```ts
interface ContentReview {
  id: string;
  source_kind: "command_output" | "file" | "download" | "web" | "api" | "tool";
  source_ref: string;
  status: "passed" | "blocked" | "sanitized";
  summary: string;
  risk: "low" | "medium" | "high";
  quarantine_id?: string | null;
  created_at: string;
}

interface QuarantineItem {
  id: string;
  review_id: string;
  source_ref: string;
  stored_path: string;
  reason: string;
  created_at: string;
}
```

---

## File Tree Structure

All Saivage project state stays project-local. Agents access these
files through MCP/support software, not direct filesystem reads/writes.

Two parallel roots separate persistent metadata from generated outputs:

- `.saivage/` — ordered metadata, indexes, card records, diaries,
  sessions, runtime state, skills, configuration.
- `.saivage-work/` — generated work products, retained artifacts,
  disposable temporary files, process output, downloads, quarantine.

The two roots mirror each other by card/process IDs so cleanup can
target `.saivage-work/` without corrupting metadata.

```text
.saivage/
  project.json
  config/
    runtime.json
    ui.json
    notifications.json
  skills/
    architecture.md
    code.md
    test.md
    doc.md
    data.md
    research.md
    ops.md
  instructions/
    planner.md              # depth-0 planner instructions (user-editable)
    executor.md             # global executor instructions (optional)
  cards/
    index.json
    by-id/
      project.json
      goal-0001.json
      plan-0001.json
      code-0002.json
    tree/
      project.children.json
      goal-0001.children.json
    dependencies/
      depends-on.json
      blocks.json
  diaries/
    plan-0001/
      index.json
      000001.initial.json
      000002.card-mutations.json
      000003.review-assessment.json
  reviews/
    by-goal/
      goal-0001.index.json
  notes/
    by-card/
      goal-0001.jsonl
      code-0002.jsonl
    queue.json
  agents/
    sessions/
      analyst-0001.json
      planner-0002.json
      executor-0003.json
      reviewer-0004.json
    messages/
      analyst-0001.jsonl
      planner-0002.jsonl
      executor-0003.jsonl
      reviewer-0004.jsonl
  runtime/
    state.json
    queue.json
    pause.json
    events.jsonl
    errors.jsonl
    processes.json
  supervision/
    reviews.jsonl
    quarantine-index.json
  views/
    leaderboard.json
    saved-filters.json
```

```text
.saivage-work/
  cards/
    goal-0001/
      artifacts/
        retained/
        working/
      attachments/
      tmp/
    code-0002/
      artifacts/
        retained/
        working/
      attachments/
      tmp/
  processes/
    proc-0001/
      meta.json
      stdout.log
      stderr.log
      combined.log
      exit.json
    proc-0002/
      meta.json
      stdout.log
      stderr.log
      combined.log
      exit.json
  downloads/
    dl-0001/
      meta.json
      original.bin
      sanitized.txt
      review.json
  quarantine/
    q-0001/
      meta.json
      raw.bin
      summary.md
  tmp/
    runtime/
    uploads/
    previews/
```

### Cleanup Policy

Cleanup operates on `.saivage-work/`, not `.saivage/`.

Safe cleanup targets:

- `.saivage-work/cards/*/tmp/`
- `.saivage-work/cards/*/artifacts/working/`
- completed `.saivage-work/processes/*/` directories after their logs
  are summarized and no retained artifact references them
- stale previews/uploads

Never delete without an explicit retention check:

- `.saivage-work/cards/*/artifacts/retained/`
- `.saivage-work/cards/*/attachments/`
- `.saivage-work/downloads/*/review.json`
- `.saivage-work/quarantine/*/meta.json`

Metadata in `.saivage/` is the source of truth and should be edited
only through MCP/runtime APIs.

---

## UX Coverage Checklist

| Feature | UX location |
|---|---|
| Analyst chat | Dashboard |
| Global pause/resume | Dashboard status + analyst command |
| Abort/restart goal | Card detail actions + analyst command |
| Restart task | Terminal card detail actions |
| Kill/wait/tail process | Card detail process panel |
| Card tree | Cards / Tree |
| Plan diary | Visible plan card detail |
| Reviewer assessment | Plan card diary + goal detail summary |
| Attachments | Card detail, web only |
| Artifacts/files | Files section + card detail links |
| Agent conversations | Agents section |
| Content supervision/quarantine | Files + Debug + card notes |
| Depth-0 escalation | Telegram notification + UI banner/card marker |
| Debug state/errors/timeline | Debug section |
