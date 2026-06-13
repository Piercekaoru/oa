import { loadMetadataCache } from "../../../mcp/cache.ts";
import { loadMcpConfig } from "../../../mcp/config.ts";
import { buildSelectionFilter, collectExposedEntries } from "../../../mcp/selection.ts";

export { computeMcpServerHash } from "../../../mcp/config.ts";

/**
 * Resolve the prefixed MCP tool names a subagent may use, based on its
 * mcpDirectTools selections ("server" or "server/tool") and the metadata
 * cache maintained by the core MCP manager.
 */
export function resolveMcpDirectToolNames(mcpDirectTools: string[] | undefined, cwd = process.cwd()): string[] {
	if (!mcpDirectTools?.length) return [];

	try {
		const config = loadMcpConfig(cwd);
		const cache = loadMetadataCache();
		if (!cache) return [];
		return collectExposedEntries(config, cache, buildSelectionFilter(mcpDirectTools)).map(
			(entry) => entry.exposedName,
		);
	} catch {
		return [];
	}
}
