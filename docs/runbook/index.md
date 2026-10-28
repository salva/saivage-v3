# Operator runbook

Native quality analysis is explicitly configured, never installed on invocation.
Use [qualification](../reference/quality-tool-qualification.md),
[opt-in configuration](../guides/configuration.md#opt-in-to-native-quality-evidence)
and [evidence limits](./evidence.md) before enabling its optional actions/tools.

For the normal objective → work → outcome journey, start with the
[overview](../overview.md) and [work tour](../guides/operating.md). Use this runbook
when commissioning, deliberate control or a problem calls for an operation—not
as a required checklist for every agent turn.

Choose the operation from the observed need. Do not start with repair/reset
when you need ordinary control or clearer evidence. The runbook owns procedures;
[system requirements](../spec/system-specification.md),
[operator contracts](../spec/operator-ui-contracts.md) and
[architecture](../architecture/system-architecture.md) explain their contracts and
owners. Project policy remains in
[AGENTS.md](https://github.com/salva/saivage-v3/blob/HEAD/AGENTS.md).

## Choose the safe next task

| I need to… | Start here | Decision boundary |
|---|---|---|
| Try Saivage on a fresh isolated target | [Getting started](../guides/getting-started.md) | Init/provider setup/server start/objective/Run are distinct |
| Build/install/start an identified service | [Deployment](./deployment.md) | Deployment-owned isolation/auth; verify exact release/project/owner |
| Configure routes, workflows, records or prompts | [Configuration](../guides/configuration.md), [stopped input adoption](./state-adoption.md#selected-configuration-and-prompts) | No live reload or implicit identity upgrade |
| Pause, resume, stop or start project work | [Runtime control](./runtime-control.md#choose-the-control) | Pause gates providers; Stop contains card work, not server/listeners |
| Verify a lifecycle owner or abandoned lock | [Ownership outcomes](./runtime-control.md#five-ownership-outcomes) | Only verified live delegates; no automatic removal/takeover |
| Replace the server process | [Confirmed restart](./runtime-control.md#confirmed-server-restart) | Separate bearer-authenticated confirmation; acknowledgement is not boot proof |
| Explain a startup/API/provider/context failure | [Diagnosis](./diagnosis.md) | Read exact evidence, preserve unknowns; no blind retry or reset |
| Connect an external client directly to Analyst | [Inbound MCP](./mcp.md#external-client-to-analyst) | Startup flags/independent secret/project-bound loopback handshake |
| Give Saivage tools from another MCP server | [Outbound MCP](./mcp.md#saivage-tools-to-configured-mcp-servers) | YAML/dynamic connection plus separate grants/discovered identities |
| Prepare native observation of approved source roots | [Observed collections](./observed-collections.md) | Offline prepare; separate adoption starts native watchers, no manual indexes or universal embeddings |
| Inspect records, instructions, executions, output or images | [Evidence](./evidence.md) | Current observation, retained provenance and provider perception differ |
| Reclaim unreferenced ordinary work | [Explicit work GC](./work-gc.md) | Preview first; separate fresh delete, paused/stopped server hold or confirmed offline bound lock, irreversible effects |
| Repair damaged **current-format** selected state | [Exact-target repair](./state-adoption.md#current-format-repair) | Stopped/excluded, complete fresh backup, report and exact typed consent |
| Adopt incompatible formats/participating identities | [Adoption decision](./state-adoption.md#choose-the-operation) | Remain stopped; explicit reset or owner-requested external migration |
| Intentionally discard generated history | [Destructive reset](./state-adoption.md#destructive-reset) | Concrete loss consent and complete stopped backup; four roots only |
| Preserve retained history across an incompatible release | [External offline migration](./state-adoption.md#explicit-external-offline-migration) | Explicit identified-project request, independent complete candidate, strict validation/fidelity |
| Handle publication uncertainty | [Stop on uncertainty](./state-adoption.md#stop-on-uncertainty) | No follow-up read/write/retry/inspection/cleanup |

## Common prerequisites

* Identify exact project, service/process, release, selected inputs and operation
  authorization. Historical deployment notes do not identify today's owner or grant
  permission. [Deployment boundaries](./deployment.md#identify-the-deployment-boundary)
  separate target/release/container/network responsibilities.
* Preserve external authentication and outbound confidentiality. No tokens in URLs,
  no provider-config/credential/transcript dumps, no assumption the public UI/docs
  grants protected API access. [Authentication](./deployment.md#authentication-and-public-docs)
  supplies private browser setup despite the UI's no-login boundary.
* Offline mutation requires positive owner exclusion and successful complete preserved
  backup, not just a stopped unit or an existing archive. Follow
  [offline prerequisites](./deployment.md#offline-exclusion-and-complete-backups),
  then the selected procedure's additional consent/effect rules.
* Runtime accepts only its exact current contracts. The
  [durable format reference](../architecture/durable-format-changes.md) is source
  evidence, not installation inventory, whole-project compatibility or adoption consent.
  Harmless noncanonical files stay ignored; never scan/clean/adopt orphans.

## Command and location reference

Run target-local commands from the exact project root with the identified release.

| Task | Command/location |
|---|---|
| Fresh init | `saivage init [--profile classic\|classic-typed\|paad-typed]` |
| Start server | `saivage start --project-root <absolute-root> --config <absolute-yaml> --host <host> --port <port>` |
| Read/control live runtime | `saivage status`, `pause`, `resume`, `stop` |
| Confirm server restart | `saivage restart_server` (bearer mode only) |
| Preview optional work reclamation | `saivage gc-work --dry-run` (use the [full procedure](./work-gc.md) before `--delete`) |
| Public health | `/health`, `/health/ready` |
| Public web/docs | `/`, `/docs/` (`/docs` redirects) |
| Selected default YAML | `.saivage/saivage.yaml` |
| Lifecycle exclusion | `.saivage/locks/runtime.lock` (not reset-owned) |
| Reset-owned generated roots | `.saivage/cards`, `.saivage/agents`, `.saivage/logs`, `.saivage/work` |

The [command-selection matrix](../reference/configuration.md#command-specific-input-selection)
distinguishes Start, exact-cwd offline commands and ancestor-selected controls.
Do not execute repair/reset/migration from a quick command table: use their complete
procedures. Starting/restarting a server does not Run a project; an explicit Run
does not authorize deployment, repair or data loss.
