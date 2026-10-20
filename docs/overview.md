# What is Saivage?

Saivage coordinates software work in a target project over long runs. You supply
an objective and constraints; configured agents break work down, perform tasks,
assess results and revise plans. The web control room lets you follow the work and
ask the Analyst to steer it. It can support a bounded fix or a much larger project;
completion time, correctness and minimal intervention are goals, not guarantees.

This is an explanation. Exact behavior belongs to the [system specification](spec/system-specification.md),
presentation to the [UI contracts](spec/operator-ui-contracts.md), and operating
procedures to the [runbook](runbook/index.md).

## From objective to cards and workflows

The work tree begins with one **project card**, whose fixed identity is `project`.
A card is a unit of work with a title, lifecycle state, records and a configured
**workflow**. Planners can create child cards, such as `card-a` and `card-a-b`.
Identity describes ancestry, not display order or a task's mutable title.

A workflow is a graph of **nodes** and outcome **edges**. A node either invokes a
named agent or runs a finite action. Its edges determine the next node or terminal
outcome. An **activation** is one execution of this graph, admitted and coordinated
by the runtime; it is not the same thing as an agent's persistent conversation.

For example, a project might delegate a code task, then inspect its result and
request review. The `classic` profile gives most leaf types one execution node;
`classic-typed` and `paad-typed` give them specialized graphs, such as
code red→green→refactor and test diagnose/coverage/repair/verify paths. Those paths
are configured work policies, not a hard-coded universal development lifecycle.
See [profile selection](guides/configuration.md#choose-a-fresh-profile).

Cards use `backlog`, `changed`, `running`, `blocked`, `stopped`, `done`, `failed`
and `cancelled`. A state describes runtime acceptance, not independent proof that
the software works. An owning Planner may reopen its own done/failed child for
correction; cancelled work remains terminal. The complete
[lifecycle contract](spec/system-specification.md#exact-card-lifecycle-vocabulary)
owns the allowed transitions.

## Agents and actions

| Responsibility | Typical bundled role |
| --- | --- |
| Turn operator context into project changes and runtime-control requests | **Analyst**, a global agent |
| Decompose, order and activate child work; assess and replan | **Planner**, on planning cards |
| Implement, investigate, test or document the current task | **Executor**, on leaf work |
| Independently assess configured planning or architecture results | **Reviewer** |
| Periodically inspect running work and send evidenced notifications | **Oversight**, an optional global agent |

Names do not grant authority. Each declaration selects a prompt, model route,
session scope, exact tools and record-write patterns. The card type separately
restricts child types and workflow participants. Bundled Planners delegate rather
than implementing/building/testing themselves. Oversight is read-only apart from
its notification intervention; it is not another execution owner.

An **action**, such as `shell.run`, has no model or conversation. It receives typed
inputs, executes its compiled operation and returns a declared outcome. Required
checks belong before acceptance in the graph. An optional postcommit hook is
advisory and cannot turn an accepted DONE into an unaccepted result.

## Execution and review

1. You settle the root objective with the Analyst, then explicitly request a **Run**.
2. The runtime activates the root. Its configured Planner can create and activate
   children, supplying current direction through the supported activation operation.
3. Agents use their tools; actions use their declared capabilities. Record gates,
   dependency rules and configured outcomes govern acceptance.
4. Results return to the parent. It can accept, arrange review, reopen its own
   child for correction, replan, or report a missing decision. Bundled root workflows
   include a Planner completion assessment after approved review: remaining
   authorized work leads back to planning, not premature project completion.
5. You inspect and steer while the Run continues, or deliberately pause/stop it.

Normal notifications supply context; urgent notifications can interrupt exact
active work and cause recipient-first recovery. Queueing is not proof of delivery
or action. After a server interruption, successful startup settles the interrupted
linked card chain to stopped without launching work. A later explicit Run starts
at the root; descendants require ordinary parent activation.

**Pause** gates new provider work cooperatively; it is not a barrier for every
action or command. **Resume** continues the paused Run. **Project Stop** contains
project execution but leaves the application and Analyst available. Application
close and confirmed server restart are different operations. Use the
[control decision table](runbook/runtime-control.md#choose-the-control), not these
short definitions, when operating an instance.

## Records, conversations and evidence

Cards own Markdown **records**. Bundled types use `brief.md` for their objective,
`status.md` for work status and, where declared, review records. Custom types choose
their own bootstrap and other names. A replaceable **head** selects the latest
accepted immutable document and any current draft.

- **Baseline0** is configured starter data, not authored acceptance. A draft may
  coexist with an older accepted document.
- An accepted **document number** is not the mutable head **revision**. Exact
  current selections also carry a head UUID. Historical selections have no current
  write authority.
- Authorship can be agent, runtime bootstrap/repair, shell stdout or external
  credential-holder attribution. Authorship alone is not a review verdict.

A named card agent keeps a stable **session**, normally `agent:<name>:<card-id>`;
globals have project-wide sessions. Its retained conversation may span multiple
indexed **segments**. Compaction summarizes covered history into a successor while
retaining required context under the owning contract. It is deliberately
loss-tolerant, not a promise that all old narrative survives.

**Prepared instructions** show retained preparation, not proof of exact delivery
or model perception. **Currently configured instructions** use the server's loaded
configuration, not edited disk files or a reconstructed historical request. Fresh
record context is selected for each logical model operation; a brief is not simply
frozen for an entire session. See [instruction evidence](runbook/evidence.md#prepared-current-and-historical-instructions).

The same distinction applies elsewhere: a recorded image selects captured pixels,
not the current source image or proof the provider saw them; missing process output
does not establish that a process is running or completed; action execution rows
are not conversations. Body-free external-operation receipts are not a universal
audit or delivery ledger. See [how to read evidence](runbook/evidence.md).

## Observe and steer

- **Cockpit**: a tree plus Overview, Conversations, Executions, Records & History
  and Evidence facets for a selected card. Exact global sessions have no invented card.
- **Files**: admitted, server-projected workspace and virtual canonical documents,
  not unrestricted access to physical persistence or secrets.
- **System**: diagnostics, processes, configured integrations and loaded workflow
  observations. Provider availability is process-local, not a durable health guarantee.
- **Analyst**: ordinary operator conversation and supported mutations. Startup can
  instead expose an external Analyst MCP interface, or both interfaces. External
  tools are concurrent operations, not a shared internal chat.
- **CLI/API**: control and observation interfaces; the CLI delegates runtime controls
  using the verified live lifecycle owner's published endpoint.

The browser has no token-entry/sign-in flow. Deployment-owned isolation and operator
authentication decisions must be established before exposure. Saivage does not
create that isolation; trusted command-capable agents can modify the target and Git.
Provider calls can incur charges, including later Analyst calls after project Stop.

## Persistence and adoption

Saivage-owned durable state uses ordinary files, not a database. Current selectors
and strict owning readers define what is canonical; unselected temporary/unlinked
artifacts are ignored, not discovered for recovery. Persistence supplies no
guarantee against loss after interruption or corruption.

An existing project that fails startup needs diagnosis, not another fresh-init
recipe. Current-format damage, incompatible adoption and intentional destructive
reset are different cases. The [state-adoption decision map](runbook/state-adoption.md#choose-the-operation)
owns their complete gates. Previous selectors are not normal fallback or old-format
converters. This documentation changes no format and grants no deployment, reset,
repair or migration permission.

## Glossary

| Term | Meaning / precise owner |
| --- | --- |
| Brief | Objective and acceptance context; bundled `brief.md`, not a universal custom record name |
| Card / node | Card is a work-tree item; node is a step in that card's configured workflow |
| Record / document / head | Record is the named product; document is an accepted immutable version; head selects accepted/draft state |
| Revision / selection identity | Mutable current counter / exact UUID selection; neither is a durable family format version |
| Session / activation | Persistent agent conversation / one admitted card workflow execution |
| Segment | One indexed conversation body; ordinal alone is not its UUID identity |
| Run / service epoch | Explicit project execution / one server-process lifetime |
| Notification | Pending card context for its designated recipient; not delivery confirmation |
| Prepared request / exact admission | Prepared context / candidate-specific check of complete serialized request capacity |
| Tombstone | Retained deleted-card selection that ends linked traversal |
| Publication outcome-unknown | Potentially committed write failure; [fatal no-follow-up boundary](runbook/diagnosis.md#publication-uncertainty), not permission to retry |
| Cutover | Adoption of changed contracts/identities under the [state-adoption procedure](runbook/state-adoption.md), not a format probe or automatic conversion |
| Lifecycle lock | Exceptional process-exclusion boundary; [five ownership outcomes](runbook/runtime-control.md#five-ownership-outcomes) |

## Next steps

[Try a disposable project](guides/getting-started.md), [operate the cockpit](guides/operating.md),
[configure an instance](guides/configuration.md), or [trace the implementation](guides/development.md).
For a precise question, use the [owner map](reference/agent-navigation.md).
