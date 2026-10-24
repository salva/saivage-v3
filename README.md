# Saivage — Autonomous Software Development

Give Saivage an objective, constraints and acceptance criteria, then explicitly
start a Run. Configured Planners delegate and sequence work, Executors implement,
investigate and test, and configured Reviewers assess evidence. Parents coordinate
correction; the root Planner assesses remaining authorized work before completion.
Workflows can also use non-LLM actions for finite commands. Output-capable actions
can publish factual reports through the ordinary record owner using
[`output_record`](docs/guides/configuration.md); command stdout and returned text
retain distinct provenance, not automatic acceptance of the work.
Explicit [JS/typed-TS/Python quality actions](docs/reference/configuration.md#quality-actions)
require preprovisioned pinned native tools; they are not enabled by default.
Optional per-agent quality tools use the same engines with strict empty requests
and operator-bound scope; they do not accept records or inherit action publication.

The goal is convergence from direction to useful coherent deliverables satisfying
the objective, not activity volume or continual human dispatch. Use the web control
room to understand results or intervene when needed. Reduced supervision is an aim,
not a guarantee of unattended success.

Agents can edit files, run commands, use configured external tools and spend
provider credits. Deploy inside an **externally isolated environment**, normally
LXC: Saivage does not supply the isolation. Review and retained evidence help you
judge results; they do not guarantee correct delivery, complete recording or no
data loss. See [how the work model fits together](docs/overview.md).

## Choose your path

Optional [observed source preparation](docs/runbook/observed-collections.md) emits
configuration and units for native automatic code/docs/skill observation. Adoption
is separate from source installation; native embeddings are uneven and originals
remain authoritative. Preparation does not walk sources or create indexes.
After explicit adoption, agents can discover logical views with
`list_observed_collections`, query useful references with
`query_observed_collections`, then read originals. Native watchers maintain these
observations without agent refresh commands; missing/stale search is not a
completeness verdict or an indexing chore.

| You want to… | Start here |
| --- | --- |
| Try a first objective | [Fresh-project tutorial](docs/guides/getting-started.md) — prepare, explicitly Run, understand a result, end the trial |
| Understand autonomous development | [Overview](docs/overview.md) — delegation, configured review, correction and evidence-qualified completion |
| Follow work and assess outcomes | [Work tour](docs/guides/operating.md) — objective, results and evidence; [runbook decision map](docs/runbook/index.md) when control or diagnosis is needed |
| Develop Saivage | [Developer guide](docs/guides/development.md) — trace owners, extend contracts and select checks |
| Retrieve an exact fact | [Reference map](docs/reference/index.md) and [agent navigation](docs/reference/agent-navigation.md) — requirements, procedures and source owners |

Read the [documentation site](https://salva.github.io/saivage-v3/) or the same
sources served at `/docs/` by a built running instance. For an authorized,
AI-assisted LXC installation, use [the standalone setup task](README-IF-YOU-ARE-AN-AI.md).
It does not authorize deployment merely by being opened.

Download the pixel-art logos and “Made with Saivage” badges from [Brand assets](docs/brand.md).

## Start safely

Use Node `>=24 <25` and npm `>=10 <12`; prefer the latest supported Node 24 LTS
patch. Build from the Saivage source checkout, not the managed target:

```bash
npm ci
npm --prefix web ci
npm run build
```

Then follow the [tutorial](docs/guides/getting-started.md) in a disposable target
inside the isolated deployment. It separates these decisions:

1. **Initialize** a fresh target with the built `bin/saivage.js init`. The default
   is `classic`; optional `classic-typed` and
   [paad-typed](src/config/system-templates/paad-typed/README.md) use typed workflows.
   Existing-config init preserves inputs; it is not a profile switch or upgrade.
2. **Configure** providers, all required model routes and the fixed summarizer.
   Bundled templates ship no provider. Use the [configuration tasks](docs/guides/configuration.md)
   and [exact field lookup](docs/reference/configuration.md); keep credentials private.
3. **Start and inspect** readiness and the stopped project before authorizing work.
   Pin the [exact target and YAML](docs/guides/getting-started.md#start-and-check-readiness),
   choose the [guest-to-browser access path](docs/runbook/deployment.md#browser-access-across-namespaces),
   and, for bearer deployments, complete [private browser setup](docs/runbook/deployment.md#browser-credential-setup).
   Startup does not imply Run. The auth-disabled trial still requires deployment-owned
   confinement; bearer credentials belong in headers, never URLs.
4. **Supply the objective, then explicitly Run.** Project Stop contains project
   work but leaves the server, Analyst and optional inbound listener available.
   [Closing the application](docs/runbook/runtime-control.md#project-stop-and-application-close)
   is a different operation.

For retained state, do not use fresh init, reset or repair as a default upgrade
step. Start with [the adoption decision](docs/runbook/state-adoption.md#choose-the-operation).
Reset is destructive; exact current-format repair is not migration; external
offline migration requires an explicit identified-project request and its full gates.

## Documentation authorities

Optional [explicit work reclamation](docs/runbook/work-gc.md) previews unreferenced
scratch before a separate irreversible delete. It is not an installation/startup
step, automatic cleanup or canonical-state repair.

| Owner | Exact responsibility |
| --- | --- |
| [AGENTS.md](AGENTS.md) | Repository engineering, safety and storage policy |
| [System specification](docs/spec/system-specification.md) | Functional behavior and runtime/CLI/API contracts |
| [UI needs](docs/spec/operator-ui-needs.md) and [UI contracts](docs/spec/operator-ui-contracts.md) | Operator requirements and exact presentation |
| [System architecture](docs/architecture/system-architecture.md) | Ownership, dependency direction, flows and source-derived inventories |
| [Prompt handling](docs/architecture/prompts.md) | Selection, composition, retention and deliberate customization |
| [Runbook](docs/runbook/index.md) | Deployment, control, diagnosis, evidence and state-adoption procedures |
| [Durable format reference](docs/architecture/durable-format-changes.md) | Current source baseline and bounded historical change evidence, not installation compatibility certification |

Guides teach tasks; they do not replace these owners. Public docs are not
automatically injected into runtime agents. Source edits alone do not update
materialized prompts or authorize installed-state adoption.

## Choose validation

Install both root and web dependencies first. Use focused owner tests, then the
profile appropriate to the change; [Validation](docs/validation.md) owns exact
coverage, prerequisites, specialized recipes and CI interpretation.

| Command | Select for |
| --- | --- |
| `npm run validate:docs` | Documentation build, contract/parity/link/source/cadence checks; no complete backend or UI suite |
| `npm run validate:routine` | Backend typecheck, export/persistence guards, architecture Jest and docs; not lint or full backend Jest |
| `npm run validate:ui-smoke` | Quick operator Vitest and selected browser smoke |
| `npm run validate:ui` | Web typecheck, complete web Vitest and operator smoke |
| `npm run validate:release` | Local release composition: typecheck, full build, backend non-E2E and E2E, operator smoke, docs |

Release success does **not** replace the separate `npm run audit:security`
high/critical gate. `npm run lint` and `npm run deps:review` have their own
[coverage and applicability](docs/validation.md#select-a-profile).
Local results do not establish exact-SHA CI success, provider behavior or deployment
readiness. Validation grants no live restart, Run, reset or migration permission.
