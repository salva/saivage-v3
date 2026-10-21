# Architecture: find the owner

Read [the product overview](../overview.md) for the autonomous work loop, then trace
dispatch, execution and acceptance through their owners below.
Architecture explains implementation responsibilities; the [specifications](../spec/index.md)
own requirements and the [runbook](../runbook/index.md) owns operating procedures.

| What you need to understand or extend | Start here | Main source boundary |
| --- | --- | --- |
| Autonomous delegation, implementation and acceptance | [Activation and node execution](./system-architecture.md#activation-and-node-execution), [shared acceptance](./system-architecture.md#agent-path-and-shared-acceptance) | `SupervisorRuntimeApi`, `CardProcessActor`, `NodeExecution`, `AgentExecutor`; bundled root assessment in `classic-shared.ts`. |
| Where a change belongs | [Ownership and dependencies](./system-architecture.md#ownership-and-dependency-direction) | Owner-published package roots/ports; `scripts/check-import-boundaries.cjs`. |
| Configuration, workflow or action | [Startup compilation](./system-architecture.md#structural-compilation-and-live-binding), then [node execution](./system-architecture.md#activation-and-node-execution) | `schemas/saivage-config.ts`, `runtime/card-process/card-process-config.ts`, `operation-contract.ts`, `NodeExecution`. |
| Dispatch, Pause/Stop or cancellation | [Control and recovery](./system-architecture.md#control-notifications-and-recovery) | `SupervisorRuntimeApi`, exact owner/lease and process-scope joins. |
| Tool permission or external Analyst client | [Caller-specific tools](./system-architecture.md#caller-specific-tools-and-analyst-operations) | Bound tool catalog and application Analyst operation surface; not agent names. |
| Prompt selection, composition or customization | [Prompt handling](./prompts.md) | Compiler/registry, preparation suppliers, context projector and declaration retention. |
| Provider request/admission/compaction | [Provider context](./system-architecture.md#provider-context-and-compaction) | Runtime source selection → agents request plan/attempts → direct conversation publication. |
| Outbound MCP or image dataflow | [MCP owners](./system-architecture.md#outbound-mcp-connections-and-native-content), [image pipeline](./system-architecture.md#images-selection-materialization-and-inspection) | Manager/runtime/transports, producer-neutral result and exact source-session selection. |
| Cards, records or durable state | [Canonical graph and persistence](./system-architecture.md#canonical-graph-and-direct-persistence) | Direct card/record/conversation owners, current selector versus reached history. |
| An API or browser feature | [Projection and browser state](./system-architecture.md#read-models-transport-and-browser-state) | Shared operation contract → source-adjacent projector → exact resource/request owner. |
| Exact route/tool/config field inventory | [Source-derived reference](./system-architecture.md#source-derived-reference) | Checked tables at the canonical architecture owner. |
| Release/state compatibility evidence | [Current durable baseline](./durable-format-changes.md#current-source-baseline), then named historical entries | Owning schemas **and** semantic consumers; source evidence is not deployment permission. |

For a practical change, trace the contract, effect owner, public projection and
consumer together, then choose focused checks from [validation](../validation.md).
Do not introduce another store, scheduler, generic dispatcher or compatibility path
to avoid the existing owner. Documentation examples and static composition are not
proof of live delivery, model compliance, installed adoption or historical fidelity.
