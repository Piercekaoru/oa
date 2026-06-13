export type ToolPrefix = "server" | "none" | "short";

export type ImportKind = "cursor" | "claude-code" | "claude-desktop" | "codex" | "windsurf" | "vscode";

export interface McpServerEntry {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	auth?: "oauth" | "bearer" | false;
	bearerToken?: string;
	bearerTokenEnv?: string;
	exposeResources?: boolean;
	excludeTools?: string[];
	directTools?: boolean | string[];
}

export interface McpSettings {
	toolPrefix?: ToolPrefix;
	directTools?: boolean;
	/** Idle time before a connected server is disconnected. Defaults to 10 minutes. */
	idleTimeoutMs?: number;
}

export interface McpConfig {
	mcpServers: Record<string, McpServerEntry>;
	imports?: ImportKind[];
	settings?: McpSettings;
}

export interface CachedToolMeta {
	name?: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

export interface CachedResourceMeta {
	uri?: string;
	name?: string;
	description?: string;
	mimeType?: string;
}

export interface ServerCacheEntry {
	configHash?: string;
	tools?: CachedToolMeta[];
	resources?: CachedResourceMeta[];
	cachedAt?: number;
}

export interface MetadataCache {
	version: number;
	servers: Record<string, ServerCacheEntry>;
}

export type McpServerState = "disconnected" | "connecting" | "connected" | "error";

export type McpTransportKind = "stdio" | "http";

export interface McpServerStatus {
	name: string;
	state: McpServerState;
	transport: McpTransportKind;
	error?: string;
	toolCount?: number;
	resourceCount?: number;
	directToolNames: string[];
	authMode: "none" | "bearer" | "oauth";
	lastUsedAt?: number;
	cacheFresh: boolean;
}
