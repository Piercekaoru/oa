import type { ToolPrefix } from "./types.ts";

/** Names that MCP tools must never shadow ("mcp" is the proxy tool itself). */
export const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "mcp"]);

export function getToolPrefix(value: unknown): ToolPrefix {
	return value === "none" || value === "short" || value === "server" ? value : "server";
}

export function getServerPrefix(serverName: string, mode: ToolPrefix): string {
	if (mode === "none") return "";
	if (mode === "short") {
		const short = serverName.replace(/-?mcp$/i, "").replace(/-/g, "_");
		return short || "mcp";
	}
	return serverName.replace(/-/g, "_");
}

/** Providers only accept [a-zA-Z0-9_-] in tool names; MCP allows more. */
function sanitizeExposedName(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function formatToolName(toolName: string, serverName: string, prefix: ToolPrefix): string {
	const serverPrefix = getServerPrefix(serverName, prefix);
	return sanitizeExposedName(serverPrefix ? `${serverPrefix}_${toolName}` : toolName);
}

export function isToolExcluded(
	toolName: string,
	serverName: string,
	prefix: ToolPrefix,
	excludeTools: unknown,
): boolean {
	if (!Array.isArray(excludeTools) || excludeTools.length === 0) return false;
	const candidates = new Set([
		normalizeToolName(toolName),
		normalizeToolName(formatToolName(toolName, serverName, prefix)),
		normalizeToolName(formatToolName(toolName, serverName, "server")),
		normalizeToolName(formatToolName(toolName, serverName, "short")),
	]);
	return excludeTools.some((excluded) => typeof excluded === "string" && candidates.has(normalizeToolName(excluded)));
}

export function normalizeToolName(value: string): string {
	return value.replace(/-/g, "_");
}

export function resourceNameToToolName(name: string): string {
	let result = name
		.replace(/[^a-zA-Z0-9]/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+/, "")
		.replace(/_+$/, "")
		.toLowerCase();
	if (!result || /^\d/.test(result)) result = `resource${result ? `_${result}` : ""}`;
	return result;
}
