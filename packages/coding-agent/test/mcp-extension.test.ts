import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getModel } from "@openachieve/ai";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { createEmptyCache, saveMetadataCache, updateServerCache } from "../src/core/mcp/cache.ts";
import { McpManager } from "../src/core/mcp/manager.ts";
import type { McpServerEntry } from "../src/core/mcp/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const FIXTURE_SERVER = fileURLToPath(new URL("./fixtures/mcp-test-server.mjs", import.meta.url));
const GENERIC_GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".config", "mcp", "mcp.json");

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

async function createSession(cwd: string, agentDir: string) {
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
	await resourceLoader.reload();
	return createAgentSession({
		cwd,
		agentDir,
		model: getModel("anthropic", "claude-sonnet-4-5")!,
		settingsManager,
		sessionManager: SessionManager.inMemory(),
		resourceLoader,
	});
}

describe("mcp extension integration", () => {
	it("registers the proxy tool and cached direct tools at startup", async () => {
		const agentDir = makeTempDir("oa-mcp-ext-agent-");
		const cwd = makeTempDir("oa-mcp-ext-cwd-");
		setEnv(ENV_AGENT_DIR, agentDir);

		const entry: McpServerEntry = {
			command: process.execPath,
			args: [FIXTURE_SERVER],
			directTools: ["echo"],
		};
		fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: entry } }));

		// Pre-populate the metadata cache so direct tools register without a live connect.
		const cache = createEmptyCache();
		updateServerCache(cache, "fixture", entry, {
			tools: [
				{
					name: "echo",
					description: "Echo back the input message",
					inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
				},
			],
			resources: [],
		});
		saveMetadataCache(cache, agentDir);

		const { session } = await createSession(cwd, agentDir);
		const toolNames = session.getAllTools().map((tool) => tool.name);

		expect(toolNames).toContain("mcp");
		expect(toolNames).toContain("fixture_echo");
		expect(session.getActiveToolNames()).toContain("mcp");
		expect(session.getActiveToolNames()).toContain("fixture_echo");

		session.dispose();
	}, 30_000);

	it.skipIf(fs.existsSync(GENERIC_GLOBAL_CONFIG_PATH))(
		"registers nothing when no servers are configured",
		async () => {
			const agentDir = makeTempDir("oa-mcp-ext-agent-");
			const cwd = makeTempDir("oa-mcp-ext-cwd-");
			setEnv(ENV_AGENT_DIR, agentDir);

			const { session } = await createSession(cwd, agentDir);
			expect(session.getAllTools().map((tool) => tool.name)).not.toContain("mcp");
			session.dispose();
		},
		30_000,
	);

	it("subagent allowlist resolves names registered by the extension pipeline", async () => {
		const agentDir = makeTempDir("oa-mcp-ext-agent-");
		const cwd = makeTempDir("oa-mcp-ext-cwd-");
		setEnv(ENV_AGENT_DIR, agentDir);

		const entry: McpServerEntry = { command: process.execPath, args: [FIXTURE_SERVER] };
		fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: entry } }));

		// Live refresh through the manager (what /mcp refresh or first use does).
		const manager = McpManager.getOrCreate(cwd);
		await manager.refreshServer("fixture");

		const { resolveMcpDirectToolNames } = await import(
			"../src/core/subagents/runs/shared/mcp-direct-tool-allowlist.ts"
		);
		expect(resolveMcpDirectToolNames(["fixture/echo"], cwd)).toEqual(["fixture_echo"]);
		expect(resolveMcpDirectToolNames(["fixture"], cwd)).toEqual([
			"fixture_echo",
			"fixture_fail_tool",
			"fixture_die",
			"fixture_get_test_notes",
		]);
	}, 30_000);
});
