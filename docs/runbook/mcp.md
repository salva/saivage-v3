# MCP: connect in the correct direction

| Direction | Configuration and authority |
|---|---|
| External client → **Saivage Analyst** | Immutable startup flags, independent bearer, project-bound loopback URL; direct selected Analyst operations |
| Saivage agent tools → **another MCP server** | YAML `mcpServers` or persisted dynamic connection, explicit named-agent grants, discovered binding/catalog |

These are independent listeners/clients. Adding YAML `mcpServers` does not enable
external Analyst access; an Analyst MCP credential does not authenticate operator
REST or configure remote tools. Deployment/provider/browser activity needs actual
authorization; examples below are recipes, not permission to launch anything.

## External client to Analyst

### Configure the inbound listener

Default `saivage start` is internal-only. For an authorized new server process,
provision `SAIVAGE_ANALYST_MCP_TOKEN` privately, nonblank/unpadded and **different**
from `SAIVAGE_API_TOKEN`. Use startup flags, for example:

```bash
saivage start --project-root /work/project --host 127.0.0.1 --port 8080 \
  --analyst-mode external --analyst-mcp-port 8082 \
  --analyst-mcp-principal local-operator --analyst-mcp-tools get_status,get_card
```

This tool subset is valid only if both canonical names are in the configured
Analyst inventory. Selection must be nonempty, duplicate-free and exact, without
wildcards/aliases/space trimming. Principal is a bounded lowercase identifier;
external port is 1..65535. Modes are `internal`, `external`, `both`; internal rejects
unused external settings. There are no mode/port/principal/tool environment aliases,
YAML fields, token CLI flag or hot-reconfigure path. Changing mode requires a
separately authorized server restart.

Read the printed exact endpoint:
`http://127.0.0.1:<port>/mcp/analyst/<projectIdentityDigest>`.
It binds loopback regardless of operator HTTP host. `localhost`, a different Host
header, another project path or an invented digest is not interchangeable. Other
hosts/containers cannot connect directly; no tunnel/firewall change is authorized.

### Initialize, inspect context and discover tools

Use a non-browser MCP Streamable HTTP client supporting protocol **2025-11-25**.
The following SDK module is a connection/read-only example for an environment with
the project's installed `@modelcontextprotocol/sdk`. Supply the exact printed URL
as `ANALYST_MCP_URL` and the independently provisioned secret as
`SAIVAGE_ANALYST_MCP_TOKEN`; neither belongs in a URL, source file or output:

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'local-operator', version: '1' });
const transport = new StreamableHTTPClientTransport(
  new URL(process.env.ANALYST_MCP_URL),
  { requestInit: { headers: {
    Authorization: `Bearer ${process.env.SAIVAGE_ANALYST_MCP_TOKEN}`,
  } } },
);
try {
  await client.connect(transport); // initialize, then notifications/initialized
  const context = await client.readResource({ uri: 'saivage://analyst/context' });
  const tools = await client.listTools();
  // Inspect locally: initialization binding, context and exact schemas.
  // Do not log credentials or assume listed mutation tools are authorized now.
  void context;
  void tools;
} finally {
  await client.close(); // disconnect is not cancellation of admitted operations
}
```

Inspect initialize's `instructions` and `_meta.saivage` for project digest, safe
name, Analyst policy and configured principal; compare with the intended project.
Read context for mode/current runtime/card types, then discover exact tool schemas
and use selected tools for actual current state/history. No internal Analyst
conversation has been loaded into the external client; its instruction/context
retention belongs to that client. Fresh observations never carry write authority.

For a raw protocol implementation, the SDK-compatible exchange is:

1. POST one JSON-RPC `initialize` with
   `params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'local-operator',version:'1'}}`.
   Include Authorization, `Content-Type: application/json` and
   **`Accept: application/json, text/event-stream`**. Optional initialize
   `MCP-Protocol-Version` must match.
2. POST `notifications/initialized` without request ID, then `resources/list`,
   `resources/read` with `{uri:'saivage://analyst/context'}`, and `tools/list` as
   ordinary single JSON-RPC requests with IDs. Every post-initialize message requires
   `MCP-Protocol-Version: 2025-11-25` and the same auth/Content-Type/both Accept types.
3. Submit `tools/call` only after discovery, with its exact `name` and `arguments`.
   Interpret `isError` and structured result; no delivery/retry guarantee follows.

Responses are stateless JSON, yet **both Accept media types are mandatory**.
No Origin header, query string (including credentials), `Mcp-Session-Id`, batch,
task invocation or GET stream is supported. POST only; body limit is 1 MiB.
Unauthorized is401; wrong Host/Origin403; wrong project path404; invalid envelope/
protocol/session/query400; unacceptable Accept406; other methods405 after auth.
Do not weaken validation to accommodate an incompatible client. Owners:
`src/config/analyst-mode.ts`, `src/server/analyst-mcp-server.ts`; the real SDK fixture
is `tests/server/external-analyst-mcp.test.ts`.

### Calls, disconnect and lifecycle

External-only disables internal submission **before ingress/provider/actor work**,
but keeps required internal history inspectable and strict startup unchanged.
Both allows concurrent internal chat and multiple direct external calls; it is
neither shared chat nor exclusive lease. Principal attributes the credential holder,
not a verified person/model. Ordinary Analyst lifecycle/record/writer gates still apply.

Disconnect loses response delivery, not admitted work. Background commands remain
application-owned/manageable across calls and reconnections. Project Stop leaves
the listener alive; App close closes admission, joins work and contains direct
processes. Never automatically replay a dropped call. Fresh authorized reads can
establish current state, not all prior effects. Navigation results are client
intents; `restart_server` only requests separate operator-authenticated confirmation,
never an MCP-only restart. Native images return call-local PNG bytes; no invented
internal transcript snapshot or model exchange is published for an external caller.

Authenticated operator `GET /api/external-tool-calls` provides **body-free settled
receipts**, not arguments/results, start rows, complete audit or delivery receipts.
External accepted-record attribution lives in its strict author/provenance, not a
receipt body. See [evidence](./evidence.md#control-events-notifications-and-external-receipts).

## Saivage tools to configured MCP servers

### Define a connection and grant tools

YAML `mcpServers` owns operator definitions: stdio `{transport,command,args?,env?}`
or Streamable HTTP `{transport,url}`, plus `autostart`/`disabled`. Agent-created
definitions are strict literal connections persisted separately in
`.saivage/config/mcp-servers.json`; registration neither edits YAML nor launches.
Dynamic definitions survive normal reset/restart but **never autostart**. Preserve
them in complete backups; `show_config` is YAML-only and Files refuses raw definitions.
Name collision between sources fails; there is no merge or auth-profile lookup.

Each named role must explicitly grant the required operations independently.
Defaults give Analyst/Executor lifecycle control, discovery and invocation;
Reviewer requires selection, Oversight has none. Custom participants may opt in.
Register/replace/unregister/list and catalog-refresh grants are separate, not
implied by connection registration or another MCP tool. See
[configuration](../guides/configuration.md) for YAML selection.

### Start, discover and call

Illustrative tool sequence for an independently authorized local peer:

```text
mcp_server_register({serverName:"local",connection:{transport:"stdio",command:"node",args:["peer.js"]}})
mcp_server_control({serverName:"local",action:"start"})
mcp_tools({serverName:"local"})
mcp_tool_call({serverName:"local",bindingId:"<observed binding UUID>",catalogId:"<observed catalog UUID>",toolName:"ping",args:{}})
```

For HTTP use `connection:{transport:'streamable-http',url:'https://example.com/mcp'}`.
Start has one180-second total budget covering fetch/install/initialize, initialized
notification and **every** tools/list page; HTTP requires no preliminary HEAD.
Running means discovery complete. Identical ready start is idempotent; unknown
definition404, disabled/busy/changed live entry409, start/containment failures errors.
Agent discovery rejection is an executed failed result only after successful local
containment/join; correct it then choose a **new** explicit start. Unclassified/
containment failures remain errors; REST discovery failure is500, not an agent result.
Autostart rejection blocks startup reconciliation/readiness.

Discover current `bindingId`, `catalogId`, tool name and exact argument schema.
Calls recheck catalog/schema at dispatch, including queued stdio calls. Stale
identities fail **before dispatch**; discover and author a new call, never replay.
Schemas without `$schema` mean2020-12. Explicit2020-12/draft-07 select their engines;
dialect-less draft-07 tuple schemas must declare
`http://json-schema.org/draft-07/schema` (optional `#`). No dialect guessing, rewriting,
coercion/default insertion, remote-reference loading or fallback.

### Stop, replace, restart or refresh

| Operation | Required state and effect |
|---|---|
| Stop | Retained owner; closes admission/readiness/catalog and joins starts/calls/containment. Project Stop does not do this. |
| Replace definition | Existing exclusively dynamic definition, complete connection not patch. Unstarted or successfully contained owner only; omitting args/env removes them. Publishes stopped, launches nothing. |
| Unregister | Exclusively dynamic definition. Removal publishes **before** containment; failure may leave absent definition and closed blocker. No rollback. |
| Restart | Retained owner, including successfully stopped. Never-started definition404: use start. Successful stop/join then selected current definition start/discovery; new binding/catalog. |
| Catalog refresh | Ready unchanged definition/exact binding. Paginated tools/list only; same connection, always fresh catalog UUID even identical schemas. No restart/install/config reload. |

Lifecycle operator alternatives are authenticated
`POST /api/mcp/servers/:name/start`, `/stop`, `/restart` with strict `{}` body.
Success is `{serverName,status,toolCount}`; there is no browser lifecycle button.
System UI refresh only fetches observations, not a remote catalog refresh.

```text
mcp_server_control({serverName:"local",action:"stop"})
mcp_server_replace({serverName:"local",connection:{transport:"stdio",command:"node",args:["peer-b.js"]}})
mcp_server_control({serverName:"local",action:"start"})
mcp_tools({serverName:"local"})
mcp_catalog_refresh({serverName:"local",bindingId:"<observed binding UUID>"})
mcp_tools({serverName:"local"})
mcp_tool_call({serverName:"local",bindingId:"<same binding UUID>",catalogId:"<new catalog UUID>",toolName:"ping",args:{}})
mcp_server_control({serverName:"local",action:"restart"})
mcp_tools({serverName:"local"})
mcp_server_control({serverName:"local",action:"stop"})
mcp_server_unregister({serverName:"local"})
```

Restart is non-atomic, not idempotent replay: each completed request reconnects.
If owner changes during join it conflicts, not adopts the successor. Cancellation
before entry does nothing; during stop it still joins, then rejects before start.
Closed application cannot resurrect a server. Failed/disabled/missing/conflicting
definition or start may leave stopped/failed ownership; errors never imply stop
was undone. Failed containment retains the blocker and forbids replacement. Stdio
contains only its exact local scope; HTTP closes local requests/session and
reconnects, **not the remote service**. Context may be lost, not preserved/reset by
guarantee. Old queued/prepared calls cannot target the successor; completed native
responses keep their original facts. No retries, compensation or remote replay.

Refresh has one30-second budget **including queue wait/pagination**, rejects busy,
and publishes only a complete catalog. Failure can leave the old complete catalog
as the last observation, not proof remote tools exist. Stop fences late publication.
Queued cancellation does not interrupt a prior stdio call; active stdio timeout/
cancel or uncorrelated failure closes/contains/joins; HTTP cancel is request-local.
Errors disclose known local status, never deny remote effects. Ephemeral identity
changes need no reset; recorded old arguments remain historical, not replay inputs.

### Deadlines, roots and process ownership

Invocation defaults to900000ms (15 minutes) from dispatch through consumption,
excluding stdio queue wait and whole agent turn. There is no public per-call timeout
override; internal test options are not operator settings. Timers are event-loop
scheduled and containment can take longer, not a hard wall-time guarantee.

Active stdio timeout/cancel closes that connection and joins retained containment/
inner work: all sessions on that server, including idle/shared browser state, may
be lost. Independent servers are not stopped. Queued cancellation does not dispatch
or stop the active call. TIMEOUT follows successful containment; failure retains
closed nonready ownership, not an ordinary tool result. HTTP abort affects only
that request, not proof remote work ended. No automatic retry/undo/recovered session.
App close joins retained work; project Stop leaves MCP services alive.

Stdio cwd and negotiated `roots/list` identify the managed project, not Saivage
source. Roots answers remain available across discovery pages/calls and while idle.
HTTP initialization advertises no roots. Stdio processId is a safe observation
association, not wait/kill authority: MCP owns launch/retirement, stdout/stderr are
`not_captured`. HTTP processId is null. Arbitrary process attachment is unsupported.

### Native results and image limits

Complete native envelope validation preserves ordered text and static PNG/JPEG/WebP
images, plus safe structured/envelope metadata; image-like nested JSON is not native
image authority. Native `isError` remains failure with effects uncertain and produces
no images. Default longest side1600; local `max_dimension` is1..16384 or `original`,
not forwarded upstream. Wire limit48MiB; source images32MiB individually/aggregate,
40million pixels; selected PNG16MiB each; complete projected nonimage text/JSON1MiB
including metadata/escaping. Oversize fails without truncation after possible effects.
Normalize completely, then fence caller cancellation before LLM image publication;
external callers receive transient call-local bytes. Pixels cannot be regex-redacted.
[Image evidence](./evidence.md#current-file-versus-recorded-image) is not perception.

## Pinned browser recipe

This retained example pins `@playwright/mcp@0.0.83`; the repository's screenshot
schema fixture records playwright-core `1.64.0-alpha-1790635538000`.
The historical integration recorded Chromium1247/155.0.8059.12, not a current stable
engine promise. Verify the exact package/runtime in a separately authorized setup.
Create dedicated project `tmp/browser-output` and provision OS browser libraries first:

```yaml
# mcpServers excerpt, not a complete Saivage configuration.
mcpServers:
  browser:
    transport: stdio
    command: npx
    args:
      - --yes
      - --package=@playwright/mcp@0.0.83
      - -c
      - 'playwright-mcp install-browser chromium >&2 && exec playwright-mcp --browser chromium --headless --isolated --image-responses allow --no-webmcp --output-dir tmp/browser-output'
    autostart: false
    disabled: false
```

Fetching/installing belongs to that configured command and the same180-second
startup budget; no mandatory official dependency, install receipt, phase retry,
fallback browser or privileged automatic install-deps. Keep stdout JSON-RPC only;
installer diagnostics go to stderr. Disposable tests need isolated HOME/npm cache/
PLAYWRIGHT_BROWSERS_PATH and a short owned TMPDIR under workspace tmp (Unix socket
path lengths matter). No live browser is launched by this documentation.

Discover schemas, navigate/snapshot/select the intended page/tab, then use discovered
`browser_take_screenshot` with `scale:'css'` and **omit filename** for native image
output. Explicit filename yields text only, not automatic image/file authority.
The recorded pinned `browser_click` uses `target` for snapshot references, not an
assumed `ref`; current discovery remains authority. Use an admitted image-capable
Responses/Codex route with sufficient serialized-pixel capacity; Chat cannot consume
image-bearing continuations. Local normalization is not provider preprocessing.

One server is one shared isolated context across agents, not per card/role.
Stop/restart/active stdio timeout/cancel may discard tabs/cookies; prior effects
remain possible. Upstream workspace restrictions remain: no unrestricted-file-access,
persistent login/storage-state, CDP, extension attachment or experimental WebMCP.
Use only nonsecret pages, never credentials/provider configs/authenticated operator
pages. Deployment owns confidentiality and browser isolation. Inspect recorded
occurrences in Conversations, current files separately; missing snapshot never
falls back to the original source.

Source owners: `src/mcp/mcp-manager.ts`, `server-runtime.ts`, `stdio-transport.ts`,
`streamable-http-transport.ts`, `src/tools/mcp-native-result.ts`. Installed custom
guidance/tool contracts need deliberate matching input adoption; this recipe grants
no deployment/reset/migration/Run authority.
