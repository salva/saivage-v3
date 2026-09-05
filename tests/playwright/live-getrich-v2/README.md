# Archived live GetRich v2 Playwright suite

**Archived on 2026-09-02. This directory is not a runnable validation suite.**

The four deployment-coupled specs and their Playwright configuration were
removed from executable validation. They remain available in Git history for
provenance. There is no current package command, default deployment URL, or
environment-variable override for this former suite.

The suite was archived rather than pointed at Pueblicos. Pueblicos is a
different project with different files, identity, provider/model setup, and
MCP configuration. A dated observation that Pueblicos was reachable did not
make it an equivalent or durable fixture, and running the mutating GetRich v2
assertions against it would not have tested the claimed environment.

The removed suite required all of the following:

- an intentionally selected, currently reachable, externally isolated
  Saivage v3 deployment running the same current build and contracts as the
  checkout;
- Node.js 24 and a supported npm version on that deployment, current
  production web assets, healthy `/health` and `/health/ready` endpoints, and
  a service rooted at the exact expected target project;
- the exact GetRich v2 fixture identity and files: `/work/getrich-v2`, project
  ID `getrich-v2`, and `docs/SPEC.md`;
- the exact asserted provider/model fixture: providers `openai-codex` and
  `opencode-go`; `opencode-go` models `glm-5.1`, `kimi-k2.6`, and
  `deepseek-v4-pro`; default route `gpt-5.4`; and planner route `gpt-5.5`;
- a configured MCP inventory containing at least one server whose tools were
  exposed through `/api/mcp/tools`;
- working configured provider credentials and quota for Analyst calls, plus
  permission to append conversation and card state—the suite was not wholly
  read-only;
- an explicit authentication design. The archived tests sent no bearer
  header, so they worked only against an auth-disabled deployment whose
  external isolation limited access to trusted origins. Bearer tokens must
  never be placed in URLs;
- host-to-container network reachability and a locally installed Playwright
  Chromium browser.

The dated execution findings are preserved in
[`docs/validation/live-getrich-v2-launch-playwright-issues-2026-06-24.md`](../../../docs/validation/live-getrich-v2-launch-playwright-issues-2026-06-24.md).
That record is historical, not current validation guidance. A future live tier
would need an explicitly provisioned disposable fixture or an operator-supplied
URL and configuration at invocation time; it must not infer fixture authority
from Pueblicos, environment history, or a dated health observation.
