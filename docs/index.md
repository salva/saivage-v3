---
layout: home
hero:
  name: Saivage v3
  text: Software work over long runs
  tagline: >-
    Give a project an objective. Configured agents plan, implement, test and review
    work in a visible card tree, while you inspect evidence and steer the next steps.
  actions:
    - theme: brand
      text: Try a first project
      link: /guides/getting-started
    - theme: alt
      text: Understand the model
      link: /overview
features:
  - title: Learn
    details: Understand cards, workflows and responsibilities, then try a disposable project.
    link: /guides/getting-started
  - title: Operate
    details: Configure models, orient in the cockpit, control work and diagnose failures.
    link: /guides/operating
  - title: Develop
    details: Trace contracts to their owners and extend existing tool, action and workflow boundaries.
    link: /guides/development
  - title: Retrieve exact facts
    details: Find the owning requirement, procedure, schema or source without reading every page.
    link: /reference/agent-navigation
---

## Choose a path

| You want to… | Start here | Then use |
| --- | --- | --- |
| Understand what runs where | [Overview](overview.md) | [First-project tutorial](guides/getting-started.md) |
| Configure or operate an instance | [Configuration tasks](guides/configuration.md) | [Field lookup](reference/configuration.md), [operating guide](guides/operating.md), [runbook decision map](runbook/index.md) |
| Change the implementation | [Development guide](guides/development.md) | [Architecture](architecture/index.md), [validation](validation.md) |
| Answer a precise question, including as an agent | [Question-to-owner map](reference/agent-navigation.md) | [Specifications](spec/index.md), [reference index](reference/index.md) |

## What to expect

Saivage runs against a target workspace in deployment-provided isolation. Agents
with command tools can modify files, execute programs and use Git. Provider calls
can incur charges. Neither a disposable copy nor loopback binding is an agent
sandbox; see the [first-use prerequisites](guides/getting-started.md#before-you-begin).

Records, selected conversations, execution observations and provider evidence make
work inspectable. They are not a complete ledger of all changes, proof of model
perception, or a guarantee of correct delivery. Persistence is loss-tolerant.
Use the [evidence guide](runbook/evidence.md) to interpret what was actually retained.

The guides teach tasks. [System requirements](spec/system-specification.md) own
functional behavior; [UI needs](spec/operator-ui-needs.md) and
[UI contracts](spec/operator-ui-contracts.md) own operator requirements and exact
presentation. Use the [specification map](spec/index.md) to choose a topic.
[System architecture](architecture/system-architecture.md) owns implementation
structure; its [owner map](architecture/index.md) helps locate a component. The
[runbook](runbook/index.md) owns operating procedures. Repository development policy
remains in [AGENTS.md](https://github.com/salva/saivage-v3/blob/master/AGENTS.md).
Editing these pages does not load them into runtime agents or authorize an operation.
