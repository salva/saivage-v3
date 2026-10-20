# Functional Specifications

These are normative references: what Saivage must do and how the operator UI
must present it. They are not startup instructions or evidence that a particular
installation conforms. Begin with the [overview](../overview.md) for vocabulary,
the [runbook](../runbook/) for an operator task, or the
[architecture](../architecture/) for implementation ownership.

## Choose the authority

| Question | Owning reference |
| --- | --- |
| What is the product/trust boundary? | [System: product and trust](system-specification.md#product-and-trust-boundary) |
| Which caller may mutate which work? | [Caller-aware operation admission](system-specification.md#caller-aware-operation-admission) |
| How do card identity, lifecycle and records work? | [Cards](system-specification.md#card-identity-and-lifecycle), [authored records](system-specification.md#authored-records-and-current-selections), [history and selections](system-specification.md#card-history-membership-and-publication) |
| What runs an agent or an action? | [Workflow engine](system-specification.md#workflow-engine), [actions and execution evidence](system-specification.md#workflow-actions-and-execution-evidence), [shipped policy](system-specification.md#workflow-configuration-and-shipped-policies) |
| What does retained conversation/instruction evidence prove? | [Conversations and instruction evidence](system-specification.md#conversations-and-instruction-evidence) |
| What do Run, Pause, Stop and restart mean? | [Runtime controls](system-specification.md#runtime-controls-and-application-containment), [startup recovery](system-specification.md#startup-and-run-recovery) |
| Which MCP direction am I using? | [External client to Analyst](system-specification.md#direct-external-analyst-service), [Saivage to configured servers](system-specification.md#outbound-mcp-connections-and-tools) |
| How do provider context, compaction and recovery differ? | [Context preparation](system-specification.md#provider-context-and-preparation), [construction and exact admission](system-specification.md#compaction-construction-and-exact-provider-admission) |
| What survives interruption, and what adoption is allowed? | [Persistence](system-specification.md#direct-file-persistence), [repair/reset/adoption](system-specification.md#repair-reset-and-adoption); historical evidence in the [format reference](../architecture/durable-format-changes.md) |
| What does the operator need to understand or do? | [UI needs: requirement register](operator-ui-needs.md#requirement-register), [resolved owner decisions](operator-ui-needs.md#resolved-owner-decisions) |
| Which exact routes, labels and evidence disclosures apply? | [UI contracts](operator-ui-contracts.md#product-model): [navigation](operator-ui-contracts.md#identity-routes-and-navigation), [records](operator-ui-contracts.md#records-versions-and-diffs), [conversations](operator-ui-contracts.md#conversation-readers), [Analyst modes](operator-ui-contracts.md#analyst-panel-and-external-only-mode), [Files](operator-ui-contracts.md#files-processes-and-evidence) |

## Reading the contracts

Stable F identifiers and priorities belong to the needs register; exact UI behavior
belongs to its paired contracts register. A failed or unverified implementation
does not retire a requirement. Exact marked source-derived value blocks remain in
their system/UI owners and are checked mechanically; passing those checks is not
a prose, usability, delivery or model-perception guarantee.

Policy remains in repository `AGENTS.md`. Procedure/source-format links do not
authorize deployment, repair, reset, migration or project Run.
