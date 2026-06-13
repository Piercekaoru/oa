import { isServerCacheValid } from "./cache.ts";
import { BUILTIN_TOOL_NAMES, formatToolName, getToolPrefix, isToolExcluded, resourceNameToToolName } from "./naming.ts";
import type { CachedResourceMeta, CachedToolMeta, McpConfig, MetadataCache } from "./types.ts";

export interface ExposedToolEntry {
	server: string;
	kind: "tool" | "resource";
	/** Raw MCP tool name, or the synthesized get_* name for resources. */
	baseName: string;
	/** Final (prefixed, sanitized) name exposed to the LLM. */
	exposedName: string;
	tool?: CachedToolMeta;
	resource?: CachedResourceMeta;
}

/** true = all tools of the server; Set = only these base names; undefined = none. */
export type ServerToolFilter = true | Set<string> | undefined;

/**
 * Parse selection strings of the form "server" (whole server) or "server/tool".
 */
export function parseSelections(selections: string[]): { servers: Set<string>; tools: Map<string, Set<string>> } {
	const servers = new Set<string>();
	const tools = new Map<string, Set<string>>();
	for (let item of selections) {
		item = item.replace(/\/+$/, "");
		if (item.includes("/")) {
			const [server, tool] = item.split("/", 2);
			if (server && tool) {
				if (!tools.has(server)) tools.set(server, new Set());
				tools.get(server)!.add(tool);
			} else if (server) {
				servers.add(server);
			}
		} else if (item) {
			servers.add(item);
		}
	}
	return { servers, tools };
}

export function buildSelectionFilter(selections: string[]): (serverName: string) => ServerToolFilter {
	const { servers, tools } = parseSelections(selections);
	return (serverName) => (servers.has(serverName) ? true : tools.get(serverName));
}

/** Filter driven by mcp.json directTools settings (per-server overrides global default). */
export function buildDirectToolsFilter(config: McpConfig): (serverName: string) => ServerToolFilter {
	const globalDefault = config.settings?.directTools === true;
	return (serverName) => {
		const directTools = config.mcpServers[serverName]?.directTools;
		if (directTools === true) return true;
		if (Array.isArray(directTools)) return new Set(directTools);
		if (directTools === false) return undefined;
		return globalDefault ? true : undefined;
	};
}

/**
 * Iterate cached server metadata and yield the tools/resources that pass the
 * per-server filter, exclusions, builtin-name collisions, and global dedup.
 * Servers without a valid cache entry are skipped.
 */
export function collectExposedEntries(
	config: McpConfig,
	cache: MetadataCache,
	getFilter: (serverName: string) => ServerToolFilter,
): ExposedToolEntry[] {
	const entries: ExposedToolEntry[] = [];
	const seenNames = new Set<string>();
	const prefix = getToolPrefix(config.settings?.toolPrefix);

	for (const [serverName, definition] of Object.entries(config.mcpServers)) {
		const serverCache = cache.servers[serverName];
		if (!isServerCacheValid(serverCache, definition)) continue;

		const toolFilter = getFilter(serverName);
		if (!toolFilter) continue;

		for (const tool of Array.isArray(serverCache.tools) ? serverCache.tools : []) {
			if (typeof tool?.name !== "string" || !tool.name) continue;
			if (toolFilter !== true && !toolFilter.has(tool.name)) continue;
			if (isToolExcluded(tool.name, serverName, prefix, definition.excludeTools)) continue;
			const exposedName = formatToolName(tool.name, serverName, prefix);
			if (BUILTIN_TOOL_NAMES.has(exposedName) || seenNames.has(exposedName)) continue;
			seenNames.add(exposedName);
			entries.push({ server: serverName, kind: "tool", baseName: tool.name, exposedName, tool });
		}

		if (definition.exposeResources === false) continue;
		for (const resource of Array.isArray(serverCache.resources) ? serverCache.resources : []) {
			if (typeof resource?.name !== "string" || !resource.name || typeof resource.uri !== "string" || !resource.uri)
				continue;
			const baseName = `get_${resourceNameToToolName(resource.name)}`;
			if (toolFilter !== true && !toolFilter.has(baseName)) continue;
			if (isToolExcluded(baseName, serverName, prefix, definition.excludeTools)) continue;
			const exposedName = formatToolName(baseName, serverName, prefix);
			if (BUILTIN_TOOL_NAMES.has(exposedName) || seenNames.has(exposedName)) continue;
			seenNames.add(exposedName);
			entries.push({ server: serverName, kind: "resource", baseName, exposedName, resource });
		}
	}

	return entries;
}
