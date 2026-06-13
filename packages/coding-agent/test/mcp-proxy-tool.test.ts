import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { McpManager } from "../src/core/mcp/manager.ts";
import { createMcpProxyTool } from "../src/core/mcp/proxy-tool.ts";
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

function setupProxy(entry?: Partial<McpServerEntry>) {
	const agentDir = makeTempDir("oa-mcp-proxy-agent-");
	const cwd = makeTempDir("oa-mcp-proxy-cwd-");
	setEnv(ENV_AGENT_DIR, agentDir);
	fs.writeFileSync(
		path.join(agentDir, "mcp.json"),
		JSON.stringify({
			mcpServers: { fixture: { command: process.execPath, args: [FIXTURE_SERVER], ...entry } },
		}),
	);
	const manager = McpManager.getOrCreate(cwd);
	const tool = createMcpProxyTool(manager);
	const run = (params: Record<string, unknown>) =>
		tool.execute("call-1", params as never, undefined, undefined, {} as never);
	return { manager, tool, run };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
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

describe("mcp proxy tool", () => {
	it("lists servers without connecting when nothing is cached", async () => {
		const { manager, run } = setupProxy();
		const result = await run({ action: "list" });
		expect(textOf(result)).toContain("fixture (disconnected, tools not cached");
		expect(textOf(result)).toContain('{action: "describe", server: "fixture"}');
		expect(manager.getConnection("fixture")).toBeUndefined();
	});

	it("describe connects, refreshes, and lists tool descriptions", async () => {
		const { manager, run } = setupProxy();
		const result = await run({ action: "describe", server: "fixture" });
		const text = textOf(result);
		expect(text).toContain("echo: Echo back the input message");
		expect(text).toContain("fail_tool");
		expect(text).toContain("get_test_notes (resource)");
		expect(manager.getConnection("fixture")?.state).toBe("connected");

		const listAfter = textOf(await run({ action: "list" }));
		expect(listAfter).toContain("echo");
		expect(listAfter).toContain("get_test_notes");
	}, 20_000);

	it("describe with tool returns the parameter schema", async () => {
		const { run } = setupProxy();
		const text = textOf(await run({ action: "describe", server: "fixture", tool: "echo" }));
		expect(text).toContain("fixture/echo");
		expect(text).toContain('"message"');
	}, 20_000);

	it("calls tools by raw and prefixed name", async () => {
		const { run } = setupProxy();
		expect(textOf(await run({ action: "call", server: "fixture", tool: "echo", args: { message: "a" } }))).toBe(
			"echo: a",
		);
		expect(
			textOf(await run({ action: "call", server: "fixture", tool: "fixture_echo", args: { message: "b" } })),
		).toBe("echo: b");
	}, 20_000);

	it("reads resources through the call action", async () => {
		const { run } = setupProxy();
		const text = textOf(await run({ action: "call", server: "fixture", tool: "get_test_notes" }));
		expect(text).toContain("the notes content");
	}, 20_000);

	it("propagates isError results as tool errors", async () => {
		const { run } = setupProxy();
		await expect(run({ action: "call", server: "fixture", tool: "fail_tool" })).rejects.toThrow(/deliberate failure/);
	}, 20_000);

	it("gives actionable errors for unknown servers and tools", async () => {
		const { run } = setupProxy();
		await expect(run({ action: "describe", server: "nope" })).rejects.toThrow(/Unknown MCP server "nope".*fixture/s);
		await expect(run({ action: "call", server: "fixture", tool: "missing" })).rejects.toThrow(
			/not found on server "fixture".*echo/s,
		);
		await expect(run({ action: "call", server: "fixture" })).rejects.toThrow(/Missing "tool"/);
	}, 20_000);

	it("hides and refuses excluded tools", async () => {
		const { run } = setupProxy({ excludeTools: ["echo"] });
		const text = textOf(await run({ action: "describe", server: "fixture" }));
		expect(text).not.toContain("echo:");
		await expect(run({ action: "call", server: "fixture", tool: "echo" })).rejects.toThrow(/excluded/);
	}, 20_000);
});
