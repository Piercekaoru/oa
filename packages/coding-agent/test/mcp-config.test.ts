import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	computeMcpServerHash,
	interpolateEnvVars,
	loadMcpConfig,
	resolveBearerToken,
	resolveConfigPath,
	validateConfig,
} from "../src/core/mcp/config.ts";
import type { McpServerEntry } from "../src/core/mcp/types.ts";

// ============================================================================
// Frozen snapshot of the legacy hash implementation (formerly in
// subagents/runs/shared/mcp-direct-tool-allowlist.ts). The production hash
// must stay byte-identical to this forever: subagent allowlist resolution
// silently breaks when cached configHash values stop matching.
// ============================================================================

function legacyInterpolateEnvVars(value: string): string {
	return value
		.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? "")
		.replace(/\$env:(\w+)/g, (_, name: string) => process.env[name] ?? "");
}

function legacyInterpolateEnvRecord(values: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!values || typeof values !== "object" || Array.isArray(values)) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(values)) {
		if (typeof value === "string") resolved[key] = legacyInterpolateEnvVars(value);
	}
	return resolved;
}

function legacyResolveConfigPath(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const resolved = legacyInterpolateEnvVars(value);
	if (resolved === "~") return os.homedir();
	if (resolved.startsWith("~/") || resolved.startsWith("~\\")) return path.join(os.homedir(), resolved.slice(2));
	return resolved;
}

function legacyResolveBearerToken(definition: Pick<McpServerEntry, "bearerToken" | "bearerTokenEnv">) {
	if (typeof definition.bearerToken === "string") return legacyInterpolateEnvVars(definition.bearerToken);
	return typeof definition.bearerTokenEnv === "string" ? process.env[definition.bearerTokenEnv] : undefined;
}

function legacyStableStringify(value: unknown): string {
	if (value === null || value === undefined || typeof value !== "object") {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? "undefined" : serialized;
	}
	if (Array.isArray(value)) return `[${value.map((entry) => legacyStableStringify(entry)).join(",")}]`;
	const obj = value as Record<string, unknown>;
	return `{${Object.keys(obj)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${legacyStableStringify(obj[key])}`)
		.join(",")}}`;
}

function legacyComputeMcpServerHash(definition: McpServerEntry): string {
	const identity: Record<string, unknown> = {
		command: definition.command,
		args: definition.args,
		env: legacyInterpolateEnvRecord(definition.env),
		cwd: legacyResolveConfigPath(definition.cwd),
		url: definition.url,
		headers: legacyInterpolateEnvRecord(definition.headers),
		auth: definition.auth,
		bearerToken: legacyResolveBearerToken(definition),
		bearerTokenEnv: definition.bearerTokenEnv,
		exposeResources: definition.exposeResources,
		excludeTools: definition.excludeTools,
	};
	return createHash("sha256").update(legacyStableStringify(identity)).digest("hex");
}

// ============================================================================

const tempDirs: string[] = [];
const envBackup = new Map<string, string | undefined>();

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function setEnv(key: string, value: string | undefined): void {
	if (!envBackup.has(key)) envBackup.set(key, process.env[key]);
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	for (const [key, value] of envBackup) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	envBackup.clear();
});

describe("computeMcpServerHash", () => {
	const cases: Record<string, McpServerEntry> = {
		stdio: { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] },
		httpBearer: { url: "https://example.com/mcp", auth: "bearer", bearerToken: "tok123" },
		empty: {},
		full: {
			command: "node",
			args: ["server.js"],
			auth: false,
			exposeResources: false,
			excludeTools: ["a", "b"],
		},
		withCwdTilde: { command: "node", cwd: "~/projects/server" },
	};

	it("matches the legacy implementation for representative entries", () => {
		for (const [name, definition] of Object.entries(cases)) {
			expect(computeMcpServerHash(definition), `case: ${name}`).toBe(legacyComputeMcpServerHash(definition));
		}
	});

	it("matches the legacy implementation with env interpolation", () => {
		setEnv("OA_MCP_TEST_TOKEN", "secret-value");
		setEnv("OA_MCP_TEST_HOME", "/srv/data");
		const definition: McpServerEntry = {
			command: "node",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal mcp.json interpolation syntax
			env: { TOKEN: "${OA_MCP_TEST_TOKEN}", OTHER: "$env:OA_MCP_TEST_HOME" },
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal mcp.json interpolation syntax
			headers: { Authorization: "Bearer ${OA_MCP_TEST_TOKEN}" },
			bearerTokenEnv: "OA_MCP_TEST_TOKEN",
		};
		expect(computeMcpServerHash(definition)).toBe(legacyComputeMcpServerHash(definition));
	});

	it("changes when identity fields change and is stable across key order", () => {
		const a = computeMcpServerHash({ command: "node", args: ["x"] });
		const b = computeMcpServerHash({ args: ["x"], command: "node" });
		const c = computeMcpServerHash({ command: "node", args: ["y"] });
		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});

	it("ignores fields that are not part of server identity", () => {
		const base: McpServerEntry = { command: "node" };
		const withDirectTools: McpServerEntry = { command: "node", directTools: ["foo"] };
		expect(computeMcpServerHash(base)).toBe(computeMcpServerHash(withDirectTools));
	});
});

describe("validateConfig", () => {
	it("accepts mcpServers and the mcp-servers alias", () => {
		expect(validateConfig({ mcpServers: { a: { command: "x" } } }).mcpServers.a).toEqual({ command: "x" });
		expect(validateConfig({ "mcp-servers": { b: { url: "https://x" } } }).mcpServers.b).toEqual({
			url: "https://x",
		});
	});

	it("tolerates malformed input", () => {
		expect(validateConfig(null).mcpServers).toEqual({});
		expect(validateConfig([1, 2]).mcpServers).toEqual({});
		expect(validateConfig({ mcpServers: [1] }).mcpServers).toEqual({});
		expect(validateConfig({ imports: ["cursor", "bogus"] }).imports).toEqual(["cursor"]);
	});
});

describe("loadMcpConfig", () => {
	it("merges agent dir, project, and .openachieve configs with later-wins precedence", () => {
		const agentDir = makeTempDir("oa-mcp-agentdir-");
		const projectDir = makeTempDir("oa-mcp-project-");
		setEnv(ENV_AGENT_DIR, agentDir);

		fs.writeFileSync(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					"oa-test-global": { command: "global-cmd" },
					"oa-test-shared": { command: "from-global" },
				},
				settings: { toolPrefix: "none" },
			}),
		);
		fs.writeFileSync(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: { "oa-test-shared": { command: "from-project" } },
				settings: { toolPrefix: "server" },
			}),
		);
		fs.mkdirSync(path.join(projectDir, ".openachieve"));
		fs.writeFileSync(
			path.join(projectDir, ".openachieve", "mcp.json"),
			JSON.stringify({ mcpServers: { "oa-test-local": { command: "local-cmd" } } }),
		);

		const config = loadMcpConfig(projectDir);
		expect(config.mcpServers["oa-test-global"]).toEqual({ command: "global-cmd" });
		expect(config.mcpServers["oa-test-shared"]).toEqual({ command: "from-project" });
		expect(config.mcpServers["oa-test-local"]).toEqual({ command: "local-cmd" });
		expect(config.settings?.toolPrefix).toBe("server");
	});

	it("expands vscode imports from the project directory without overriding explicit servers", () => {
		const agentDir = makeTempDir("oa-mcp-agentdir-");
		const projectDir = makeTempDir("oa-mcp-project-");
		setEnv(ENV_AGENT_DIR, agentDir);

		fs.mkdirSync(path.join(projectDir, ".vscode"));
		fs.writeFileSync(
			path.join(projectDir, ".vscode", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					"oa-test-imported": { command: "imported-cmd" },
					"oa-test-overridden": { command: "imported-version" },
				},
			}),
		);
		fs.writeFileSync(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify({
				imports: ["vscode"],
				mcpServers: { "oa-test-overridden": { command: "explicit-version" } },
			}),
		);

		const config = loadMcpConfig(projectDir);
		expect(config.mcpServers["oa-test-imported"]).toEqual({ command: "imported-cmd" });
		expect(config.mcpServers["oa-test-overridden"]).toEqual({ command: "explicit-version" });
	});

	it("returns an empty config when nothing exists", () => {
		const agentDir = makeTempDir("oa-mcp-agentdir-");
		const projectDir = makeTempDir("oa-mcp-project-");
		setEnv(ENV_AGENT_DIR, agentDir);
		const config = loadMcpConfig(projectDir);
		expect(config.mcpServers["oa-test-anything"]).toBeUndefined();
	});
});

describe("interpolation helpers", () => {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal mcp.json interpolation syntax
	it("interpolates ${VAR} and $env:VAR", () => {
		setEnv("OA_MCP_TEST_A", "alpha");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal mcp.json interpolation syntax
		expect(interpolateEnvVars("x-${OA_MCP_TEST_A}-y")).toBe("x-alpha-y");
		expect(interpolateEnvVars("$env:OA_MCP_TEST_A")).toBe("alpha");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal mcp.json interpolation syntax
		expect(interpolateEnvVars("${OA_MCP_TEST_MISSING_VAR}")).toBe("");
	});

	it("expands ~ in config paths", () => {
		expect(resolveConfigPath("~")).toBe(os.homedir());
		expect(resolveConfigPath("~/sub/dir")).toBe(path.join(os.homedir(), "sub/dir"));
		expect(resolveConfigPath("/abs/path")).toBe("/abs/path");
		expect(resolveConfigPath(undefined)).toBeUndefined();
	});

	it("resolves bearer tokens from literal or env", () => {
		setEnv("OA_MCP_TEST_TOKEN", "from-env");
		expect(resolveBearerToken({ bearerToken: "literal" })).toBe("literal");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal mcp.json interpolation syntax
		expect(resolveBearerToken({ bearerToken: "${OA_MCP_TEST_TOKEN}" })).toBe("from-env");
		expect(resolveBearerToken({ bearerTokenEnv: "OA_MCP_TEST_TOKEN" })).toBe("from-env");
		expect(resolveBearerToken({})).toBeUndefined();
	});
});
