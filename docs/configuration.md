# Saivage v3 — Configuration Reference

Configuration is loaded from `.saivage/saivage.json` in the project root directory. The file is validated against a [Zod](https://zod.dev) schema with sensible defaults for every section. Environment variable references of the form `${ENV_VAR}` are interpolated at load time.

## Top-Level Structure

```json
{
  "server": { ... },
  "models": { ... },
  "providers": { ... },
  "runtime": { ... },
  "security": { ... },
  "supervisor": { ... },
  "telegram": { ... },
  "notifications": { ... },
  "mcpServers": { ... },
  "failover": { ... }
}
```

All sections are optional — defaults apply when omitted.

---

## Server Section (`server`)

Controls the HTTP server binding.

| Field | Type | Default | Description |
|---|---|---|---|
| `host` | string | `"0.0.0.0"` | Listen address |
| `port` | number | `8080` | Listen port |

Example:

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 3000
  }
}
```

---

## Models Section (`models`)

Defines which LLM models to use for each agent role and how to route model selection.

### Per-Role Model Lists

Each role can have an ordered list of model strings. The first available model is used; from there, failover chains (see `failover` section) control fallback behavior.

| Role | Used by |
|---|---|
| `planner` | Top-level strategist agent |
| `manager` | Tactical executor that decomposes stages into tasks |
| `coder` | One-shot coding agent |
| `researcher` | Information gathering agent |
| `executor` | General task execution |
| `reviewer` | Reviews completed work |
| `analyst` | Interactive analyst chat |
| `inspector` | Inspection/verification agent |
| `data_agent` | Data processing agent |
| `chat` | Lightweight chat interactions |
| `default` | Fallback for any role without a specific model list |

### Routing Profiles

Profiles define preferred and allowed model subsets for a routing context.

```json
{
  "models": {
    "profiles": {
      "fast": {
        "preferred": ["deepseek-v4-flash"],
        "allowed": ["deepseek-v4-flash", "qwen3.5-plus"]
      },
      "powerful": {
        "preferred": ["kimi-k2.6"],
        "allowed": ["kimi-k2.6", "deepseek-v4-pro"]
      }
    },
    "routing": {
      "coder": "powerful",
      "chat": "fast"
    }
  }
}
```

### Model Equivalents

Groups of model strings treated as equivalent for failover purposes:

```json
{
  "models": {
    "equivalents": [
      ["claude-sonnet-4-20250514", "claude-3-5-sonnet-20241022"]
    ]
  }
}
```

### Failover Chains (deprecated location)

Failover can also be configured in the `models.failover` section (in addition to the top-level `failover`):

```json
{
  "models": {
    "failover": {
      "kimi-k2.6": ["deepseek-v4-pro", "minimax-m2.7"]
    }
  }
}
```

---

## Providers Section (`providers`)

Maps provider names to their configuration. Each provider entry includes credentials, available models, and optional priority and base URL.

### Provider Entry Fields

| Field | Type | Description |
|---|---|---|
| `priority` | number | Lower number = higher priority when selecting among providers |
| `models` | string[] | Models available from this provider |
| `apiKey` | string | API key (supports `${ENV_VAR}` interpolation) |
| `baseUrl` | string | Optional custom base URL for the provider API |
| `authProfile` | string | Name of an OAuth auth profile (alternative to `apiKey`) |
| `accounts` | object | Multiple named accounts, each with its own credentials |

### Provider Accounts

Each named account under `accounts` supports the same fields as the provider entry (`priority`, `apiKey`, `baseUrl`, `authProfile`, `models`), allowing multiple sets of credentials for a single provider.

### Example

```json
{
  "providers": {
    "anthropic": {
      "apiKey": "${ANTHROPIC_API_KEY}",
      "models": ["claude-sonnet-4-20250514", "claude-3-5-sonnet-20241022"],
      "priority": 10
    },
    "openai": {
      "apiKey": "${OPENAI_API_KEY}",
      "models": ["gpt-4o", "gpt-4o-mini"],
      "priority": 20,
      "accounts": {
        "org-a": {
          "apiKey": "${OPENAI_ORG_A_KEY}",
          "priority": 15
        }
      }
    }
  }
}
```

---

## Runtime Section (`runtime`)

Controls the runtime loop behavior, recovery, and compaction.

| Field | Type | Default | Description |
|---|---|---|---|
| `recoverAgentInvocations` | boolean | `true` | Recover agent sessions on restart |
| `healthCheckIntervalMs` | number | `30000` | Interval between health checks (ms) |
| `idleShutdownMs` | number | `300000` | Auto-shutdown after idle (ms) |
| `maxGoalDepth` | number | `5` | Maximum plan/goal nesting depth |
| `recoveryDelayMs` | number | `60000` | Delay before recovery attempt (ms) |
| `continuousImprovement` | boolean | `false` | Enable continuous improvement mode |
| `compactionThreshold` | number | `0.8` | Context usage fraction that triggers compaction (0–1) |
| `maxCompactions` | number | `3` | Maximum compactions per session |
| `compactionTimeoutMs` | number | `1200000` | Compaction timeout (20 min) |
| `compactionKeepFraction` | number | `0.2` | Fraction of context to retain during compaction (0–1) |
| `maxRecoveryRetries` | number | `3` | Maximum recovery retry attempts |

---

## Security Section (`security`)

Controls the content supervisor and prompt injection scanner.

| Field | Type | Default | Description |
|---|---|---|---|
| `injectionScanner` | boolean | `true` | Enable prompt injection scanning |
| `injectionModel` | string | — | Model for LLM-based injection scanning (Layer 2) |
| `maxScanLengthBytes` | number | `102400` | Max bytes to send to the LLM scanner |

Example:

```json
{
  "security": {
    "injectionScanner": true,
    "injectionModel": "opencode-go/deepseek-v4-flash",
    "maxScanLengthBytes": 100000
  }
}
```

---

## Supervisor Section (`supervisor`)

Controls the runtime supervisor that monitors for stuck agent invocations.

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Enable the supervisor |
| `model` | string | — | Model for supervisor analysis |
| `intervalMs` | number | `1200000` | Supervision interval (20 min default) |
| `consecutiveStuckVerdicts` | number | `3` | Consecutive stuck verdicts before escalation |
| `logLines` | number | `400` | Log lines fed to the supervisor for analysis |

---

## Telegram Section (`telegram`)

Optional. If a `botToken` is provided, the Telegram bot starts automatically on server startup.

| Field | Type | Description |
|---|---|---|
| `botToken` | string | Telegram Bot API token (supports `${ENV_VAR}`) |
| `allowedUserIds` | number[] | List of Telegram user IDs allowed to interact with the bot |

```json
{
  "telegram": {
    "botToken": "${TELEGRAM_BOT_TOKEN}",
    "allowedUserIds": [123456789]
  }
}
```

---

## Notifications Section (`notifications`)

Configures notification delivery channels and filtering.

| Field | Type | Default | Description |
|---|---|---|---|
| `channels` | string[] | `["web"]` | Enabled notification channels (`web`, `telegram`) |
| `filters.min_severity` | string | `"info"` | Minimum severity to notify (`info`, `warning`, `error`) |
| `filters.categories` | string[] | — | Optional category whitelist |

---

## MCP Servers Section (`mcpServers`)

Configures Model Context Protocol servers that the runtime can launch and manage.

Each entry key is a server name, and the value is:

| Field | Type | Required | Description |
|---|---|---|---|
| `command` | string | for stdio | Executable command |
| `args` | string[] | no | Command arguments |
| `env` | object | no | Environment variables |
| `url` | string | for sse | SSE endpoint URL |
| `transport` | `"stdio"` \| `"sse"` | **yes** | Transport protocol |
| `disabled` | boolean | no | If `true`, the server is not started |
| `autostart` | boolean | no | If `true`, starts automatically on server launch (default: `true`) |

Example:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest", "--headless"],
      "transport": "stdio",
      "autostart": true
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"],
      "transport": "stdio",
      "disabled": false,
      "autostart": false
    }
  }
}
```

MCP server status is available at `GET /api/mcp/status`.

---

## Failover Section (`failover`)

Top-level model failover chains. When a model is unavailable, the runtime tries the next model in the chain.

```json
{
  "failover": {
    "kimi-k2.6": ["deepseek-v4-pro"],
    "deepseek-v4-flash": ["qwen3.5-plus"],
    "minimax-m2.7": ["kimi-k2.6"]
  }
}
```

---

## Secrets and Environment Variables

All fields with names matching secret patterns (`apiKey`, `apiToken`, `botToken`, `accessToken`, `refreshToken`, or any key ending in `Token`/`Key`/`Secret`/`Password`) support `${ENV_VAR}` syntax. Values that remain as literal strings (not env-var references) are **redacted** when the config is served through `GET /api/config`.

Example showing both patterns:

```json
{
  "providers": {
    "anthropic": {
      "apiKey": "${ANTHROPIC_API_KEY}"
    }
  },
  "telegram": {
    "botToken": "${TELEGRAM_BOT_TOKEN}"
  }
}
```

Unknown environment variables resolve to an empty string and generate a warning.

---

## Complete Realistic Example

```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 8080
  },
  "models": {
    "planner": ["minimax-m2.7", "kimi-k2.6"],
    "manager": ["minimax-m2.7", "kimi-k2.6"],
    "coder": ["kimi-k2.6", "deepseek-v4-pro"],
    "executor": ["deepseek-v4-flash", "qwen3.5-plus"],
    "reviewer": ["kimi-k2.6", "deepseek-v4-pro"],
    "analyst": ["deepseek-v4-flash", "qwen3.5-plus"],
    "default": ["deepseek-v4-flash", "qwen3.5-plus"],
    "profiles": {
      "fast": {
        "preferred": ["deepseek-v4-flash"],
        "allowed": ["deepseek-v4-flash", "qwen3.5-plus"]
      },
      "powerful": {
        "preferred": ["kimi-k2.6"],
        "allowed": ["kimi-k2.6", "deepseek-v4-pro", "minimax-m2.7"]
      }
    },
    "routing": {
      "coder": "powerful",
      "chat": "fast"
    }
  },
  "providers": {
    "opencode-go": {
      "apiKey": "${OPENCODE_API_KEY}",
      "models": ["minimax-m2.7", "kimi-k2.6", "deepseek-v4-pro", "deepseek-v4-flash", "qwen3.5-plus"],
      "priority": 10
    }
  },
  "failover": {
    "kimi-k2.6": ["deepseek-v4-pro"],
    "deepseek-v4-flash": ["qwen3.5-plus"],
    "minimax-m2.7": ["kimi-k2.6"]
  },
  "security": {
    "injectionScanner": true,
    "injectionModel": "opencode-go/deepseek-v4-flash",
    "maxScanLengthBytes": 100000
  },
  "supervisor": {
    "enabled": true,
    "model": "opencode-go/deepseek-v4-flash",
    "intervalMs": 1200000
  },
  "runtime": {
    "continuousImprovement": true
  }
}
```
