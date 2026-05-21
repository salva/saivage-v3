# Saivage v3 — Configuration Reference

<!-- doc-authority
status: current
disposition: keep
owner: docs-maintainers
superseded_by: none
last_verified_against: src/agents/config-schema.ts:1
-->

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
| `capabilities` | object | Optional provider capability declaration for routing/tool compatibility |
| `modelCapabilities` | object | Optional per-model capability overrides keyed by model name |

### Provider Accounts

Each named account under `accounts` supports `priority`, `apiKey`, `baseUrl`, `tokenEndpoint`, `authProfile`, `models`, and optional `capabilities`, allowing multiple sets of credentials and capability declarations for a single provider.

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


### Provider Capabilities

Provider, account, and model-specific entries may declare optional `capabilities` metadata. Saivage uses these declarations during routing so candidates that cannot satisfy a request for native tool calls, `tool_choice`, response shape, streaming, or transport protocol are skipped before transport invocation and without marking provider health as failed.

Supported fields are `transportProtocol` (`openai-chat-completions` or `openai-codex-backend`), `toolCalls` (`native` or `none`), `toolChoice` (`auto` or `none`), `responseShape` (`openai-chat-choice` or `codex-backend`), `streaming`, `contextWindowTokens`, `maxOutputTokens`, and `quirks`.

Precedence is model override → account override → provider declaration → built-in provider default → global default. Built-in provider defaults exist for `github-copilot`, `openai-codex`, `opencode`, and `opencode-go`; `openai-codex` defaults to the `openai-codex-backend` transport and `codex-backend` response shape to preserve its special backend path.

```json
{
  "providers": {
    "opencode": {
      "models": ["kimi-k2.6"],
      "capabilities": { "toolCalls": "native", "toolChoice": "auto" },
      "accounts": {
        "safe-text-only": {
          "models": ["kimi-k2.6"],
          "capabilities": { "toolCalls": "none", "toolChoice": "none" }
        }
      },
      "modelCapabilities": {
        "kimi-k2.6": { "contextWindowTokens": 128000, "maxOutputTokens": 8192 }
      }
    }
  }
}
```

Rollback is additive: remove the declarations to return to built-in defaults, or explicitly set a candidate to OpenAI-compatible defaults (`openai-chat-completions`, native tool calls, `openai-chat-choice`) if a provider was under-declared.

---

## Runtime Section (`runtime`)

Controls the persisted §13 runtime settings. The on-disk section accepts only the snake_case keys below; legacy camelCase runtime keys are one-shot migrated by `loadConfig()` and unsupported persisted runtime keys are rejected.

| Field | Type | Default | Description |
|---|---|---|---|
| `continuous_improvement` | boolean | `false` | Enable idle depth-0 planner continuous improvement cycles |
| `max_review_retries` | number | `3` | Default maximum reviewer correction attempts for goal cards; card metadata can override with `max_review_retries` |
| `process_timeouts.planner_ms` | number | `1200000` | Planner invocation timeout in milliseconds |
| `process_timeouts.executor_ms` | number | `1200000` | Executor invocation timeout in milliseconds |
| `process_timeouts.reviewer_ms` | number | `1200000` | Reviewer invocation timeout in milliseconds |

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

Optional. If a `botToken` is provided, the Telegram bot starts automatically on server startup. Outbound Telegram notifications require explicit `notificationChatIds`; `allowedUserIds` only controls inbound bot authorization.

| Field | Type | Description |
|---|---|---|
| `botToken` | string | Telegram Bot API token (supports `${ENV_VAR}`) |
| `allowedUserIds` | number[] | List of Telegram user IDs allowed to interact with the bot |
| `notificationChatIds` | number[] | Explicit outbound notification recipients; safe non-zero integer chat IDs, deduplicated at startup and separate from `allowedUserIds` |

```json
{
  "telegram": {
    "botToken": "${TELEGRAM_BOT_TOKEN}",
    "allowedUserIds": [123456789],
    "notificationChatIds": [111111, -222222]
  }
}
```

---

## Notifications Section (`notifications`)

Configures notification delivery channels and filtering. Channel and severity values are strict at config parse time. `telegram` enables the Telegram channel only when a runtime Telegram handler is registered; outbound recipients remain `telegram.notificationChatIds`, not `allowedUserIds`.

| Field | Type | Default | Description |
|---|---|---|---|
| `channels` | enum[] | `["web"]` | Enabled notification channels; each value must be `web` or `telegram` |
| `filters.min_severity` | enum | `"info"` | Minimum router event severity to notify: `info`, `warning`, `error`, or `critical`. Durable severities such as `warn` and `block` are not valid in this router config field. |
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

For HTTP MCP servers, `transport: "sse"` currently means Saivage's Streamable HTTP single-endpoint mode: Saivage sends JSON-RPC `POST` requests to the single configured `url` for initialize, `notifications/initialized`, paginated `tools/list`, and `tools/call`. POST responses may be encoded as `application/json` or `text/event-stream`; event-stream responses are read only until the matching JSON-RPC response id is received. Stateful Streamable HTTP servers may return an `Mcp-Session-Id` header during initialize; Saivage keeps that synthetic session value in memory for the lifetime of the running server handle and sends it on later initialized/list/call POSTs.

Saivage does **not** implement legacy two-endpoint HTTP+SSE endpoint discovery for `transport: "sse"`, and there is no separate `streamable-http` transport enum. Configure a single Streamable HTTP MCP endpoint in `url`.

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
    "continuous_improvement": true,
    "max_review_retries": 3,
    "process_timeouts": {
      "planner_ms": 1200000,
      "executor_ms": 1200000,
      "reviewer_ms": 1200000
    }
  }
}
```

<!-- saivage:config-schema:start -->
## Source-verified schema inventory

`npm run docs:verify` compares this table with `src/agents/config-schema.ts` field-by-field. Persisted `runtime` accepts the snake_case §13 keys only; legacy camelCase runtime keys are one-shot migrated by `loadConfig()`.

| Section | Fields | Code anchor |
|---|---|---|
| `top-level` | `failover,mcpServers,models,notifications,providers,runtime,security,server,supervisor,telegram` | `src/agents/config-schema.ts:294` |
| `models` | `analyst,chat,coder,data_agent,default,equivalents,executor,failover,inspector,manager,max_tokens,planner,profiles,researcher,reviewer,routing,temperature` | `src/agents/config-schema.ts:131` |
| `providers.entry` | `accounts,apiKey,authProfile,baseUrl,capabilities,modelCapabilities,models,priority,tokenEndpoint` | `src/agents/config-schema.ts:198` |
| `providers.account` | `apiKey,authProfile,baseUrl,capabilities,models,priority,tokenEndpoint` | `src/agents/config-schema.ts:188` |
| `server` | `host,port` | `src/agents/config-schema.ts:209` |
| `runtime` | `continuous_improvement,max_review_retries,process_timeouts` | `src/agents/config-schema.ts:226` |
| `runtime.process_timeouts` | `executor_ms,planner_ms,reviewer_ms` | `src/agents/config-schema.ts:220` |
| `security` | `injectionModel,injectionScanner,maxScanLengthBytes` | `src/agents/config-schema.ts:252` |
| `supervisor` | `consecutiveStuckVerdicts,enabled,intervalMs,logLines,model` | `src/agents/config-schema.ts:259` |
| `telegram` | `allowedUserIds,botToken,notificationChatIds` | `src/agents/config-schema.ts:268` |
| `notifications` | `channels,filters` | `src/agents/config-schema.ts:274` |
| `mcpServers.entry` | `args,autostart,command,disabled,env,transport,url` | `src/agents/config-schema.ts:285` |
<!-- saivage:config-schema:end -->
