import type { ExtensionAPI, ExtensionCommandContext } from "../extensions/types.ts";
import { errorMessage } from "./connection.ts";
import type { McpManager } from "./manager.ts";
import { authorizeServer } from "./oauth.ts";
import type { McpServerStatus } from "./types.ts";

export interface McpCommandHooks {
	/** Re-register direct tools after metadata changed (e.g. /mcp refresh). */
	syncDirectTools: (ctx: ExtensionCommandContext) => void;
}

const SUBCOMMANDS = [
	{ value: "tools", label: "tools", description: "List exposed MCP tool names" },
	{ value: "refresh", label: "refresh", description: "Reconnect and refresh server metadata" },
	{ value: "auth", label: "auth", description: "Authorize a remote server (OAuth)" },
	{ value: "connect", label: "connect", description: "Connect a server now" },
	{ value: "disconnect", label: "disconnect", description: "Disconnect a server" },
];

export function registerMcpSlashCommand(pi: ExtensionAPI, manager: McpManager, hooks: McpCommandHooks): void {
	pi.registerCommand("mcp", {
		description: "Show MCP server status and tools",
		getArgumentCompletions: (prefix) => {
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1) {
				const items = SUBCOMMANDS.filter((item) => item.value.startsWith(parts[0] ?? ""));
				return items.length ? items : null;
			}
			const serverPrefix = parts[1] ?? "";
			const servers = manager
				.getServerNames()
				.filter((name) => name.startsWith(serverPrefix))
				.map((name) => ({ value: `${parts[0]} ${name}`, label: name }));
			return servers.length ? servers : null;
		},
		handler: async (args, ctx) => {
			const [subcommand, serverName] = args.trim().split(/\s+/).filter(Boolean);
			try {
				switch (subcommand ?? "") {
					case "":
						showStatus(manager, ctx);
						return;
					case "tools":
						showTools(manager, ctx, serverName);
						return;
					case "refresh":
						await refreshServers(manager, ctx, hooks, serverName);
						return;
					case "auth":
						await runAuth(manager, ctx, serverName);
						return;
					case "connect":
						await connectServer(manager, ctx, hooks, requireServerArg(serverName));
						return;
					case "disconnect":
						await manager.disconnect(requireServerArg(serverName));
						ctx.ui.notify(`Disconnected ${serverName}`, "info");
						return;
					default:
						ctx.ui.notify(
							`Unknown subcommand "${subcommand}". Usage: /mcp [tools|refresh|auth|connect|disconnect] [server]`,
							"warning",
						);
				}
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});
}

function requireServerArg(serverName: string | undefined): string {
	if (!serverName) throw new Error("Missing server name. Usage: /mcp <subcommand> <server>");
	return serverName;
}

function showStatus(manager: McpManager, ctx: ExtensionCommandContext): void {
	const theme = ctx.ui.theme;
	const statuses = manager.getStatuses();
	if (statuses.length === 0) {
		ctx.ui.notify(
			"No MCP servers configured.\nAdd servers to ~/.openachieve/agent/mcp.json (global) or .mcp.json (project).",
			"info",
		);
		return;
	}

	const nameWidth = Math.max(6, ...statuses.map((status) => status.name.length));
	const lines: string[] = [];
	lines.push(theme.bold("MCP Servers"));
	lines.push(theme.fg("dim", "─".repeat(70)));
	for (const status of statuses) {
		lines.push(
			[
				status.name.padEnd(nameWidth),
				renderState(status, theme),
				status.transport,
				renderInventory(status, theme),
				renderAuth(status, theme),
			]
				.filter(Boolean)
				.join("  "),
		);
		if (status.error && status.state === "error") {
			lines.push(theme.fg("error", `${" ".repeat(nameWidth)}  ${status.error}`));
		}
	}
	lines.push("");
	lines.push(theme.fg("dim", "Use /mcp tools [server], /mcp refresh [server], /mcp auth <server>"));
	ctx.ui.notify(lines.join("\n"), "info");
}

function renderState(status: McpServerStatus, theme: ExtensionCommandContext["ui"]["theme"]): string {
	switch (status.state) {
		case "connected":
			return theme.fg("success", "● connected".padEnd(13));
		case "connecting":
			return theme.fg("warning", "◌ connecting".padEnd(13));
		case "error":
			return theme.fg("error", "✕ error".padEnd(13));
		default:
			return theme.fg("dim", "○ idle".padEnd(13));
	}
}

function renderInventory(status: McpServerStatus, theme: ExtensionCommandContext["ui"]["theme"]): string {
	if (!status.cacheFresh) return theme.fg("dim", "tools not cached");
	const direct = status.directToolNames.length;
	const parts = [`${status.toolCount ?? 0} tools`];
	if (status.resourceCount) parts.push(`${status.resourceCount} resources`);
	parts.push(direct > 0 ? `${direct} direct` : "proxy");
	return parts.join(", ");
}

function renderAuth(status: McpServerStatus, theme: ExtensionCommandContext["ui"]["theme"]): string {
	if (status.authMode === "none") return "";
	return theme.fg("dim", `[${status.authMode}]`);
}

function showTools(manager: McpManager, ctx: ExtensionCommandContext, serverName: string | undefined): void {
	const theme = ctx.ui.theme;
	const statuses = manager.getStatuses().filter((status) => !serverName || status.name === serverName);
	if (serverName && statuses.length === 0) {
		ctx.ui.notify(`Unknown MCP server "${serverName}". Configured: ${manager.formatServerList()}`, "error");
		return;
	}

	const lines: string[] = [];
	for (const status of statuses) {
		lines.push(theme.bold(status.name));
		if (!status.cacheFresh) {
			lines.push(theme.fg("dim", `  tools not cached — run /mcp refresh ${status.name}`));
			continue;
		}
		const cacheEntry = manager.getCache().servers[status.name];
		const directSet = new Set(status.directToolNames);
		for (const tool of cacheEntry?.tools ?? []) {
			if (!tool.name) continue;
			lines.push(`  ${tool.name}${markDirect(tool.name, directSet, theme)}`);
		}
		for (const resource of cacheEntry?.resources ?? []) {
			if (!resource.name) continue;
			lines.push(theme.fg("dim", `  resource: ${resource.name} (${resource.uri})`));
		}
		if (!cacheEntry?.tools?.length && !cacheEntry?.resources?.length) {
			lines.push(theme.fg("dim", "  (no tools)"));
		}
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

function markDirect(rawName: string, directSet: Set<string>, theme: ExtensionCommandContext["ui"]["theme"]): string {
	for (const direct of directSet) {
		if (direct === rawName || direct.endsWith(`_${rawName.replace(/[^a-zA-Z0-9_-]/g, "_")}`)) {
			return theme.fg("accent", ` → ${direct} (direct)`);
		}
	}
	return "";
}

async function refreshServers(
	manager: McpManager,
	ctx: ExtensionCommandContext,
	hooks: McpCommandHooks,
	serverName: string | undefined,
): Promise<void> {
	const names = serverName ? [serverName] : manager.getServerNames();
	for (const name of names) {
		ctx.ui.setStatus("mcp", `connecting ${name}...`);
		try {
			const result = await manager.refreshServer(name);
			ctx.ui.notify(`${name}: ${result.tools.length} tools, ${result.resources.length} resources`, "info");
		} catch (error) {
			ctx.ui.notify(`${name}: ${errorMessage(error)}`, "error");
		}
	}
	ctx.ui.setStatus("mcp", undefined);
	hooks.syncDirectTools(ctx);
}

async function connectServer(
	manager: McpManager,
	ctx: ExtensionCommandContext,
	hooks: McpCommandHooks,
	serverName: string,
): Promise<void> {
	ctx.ui.setStatus("mcp", `connecting ${serverName}...`);
	try {
		await manager.ensureConnected(serverName);
		ctx.ui.notify(`Connected ${serverName}`, "info");
		hooks.syncDirectTools(ctx);
	} finally {
		ctx.ui.setStatus("mcp", undefined);
	}
}

async function runAuth(
	manager: McpManager,
	ctx: ExtensionCommandContext,
	serverName: string | undefined,
): Promise<void> {
	const name = requireServerArg(serverName);
	await authorizeServer(manager, name, {
		onAuthorizationUrl: (url) => {
			ctx.ui.notify(`If the browser did not open, visit:\n${url}`, "info");
		},
		onStatus: (message) => ctx.ui.setStatus("mcp", message),
	});
	ctx.ui.setStatus("mcp", undefined);
	ctx.ui.notify(`Authorized ${name}`, "info");
}
