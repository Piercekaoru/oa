# MCP

Openachieve Agent has a built-in MCP (Model Context Protocol) client. Configure servers in `mcp.json` and the agent can discover and call their tools.

## Configuration

Configs are merged in order (later wins):

1. `~/.config/mcp/mcp.json` (generic global)
2. `~/.openachieve/agent/mcp.json` (agent global)
3. `<project>/.mcp.json`
4. `<project>/.openachieve/mcp.json`

```json
{
	"mcpServers": {
		"github": {
			"command": "npx",
			"args": ["-y", "@modelcontextprotocol/server-github"],
			"env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" },
			"directTools": ["create_issue", "get_pull_request"]
		},
		"remote-api": {
			"url": "https://mcp.example.com/mcp",
			"auth": "oauth"
		},
		"internal": {
			"url": "https://internal.example.com/mcp",
			"auth": "bearer",
			"bearerTokenEnv": "INTERNAL_MCP_TOKEN"
		}
	},
	"imports": ["claude-code", "cursor"],
	"settings": {
		"toolPrefix": "server",
		"directTools": false,
		"idleTimeoutMs": 600000
	}
}
```

### Server fields

| Field | Description |
|---|---|
| `command`, `args`, `env`, `cwd` | stdio server: spawn command. `env` values support `${VAR}` and `$env:VAR` interpolation; `cwd` supports `~`. |
| `url`, `headers` | Remote server: Streamable HTTP with automatic SSE fallback. |
| `auth` | `"bearer"`, `"oauth"`, or `false`. |
| `bearerToken` / `bearerTokenEnv` | Bearer token literal (supports interpolation) or env var name. |
| `directTools` | `true`, `false`, or a list of tool names to register as first-class tools. |
| `excludeTools` | Tool names to hide entirely (matched raw or prefixed). |
| `exposeResources` | Set `false` to skip exposing MCP resources as `get_*` tools. |

### Settings

- `toolPrefix`: how direct tool names are prefixed — `"server"` (default, `github_create_issue`), `"short"` (strips trailing `-mcp`), `"none"`.
- `directTools`: global default for servers that don't set their own.
- `idleTimeoutMs`: disconnect idle servers after this long (default 10 minutes).

### Imports

`imports` pulls server definitions from other tools' configs: `cursor`, `claude-code`, `claude-desktop`, `codex`, `windsurf`, `vscode`. Explicitly configured servers win over imported ones.

## How tools are exposed

By default the model sees a single `mcp` proxy tool (~200 tokens regardless of how many servers you configure). The model discovers and calls tools on demand:

- `{action: "list"}` — servers and tool names
- `{action: "describe", server, tool?}` — descriptions and parameter schemas
- `{action: "call", server, tool, args}` — execute

Servers connect lazily on first use and disconnect after the idle timeout. Tool metadata is cached in `~/.openachieve/agent/mcp-cache.json` (7-day TTL), so `list`/`describe` work without spawning servers.

Tools listed in `directTools` are additionally registered as first-class tools the model sees directly (each costs context tokens, so prefer small curated sets). MCP resources become `get_<name>` tools.

## /mcp command

- `/mcp` — server status (connection state, tool counts, auth)
- `/mcp tools [server]` — list tools, marking direct ones
- `/mcp refresh [server]` — reconnect and refresh metadata
- `/mcp auth <server>` — run the OAuth flow for a remote server
- `/mcp connect <server>` / `/mcp disconnect <server>`

## Permissions

MCP calls are gated on the `mcp` permission surface. `list`/`describe` are allowed by default; `call` asks. Targets are `server/tool` patterns, and they govern both proxy calls and direct tools:

```json
{
	"permission": {
		"mcp": {
			"github/*": "allow",
			"dangerous-server/*": "deny"
		}
	}
}
```

Set `"mcp": "deny"` to hide MCP tools entirely.

## OAuth

Servers with `"auth": "oauth"` use the authorization-code flow with PKCE and dynamic client registration. Run `/mcp auth <server>`: a local callback server starts, the browser opens, and tokens are stored in `~/.openachieve/agent/mcp-auth.json` (mode 0600). Tokens refresh automatically on later connects.

## Subagents

Subagent `mcpDirectTools` frontmatter (e.g. `["github", "jira/create_ticket"]`) resolves against the shared metadata cache, so a subagent can receive specific MCP tools in its allowlist. Run the parent agent (or `/mcp refresh`) at least once so the cache exists.
