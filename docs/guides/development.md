# Develop Saivage

Start with an intended behavior change, locate its owner, then trace the contracts
and consumers it affects. This is a task guide, not permission to change deployed
projects. [AGENTS.md](https://github.com/salva/saivage-v3/blob/master/AGENTS.md)
owns repository policy and issue-fix review; the [architecture](../architecture/index.md)
owns dependency direction. Use [validation](../validation.md) for complete check
recipes and CI applicability.

## Establish a development checkout

Use Node`>=24 <25`, npm`>=10 <12`, and install both dependency trees:

```bash
npm ci
(cd web && npm ci)
npm run typecheck
```

Do not develop against a live target's generated state. Use disposable fixtures
outside real projects; tests supply synthetic models/providers where needed.
Backend/source code is TypeScript ESM; root and `web/` have separate package
ownership. The web runtime/build dependency relationship is described in
[browser presentation and build ownership](../architecture/system-architecture.md#browser-presentation-and-build-ownership).

## Pick the owner before editing

| Change | Start at | Follow through |
| --- | --- | --- |
| Product behavior | [System requirements](../spec/system-specification.md) | Domain/runtime owner, application projection, API/UI consumer |
| Card or record meaning | `src/cards/card-service.ts`, `src/persistence/authored-record-files.ts` | Exact owning schemas/heads, configured gates, read models/history |
| Agent tool | `src/tools/runtime-tool-catalog.ts`, owning provider binder | Input schema, invocation/result policy, exact grants, projections/presenters |
| Deterministic node action | `src/runtime/card-process/operation-contract.ts` | Compile options/routing, NodeExecution, retained execution evidence |
| Workflow/input graph | `src/schemas/saivage-config.ts`, `card-process-config.ts` | Template config, generated outcome contract, acceptance and presentation |
| Prompt/task direction | [Prompt composition](../architecture/prompts.md) | Selected role/node/edge/fragment host, compiler, preparation and retention |
| Operator route/UI | `src/contracts/operator-api-*.ts` | `src/server/routes/`, `src/application/read-models/`, web API/store/view |
| MCP integration | `src/mcp/` for outbound; `src/server/analyst-mcp-server.ts` for inbound | Distinct lifecycle, protocol and evidence owners |

Paths in this table are repository-relative. Exact exported contracts, routes and
scope-valid tools remain in the architecture's
[source-derived reference](../architecture/system-architecture.md#source-derived-reference).
Do not add a generic store, service bag or plugin registry to avoid locating an
existing owner. Persistence changes require the full
[durable-format policy](https://github.com/salva/saivage-v3/blob/master/AGENTS.md#durable-format-versioning),
not just a schema edit or mutable revision increment.

## Trace one feature end to end

Image inspection is a useful existing vertical slice:

1. Input: [`viewImageInputSchema`](https://github.com/salva/saivage-v3/blob/HEAD/src/contracts/view-image.ts)
   describes the tool arguments. [`workspace-provider.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/tools/workspace-provider.ts)
   binds the same tool identity to actual card/global context.
2. Effect: [`project-file-tools.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/tools/project-file-tools.ts) admits
   the path and [`image-decode.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/tools/image-decode.ts) normalizes the
   static raster. Capability requirements are separate from file admission.
3. Settlement: [`invocation.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/tools/invocation.ts) and
   [`tool-result-settlement.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/tools/tool-result-settlement.ts) separate
   actual LLM conversation publication from call-local external-client image bytes.
   [`conversation-image.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/persistence/conversation-image.ts) owns
   selected PNG evidence, not a current-source fallback.
4. Projection: [`agent-operator-read-model.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/application/read-models/agent-operator-read-model.ts)
   and [agent API contract](https://github.com/salva/saivage-v3/blob/HEAD/src/contracts/operator-api-agents.ts) validate the
   exact session/segment/result/content occurrence before returning pixels.
5. Presentation: [image result presentation](../spec/operator-ui-contracts.md#image-result-presentation)
   distinguishes descriptors from explicit Inspect image pixels and current Files.
6. Validation: focused image/cancellation/publication/API tests plus
   [`image-inspection.e2e.test.ts`](https://github.com/salva/saivage-v3/blob/HEAD/tests/e2e/image-inspection.e2e.test.ts)
   cover the behavior at real boundaries. Screenshots alone do not prove it.

A change may touch fewer owners, but do not stop at the producer when the public
meaning changes. Keep input/output contracts, strict consumers, fixtures, docs and
deployment assumptions coherent. Prepared/recorded evidence must not turn into a
new delivery/perception guarantee.

## Add or change a tool at its existing binder

For an ordinary workspace tool, follow the `read`/`view_image` entries in
[`workspaceToolBinders`](https://github.com/salva/saivage-v3/blob/HEAD/src/tools/workspace-provider.ts). A `defineToolBinder`
declaration supplies exact name, description, result policy, context-dependent
input schema and executor. The runtime catalog groups binders by global/card scope
and provides concrete context. Unknown or duplicate identities fail compilation.

Keep responsibilities separate:

- Input schema owns strict arguments. The executor calls the domain/actor owner,
  not another HTTP route or a mirrored validator.
- The result policy owns observational versus operational evidence/retention.
  Publication uncertainty is not an ordinary failed ToolResult or retry request.
- [`tool-invocation-outbound.ts`](https://github.com/salva/saivage-v3/blob/HEAD/src/tools/tool-invocation-outbound.ts) owns
  tool-specific safe public projection; update source-adjacent API projections and
  web presenters when the public shape changes, not a generic raw-data escape hatch.
- Exact configured `agents.<name>.tools` selects availability. Update intended
  bundled declarations in `classic-shared.ts`, not every role by default. Existing
  installed inputs do not inherit a new source grant.
- Global Analyst-specific operations use the Analyst binders/application operation
  owner; external clients reuse selected configured canonical contracts, not a
  separately invented tool implementation. Oversight's allowed read-only set remains
  its own boundary.

Use [`tool-result-policy-catalog.test.ts`](https://github.com/salva/saivage-v3/blob/HEAD/tests/tools/tool-result-policy-catalog.test.ts),
owning tool tests and safe projection tests for relevant regressions. If adding a
public route too, update the operation/status schemas and both producer and browser
consumers; do not weaken contract discovery/parity guards to accept an omission.

## Add an action without inventing a plugin service

Use the existing [shell.run node](configuration.md#add-an-action-before-acceptance)
for a required command check. It needs no new production action mechanism.
`NodeExecution` invokes it without a model/session; `CardProcessActor`/Supervisor
own acceptance, natural commit and advisory postcommit hooks. Required checks go
before acceptance, never in a hook whose failure cannot reverse DONE.

For a genuinely new trusted compiled operation, the actual boundary is
`OperationDefinition`/`OperationPlugin` plus explicit
`WorkflowCompileOptions.operationPlugins`. There is no dynamic installation,
directory scan, YAML module path or general plugin server. Production composition
must deliberately supply a declaration; a test-only compile option is not product
installation support.

This **synthetic module example** declares a pure in-memory operation and compiles
the declaration only; it does not execute work, install a module or supply a full
workflow. Imports are repository-root-relative TypeScript source imports:

```ts
import { z } from 'zod';
import {
  compileOperations,
  type OperationDefinition,
} from './src/runtime/card-process/operation-contract.js';

const inspect: OperationDefinition = {
  id: 'example.inspect',
  provider: { kind: 'plugin', name: 'example' },
  contractVersion: 1,
  bindings: ['node'],
  config: z.object({}).strict(),
  inputs: { scope: { type: 'string', enum: ['project'], workflow: true } },
  outcomes: {
    finished: { count: { type: 'integer', min: 0, max: 1000, workflow: true } },
  },
  retainFields: ['count'],
  async run() {
    return { outcome: 'finished', summary: 'Synthetic result.', values: { count: 0 } };
  },
};
const operations = compileOperations([], [
  { namespace: 'example', operations: { inspect } },
]);
if (!operations.has('example.inspect')) throw new Error('Missing declaration');
```

`run` receives explicit capabilities and cancellation, not a service bag. Real
operations declare strict config, all finite outcomes, exact flat fields and public
workflow visibility. Reserved shell/git/saivage namespaces cannot be shadowed.
Return validation requires a nonempty≤2000-character summary and exact declared
values. [Typed input/routing constraints](../reference/configuration.md#typed-inputs-and-routes)
govern cases/handoff. No nested JSON, coercion or private-field routing.

For an integrated example, read
[`workflow-action-compilation.test.ts`](https://github.com/salva/saivage-v3/blob/HEAD/tests/runtime/card-process/workflow-action-compilation.test.ts):
it explicitly passes `operationPlugins`, supplies a typed count from action to
agent and rejects invalid stdout destinations/private routes. Then inspect
[`operation-execution.test.ts`](https://github.com/salva/saivage-v3/blob/HEAD/tests/runtime/actors/operation-execution.test.ts)
for actual owner/cancellation/acceptance evidence. Neither an execution log nor a
missing result authorizes replay of unknown effects.

## Change a workflow at its compiler boundary

1. Start from a complete profile/type fixture, not a partial deep merge. Keep one
   bootstrap record and a closed permitted-child map.
2. Add/adjust a node in `card_types.<type>.workflow`. Choose agent versus action;
   all graph nodes must be reachable and have a terminal path.
3. Supply every exact action outcome. For agent nodes, generated `emit_result`
   schema/description owns outcome names; don't handwrite an alternate contract.
4. Check every lifecycle entry, STOPPED recipient recovery, terminal promotion,
   pending-notification alternative, typed incoming supplier and record/context
   gate. For stdout, declare the nonbootstrap destination and continue/updated.
5. Compile using actual `effectiveSaivageConfigSchema` and
   `compileProjectWorkflows`, as the existing tests do. Structural compilation is
   offline. Runtime `bindRuntimeWorkflows` separately resolves model/tool capability
   and positive input capacity, without probing credentials or calling providers.
6. Update `compiled-graphs-projection.ts` and `workflow-presentation-projection.ts`
   only if their contract changes; action identity must not disclose executable
   script/config, and action nodes must not fabricate agent sessions.

Useful tests: [config compilation](https://github.com/salva/saivage-v3/blob/HEAD/tests/runtime/card-process/card-process-config.test.ts),
[action compilation](https://github.com/salva/saivage-v3/blob/HEAD/tests/runtime/card-process/workflow-action-compilation.test.ts),
[record initialization](https://github.com/salva/saivage-v3/blob/HEAD/tests/runtime/card-process/record-initialization.test.ts),
[offline CLI compilation](https://github.com/salva/saivage-v3/blob/HEAD/tests/cli/offline-workflow-compilation.test.ts), and
[workflow routes](https://github.com/salva/saivage-v3/blob/HEAD/tests/server/operator-workflow-routes.test.ts).

Source edits do not update a running installation. Participating retained identity
changes have [adoption consequences](../runbook/state-adoption.md#participating-identity-changes)
even when required-index startup succeeds. Do not rewrite old outcomes or add a
compatibility path to make a new graph appear historical.

## Author prompts at the effective delivery owner

Read the mandatory
[prompt-authoring workflow](https://github.com/salva/saivage-v3/blob/master/.github/skills/saivage-prompt-authoring/SKILL.md)
before editing any prompt/template/instruction. Use
[exact prompt references](../architecture/prompts.md#exact-prompt-references-and-lookup)
to find the actual selected file, then the
[host contract](../architecture/prompts.md#compiler-and-host-contract) for allowed tokens/includes.

Role/shared text owns reusable method; node text owns the present task delta;
correction/edge messages own the observed handoff. Records/initializers are data,
not a shortcut for new prompt authority. `prompt-api.ts` compiles host closure;
`AgentExecutor` prepares role/node/tools/parent direction; the same-read supplier
captures record context for a logical model operation. Compaction has its own
retention contract. Editing docs or a materialized file proves neither delivery
nor model understanding, and does not hot-reload server configuration.

Review representative composed results, including re-entry/continuation cases
affected by the edit, then perform the skill's distinct final clean-room pass
after all changes. Keep runtime prompt selection separate from OpenCode/Copilot
development instruction loading; do not assume one reads the other's docs.

## Choose validation and deliver the documentation

For a small change, run focused owning tests first; broaden by actual risk:

```bash
npm run test:direct -- --runInBand --runTestsByPath tests/runtime/card-process/workflow-action-compilation.test.ts
npm run validate:docs
npm run validate:routine
```

Use UI smoke/full UI for browser changes and release validation for the complete
release boundary, according to the [validation reference](../validation.md).
Source schema acceptance is not E2E qualification. Use actual owners, synthetic
fixtures and bounded no-provider checks; live services/providers require separate
authorization. Never print production config, tokens or backups into test evidence.

In the same coherent change, update the owning specification, task guide, field
lookup and examples; synchronize source-derived inventories and substantive negative
guard tests where necessary. A durable change also updates every affected existing
discriminator/producer/strict consumer/fixture and the
[format reference](../architecture/durable-format-changes.md), with honest release
applicability. Documentation-only work changes no format.

Report commands/results and limits, not just “tests pass.” CI classification follows
actual changed paths: script/test changes are not automatically docs-only. A green
ancestor is not exact-final-SHA evidence. Repository policy owns review, stable
commits and publication; validation grants no deployment, Run or migration permission.
