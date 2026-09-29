# Operating a project

Status: non-authoritative guide. Exact UI behavior is owned by the
[Operator UI needs](../spec/operator-ui-needs.md) and
[contracts](../spec/operator-ui-contracts.md) registers; runtime behavior by the
[System specification](../spec/system-specification.md); procedures by the
[Operator runbook](../runbook/index.md).

Saivage works autonomously for long stretches. Your job as operator is to
launch it, stay oriented, answer the rare question, and accept results. This
guide shows where everything lives and the small set of interactions you
actually use. For card, brief, session, and epoch terminology, see the
[glossary](../overview.md#glossary).

## The control room

Open `http://<host>:<port>/`. The whole application is the **control room**;
its **card cockpit** is the **Cockpit** destination's layout: a global strip
across the top, the card tree on the left, the card workspace in the center,
and the Analyst conversation on the right. Primary navigation is
**Cockpit | Files | System**; the Analyst panel stays beside every
destination.

The five views below come from an **illustrative, disposable local fixture**:
an auth-disabled loopback instance with a synthetic provider and a fictional
release checklist. The Analyst created a child, the configured card agents
completed it, and the project settled. **Stopped** and **No current work** in
these pictures are real observations of that completed run, not simulated live
activity. Open an image at full size to read its smaller labels.

There is no sign-in screen and no token entry. Deployments are expected to
run auth-disabled behind deployment-owned isolation; a bearer-configured
deployment shows an honest unauthorized state instead.

### The global strip

The strip answers orientation in one place: project identity, runtime
lifecycle, the current work link, the independent REST and socket
observation conditions, and the Oversight epoch status. Its only direct
runtime control is capability-gated, confirmed **Restart server**; it does
not start project work. Ask the Analyst to start or stop project work, or
to pause or resume it.
The **Updates** disclosure explains what refreshes from WebSocket hints
(cards, conversations, records) versus what needs explicit Refresh (Files,
Processes, Events).

### Cockpit

![A settled project card in the cockpit: global status strip, expanded child in the tree, objective and records in Overview, and persistent Analyst conversation.](/screenshots/cockpit-overview.png)

*Cockpit Overview — a completed fictional checklist, with its source-backed objective, recorded result, card tree and Analyst panel still visible.*

Home opens the Overview of the current card (or says **No current work**
when the project is settled). The card workspace is the heart of the UI: a
persistent compact card-flow header gives the represented chain and one
plain-language **Observed workflow step**. Open **Workflow & technical details**
for exact position, publication facts, and configured outcomes/workflow; those
mechanics are bounded and scrollable so the selected facet or transcript keeps
usable space. The workspace has four facets:

- **Overview** — the source-backed objective first, then activity and
  participants, the neutral recorded result and independently loaded declared
  records, problems/waiting, and parent/related work. Record excerpts identify
  Draft or Accepted effective content and disclose the complete content here;
  arbitrary record names are not interpreted as progress. A missing wait reason
  stays unknown, and `done` means accepted as done rather than independently
  verified correctness.
- **Conversations** — a participant rail of the card's exact named-agent
  sessions; choosing one opens the single exact reader while the selected tree,
  four tabs, card header, and rail stay in view. Direct links to an admitted
  card session open that same contextual cockpit.

  ![Conversations facet with the project Planner selected, showing a real synthetic tool transcript beside the card tree and participant rail.](/screenshots/cockpit-conversations.png)

  *Conversations — the Planner's settled session records a status write, child activation and review handoff; idle means the session is not currently executing.*
- **Records & History** — every declared record in declaration order plus
  card versions, snapshots, and diffs.

  ![Records and History facet showing the fictional review record and a selected prior card version with its diff.](/screenshots/cockpit-records-history.png)

  *Records & History — an accepted review record above the selected first card version and its comparison with current state.*
- **Evidence** — source-labeled catalogs (card versions, record revisions,
  session segments) with exact links, plus a bounded card-scoped events
  tail. Use it to open the exact version, revision or segment behind an
  observation; the event tail is scoped to this card rather than a global
  execution narrative.

The tree is the structural spine: lazy discovery, committed order, and
color-only lifecycle markers. Select a row for exact lifecycle text and card
detail. There is **no tree title/state search or filter**: expand branches
manually, or ask the Analyst to find work by known information or state.

### Files

![Files view browsing the virtual project card directory and previewing its fictional brief.md record.](/screenshots/files.png)

*Files — the canonical virtual tree and a selected synthetic brief; the preview is server-redacted even though the example has no credentials.*

Files exposes the canonical generated state as a readable virtual file tree
— card documents and their versioned records. Physical stream paths are
never shown; this is the evidence browser behind the cockpit.

### System

![System Provider availability view showing four locally configured fixture models as healthy routing candidates.](/screenshots/system-provider-availability.png)

*System → Provider availability — process-local routing diagnostics for the fixture provider, not a claim about a commercial service or a durable health guarantee.*

System consolidates the diagnostics — runtime state, operator observation,
cross-card Participants, Errors, Events, Processes, MCP, Provider
availability, saved Configuration, Installed workflows, settled Actions,
and the manual Doctor. Sections read on selection; opening System fetches
nothing. **System > Installed workflows** is the place to verify what a
configuration change actually compiled into.

## Talking to the Analyst

The right-hand conversation is the ordinary surface for changing project work.
Ask the Analyst in plain language:

- **Start work**: describe the objective (or point at a spec file), settle
  the root brief (the root card's `brief.md` objective record), then ask it
  to start the project. The Analyst calls `start_project` and the runtime
  takes over.
- **Pause, resume, or stop work**: ask the Analyst in the conversation. A
  project Stop halts work without shutting down the server.
- **Steer**: ask for a new card, a reorder, a reopen of finished work, a
  cancellation, or an edit to a brief. The Analyst applies it with the
  proper audit trail.
- **Ask**: the Analyst has read tools — it can report state, read sessions,
  and summarize progress on request.

Runtime control is split by surface: request project Run (start), Pause,
Resume, or Stop in conversation with the Analyst. The global strip offers
only the capability-gated, confirmed **Restart server** action, which shuts
down the server rather than starting project work. The CLI (`saivage status`,
`pause`, `resume`, `stop`, `restart_server`) drives the same operations through
the lifecycle lock.

## The rhythm of a long run

1. **Launch**: brief settled, project started. The Planner may decompose the
   objective and activate children; the tree does not necessarily grow on
   every turn.
2. **Watch — or don't**: sessions show work; records accumulate evidence.
   A reply may take seconds to minutes and meaningful project work can take
   hours or longer. If nothing seems to progress, inspect the selected card's
   **Conversations** and **Records & History**, then **System → Errors** and
   **System → Provider availability**; ask the Analyst for an observation.
   Saivage keeps working between your visits while the project is running.
3. **Answer when asked**: a card settles `blocked` when a genuine decision,
   resource, or input is missing; its blocked result records what is needed.
   Nothing is pushed at you — you see the blocked status in the tree (and
   Oversight may flag it). Provide the decision or input through the Analyst
   conversation and ask for the blocked work to be reopened. See
   [activation outcomes](../spec/system-specification.md#6-activation-outcomes-and-cancellation).
4. **Oversight checks in**: with the default two-hour cadence, the Oversight
   agent periodically reviews state read-only and, when warranted, sends an
   evidenced notification to a planning card — visible as new activity and
   possible notification-driven re-entry in the tree. Normal context can queue
   while running; justified urgent context may stop exact active work and enter
   recipient-first recovery. A paused run needs Resume; a queue-only result
   needs explicit Run for later execution, without guaranteeing model action.
   It never mutates anything
   itself. See [Project Oversight](../spec/system-specification.md#project-oversight).
5. **Accept**: completed planning work passes independent review against its
   brief. The root turns `done` when the whole objective is accepted.

After a crash or server restart, successful new-server startup settles the
interrupted linked running cards to stopped before the control room is available,
without launching work. After same-process project Stop, durable cards can remain
running until the next explicit Run. Ask the Analyst to start the project again
to launch only the root through STOPPED; descendants resume only through ordinary
parent activation. See
[Run, Pause, Resume, Stop, and Restart](../spec/system-specification.md#7-run-pause-resume-stop-and-restart).

## Reading evidence

- **Card > Records & History**: the accepted briefs, statuses, and reviews,
  plus every card version with diffs.
- **Card > Conversations** (or an admitted card-session link): full redacted
  transcripts including every command run and its bounded output, with durable
  log URLs, inside the persistent card cockpit. A global session instead shows
  global purpose with no invented card context. If a retained exact session's
  card flow is unavailable, its exact ID and transcript remain while unavailable
  card facets are disabled and no hierarchy is invented.
- **Card > Evidence**: bounded event tails and source-labeled version,
  revision, and segment catalogs.
- **Files**: canonical documents behind the projections.

## Where to go next

- [Configuration](./configuration.md) for providers, routes, and workflows.
- [Operator runbook](../runbook/index.md) for lifecycle, recovery, and reset
  procedures (authoritative).
- [What is Saivage](../overview.md) for the model behind the UI.
