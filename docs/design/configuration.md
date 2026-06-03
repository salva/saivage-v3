# Configuration

<!-- doc-authority
status: stale
disposition: merge-into
owner: docs-maintainers
superseded_by: docs/configuration.md
last_verified_against: src/agents/config-schema.ts:1
-->

> **Authority status: stale.** This page is retained for context only and is not current operator guidance. Prefer `docs/configuration.md` for current authority where applicable. See `docs/documentation-inventory.md` for disposition `merge-into`.

> Canonical design document consolidated from `docs/design/configuration.md` during Stage 22. Stage 23 will reconcile detailed source anchors where needed.


All configuration lives in `.saivage/saivage.json`. The file is JSON
with environment variable interpolation: `${VAR}` references are
resolved at load time.

---

## Schema

```json
{
  "models": { ... },
  "providers": { ... },
  "server": { ... },
  "runtime": { ... },
  "security": { ... },
  "supervisor": { ... },
  "telegram": { ... },
  "notifications": { ... },
  "mcpServers": { ... }
}
```

---

## Models

Models are provider-independent model identities such as `gpt-5.5`,
`kimi-k2.6`, or `deepseek-v4-pro`. They describe what capability the
runtime wants, not which service account will serve the request.

Each agent role receives an ordered list of acceptable models:

```json
{
  "models": {
    "planner": ["gpt-5.5", "kimi-k2.6"],
    "executor": ["kimi-k2.6", "deepseek-v4-pro"],
    "reviewer": ["gpt-5.5", "deepseek-v4-pro"],
    "analyst": ["deepseek-v4-flash", "qwen3.5-plus"],
    "default": ["deepseek-v4-flash"]
  }
}
```

`default` is used when a role has no explicit assignment. A single
string is accepted as shorthand for a one-item list, but the normalized
configuration is always an ordered list.

### Model routing

For advanced setups, models can be assigned via routing profiles. A
routing profile still names models first. Provider and account
selection happens later, after the runtime has matched the requested
model against available provider capabilities.

```json
{
  "models": {
    "profiles": {
      "heavy": {
        "preferred": ["gpt-5.5", "kimi-k2.6"],
        "allowed": ["deepseek-v4-pro"]
      },
      "light": {
        "preferred": ["deepseek-v4-flash"],
        "allowed": ["qwen3.5-plus"]
      }
    },
    "routing": {
      "planner": "heavy",
      "executor": "heavy",
      "reviewer": "light",
      "analyst": "heavy"
    }
  }
}
```

The runtime expands each role into an ordered candidate list:

1. Iterate the role's configured models in order.
2. For the current model, find providers that can serve that model.
3. Order providers by configured priority, then current health state.
4. For each provider, order accounts by account priority, then current
  health state.
5. Produce concrete `provider/account/model` candidates.

The final candidate chain for an agent is therefore an ordered list of
concrete `provider/account/model` attempts. The runtime applies the
configured recovery policy to that chain.

### Model equivalents

Groups of interchangeable models for failover:

```json
{
  "models": {
    "equivalents": [
      ["claude-sonnet-4-20250514", "gpt-4o"],
      ["claude-haiku", "gpt-4o-mini"]
    ]
  }
}
```

Model equivalents are optional. They are used only after the runtime
has exhausted every working provider and account for the currently
selected model. Equivalent models are tried before falling back to the
profile's `allowed` list.

### Failover

Per-model fallback chains define the next model to try after no
provider/account can serve the current model:

```json
{
  "models": {
    "failover": {
      "gpt-5.5": ["kimi-k2.6", "deepseek-v4-pro"],
      "kimi-k2.6": ["deepseek-v4-pro"]
    }
  }
}
```

Provider failure does not immediately advance to the next model. The
router first tries the next provider/account that can serve the same
model. It advances to the next model only after all eligible providers
and accounts for the current model are unavailable, failing, or in
cooldown.

---

## Providers

Providers are concrete services such as `github`, `opencode-go`, or
`opencode`. A provider declares which models it can serve, how it is
authenticated, and its priority relative to other providers. Each
provider can have zero or more named accounts.

```json
{
  "providers": {
    "github": {
      "priority": 10,
      "models": ["gpt-5.5", "gpt-5.5-mini"],
      "accounts": {
        "primary": {
          "priority": 10,
          "authProfile": "github-primary"
        },
        "secondary": {
          "priority": 20,
          "authProfile": "github-secondary"
        }
      }
    },
    "opencode-go": {
      "priority": 20,
      "models": ["kimi-k2.6", "deepseek-v4-pro", "deepseek-v4-flash"],
      "apiKey": "${OPENCODE_GO_API_KEY}"
    },
    "opencode": {
      "priority": 30,
      "models": ["kimi-k2.6", "deepseek-v4-pro", "qwen3.5-plus"],
      "apiKey": "${OPENCODE_API_KEY}"
    }
  }
}
```

Fields per provider:

| Field         | Required | Description                                 |
|---------------|----------|---------------------------------------------|
| `models`      | yes*     | Models this provider can serve               |
| `priority`    | no       | Lower numbers are tried first                |
| `apiKey`      | yes**    | API key (supports `${ENV_VAR}` interpolation) |
| `baseUrl`     | no       | Override the default API endpoint            |
| `authProfile` | no       | Name of an OAuth profile for token refresh   |
| `accounts`    | no       | Named sub-accounts for routing               |
| `capabilities` | no       | Provider capability declaration for routing/tool compatibility |
| `modelCapabilities` | no   | Per-model capability overrides keyed by model name |

*`models` can be omitted only for providers whose model list is
discovered at startup. Discovered models are cached with the provider
health state.

**`apiKey` can be omitted if `authProfile` is used instead, or if all
traffic goes through named accounts.

Fields per account:

| Field         | Required | Description                                  |
|---------------|----------|----------------------------------------------|
| `priority`    | no       | Lower numbers are tried first within provider |
| `apiKey`      | yes*     | Account-specific API key                      |
| `baseUrl`     | no       | Account-specific endpoint override            |
| `authProfile` | no       | Account-specific OAuth profile                |
| `models`      | no       | Account-specific model subset or override     |
| `capabilities` | no      | Account capability declaration                 |

*`apiKey` can be omitted if `authProfile` is used instead.

If a provider has no `accounts`, the provider itself acts as a single
implicit account. If accounts are configured, account-level settings
override provider-level settings.

### Provider recovery

The router tracks health separately for each provider/account/model
candidate. When a candidate fails, it enters the recovery delay policy
defined by the runtime. While it is in cooldown, the router skips it
and tries the next candidate. If every candidate for a model is in
cooldown or fails, the router advances to the next configured model.

Provider priority affects the initial order only. Runtime health can
temporarily move a higher-priority provider behind a lower-priority
provider until its cooldown expires.

---

## Server

```json
{
  "server": {
    "port": 8080,
    "host": "0.0.0.0"
  }
}
```

| Field  | Default      | Description                     |
|--------|--------------|---------------------------------|
| `port` | `8080`       | HTTP + WebSocket server port    |
| `host` | `"0.0.0.0"` | Bind address                    |

---

## Runtime

Persisted runtime configuration uses the §13 snake_case keys only. `loadConfig()` one-shot migrates legacy camelCase runtime files, while the schema rejects unsupported persisted runtime keys.

```json
{
  "runtime": {
    "continuous_improvement": false,
    "max_review_retries": 3,
    "process_timeouts": {
      "planner_ms": 1200000,
      "executor_ms": 1200000,
      "reviewer_ms": 1200000
    }
  }
}
```

| Field | Default | Description |
|---|---|---|
| `continuous_improvement` | `false` | Allow idle depth-0 planner to propose the next improvement cycle |
| `max_review_retries` | `3` | Default maximum reviewer correction attempts for goal cards; card metadata can override with `max_review_retries` |
| `process_timeouts.planner_ms` | `1200000` | Planner invocation timeout in milliseconds |
| `process_timeouts.executor_ms` | `1200000` | Executor invocation timeout in milliseconds |
| `process_timeouts.reviewer_ms` | `1200000` | Reviewer invocation timeout in milliseconds |

---

## Security

```json
{
  "security": {
    "injectionScanner": true,
    "injectionModel": "claude-haiku",
    "maxScanLengthBytes": 102400
  }
}
```

| Field                | Default    | Description                                      |
|----------------------|------------|--------------------------------------------------|
| `injectionScanner`   | `true`     | Enable prompt injection scanning                 |
| `injectionModel`     | —          | Model for Layer 2 LLM scan                      |
| `maxScanLengthBytes` | `102400`   | Max content size for scanning (100 KB)           |

---

## Supervisor

```json
{
  "supervisor": {
    "enabled": true,
    "model": "claude-haiku",
    "intervalMs": 1200000,
    "consecutiveStuckVerdicts": 3,
    "logLines": 400
  }
}
```

| Field                      | Default    | Description                                  |
|----------------------------|------------|----------------------------------------------|
| `enabled`                  | `true`     | Enable stuck-agent supervisor                |
| `model`                    | —          | Model for stuck detection assessment         |
| `intervalMs`               | `1200000`  | Check interval (20 minutes)                  |
| `consecutiveStuckVerdicts` | `3`        | Consecutive stuck verdicts before abort      |
| `logLines`                 | `400`      | Number of recent log lines to feed the model |

---

## Telegram

```json
{
  "telegram": {
    "botToken": "${TELEGRAM_BOT_TOKEN}",
    "allowedUserIds": [123456789],
    "notificationChatIds": [111111, -222222]
  }
}
```

| Field            | Required | Description                                |
|------------------|----------|--------------------------------------------|
| `botToken`       | yes      | Telegram bot API token                     |
| `allowedUserIds` | yes      | Array of numeric Telegram user IDs allowed |
| `notificationChatIds` | no       | Explicit outbound notification recipients; safe non-zero integer chat IDs, separate from inbound authorization |

Only users in `allowedUserIds` can interact with the bot. Messages
from other users are silently ignored. `notificationChatIds` controls outbound
Telegram notification delivery and does not authorize inbound users.

---

## Notifications

Notification channels and router severity thresholds are strict enums at config parse time. `telegram` channel enablement is separate from outbound recipients, which remain in `telegram.notificationChatIds`.

```json
{
  "notifications": {
    "channels": ["telegram", "web"],
    "filters": {
      "min_severity": "warning",
      "categories": ["goal_completed", "goal_failed", "escalation"]
    }
  }
}
```

| Field                   | Default     | Description                              |
|-------------------------|-------------|------------------------------------------|
| `channels`              | `["web"]`   | Active notification channels; each value must be `web` or `telegram` |
| `filters.min_severity`  | `"info"`    | Minimum router event severity: `info`, `warning`, `error`, or `critical`. Durable `warn`/`block` values are not valid here. |
| `filters.categories`    | all         | Event types to notify (empty = all)      |

---

## MCP Servers

Named external MCP servers:

```json
{
  "mcpServers": {
    "my-data-tool": {
      "command": "npx",
      "args": ["-y", "@my-org/data-tool-mcp"],
      "env": {
        "DATA_API_KEY": "${DATA_API_KEY}"
      },
      "disabled": false,
      "autostart": true,
      "transport": "stdio"
    },
    "remote-search": {
      "url": "https://search-mcp.internal/sse",
      "transport": "sse",
      "autostart": true
    }
  }
}
```

Fields per server:

| Field       | Required | Description                                       |
|-------------|----------|---------------------------------------------------|
| `command`   | yes*     | Command to launch (for stdio transport)           |
| `args`      | no       | Command arguments                                 |
| `env`       | no       | Environment variables (supports interpolation)     |
| `url`       | yes*     | Server URL (for SSE transport)                    |
| `transport` | yes      | `"stdio"` or `"sse"`                              |
| `disabled`  | no       | Skip this server (default: `false`)               |
| `autostart` | no       | Start on runtime init (default: `true`)           |

*`command` is required for `stdio`, `url` for `sse`.

---

## Authentication

OAuth profiles are stored in `.saivage/auth-profiles.json`
(file mode `0600`):

```json
{
  "my-oauth-profile": {
    "provider": "custom-provider",
    "accessToken": "...",
    "refreshToken": "...",
    "expiresAt": "2025-01-01T00:00:00Z"
  }
}
```

The runtime refreshes tokens automatically before expiry. This file
is never served through any API endpoint and is blocked from agent
access (see `security.md`).

For simple setups, API keys via environment variables are sufficient.
OAuth profiles are for providers that require OAuth flows (e.g.,
enterprise SSO endpoints).

An API token for the Saivage server itself is set via the
`SAIVAGE_API_TOKEN` environment variable (see `security.md` and
`server-api.md`).

<!-- saivage:config-schema:start -->
## Source-verified schema inventory

`npm run docs:verify` compares this table with `src/agents/config-schema.ts` field-by-field. Persisted `runtime` accepts the snake_case §13 keys only; legacy camelCase runtime keys are one-shot migrated by `loadConfig()`.

| Section | Fields | Code anchor |
|---|---|---|
| `top-level` | `mcpServers,models,notifications,providers,rag,runtime,security,server,supervisor,telegram` | `src/agents/config-schema.ts:267` |
| `models` | `default,equivalents,failover,max_tokens,profiles,routing,temperature` | `src/agents/config-schema.ts:103` |
| `providers.entry` | `accounts,apiKey,authProfile,baseUrl,capabilities,modelCapabilities,models,priority,tokenEndpoint` | `src/agents/config-schema.ts:198` |
| `providers.account` | `apiKey,authProfile,baseUrl,capabilities,models,priority,tokenEndpoint` | `src/agents/config-schema.ts:188` |
| `server` | `host,port` | `src/agents/config-schema.ts:209` |
| `runtime` | `candidate_availability_compact_bytes,continuous_improvement,max_review_retries,process_timeouts` | `src/agents/config-schema.ts:186` |
| `runtime.process_timeouts` | `executor_ms,planner_ms,reviewer_ms` | `src/agents/config-schema.ts:220` |
| `security` | `injectionModel,injectionScanner,maxScanLengthBytes` | `src/agents/config-schema.ts:252` |
| `supervisor` | `consecutiveStuckVerdicts,enabled,intervalMs,logLines,model` | `src/agents/config-schema.ts:259` |
| `telegram` | `allowedUserIds,botToken,notificationChatIds` | `src/agents/config-schema.ts:268` |
| `notifications` | `channels,filters` | `src/agents/config-schema.ts:274` |
| `mcpServers.entry` | `args,autostart,command,disabled,env,transport,url` | `src/agents/config-schema.ts:285` |
<!-- saivage:config-schema:end -->
