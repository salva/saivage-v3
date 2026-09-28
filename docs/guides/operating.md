# Operating a project

Status: non-authoritative guide. Exact UI behavior is owned by the
[Operator UI needs](../spec/operator-ui-needs.md) and
[contracts](../spec/operator-ui-contracts.md) registers; runtime behavior by the
[System specification](../spec/system-specification.md); procedures by the
[Operator runbook](../runbook/index.md).

Saivage works autonomously for long stretches. Your job as operator is to
launch it, stay oriented, answer the rare question, and accept results. This
guide shows where everything lives and the small set of interactions you
actually use.

## The control room

Open `http://<host>:<port>/`. The screen is a card cockpit: a global strip
across the top, the card tree on the left, the card workspace in the center,
and the Analyst conversation on the right. Primary navigation is
**Cockpit | Files | System**; the Analyst panel stays beside every
destination.

There is no sign-in screen and no token entry. Deployments are expected to
run auth-disabled behind deployment-owned isolation; a bearer-configured
deployment shows an honest unauthorized state instead.

### The global strip

The strip answers orientation in one place: project identity, runtime
lifecycle, the current work link, the independent REST and socket
observation conditions, and the Oversight epoch status. Its two direct
runtime controls are **Stop project** and the confirmed **Restart server**.
The **Updates** disclosure explains what refreshes from WebSocket hints
(cards, conversations, records) versus what needs explicit Refresh (Files,
Processes, Events).

### Cockpit

Home opens the Overview of the current card (or says **No current work**
when the project is settled). The card workspace is the heart of the UI: a
persistent card-flow header answering *Context* (the represented chain),
*Observed now* (the runtime-projected workflow position), and *Possible
outcomes* (configured transitions, clearly not execution history), with four
facets:

- **Overview** — situation, participants with backend liveness, latest
  result, declared records, and children/siblings.
- **Conversations** — a participant rail of the card's exact named-agent
  sessions; choosing one opens the exact session reader with the card header
  and rail still in view.
- **Records & History** — every declared record in declaration order plus
  card versions, snapshots, and diffs.
- **Evidence** — source-labeled catalogs (card versions, record revisions,
  session segments) with exact links, plus a bounded card-scoped events
tail.

The tree is the structural spine: lazy discovery, committed order, and a
text lifecycle status on every row. Expand branches manually and select a row
to inspect that exact card; ask the Analyst to find work by known information
or state.

### Files

Files exposes the canonical generated state as a readable virtual file tree
— card documents and their versioned records. Physical stream paths are
never shown; this is the evidence browser behind the cockpit.

### System

System consolidates the diagnostics — runtime state, operator observation,
cross-card Participants, Errors, Events, Processes, MCP, Provider
availability, saved Configuration, Installed workflows, settled Actions,
and the manual Doctor. Sections read on selection; opening System fetches
nothing. **System > Installed workflows** is the place to verify what a
configuration change actually compiled into.

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
the global strip's two direct actions. The CLI (`saivage status`, `pause`,
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

- **Card > Records & History**: the accepted briefs, statuses, and reviews,
  plus every card version with diffs.
- **Card > Conversations** (or any session link): full redacted transcripts
  including every command run and its bounded output, with durable log URLs.
- **Card > Evidence**: bounded event tails and source-labeled version,
  revision, and segment catalogs.
- **Files**: canonical documents behind the projections.

## Where to go next

- [Configuration](./configuration.md) for providers, routes, and workflows.
- [Operator runbook](../runbook/index.md) for lifecycle, recovery, and reset
  procedures (authoritative).
- [What is Saivage](../overview.md) for the model behind the UI.
