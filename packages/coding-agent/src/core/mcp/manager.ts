import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import {
	createEmptyCache,
	isServerCacheValid,
	loadMetadataCache,
	saveMetadataCache,
	updateServerCache,
} from "./cache.ts";
import { computeMcpServerHash, loadMcpConfig } from "./config.ts";
import { errorMessage, McpConnection } from "./connection.ts";
import { buildDirectToolsFilter, collectExposedEntries } from "./selection.ts";
import type {
	CachedResourceMeta,
	CachedToolMeta,
	McpConfig,
	McpServerEntry,
	McpServerStatus,
	MetadataCache,
} from "./types.ts";

const GLOBAL_STORE_KEY = "__oaMcpManager";

export interface RefreshResult {
	tools: CachedToolMeta[];
	resources: CachedResourceMeta[];
}

export type AuthProviderFactory = (serverName: string, entry: McpServerEntry) => OAuthClientProvider | undefined;

/**
 * Owns MCP server connections and the metadata cache. Stored as a process
 * global so /reload and session switches reuse live connections instead of
 * orphaning stdio child processes.
 */
export class McpManager {
	cwd: string;
	config: McpConfig;
	authProviderFactory: AuthProviderFactory | undefined;

	private cache: MetadataCache;
	private readonly connections = new Map<string, McpConnection>();
	private readonly inflightConnects = new Map<string, Promise<McpConnection>>();
	private exitHandler: (() => void) | undefined;

	private constructor(cwd: string) {
		this.cwd = cwd;
		this.config = loadMcpConfig(cwd);
		this.cache = loadMetadataCache() ?? createEmptyCache();
		this.installExitHandler();
	}

	static getOrCreate(cwd: string): McpManager {
		const store = globalThis as Record<string, unknown>;
		const existing = store[GLOBAL_STORE_KEY];
		if (existing instanceof McpManager) {
			existing.reloadConfig(cwd);
			return existing;
		}
		const manager = new McpManager(cwd);
		store[GLOBAL_STORE_KEY] = manager;
		return manager;
	}

	static getExisting(): McpManager | undefined {
		const existing = (globalThis as Record<string, unknown>)[GLOBAL_STORE_KEY];
		return existing instanceof McpManager ? existing : undefined;
	}

	/** Re-read config (cwd may have changed); drop connections whose identity changed. */
	reloadConfig(cwd: string): void {
		this.cwd = cwd;
		this.config = loadMcpConfig(cwd);
		this.cache = loadMetadataCache() ?? this.cache;
		for (const [name, connection] of this.connections) {
			const entry = this.config.mcpServers[name];
			if (!entry || computeMcpServerHash(entry) !== computeMcpServerHash(connection.entry)) {
				this.connections.delete(name);
				void connection.close();
			}
		}
	}

	hasServers(): boolean {
		return Object.keys(this.config.mcpServers).length > 0;
	}

	getServerNames(): string[] {
		return Object.keys(this.config.mcpServers);
	}

	getServerEntry(name: string): McpServerEntry | undefined {
		return this.config.mcpServers[name];
	}

	getCache(): MetadataCache {
		return this.cache;
	}

	getConnection(name: string): McpConnection | undefined {
		return this.connections.get(name);
	}

	idleTimeoutMs(): number | undefined {
		const value = this.config.settings?.idleTimeoutMs;
		return typeof value === "number" && value >= 0 ? value : undefined;
	}

	async ensureConnected(name: string, signal?: AbortSignal): Promise<McpConnection> {
		const entry = this.config.mcpServers[name];
		if (!entry) {
			throw new Error(`Unknown MCP server "${name}". Configured servers: ${this.formatServerList()}`);
		}

		const existing = this.connections.get(name);
		if (existing?.isConnected()) return existing;

		const inflight = this.inflightConnects.get(name);
		if (inflight) return inflight;

		const connectPromise = (async () => {
			const connection =
				existing ??
				new McpConnection(name, entry, {
					idleTimeoutMs: this.idleTimeoutMs(),
					authProvider: this.authProviderFactory?.(name, entry),
				});
			this.connections.set(name, connection);
			await connection.connect(signal);
			await this.refreshMetadata(connection, signal);
			return connection;
		})();

		this.inflightConnects.set(name, connectPromise);
		try {
			return await connectPromise;
		} finally {
			this.inflightConnects.delete(name);
		}
	}

	/** Connect (if needed) and refresh the metadata cache for one server. */
	async refreshServer(name: string, signal?: AbortSignal): Promise<RefreshResult> {
		const connection = await this.ensureConnected(name, signal);
		return await this.refreshMetadata(connection, signal);
	}

	private async refreshMetadata(connection: McpConnection, signal?: AbortSignal): Promise<RefreshResult> {
		const tools = await connection.listTools(signal);
		const resources = await connection.listResources(signal);
		updateServerCache(this.cache, connection.name, connection.entry, { tools, resources });
		try {
			saveMetadataCache(this.cache);
		} catch {
			// Cache persistence is advisory; never fail a live call over it.
		}
		return { tools, resources };
	}

	async callTool(
		serverName: string,
		toolName: string,
		args: Record<string, unknown> | undefined,
		signal?: AbortSignal,
	): Promise<CallToolResult> {
		const connection = await this.ensureConnected(serverName, signal);
		try {
			return await connection.callTool(toolName, args, signal);
		} catch (error) {
			if (signal?.aborted || connection.isConnected()) throw error;
			// The transport died mid-call (server crash, idle disconnect race):
			// reconnect once and retry.
			const reconnected = await this.ensureConnected(serverName, signal);
			return await reconnected.callTool(toolName, args, signal);
		}
	}

	async readResource(serverName: string, uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
		const connection = await this.ensureConnected(serverName, signal);
		return await connection.readResource(uri, signal);
	}

	getStatuses(): McpServerStatus[] {
		const directNames = new Map<string, string[]>();
		for (const entry of collectExposedEntries(this.config, this.cache, buildDirectToolsFilter(this.config))) {
			const list = directNames.get(entry.server) ?? [];
			list.push(entry.exposedName);
			directNames.set(entry.server, list);
		}

		return Object.entries(this.config.mcpServers).map(([name, entry]) => {
			const connection = this.connections.get(name);
			const cacheEntry = this.cache.servers[name];
			const cacheFresh = isServerCacheValid(cacheEntry, entry);
			return {
				name,
				state: connection?.state ?? "disconnected",
				transport: entry.url ? "http" : "stdio",
				error: connection?.lastError,
				toolCount: cacheFresh ? (cacheEntry.tools?.length ?? 0) : undefined,
				resourceCount: cacheFresh ? (cacheEntry.resources?.length ?? 0) : undefined,
				directToolNames: directNames.get(name) ?? [],
				authMode:
					entry.auth === "oauth"
						? "oauth"
						: entry.auth === "bearer" || entry.bearerToken || entry.bearerTokenEnv
							? "bearer"
							: "none",
				lastUsedAt: connection?.lastUsedAt,
				cacheFresh,
			};
		});
	}

	async disconnect(name: string): Promise<void> {
		const connection = this.connections.get(name);
		if (connection) await connection.close();
	}

	async disposeAll(): Promise<void> {
		const closing = [...this.connections.values()].map((connection) => connection.close());
		this.connections.clear();
		await Promise.allSettled(closing);
		if (this.exitHandler) {
			process.off("exit", this.exitHandler);
			this.exitHandler = undefined;
		}
		const store = globalThis as Record<string, unknown>;
		if (store[GLOBAL_STORE_KEY] === this) delete store[GLOBAL_STORE_KEY];
	}

	formatServerList(): string {
		const names = this.getServerNames();
		return names.length ? names.join(", ") : "(none)";
	}

	/** Best-effort synchronous cleanup of stdio children when the process exits. */
	private installExitHandler(): void {
		this.exitHandler = () => {
			for (const connection of this.connections.values()) {
				const pid = connection.pid;
				if (pid) {
					try {
						process.kill(pid, "SIGTERM");
					} catch {
						// Already gone.
					}
				}
			}
		};
		process.on("exit", this.exitHandler);
	}
}

export { errorMessage };
