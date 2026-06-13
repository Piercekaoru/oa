import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { validateToolArguments } from "@openachieve/ai";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { buildDirectToolDefinition, normalizeJsonSchema, selectDirectTools } from "../src/core/mcp/direct-tools.ts";
import { McpManager } from "../src/core/mcp/manager.ts";

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

describe("normalizeJsonSchema", () => {
	it("passes plain object schemas through", () => {
		const schema = normalizeJsonSchema({
			type: "object",
			properties: { a: { type: "string" } },
			required: ["a"],
		}) as Record<string, unknown>;
		expect(schema).toMatchObject({ type: "object", required: ["a"] });
	});

	it("inlines $refs and strips $defs", () => {
		const schema = normalizeJsonSchema({
			type: "object",
			properties: { item: { $ref: "#/$defs/Item" } },
			$defs: { Item: { type: "string", minLength: 1 } },
		}) as { properties: { item: Record<string, unknown> }; $defs?: unknown };
		expect(schema.properties.item).toEqual({ type: "string", minLength: 1 });
		expect(schema.$defs).toBeUndefined();
	});

	it("cuts cyclic refs instead of recursing forever", () => {
		const schema = normalizeJsonSchema({
			type: "object",
			properties: { node: { $ref: "#/$defs/Node" } },
			$defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } } } },
		}) as Record<string, unknown>;
		expect(schema.type).toBe("object");
	});

	it("forces an object root and tolerates garbage", () => {
		expect((normalizeJsonSchema({ type: "string" }) as Record<string, unknown>).type).toBe("object");
		expect((normalizeJsonSchema(undefined) as Record<string, unknown>).type).toBe("object");
	});

	it("produces schemas that validateToolArguments accepts for raw JSON Schema", () => {
		const parameters = normalizeJsonSchema({
			type: "object",
			properties: { message: { type: "string" } },
			required: ["message"],
		});
		const tool = { name: "x", description: "", parameters };
		const validated = validateToolArguments(tool as never, {
			type: "toolCall",
			id: "1",
			name: "x",
			arguments: { message: "hello" },
		});
		expect(validated).toEqual({ message: "hello" });
		expect(() =>
			validateToolArguments(tool as never, { type: "toolCall", id: "2", name: "x", arguments: {} }),
		).toThrow(/Validation failed/);
	});
});

describe("direct tool definitions", () => {
	function setup(directTools: boolean | string[]) {
		const agentDir = makeTempDir("oa-mcp-direct-agent-");
		const cwd = makeTempDir("oa-mcp-direct-cwd-");
		setEnv(ENV_AGENT_DIR, agentDir);
		fs.writeFileSync(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: { fixture: { command: process.execPath, args: [FIXTURE_SERVER], directTools } },
			}),
		);
		return McpManager.getOrCreate(cwd);
	}

	it("selects nothing before the cache exists, everything after refresh", async () => {
		const manager = setup(true);
		expect(selectDirectTools(manager)).toEqual([]);

		await manager.refreshServer("fixture");
		const names = selectDirectTools(manager).map((entry) => entry.exposedName);
		expect(names).toEqual(["fixture_echo", "fixture_fail_tool", "fixture_die", "fixture_get_test_notes"]);
	}, 20_000);

	it("respects string selections", async () => {
		const manager = setup(["echo", "get_test_notes"]);
		await manager.refreshServer("fixture");
		const names = selectDirectTools(manager).map((entry) => entry.exposedName);
		expect(names).toEqual(["fixture_echo", "fixture_get_test_notes"]);
	}, 20_000);

	it("executes promoted tools and resources end-to-end", async () => {
		const manager = setup(["echo", "get_test_notes"]);
		await manager.refreshServer("fixture");
		const entries = selectDirectTools(manager);

		const echoTool = buildDirectToolDefinition(manager, entries.find((entry) => entry.kind === "tool")!);
		expect(echoTool.name).toBe("fixture_echo");
		expect(echoTool.promptSnippet).toContain("Echo back");
		const validated = validateToolArguments(echoTool as never, {
			type: "toolCall",
			id: "1",
			name: echoTool.name,
			arguments: { message: "live" },
		});
		const result = await echoTool.execute("call-1", validated, undefined, undefined, {} as never);
		expect(result.content).toEqual([{ type: "text", text: "echo: live" }]);
		expect(result.details).toEqual({ server: "fixture", mcpTool: "echo" });

		const resourceTool = buildDirectToolDefinition(manager, entries.find((entry) => entry.kind === "resource")!);
		expect(resourceTool.name).toBe("fixture_get_test_notes");
		const resourceResult = await resourceTool.execute("call-2", {}, undefined, undefined, {} as never);
		expect(resourceResult.content[0]).toMatchObject({ type: "text" });
		expect((resourceResult.content[0] as { text: string }).text).toContain("the notes content");
	}, 20_000);
});
