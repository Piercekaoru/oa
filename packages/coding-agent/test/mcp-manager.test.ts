import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { loadMetadataCache } from "../src/core/mcp/cache.ts";
import { McpManager } from "../src/core/mcp/manager.ts";
import type { McpServerEntry } from "../src/core/mcp/types.ts";

const FIXTURE_SERVER = fileURLToPath(new URL("./fixtures/mcp-test-server.mjs", import.meta.url));

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

function fixtureEntry(): McpServerEntry {
	return { command: process.execPath, args: [FIXTURE_SERVER] };
}

function setupManager(options?: { settings?: Record<string, unknown>; entry?: McpServerEntry }): {
	manager: McpManager;
	agentDir: string;
	cwd: string;
} {
	const agentDir = makeTempDir("oa-mcp-manager-agent-");
	const cwd = makeTempDir("oa-mcp-manager-cwd-");
	setEnv(ENV_AGENT_DIR, agentDir);
	fs.writeFileSync(
		path.join(agentDir, "mcp.json"),
		JSON.stringify({
			mcpServers: { fixture: options?.entry ?? fixtureEntry() },
			...(options?.settings ? { settings: options.settings } : {}),
		}),
	);
	return { manager: McpManager.getOrCreate(cwd), agentDir, cwd };
}

afterEach(async () => {
	await McpManager.getExisting()?.disposeAll();
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	for (const [key, value] of envBackup) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	envBackup.clear();
});

describe("McpManager", () => {
	it("connects lazily and writes the metadata cache", async () => {
		const { manager, agentDir } = setupManager();
		expect(manager.getConnection("fixture")).toBeUndefined();

		const connection = await manager.ensureConnected("fixture");
		expect(connection.state).toBe("connected");

		const cache = loadMetadataCache(agentDir);
		const toolNames = cache?.servers.fixture?.tools?.map((tool) => tool.name);
		expect(toolNames).toContain("echo");
		expect(toolNames).toContain("fail_tool");
		expect(cache?.servers.fixture?.resources?.map((resource) => resource.uri)).toContain("memo://notes");
		expect(cache?.servers.fixture?.tools?.find((tool) => tool.name === "echo")?.inputSchema).toMatchObject({
			type: "object",
		});
	}, 20_000);

	it("deduplicates concurrent connects", async () => {
		const { manager } = setupManager();
		const [first, second] = await Promise.all([
			manager.ensureConnected("fixture"),
			manager.ensureConnected("fixture"),
		]);
		expect(first).toBe(second);
	}, 20_000);

	it("calls tools and surfaces results", async () => {
		const { manager } = setupManager();
		const result = await manager.callTool("fixture", "echo", { message: "hi" });
		expect(result.content).toEqual([{ type: "text", text: "echo: hi" }]);
	}, 20_000);

	it("rejects unknown servers with the configured list", async () => {
		const { manager } = setupManager();
		await expect(manager.ensureConnected("nope")).rejects.toThrow(/Unknown MCP server "nope".*fixture/s);
	});

	it("disconnects idle servers", async () => {
		const { manager } = setupManager({ settings: { idleTimeoutMs: 150 } });
		const connection = await manager.ensureConnected("fixture");
		expect(connection.state).toBe("connected");
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(connection.state).toBe("disconnected");
	}, 20_000);

	it("reconnects after a server crash", async () => {
		const { manager } = setupManager();
		const result = await manager.callTool("fixture", "die", {});
		expect(result.content).toEqual([{ type: "text", text: "dying" }]);
		await new Promise((resolve) => setTimeout(resolve, 300));

		const recovered = await manager.callTool("fixture", "echo", { message: "back" });
		expect(recovered.content).toEqual([{ type: "text", text: "echo: back" }]);
	}, 20_000);

	it("reports statuses including direct tool names", async () => {
		const { manager } = setupManager({ entry: { ...fixtureEntry(), directTools: ["echo"] } });
		await manager.refreshServer("fixture");

		const statuses = manager.getStatuses();
		expect(statuses).toHaveLength(1);
		expect(statuses[0]).toMatchObject({
			name: "fixture",
			state: "connected",
			transport: "stdio",
			cacheFresh: true,
			authMode: "none",
		});
		expect(statuses[0]!.directToolNames).toEqual(["fixture_echo"]);
	}, 20_000);

	it("drops connections whose config identity changed on reload", async () => {
		const { manager, agentDir, cwd } = setupManager();
		const connection = await manager.ensureConnected("fixture");
		expect(connection.state).toBe("connected");

		fs.writeFileSync(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { fixture: { ...fixtureEntry(), env: { CHANGED: "1" } } } }),
		);
		manager.reloadConfig(cwd);
		expect(manager.getConnection("fixture")).toBeUndefined();
	}, 20_000);
});
