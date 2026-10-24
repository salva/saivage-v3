# Reference: find the exact fact

Use a reference to look something up, a guide to perform a task, an explanation to
understand the model, and the runbook for an operating decision.

| Question | Owning destination |
| --- | --- |
| How does an objective become autonomous work and an outcome? | [Work loop](../overview.md#execution-and-review), [autonomous ownership lookup](agent-navigation.md#autonomous-work-and-completion) |
| Who accepts results, coordinates correction and decides completion? | [Planning and assessment](../spec/system-specification.md#planning-assessment-and-current-status), [shared acceptance](../architecture/system-architecture.md#agent-path-and-shared-acceptance) |
| Which YAML field/default or startup input? | [Configuration lookup](configuration.md) |
| Where should an agent retrieve a precise answer? | [Question-to-owner map](agent-navigation.md) |
| What must the product do? | [System specification](../spec/system-specification.md) |
| What must the cockpit show? | [UI needs](../spec/operator-ui-needs.md) and [exact contracts](../spec/operator-ui-contracts.md) |
| Which routes/tools/schema fields exist? | [Source-derived inventories](../architecture/system-architecture.md#source-derived-reference) |
| Which component owns an effect? | [Architecture owner map](../architecture/index.md) |
| How do prompt references/tokens/retention work? | [Prompt handling](../architecture/prompts.md) |
| Which current durable contract and historical change? | [Durable format reference](../architecture/durable-format-changes.md#current-source-baseline) |
| Which validation gate/evidence? | [Validation](../validation.md) |
| Which isolated native quality pins, licenses and qualification limits? | [Native quality prerequisites](quality-tool-qualification.md) |
| How do I operate, diagnose or adopt state? | [Runbook decision map](../runbook/index.md#choose-the-safe-next-task) |

The [configuration guide](../guides/configuration.md), [work tour](../guides/operating.md)
and [developer guide](../guides/development.md) supply worked tasks. None replaces
the linked contract or authorizes live effects. Source facts and historical evidence
do not override repository policy or explicit owner instructions.

Source links open the repository on GitHub because deployed documentation serves
only the built site, not the source checkout. `HEAD`/`master` links follow repository
development; for an installed release, inspect the same path at its pinned commit
or in its matching checkout rather than assuming the link identifies that release.
