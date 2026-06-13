import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	CACHE_VERSION,
	createEmptyCache,
	getCachePath,
	isServerCacheValid,
	loadMetadataCache,
	saveMetadataCache,
	updateServerCache,
} from "../src/core/mcp/cache.ts";
import { computeMcpServerHash } from "../src/core/mcp/config.ts";
import { resolveMcpDirectToolNames } from "../src/core/subagents/runs/shared/mcp-direct-tool-allowlist.ts";

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

describe("metadata cache", () => {
	it("round-trips through save and load", () => {
		const agentDir = makeTempDir("oa-mcp-cache-");
		const cache = createEmptyCache();
		updateServerCache(
			cache,
			"alpha",
			{ command: "node" },
			{
				tools: [{ name: "do_thing", description: "Does a thing" }],
				resources: [{ uri: "file:///notes", name: "Notes" }],
			},
		);
		saveMetadataCache(cache, agentDir);

		const loaded = loadMetadataCache(agentDir);
		expect(loaded).not.toBeNull();
		expect(loaded?.version).toBe(CACHE_VERSION);
		expect(loaded?.servers.alpha?.tools).toEqual([{ name: "do_thing", description: "Does a thing" }]);
		expect(loaded?.servers.alpha?.configHash).toBe(computeMcpServerHash({ command: "node" }));
		expect(typeof loaded?.servers.alpha?.cachedAt).toBe("number");
	});

	it("leaves no temp files behind", () => {
		const agentDir = makeTempDir("oa-mcp-cache-");
		saveMetadataCache(createEmptyCache(), agentDir);
		const leftovers = fs.readdirSync(agentDir).filter((name) => name.endsWith(".tmp"));
		expect(leftovers).toEqual([]);
		expect(fs.existsSync(getCachePath(agentDir))).toBe(true);
	});

	it("rejects missing, malformed, or wrong-version caches", () => {
		const agentDir = makeTempDir("oa-mcp-cache-");
		expect(loadMetadataCache(agentDir)).toBeNull();

		fs.writeFileSync(getCachePath(agentDir), "not json");
		expect(loadMetadataCache(agentDir)).toBeNull();

		fs.writeFileSync(getCachePath(agentDir), JSON.stringify({ version: 999, servers: {} }));
		expect(loadMetadataCache(agentDir)).toBeNull();

		fs.writeFileSync(getCachePath(agentDir), JSON.stringify({ version: CACHE_VERSION, servers: [] }));
		expect(loadMetadataCache(agentDir)).toBeNull();
	});

	it("validates entries by hash and age", () => {
		const definition = { command: "node" };
		const hash = computeMcpServerHash(definition);

		expect(isServerCacheValid(undefined, definition)).toBe(false);
		expect(isServerCacheValid({ configHash: "stale", cachedAt: Date.now() }, definition)).toBe(false);
		expect(isServerCacheValid({ configHash: hash }, definition)).toBe(false);
		expect(isServerCacheValid({ configHash: hash, cachedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 }, definition)).toBe(
			false,
		);
		expect(isServerCacheValid({ configHash: hash, cachedAt: Date.now() }, definition)).toBe(true);
	});
});

describe("cross-contract: cache written by core mcp is readable by the subagent allowlist", () => {
	it("resolves direct tool names from a cache produced by updateServerCache", () => {
		const agentDir = makeTempDir("oa-mcp-contract-agent-");
		const projectDir = makeTempDir("oa-mcp-contract-project-");
		setEnv(ENV_AGENT_DIR, agentDir);

		const serverName = "oa-contract-test-server";
		const definition = { command: "node", args: ["server.js"] };
		fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { [serverName]: definition } }));

		const cache = createEmptyCache();
		updateServerCache(cache, serverName, definition, {
			tools: [{ name: "do_thing" }, { name: "other-tool" }],
			resources: [{ uri: "file:///notes", name: "Project Notes" }],
		});
		saveMetadataCache(cache, agentDir);

		expect(resolveMcpDirectToolNames([serverName], projectDir)).toEqual([
			"oa_contract_test_server_do_thing",
			"oa_contract_test_server_other-tool",
			"oa_contract_test_server_get_project_notes",
		]);

		expect(resolveMcpDirectToolNames([`${serverName}/do_thing`], projectDir)).toEqual([
			"oa_contract_test_server_do_thing",
		]);

		expect(resolveMcpDirectToolNames(["unknown-server"], projectDir)).toEqual([]);
		expect(resolveMcpDirectToolNames(undefined, projectDir)).toEqual([]);
		expect(resolveMcpDirectToolNames([], projectDir)).toEqual([]);
	});

	it("returns nothing when the config hash no longer matches", () => {
		const agentDir = makeTempDir("oa-mcp-contract-agent-");
		const projectDir = makeTempDir("oa-mcp-contract-project-");
		setEnv(ENV_AGENT_DIR, agentDir);

		const serverName = "oa-contract-test-server";
		const cache = createEmptyCache();
		updateServerCache(
			cache,
			serverName,
			{ command: "node", args: ["old.js"] },
			{
				tools: [{ name: "do_thing" }],
				resources: [],
			},
		);
		saveMetadataCache(cache, agentDir);

		fs.writeFileSync(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { [serverName]: { command: "node", args: ["new.js"] } } }),
		);

		expect(resolveMcpDirectToolNames([serverName], projectDir)).toEqual([]);
	});
});
