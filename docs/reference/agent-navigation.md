# Agent navigation: question to owner

Start with the question, open the owning heading below, then follow its source
contract if the answer needs implementation detail. Cite the exact heading and
source you actually consumed; distinguish a current rule, historical observation
and unknown deployment fact. This is a retrieval map, not another policy document
or permission to operate a project.

## Choose the kind of authority

| Kind | Use it for | Not evidence of |
| --- | --- | --- |
| [AGENTS.md](https://github.com/salva/saivage-v3/blob/master/AGENTS.md) and explicit owner instructions | Development/storage/safety/workflow policy | Consent inferred from a design or passing test |
| [System specification](../spec/system-specification.md), [UI needs](../spec/operator-ui-needs.md), [UI contracts](../spec/operator-ui-contracts.md) | Required behavior and presentation | Measured implementation conformance |
| [Runbook](../runbook/index.md) | Actual operating procedure and decision gates | Automatic authorization to execute it |
| [Architecture](../architecture/system-architecture.md), source/schema | Ownership and exact implementation contract | A replacement for an unmet requirement |
| [Durable format reference](../architecture/durable-format-changes.md) | Current source baseline and bounded dated change evidence | Installation inventory, supported old reader or permission to normalize |
| [Guides](../guides/getting-started.md), [overview](../overview.md), field lookup | Learning/tasks/explanation/current lookup | A competing normative policy |
| `docs/working/` | Local task plan/review/provenance, when assigned | Published authority or completed implementation |

## Analyst, MCP and lifecycle

| Exact question | Owning heading | Source/contract to inspect |
| --- | --- | --- |
| Can project Stop terminate the external Analyst listener? | [Project Stop and application close](../runbook/runtime-control.md#project-stop-and-application-close); [Calls, disconnect and lifecycle](../runbook/mcp.md#calls-disconnect-and-lifecycle) | [`server-services.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/server/composition/server-services.ts), [`external-analyst-operations.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/application/external-analyst-operations.ts), [`analyst-mcp-server.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/server/analyst-mcp-server.ts) |
| How do I choose internal/external/both and a tool subset? | [Inbound Analyst startup selection](configuration.md#inbound-analyst-startup-selection) | [`resolveAnalystStartup`](https://github.com/salva/saivage-v3/blob/HEAD/src/config/analyst-mode.ts); [`cli.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/cli.ts) |
| How does an external client connect, initialize, get context and discover tools? | [Initialize, inspect context and discover tools](../runbook/mcp.md#initialize-inspect-context-and-discover-tools) | [`analyst-mcp-server.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/server/analyst-mcp-server.ts), [real SDK fixture](https://github.com/salva/saivage-v3/blob/HEAD/tests/server/external-analyst-mcp.test.ts) |
| Does disconnect cancel admitted work or permit replay? | [Calls, disconnect and lifecycle](../runbook/mcp.md#calls-disconnect-and-lifecycle) | [`external-analyst-operations.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/application/external-analyst-operations.ts), [`invokeTool`](https://github.com/salva/saivage-v3/blob/HEAD/src/tools/invocation.ts) |
| Where does external record attribution live? | [Authorship is not a verdict](../runbook/evidence.md#authorship-is-not-a-verdict); [Analyst operations and external clients](../spec/system-specification.md#analyst-operations-and-external-clients) | [`operation-author.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/schemas/operation-author.ts), [`record-author.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/schemas/record-author.ts), [`canonical-record-artifacts.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/persistence/canonical-record-artifacts.ts) |
| Are receipts a shared chat, complete audit or delivery proof? | [Control events, notifications and external receipts](../runbook/evidence.md#control-events-notifications-and-external-receipts) | [`external-tool-call.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/application/external-tool-call.ts), [app-log contract](https://github.com/salva/saivage-v3/blob/HEAD/src/contracts/app-log.ts) |
| Is outbound MCP the same listener? | [Saivage tools to configured MCP servers](../runbook/mcp.md#saivage-tools-to-configured-mcp-servers) | [`mcp-manager.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/mcp/mcp-manager.ts), [`server-definitions.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/mcp/server-definitions.ts) |
| Restart connection, refresh catalog, or restart remote server? | [Stop, replace, restart or refresh](../runbook/mcp.md#stop-replace-restart-or-refresh) | [`server-runtime.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/mcp/server-runtime.ts), [`streamable-http-transport.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/mcp/streamable-http-transport.ts), [`stdio-transport.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/mcp/stdio-transport.ts) |
| What are invocation deadlines, roots, native text/images and result limits? | [Deadlines, roots and process ownership](../runbook/mcp.md#deadlines-roots-and-process-ownership); [Native results and image limits](../runbook/mcp.md#native-results-and-image-limits) | [`server-runtime.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/mcp/server-runtime.ts), [`mcp-native-result.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/tools/mcp-native-result.ts) |
| Pause versus Resume versus Run/Stop/close/restart? | [Choose the control](../runbook/runtime-control.md#choose-the-control) | [`supervisor-runtime-api.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/runtime/actors/supervisor-runtime-api.ts), [`boot/app.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/boot/app.ts), [`restart-port.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/boot/restart-port.ts) |
| Which lock observation allows CLI delegation? | [Five ownership outcomes](../runbook/runtime-control.md#five-ownership-outcomes) | [`readRuntimeLockStatus`](https://github.com/salva/saivage-v3/blob/HEAD/src/runtime/lock.ts), [`cli.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/cli.ts) |

The inbound procedure is the source for separate bearer/loopback/project-digest
binding, protocol2025-11-25, both Accept types and prohibited Origin/query/session/
batch/GET-stream. Do not turn its SDK example into a generic remote deployment
recipe. The outbound pinned browser recipe is a different task and is not a live
launch instruction merely because a reader found it.

## Evidence and uncertainty

| Exact question | Owning heading | Source/contract to inspect |
| --- | --- | --- |
| Is document0/draft/accepted number the head revision? | [Baseline0, drafts and accepted documents](../runbook/evidence.md#baseline0-drafts-and-accepted-documents) | [`authored-record-files.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/persistence/authored-record-files.ts), [`canonical-record-artifacts.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/persistence/canonical-record-artifacts.ts) |
| Does a recorded image establish provider perception or current source pixels? | [Current file versus recorded image](../runbook/evidence.md#current-file-versus-recorded-image); [Explicit image observations](../spec/system-specification.md#explicit-image-observations) | [`conversation-image.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/persistence/conversation-image.ts), [`tool-result-settlement.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/tools/tool-result-settlement.ts), [`openai-content-serializer.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/agents/openai-content-serializer.ts) |
| Current loaded instructions, historical preparation, or exact provider request? | [Prepared, current and historical instructions](../runbook/evidence.md#prepared-current-and-historical-instructions) | [`activation-instructions.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/schemas/activation-instructions.ts), [`agent-operator-read-model.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/application/read-models/agent-operator-read-model.ts), [`bootstrap-context.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/runtime/records/bootstrap-context.ts) |
| Missing process output: running, completed or unavailable? | [Process state and missing output](../runbook/evidence.md#process-state-and-missing-output) | [`process-view.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/application/read-models/process-view.ts), [`operator-api-processes.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/contracts/operator-api-processes.ts) |
| Where is action/hook evidence rather than a conversation? | [Action execution and stdout](../runbook/evidence.md#action-execution-and-stdout) | [`node-execution.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/runtime/actors/node-execution.ts), [`card-execution-log.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/persistence/card-execution-log.ts), [`operator-api-executions.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/contracts/operator-api-executions.ts) |
| Does a shell report author mean semantic approval? | [Authorship is not a verdict](../runbook/evidence.md#authorship-is-not-a-verdict) | [`record-author.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/schemas/record-author.ts), [`node-execution.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/runtime/actors/node-execution.ts) |
| Why did startup/provider/auth/context fail? | [Diagnosis](../runbook/diagnosis.md) and its symptom heading | [`environment.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/config/environment.ts), actual named failing consumer, not only a dashboard |
| May I retry/read/clean up after uncertain publication? | [Publication uncertainty](../runbook/diagnosis.md#publication-uncertainty) | [`publication-outcome.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/contracts/publication-outcome.ts), [`replace-file.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/persistence/replace-file.ts) |

Public evidence and sensitive private failed-request captures have different
owners. Missing evidence stays unknown. No row authorizes secret disclosure,
provider perception claims, or a universal “everything recorded” ledger.

## Configuration, extension and retained state

For commissioning, first resolve [command-specific inputs](configuration.md#command-specific-input-selection)
and [browser access/setup](../runbook/deployment.md#browser-access-across-namespaces).
Before offline mutation, use the [effective-input gate](../runbook/state-adoption.md#offline-command-inputs),
not Start's selectors. Current workflow declarations use format3; the
[literal-key adoption boundary](../runbook/state-adoption.md#workflow3-literal-protection-keys)
explains why historical workflow2 examples are not current inputs.

| Exact question | Owning heading | Source/contract to inspect |
| --- | --- | --- |
| Which YAML/default/capability is current? | [Configuration reference](configuration.md), grouped field heading | [`saivage-config.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/schemas/saivage-config.ts), [`resolved-config-authority.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/config/resolved-config-authority.ts), [`provider.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/agents/provider.ts) |
| How do I add an action and validate it? | [Add an action without inventing a plugin service](../guides/development.md#add-an-action-without-inventing-a-plugin-service); [Change a workflow](../guides/development.md#change-a-workflow-at-its-compiler-boundary) | [`operation-contract.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/runtime/card-process/operation-contract.ts), [`shell-operation.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/runtime/card-process/shell-operation.ts), [`workflow-action-compilation.test.ts`](https://github.com/salva/saivage-v3/blob/HEAD/tests/runtime/card-process/workflow-action-compilation.test.ts) |
| Where do tool grants/binding/projection belong? | [Add or change a tool at its existing binder](../guides/development.md#add-or-change-a-tool-at-its-existing-binder) | [`runtime-tool-catalog.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/tools/runtime-tool-catalog.ts), [`invocation.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/tools/invocation.ts), owning provider/projection |
| Where should reusable prompt method versus task delta live? | [Author prompts at the effective delivery owner](../guides/development.md#author-prompts-at-the-effective-delivery-owner) | [`prompt-api.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/utils/prompt-api.ts), [`AgentExecutor`](https://github.com/salva/saivage-v3/blob/HEAD/src/runtime/actors/agent-executor.ts); mandatory prompt-authoring skill |
| Can a previous selector repair old-format state? | [Choose the operation](../runbook/state-adoption.md#choose-the-operation); [Current selections, previous slots and orphans](../runbook/state-adoption.md#current-selections-previous-slots-and-orphans) | [`repair-target.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/persistence/repair-target.ts), [`publish-head.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/persistence/publish-head.ts), exact current schema |
| Which source owns current conversation format, and which adoption is permitted? | [Current source baseline](../architecture/durable-format-changes.md#current-source-baseline); [Explicit external offline migration](../runbook/state-adoption.md#explicit-external-offline-migration) | [`canonical-conversation-artifacts.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/persistence/canonical-conversation-artifacts.ts), [`conversation-file.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/persistence/conversation-file.ts), AGENTS Storage Policy |
| Upgrade failure, current damage or intentional reset? | [Choose the safe next task](../runbook/index.md#choose-the-safe-next-task), then [state-adoption decision](../runbook/state-adoption.md#choose-the-operation) | Exact source/target contracts and named failing consumer; readiness alone does not certify compatibility |
| Which check and CI evidence applies? | [Choose validation and deliver the documentation](../guides/development.md#choose-validation-and-deliver-the-documentation), [Validation](../validation.md) | [`package.json`](https://github.com/salva/saivage-v3/blob/HEAD/package.json), [validation workflow](https://github.com/salva/saivage-v3/blob/HEAD/.github/workflows/validation.yml) |

For adoption questions, retrieve the **complete** selected procedure, not only a
table row: current-format repair is not migration; reset has separate destructive
consent; external migration needs the explicit identified-project request and full
offline backup/candidate/validation/fidelity/loss/cutover gates. Start and Run remain
separate decisions. Historical equal-version incompatibilities remain historical,
not implicit normalization permission.

## Retrieve enough, not everything

Use local search or file search for the exact heading/symbol. Read its surrounding
contract, not a matching line alone; follow any required precondition link before
an action. If source and a requirement genuinely disagree, report the conflict
instead of weakening the requirement or improvising a product fix. Record the
pages/source retrieved and evidence limits when handing off an answer.

Public documentation is not automatically loaded into runtime agents. A static
composition or current-instructions view does not prove delivery or understanding.
Host development instructions, shipped role prompts, target project overrides and
conversation evidence are distinct inputs with distinct owners.
