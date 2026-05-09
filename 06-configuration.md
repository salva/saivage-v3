# Configuration

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

Assigns model specs to agent roles:

```json
{
  "models": {
    "analyst": "claude-sonnet-4-20250514",
    "planner": "claude-sonnet-4-20250514",
    "executor": "claude-sonnet-4-20250514",
    "reviewer": "claude-sonnet-4-20250514",
    "default": "claude-sonnet-4-20250514"
  }
}
```

`default` is used when a role has no explicit assignment.

### Model routing

For advanced setups, models can be assigned via routing profiles:

```json
{
  "models": {
    "profiles": {
      "heavy": {
        "preferred": ["claude-sonnet-4-20250514"],
        "allowed": ["gpt-4o"],
        "preferredAccounts": ["account-1"],
        "allowedAccounts": ["account-1", "account-2"]
      },
      "light": {
        "preferred": ["claude-haiku"],
        "allowed": ["gpt-4o-mini"]
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

When a preferred model is unavailable, the router tries equivalent
models before falling back to the `allowed` list.

### Failover

Per-model fallback chains:

```json
{
  "models": {
    "failover": {
      "claude-sonnet-4-20250514": ["gpt-4o", "claude-haiku"]
    }
  }
}
```

---

## Providers

Per-provider connection configuration:

```json
{
  "providers": {
    "anthropic": {
      "apiKey": "${ANTHROPIC_API_KEY}",
      "baseUrl": "https://api.anthropic.com"
    },
    "openai": {
      "apiKey": "${OPENAI_API_KEY}"
    },
    "openrouter": {
      "apiKey": "${OPENROUTER_API_KEY}",
      "baseUrl": "https://openrouter.ai/api/v1"
    },
    "custom-provider": {
      "apiKey": "${CUSTOM_KEY}",
      "baseUrl": "https://my-llm-proxy.internal/v1",
      "authProfile": "my-oauth-profile"
    }
  }
}
```

Fields per provider:

| Field        | Required | Description                                 |
|--------------|----------|---------------------------------------------|
| `apiKey`     | yes*     | API key (supports `${ENV_VAR}` interpolation) |
| `baseUrl`    | no       | Override the default API endpoint            |
| `authProfile`| no       | Name of an OAuth profile for token refresh   |
| `accounts`   | no       | Named sub-accounts for routing               |

*`apiKey` can be omitted if `authProfile` is used instead.

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

```json
{
  "runtime": {
    "restartOnCrash": true,
    "healthCheckIntervalMs": 30000,
    "idleShutdownMs": 300000,
    "maxGoalDepth": 5,
    "recoveryDelayMs": 60000,
    "continuousImprovement": false
  }
}
```

| Field                   | Default  | Description                                       |
|-------------------------|----------|---------------------------------------------------|
| `restartOnCrash`        | `true`   | Auto-restart planner on non-PLAN_COMPLETE exit    |
| `healthCheckIntervalMs` | `30000`  | Health check frequency (30 seconds)               |
| `idleShutdownMs`        | `300000` | Auto-shutdown after idle period (5 minutes)       |
| `maxGoalDepth`          | `5`      | Maximum goal nesting depth                        |
| `recoveryDelayMs`       | `60000`  | Delay before planner restart after failure         |
| `continuousImprovement` | `false`  | Restart planner with improvement directive on PLAN_COMPLETE |

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
    "allowedUserIds": [123456789]
  }
}
```

| Field            | Required | Description                                |
|------------------|----------|--------------------------------------------|
| `botToken`       | yes      | Telegram bot API token                     |
| `allowedUserIds` | yes      | Array of numeric Telegram user IDs allowed |

Only users in `allowedUserIds` can interact with the bot. Messages
from other users are silently ignored.

---

## Notifications

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
| `channels`              | `["web"]`   | Active notification channels             |
| `filters.min_severity`  | `"info"`    | Minimum event severity to notify         |
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
access (see `05-security.md`).

For simple setups, API keys via environment variables are sufficient.
OAuth profiles are for providers that require OAuth flows (e.g.,
enterprise SSO endpoints).

An API token for the Saivage server itself is set via the
`SAIVAGE_API_TOKEN` environment variable (see `05-security.md` and
`08-server-api.md`).
