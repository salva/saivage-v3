# Operating a project

Status: non-authoritative guide. Exact UI behavior is owned by the
[Operator UI specification](../spec/operator-ui.md); runtime behavior by the
[System specification](../spec/system-specification.md); procedures by the
[Operator runbook](../runbook/index.md).

Saivage works autonomously for long stretches. Your job as operator is to
launch it, stay oriented, answer the rare question, and accept results. This
guide shows where everything lives and the small set of interactions you
actually use.

## The control room

Open `http://<host>:<port>/` and enter the bearer token. The screen has a
left workspace with the main views and a right panel with the Analyst
conversation.

### Dashboard

![Dashboard view](/screenshots/dashboard.png)

The Dashboard shows the current runtime status, the current card, and the two
direct runtime controls: **Stop project** and **Restart server**. Stop halts
the run (it is a halt, not a cancellation — cards keep their state and
continue through ordinary recovery after the next Run). Restart server is a
confirmed service restart, available only when bearer authentication is
enabled. The other runtime controls — Run, Pause, Resume — live in the
Analyst panel, not here.

### Cards

![Cards view](/screenshots/cards.png)

Cards is the heart of the UI: the work tree. Every node is a card with a
status (backlog, changed, running, blocked, stopped, done, failed,
cancelled). Selecting a card opens its detail: the workflow position, the
configured records (commonly `brief.md`, `status.md`, `review.md`),
dependencies, children, and full
history with version diffs. This is where you see the project's shape and
where every result is traceable to evidence.

### Agents

![Agents view](/screenshots/agents.png)

Agents lists the named-agent sessions — the Analyst and Oversight global
conversations plus every card-scoped session that exists. Opening a session
shows the redacted transcript: provider messages, tool calls and results, and
safe exchange metadata. It is a live view into what the runtime is doing
right now.

### Files

![Files view](/screenshots/files.png)

Files exposes the canonical generated state as a readable virtual file tree —
card documents and their versioned records. Physical stream paths are never
shown; this is the evidence browser behind the Cards view.

### Debug

![Debug view](/screenshots/debug.png)

Debug holds the diagnostics: runtime state, the compiled workflow graphs,
and current errors. It is read-only. **Debug > Graphs** is the place to
verify what a configuration change actually compiled into.

## Talking to the Analyst

The right-hand conversation is the ordinary operator surface. Everything you
want changed goes through it in plain language:

- **Start work**: describe the objective (or point at a spec file), settle
  the root brief (the root card's `brief.md` objective record), then ask it
  to start the project. The Analyst calls `start_project` and the runtime
  takes over.
- **Steer**: ask for a new card, a reorder, a reopen of finished work, a
  cancellation, or an edit to a brief. The Analyst applies it with the
  proper audit trail.
- **Ask**: the Analyst has read tools — it can report state, read sessions,
  and summarize progress on request.

Runtime control is split by surface: **Run, Pause, and Resume are Analyst
panel controls**; **Stop project** and the confirmed **Restart server** are
the Dashboard's two direct actions. The CLI (`saivage status`, `pause`,
`resume`, `stop`, `restart_server`) drives the same operations through the
lifecycle lock.

## The rhythm of a long run

1. **Launch**: brief settled, project started. The tree grows as the Planner
   decomposes the objective and activates children.
2. **Watch — or don't**: sessions show live work; records accumulate
   evidence. Saivage keeps working between your visits.
3. **Answer when asked**: a card settles `blocked` when a genuine decision,
   resource, or input is missing; its blocked result records what is needed.
   Nothing is pushed at you — you see the blocked status in the tree (and
   Oversight may flag it). Provide the decision or input through the Analyst
   conversation and ask for the blocked work to be reopened. See
   [activation outcomes](../spec/system-specification.md#6-activation-outcomes-and-cancellation).
4. **Oversight checks in**: with the default two-hour cadence, the Oversight
   agent periodically reviews state read-only and, when warranted, sends an
   evidenced notification to a planning card — visible as new activity and
   a notification-driven re-entry in the tree. It never mutates anything
   itself. See [Project Oversight](../spec/system-specification.md#project-oversight).
5. **Accept**: completed planning work passes independent review against its
   brief. The root turns `done` when the whole objective is accepted.

After an interruption (Stop, crash, restart), cards retain their state. A
fresh **Run** — asking the Analyst to start the project again — performs the
full-chain recovery and continues. See
[Run, Pause, Resume, Stop, and Restart](../spec/system-specification.md#7-run-pause-resume-stop-and-restart).

## Reading evidence

- **Card detail → Records**: the accepted briefs, statuses, and reviews.
- **Card detail → History**: every version with diffs.
- **Agents → session**: full redacted transcripts including every command
  run and its bounded output, with durable log URLs.
- **Files**: canonical documents behind the projections.

## Where to go next

- [Configuration](./configuration.md) for providers, routes, and workflows.
- [Operator runbook](../runbook/index.md) for lifecycle, recovery, and reset
  procedures (authoritative).
- [What is Saivage](../overview.md) for the model behind the UI.
