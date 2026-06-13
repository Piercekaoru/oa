import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "../../config.ts";
import type { ImportKind, McpConfig, McpServerEntry } from "./types.ts";

const GENERIC_GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".config", "mcp", "mcp.json");
const IMPORT_PATHS: Record<ImportKind, readonly string[]> = {
	cursor: [path.join(os.homedir(), ".cursor", "mcp.json")],
	"claude-code": [
		path.join(os.homedir(), ".claude", "mcp.json"),
		path.join(os.homedir(), ".claude.json"),
		path.join(os.homedir(), ".claude", "claude_desktop_config.json"),
	],
	"claude-desktop": [
		path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json"),
	],
	codex: [path.join(os.homedir(), ".codex", "config.json")],
	windsurf: [path.join(os.homedir(), ".windsurf", "mcp.json")],
	vscode: [".vscode/mcp.json"],
};

export function loadMcpConfig(cwd: string): McpConfig {
	let config: McpConfig = { mcpServers: {} };
	for (const sourcePath of getConfigPaths(cwd)) {
		const loaded = readConfig(sourcePath);
		if (!loaded) continue;
		config = mergeConfigs(config, expandImports(loaded, cwd));
	}
	return config;
}

export function getConfigPaths(cwd: string): string[] {
	const oaGlobalPath = path.join(getAgentDir(), "mcp.json");
	const projectPath = path.resolve(cwd, ".mcp.json");
	const projectOaPath = path.resolve(cwd, ".openachieve", "mcp.json");
	const sources: string[] = [];
	if (GENERIC_GLOBAL_CONFIG_PATH !== oaGlobalPath) sources.push(GENERIC_GLOBAL_CONFIG_PATH);
	sources.push(oaGlobalPath);
	if (projectPath !== oaGlobalPath) sources.push(projectPath);
	if (projectOaPath !== oaGlobalPath && projectOaPath !== projectPath) sources.push(projectOaPath);
	return sources;
}

function readConfig(configPath: string): McpConfig | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
	} catch {
		return null;
	}
	return validateConfig(parsed);
}

export function validateConfig(raw: unknown): McpConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { mcpServers: {} };
	const obj = raw as Record<string, unknown>;
	const servers = obj.mcpServers ?? obj["mcp-servers"] ?? {};
	return {
		mcpServers:
			servers && typeof servers === "object" && !Array.isArray(servers)
				? (servers as Record<string, McpServerEntry>)
				: {},
		imports: Array.isArray(obj.imports)
			? obj.imports.filter((value): value is ImportKind => isImportKind(value))
			: undefined,
		settings:
			obj.settings && typeof obj.settings === "object" && !Array.isArray(obj.settings)
				? (obj.settings as McpConfig["settings"])
				: undefined,
	};
}

function mergeConfigs(base: McpConfig, next: McpConfig): McpConfig {
	const imports = [...(base.imports ?? []), ...(next.imports ?? [])];
	return {
		mcpServers: { ...base.mcpServers, ...next.mcpServers },
		imports: imports.length ? [...new Set(imports)] : undefined,
		settings: next.settings ? { ...base.settings, ...next.settings } : base.settings,
	};
}

function expandImports(config: McpConfig, cwd: string): McpConfig {
	if (!config.imports?.length) return config;

	const importedServers: Record<string, McpServerEntry> = {};
	for (const importKind of config.imports) {
		const importPath = resolveImportPath(importKind, cwd);
		if (!importPath) continue;
		let imported: unknown;
		try {
			imported = JSON.parse(fs.readFileSync(importPath, "utf-8"));
		} catch {
			continue;
		}
		for (const [name, definition] of Object.entries(extractServers(imported, importKind))) {
			if (!importedServers[name]) importedServers[name] = definition;
		}
	}

	return {
		imports: config.imports,
		settings: config.settings,
		mcpServers: { ...importedServers, ...config.mcpServers },
	};
}

function resolveImportPath(importKind: ImportKind, cwd: string): string | null {
	for (const candidate of IMPORT_PATHS[importKind]) {
		const fullPath = candidate.startsWith(".") ? path.resolve(cwd, candidate) : candidate;
		if (fs.existsSync(fullPath)) return fullPath;
	}
	return null;
}

function extractServers(config: unknown, kind: ImportKind): Record<string, McpServerEntry> {
	if (!config || typeof config !== "object" || Array.isArray(config)) return {};
	const obj = config as Record<string, unknown>;
	const servers =
		kind === "cursor" || kind === "windsurf" || kind === "vscode"
			? (obj.mcpServers ?? obj["mcp-servers"])
			: obj.mcpServers;
	return servers && typeof servers === "object" && !Array.isArray(servers)
		? (servers as Record<string, McpServerEntry>)
		: {};
}

function isImportKind(value: unknown): value is ImportKind {
	return typeof value === "string" && Object.hasOwn(IMPORT_PATHS, value);
}

/**
 * Identity hash of a server definition. Cache entries are invalidated when this
 * changes, and subagent allowlist resolution depends on it matching exactly —
 * never change the field set or serialization without versioning the cache.
 */
export function computeMcpServerHash(definition: McpServerEntry): string {
	const identity: Record<string, unknown> = {
		command: definition.command,
		args: definition.args,
		env: interpolateEnvRecord(definition.env),
		cwd: resolveConfigPath(definition.cwd),
		url: definition.url,
		headers: interpolateEnvRecord(definition.headers),
		auth: definition.auth,
		bearerToken: resolveBearerToken(definition),
		bearerTokenEnv: definition.bearerTokenEnv,
		exposeResources: definition.exposeResources,
		excludeTools: definition.excludeTools,
	};
	return createHash("sha256").update(stableStringify(identity)).digest("hex");
}

export function interpolateEnvRecord(values: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!values || typeof values !== "object" || Array.isArray(values)) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(values)) {
		if (typeof value === "string") resolved[key] = interpolateEnvVars(value);
	}
	return resolved;
}

export function interpolateEnvVars(value: string): string {
	return value
		.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? "")
		.replace(/\$env:(\w+)/g, (_, name: string) => process.env[name] ?? "");
}

export function resolveConfigPath(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const resolved = interpolateEnvVars(value);
	if (resolved === "~") return os.homedir();
	if (resolved.startsWith("~/") || resolved.startsWith("~\\")) return path.join(os.homedir(), resolved.slice(2));
	return resolved;
}

export function resolveBearerToken(
	definition: Pick<McpServerEntry, "bearerToken" | "bearerTokenEnv">,
): string | undefined {
	if (typeof definition.bearerToken === "string") return interpolateEnvVars(definition.bearerToken);
	return typeof definition.bearerTokenEnv === "string" ? process.env[definition.bearerTokenEnv] : undefined;
}

function stableStringify(value: unknown): string {
	if (value === null || value === undefined || typeof value !== "object") {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? "undefined" : serialized;
	}
	if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
	const obj = value as Record<string, unknown>;
	return `{${Object.keys(obj)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
		.join(",")}}`;
}
