import { Text } from "@openachieve/tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { isServerCacheValid } from "./cache.ts";
import { mapCallToolResult, mapReadResourceResult } from "./content.ts";
import { errorMessage, type McpManager } from "./manager.ts";
import { formatToolName, getToolPrefix, isToolExcluded, resourceNameToToolName } from "./naming.ts";
import type { CachedResourceMeta, CachedToolMeta, McpServerEntry } from "./types.ts";

const McpProxyParams = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("describe"), Type.Literal("call")], {
		description: "list: enumerate servers/tools. describe: tool details + schemas. call: execute a tool.",
	}),
	server: Type.Optional(Type.String({ description: "Server name (required for describe and call)" })),
	tool: Type.Optional(Type.String({ description: "Tool name (required for call, narrows describe)" })),
	args: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "Tool arguments for call, matching the schema from describe",
		}),
	),
});

export interface McpProxyDetails {
	action: "list" | "describe" | "call";
	server?: string;
	tool?: string;
}

interface ServerInventory {
	tools: CachedToolMeta[];
	resources: CachedResourceMeta[];
	fromCache: boolean;
}

export function createMcpProxyTool(manager: McpManager): ToolDefinition<typeof McpProxyParams, McpProxyDetails> {
	return {
		name: "mcp",
		label: "MCP",
		description: `Discover and call tools from configured MCP (Model Context Protocol) servers.

Usage:
- {action: "list"}: all servers with their tool names
- {action: "describe", server}: tool descriptions for one server
- {action: "describe", server, tool}: full parameter schema for one tool
- {action: "call", server, tool, args}: execute a tool

Describe unfamiliar tools before calling them; pass args matching the described schema.`,
		promptSnippet: "Discover and call MCP server tools (list/describe/call)",
		parameters: McpProxyParams,

		async execute(_toolCallId, params, signal, onUpdate) {
			const details: McpProxyDetails = { action: params.action, server: params.server, tool: params.tool };
			const notifyProgress = (text: string): void => {
				onUpdate?.({ content: [{ type: "text", text }], details });
			};
			try {
				switch (params.action) {
					case "list":
						return {
							content: [{ type: "text", text: await runList(manager, params, signal, notifyProgress) }],
							details,
						};
					case "describe":
						return {
							content: [{ type: "text", text: await runDescribe(manager, params, signal, notifyProgress) }],
							details,
						};
					case "call":
						return { content: await runCall(manager, params, signal, notifyProgress), details };
					default:
						throw new Error(`Unknown action "${params.action}". Use "list", "describe", or "call".`);
				}
			} catch (error) {
				throw new Error(formatActionError(manager, params, error));
			}
		},

		renderCall(args, theme) {
			const title = theme.fg("toolTitle", theme.bold("mcp "));
			const target = [args.server, args.tool].filter(Boolean).join("/");
			return new Text(`${title}${args.action ?? "?"}${target ? ` ${theme.fg("accent", target)}` : ""}`, 0, 0);
		},
	};
}

async function getInventory(
	manager: McpManager,
	serverName: string,
	entry: McpServerEntry,
	signal: AbortSignal | undefined,
	progress: (text: string) => void,
): Promise<ServerInventory> {
	const cacheEntry = manager.getCache().servers[serverName];
	if (isServerCacheValid(cacheEntry, entry)) {
		return { tools: cacheEntry.tools ?? [], resources: cacheEntry.resources ?? [], fromCache: true };
	}
	progress(`Connecting to MCP server "${serverName}"...`);
	const refreshed = await manager.refreshServer(serverName, signal);
	return { tools: refreshed.tools, resources: refreshed.resources, fromCache: false };
}

function visibleTools(
	entry: McpServerEntry,
	inventory: ServerInventory,
	prefix: ReturnType<typeof getToolPrefix>,
	serverName: string,
) {
	const tools = inventory.tools.filter(
		(tool) => tool.name && !isToolExcluded(tool.name, serverName, prefix, entry.excludeTools),
	);
	const resources =
		entry.exposeResources === false
			? []
			: inventory.resources.filter((resource) => {
					if (!resource.name || !resource.uri) return false;
					const baseName = `get_${resourceNameToToolName(resource.name)}`;
					return !isToolExcluded(baseName, serverName, prefix, entry.excludeTools);
				});
	return { tools, resources };
}

async function runList(
	manager: McpManager,
	params: Static<typeof McpProxyParams>,
	signal: AbortSignal | undefined,
	progress: (text: string) => void,
): Promise<string> {
	if (params.server) return runDescribe(manager, params, signal, progress);

	const names = manager.getServerNames();
	if (names.length === 0) {
		return "No MCP servers configured. Add servers to mcp.json (global: ~/.openachieve/agent/mcp.json, project: .mcp.json).";
	}

	const prefix = getToolPrefix(manager.config.settings?.toolPrefix);
	const lines: string[] = [];
	for (const name of names) {
		const entry = manager.getServerEntry(name)!;
		const connection = manager.getConnection(name);
		const cacheEntry = manager.getCache().servers[name];
		const state = connection?.state ?? "disconnected";

		if (isServerCacheValid(cacheEntry, entry)) {
			const { tools, resources } = visibleTools(
				entry,
				{ tools: cacheEntry.tools ?? [], resources: cacheEntry.resources ?? [], fromCache: true },
				prefix,
				name,
			);
			const toolNames = [
				...tools.map((tool) => tool.name),
				...resources.map((resource) => `get_${resourceNameToToolName(resource.name!)}`),
			];
			lines.push(
				`${name} (${state}, ${tools.length} tools${resources.length ? `, ${resources.length} resources` : ""})`,
			);
			lines.push(`  tools: ${toolNames.join(", ") || "(none)"}`);
		} else {
			const errorSuffix = connection?.lastError ? `, last error: ${connection.lastError}` : "";
			lines.push(`${name} (${state}, tools not cached${errorSuffix})`);
			lines.push(`  use {action: "describe", server: "${name}"} to connect and list tools`);
		}
	}
	return lines.join("\n");
}

async function runDescribe(
	manager: McpManager,
	params: Static<typeof McpProxyParams>,
	signal: AbortSignal | undefined,
	progress: (text: string) => void,
): Promise<string> {
	const serverName = requireServer(manager, params);
	const entry = requireEntry(manager, serverName);
	const prefix = getToolPrefix(manager.config.settings?.toolPrefix);
	const inventory = await getInventory(manager, serverName, entry, signal, progress);
	const { tools, resources } = visibleTools(entry, inventory, prefix, serverName);

	if (params.tool) {
		const tool = tools.find((candidate) => matchesToolName(candidate.name!, params.tool!, serverName, prefix));
		if (tool) {
			return [
				`${serverName}/${tool.name}`,
				tool.description ?? "(no description)",
				"",
				`Parameters: ${JSON.stringify(tool.inputSchema ?? { type: "object" }, null, 2)}`,
			].join("\n");
		}
		const resource = resources.find((candidate) =>
			matchesToolName(`get_${resourceNameToToolName(candidate.name!)}`, params.tool!, serverName, prefix),
		);
		if (resource) {
			return [
				`${serverName}/get_${resourceNameToToolName(resource.name!)} (resource)`,
				resource.description ?? resource.name ?? "(no description)",
				`URI: ${resource.uri}`,
				"",
				"Parameters: none (call with empty args)",
			].join("\n");
		}
		throw new Error(`Tool "${params.tool}" not found on server "${serverName}". ${availableHint(tools, resources)}`);
	}

	const lines = [`${serverName}: ${tools.length} tools${resources.length ? `, ${resources.length} resources` : ""}`];
	for (const tool of tools) {
		lines.push(`- ${tool.name}: ${oneLine(tool.description) || "(no description)"}`);
	}
	for (const resource of resources) {
		lines.push(
			`- get_${resourceNameToToolName(resource.name!)} (resource): ${oneLine(resource.description) || resource.uri}`,
		);
	}
	if (tools.length + resources.length === 0) lines.push("(no tools exposed)");
	lines.push("", `Use {action: "describe", server: "${serverName}", tool: "<name>"} for parameter schemas.`);
	return lines.join("\n");
}

async function runCall(
	manager: McpManager,
	params: Static<typeof McpProxyParams>,
	signal: AbortSignal | undefined,
	progress: (text: string) => void,
) {
	const serverName = requireServer(manager, params);
	const entry = requireEntry(manager, serverName);
	if (!params.tool) throw new Error(`Missing "tool". ${describeHint(serverName)}`);
	const prefix = getToolPrefix(manager.config.settings?.toolPrefix);

	const inventory = await getInventory(manager, serverName, entry, signal, progress);
	const { tools, resources } = visibleTools(entry, inventory, prefix, serverName);

	const tool = tools.find((candidate) => matchesToolName(candidate.name!, params.tool!, serverName, prefix));
	if (tool) {
		progress(`Calling ${serverName}/${tool.name}...`);
		const result = await manager.callTool(serverName, tool.name!, params.args, signal);
		return mapCallToolResult(result, `${serverName}/${tool.name}`);
	}

	const resource = resources.find((candidate) =>
		matchesToolName(`get_${resourceNameToToolName(candidate.name!)}`, params.tool!, serverName, prefix),
	);
	if (resource) {
		progress(`Reading ${resource.uri}...`);
		const result = await manager.readResource(serverName, resource.uri!, signal);
		return mapReadResourceResult(result);
	}

	if (isToolExcluded(params.tool, serverName, prefix, entry.excludeTools)) {
		throw new Error(`Tool "${params.tool}" is excluded by configuration on server "${serverName}".`);
	}
	throw new Error(`Tool "${params.tool}" not found on server "${serverName}". ${availableHint(tools, resources)}`);
}

function matchesToolName(
	rawName: string,
	requested: string,
	serverName: string,
	prefix: ReturnType<typeof getToolPrefix>,
): boolean {
	return rawName === requested || formatToolName(rawName, serverName, prefix) === requested;
}

function requireServer(manager: McpManager, params: Static<typeof McpProxyParams>): string {
	if (!params.server) {
		throw new Error(`Missing "server". Configured servers: ${manager.formatServerList()}`);
	}
	return params.server;
}

function requireEntry(manager: McpManager, serverName: string): McpServerEntry {
	const entry = manager.getServerEntry(serverName);
	if (!entry) {
		throw new Error(`Unknown MCP server "${serverName}". Configured servers: ${manager.formatServerList()}`);
	}
	return entry;
}

function availableHint(tools: CachedToolMeta[], resources: CachedResourceMeta[]): string {
	const names = [
		...tools.map((tool) => tool.name),
		...resources.map((resource) => `get_${resourceNameToToolName(resource.name!)}`),
	].filter(Boolean);
	return names.length ? `Available: ${names.join(", ")}` : "The server exposes no tools.";
}

function describeHint(serverName: string): string {
	return `Use {action: "describe", server: "${serverName}"} to see available tools.`;
}

function oneLine(text: string | undefined): string {
	if (!text) return "";
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

function formatActionError(manager: McpManager, params: Static<typeof McpProxyParams>, error: unknown): string {
	const message = errorMessage(error);
	if (params.server && manager.getServerEntry(params.server)) {
		const connection = manager.getConnection(params.server);
		const stderr = connection?.getRecentStderr().slice(-5) ?? [];
		const stderrSuffix = stderr.length ? `\nServer stderr:\n${stderr.join("\n")}` : "";
		return `${message}${stderrSuffix}`;
	}
	return message;
}
