import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../../config.ts";
import { computeMcpServerHash } from "./config.ts";
import type { CachedResourceMeta, CachedToolMeta, McpServerEntry, MetadataCache, ServerCacheEntry } from "./types.ts";

export const CACHE_VERSION = 1;
export const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function getCachePath(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "mcp-cache.json");
}

export function createEmptyCache(): MetadataCache {
	return { version: CACHE_VERSION, servers: {} };
}

export function loadMetadataCache(agentDir: string = getAgentDir()): MetadataCache | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(getCachePath(agentDir), "utf-8"));
	} catch {
		return null;
	}

	if (!parsed || typeof parsed !== "object") return null;
	const raw = parsed as Record<string, unknown>;
	if (raw.version !== CACHE_VERSION || !raw.servers || typeof raw.servers !== "object" || Array.isArray(raw.servers)) {
		return null;
	}
	return raw as unknown as MetadataCache;
}

/** Atomic write: subagent child processes read this file concurrently. */
export function saveMetadataCache(cache: MetadataCache, agentDir: string = getAgentDir()): void {
	const cachePath = getCachePath(agentDir);
	const tmpPath = `${cachePath}.${process.pid}.tmp`;
	fs.mkdirSync(path.dirname(cachePath), { recursive: true });
	fs.writeFileSync(tmpPath, JSON.stringify(cache, null, "\t"));
	fs.renameSync(tmpPath, cachePath);
}

export function isServerCacheValid(
	entry: ServerCacheEntry | undefined,
	definition: McpServerEntry,
): entry is ServerCacheEntry {
	if (!entry || entry.configHash !== computeMcpServerHash(definition)) return false;
	if (!entry.cachedAt || typeof entry.cachedAt !== "number") return false;
	return Date.now() - entry.cachedAt <= CACHE_MAX_AGE_MS;
}

export function updateServerCache(
	cache: MetadataCache,
	serverName: string,
	definition: McpServerEntry,
	data: { tools: CachedToolMeta[]; resources: CachedResourceMeta[] },
): void {
	cache.servers[serverName] = {
		configHash: computeMcpServerHash(definition),
		tools: data.tools,
		resources: data.resources,
		cachedAt: Date.now(),
	};
}
