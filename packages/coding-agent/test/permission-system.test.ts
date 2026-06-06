import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getModel } from "@openachieve/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionUIContext } from "../src/core/extensions/index.ts";
import {
	extractBashCommands,
	extractBashPathCandidates,
	mergePermissionConfig,
	normalizePermissionPathForTest,
	type PermissionConfig,
	PermissionManager,
	splitBashCommands,
	wildcardMatch,
} from "../src/core/permission-system.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { buildOaArgs } from "../src/core/subagents/runs/shared/oa-args.ts";

describe("permission system", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `openachieve-permissions-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createManager(config: PermissionConfig | undefined): PermissionManager {
		return new PermissionManager(tempDir, () => config);
	}

	it("uses built-in permissions when permission config is absent", () => {
		const manager = createManager(undefined);

		expect(manager.resolve("read", { path: "src/index.ts" }).state).toBe("allow");
		expect(manager.resolve("grep", { pattern: "x", path: "src" }).state).toBe("allow");
		expect(manager.resolve("find", { pattern: "*.ts", path: "src" }).state).toBe("allow");
		expect(manager.resolve("ls", { path: "src" }).state).toBe("allow");
		expect(manager.resolve("write", { path: "src/index.ts", content: "" }).state).toBe("ask");
		expect(manager.resolve("edit", { path: "src/index.ts", edits: [] }).state).toBe("ask");
		expect(manager.resolve("bash", { command: "git status" }).state).toBe("ask");
		expect(manager.resolve("read", { path: ".env" }).state).toBe("deny");
		expect(manager.shouldExposeTool("bash")).toBe(true);
	});

	it("allows users to opt back into permissive defaults", () => {
		const manager = createManager({ "*": "allow" });

		expect(manager.resolve("bash", { command: "rm -rf build" }).state).toBe("allow");
		expect(manager.resolve("read", { path: ".env" }).state).toBe("allow");
		expect(manager.resolve("write", { path: "src/index.ts", content: "" }).state).toBe("allow");
	});

	it("permission-mode allow upgrades ask to allow but keeps deny", () => {
		const manager = new PermissionManager(tempDir, () => undefined, "allow");

		expect(manager.resolve("write", { path: "src/index.ts", content: "" }).state).toBe("allow");
		expect(manager.resolve("edit", { path: "src/index.ts", edits: [] }).state).toBe("allow");
		expect(manager.resolve("bash", { command: "rm -rf build" }).state).toBe("allow");
		// deny (credential paths) is preserved even under allow mode
		expect(manager.resolve("read", { path: ".env" }).state).toBe("deny");
		expect(manager.resolve("bash", { command: "cat .env" }).state).toBe("deny");
	});

	it("permission-mode bypass allows everything including deny", () => {
		const manager = new PermissionManager(tempDir, () => undefined, "bypass");

		expect(manager.resolve("write", { path: "src/index.ts", content: "" }).state).toBe("allow");
		expect(manager.resolve("bash", { command: "rm -rf build" }).state).toBe("allow");
		expect(manager.resolve("read", { path: ".env" }).state).toBe("allow");
		expect(manager.resolve("bash", { command: "cat .env" }).state).toBe("allow");
		expect(manager.shouldExposeTool("bash")).toBe(true);
	});

	it("permission-mode bypass exposes tools the config denies", () => {
		const manager = new PermissionManager(tempDir, () => ({ bash: "deny" }), "bypass");

		expect(manager.shouldExposeTool("bash")).toBe(true);
		expect(manager.resolve("bash", { command: "echo hi" }).state).toBe("allow");
	});

	it("uses built-in ask policy for configured permissions without a matching override", () => {
		const manager = createManager({ read: "allow" });

		const result = manager.resolve("write", { path: "src/index.ts", content: "" });

		expect(result.state).toBe("ask");
		expect(result.rule.layer).toBe("builtin");
	});

	it("matches wildcard patterns including bare command star suffixes", () => {
		expect(wildcardMatch("git *", "git")).toBe(true);
		expect(wildcardMatch("git *", "git status")).toBe(true);
		expect(wildcardMatch("file?.ts", "file1.ts")).toBe(true);
		expect(wildcardMatch("file?.ts", "file10.ts")).toBe(false);
	});

	it("uses last matching rule within a surface", () => {
		const manager = createManager({
			"*": "allow",
			bash: {
				"*": "allow",
				"git *": "ask",
				"git status": "allow",
			},
		});

		expect(manager.resolve("bash", { command: "git diff" }).state).toBe("ask");
		expect(manager.resolve("bash", { command: "git status" }).state).toBe("allow");
	});

	it("uses deny over ask over allow for bash command chains", () => {
		const manager = createManager({
			"*": "allow",
			bash: {
				"*": "allow",
				"npm *": "ask",
				"rm -rf *": "deny",
			},
		});

		const result = manager.resolve("bash", { command: "git status && npm install foo; rm -rf build" });

		expect(result.state).toBe("deny");
		expect(result.matchedPattern).toBe("rm -rf *");
	});

	it("splits bash chains while respecting quoted operators", () => {
		expect(splitBashCommands("echo 'a && b' && git status | sed \"s/x;y/z/\"")).toEqual([
			"echo 'a && b'",
			"git status",
			'sed "s/x;y/z/"',
		]);
	});

	it("applies path policy before per-tool policy", () => {
		const manager = createManager({
			"*": "allow",
			path: {
				"*": "allow",
				"*.env": "deny",
			},
			read: "allow",
		});

		const result = manager.resolve("read", { path: ".env" });

		expect(result.state).toBe("deny");
		expect(result.surface).toBe("path");
		expect(result.matchedPattern).toBe("*.env");
	});

	it("matches path-bearing tool inputs for built-in tools", () => {
		const manager = createManager({
			"*": "allow",
			read: { "src/*": "ask" },
			write: { "src/*": "ask" },
			edit: { "src/*": "ask" },
			grep: { "src*": "ask" },
			find: { "src*": "ask" },
			ls: { "src*": "ask" },
		});

		expect(manager.resolve("read", { path: "src/a.ts" }).state).toBe("ask");
		expect(manager.resolve("write", { path: "src/a.ts", content: "" }).state).toBe("ask");
		expect(manager.resolve("edit", { path: "src/a.ts", edits: [] }).state).toBe("ask");
		expect(manager.resolve("grep", { pattern: "x", path: "src" }).state).toBe("ask");
		expect(manager.resolve("find", { pattern: "*.ts", path: "src" }).state).toBe("ask");
		expect(manager.resolve("ls", { path: "src" }).state).toBe("ask");
	});

	it("asks for external directory access outside cwd", () => {
		const manager = createManager({
			"*": "allow",
			external_directory: "ask",
			read: "allow",
		});

		const externalPath = resolve(tempDir, "..", "outside.txt");
		const result = manager.resolve("read", { path: externalPath });

		expect(result.state).toBe("ask");
		expect(result.surface).toBe("external_directory");
	});

	it("applies path policy to bash path candidates", () => {
		const manager = createManager({
			"*": "allow",
			path: {
				"*": "allow",
				".env": "deny",
			},
			bash: "allow",
		});

		const result = manager.resolve("bash", { command: "cat .env && echo done" });

		expect(extractBashPathCandidates("cat .env && echo done")).toContain(".env");
		expect(result.state).toBe("deny");
		expect(result.surface).toBe("path");
	});

	it("applies built-in path policy to bash path candidates", () => {
		const manager = createManager(undefined);

		const result = manager.resolve("bash", { command: "cat .env && echo done" });

		expect(result.state).toBe("deny");
		expect(result.surface).toBe("path");
		expect(result.matchedPattern).toBe("*.env");
	});

	it("checks nested bash commands without matching quoted text", () => {
		const manager = createManager({
			"*": "allow",
			bash: {
				"*": "allow",
				"rm -rf *": "deny",
			},
		});

		const nested = manager.resolve("bash", { command: "echo $(rm -rf build)" });
		const quoted = manager.resolve("bash", { command: "echo 'rm -rf build'" });

		expect(extractBashCommands("echo $(rm -rf build)")).toContain("rm -rf build");
		expect(nested.state).toBe("deny");
		expect(nested.matchedPattern).toBe("rm -rf *");
		expect(quoted.state).toBe("allow");
	});

	it("checks command substitution inside double quotes", () => {
		const manager = createManager(undefined);

		const result = manager.resolve("bash", { command: 'echo "$(cat .env)"' });

		expect(result.state).toBe("deny");
		expect(result.surface).toBe("path");
	});

	it("stores session approvals without persisting settings", () => {
		const manager = createManager({
			"*": "allow",
			bash: {
				"git *": "ask",
			},
		});

		const first = manager.resolve("bash", { command: "git diff" });
		expect(first.state).toBe("ask");
		expect(first.sessionApproval).toEqual({ surface: "bash", pattern: "git *" });

		expect(first.sessionApproval).toBeDefined();
		if (!first.sessionApproval) {
			throw new Error("Expected session approval");
		}
		manager.addSessionApproval(first.sessionApproval.surface, first.sessionApproval.pattern);

		const second = manager.resolve("bash", { command: "git status" });
		expect(second.state).toBe("allow");
		expect(second.rule.layer).toBe("session");
	});

	it("merges project permission maps by surface pattern", () => {
		const merged = mergePermissionConfig(
			{ "*": "allow", path: { "*": "allow", "*.env": "deny" }, bash: "ask" },
			{ path: { "*.env.example": "allow" }, bash: "deny" },
		);

		expect(merged).toEqual({
			"*": "allow",
			path: { "*": "allow", "*.env": "deny", "*.env.example": "allow" },
			bash: "deny",
		});
	});

	it("normalizes absolute paths for exact session approval patterns", () => {
		expect(normalizePermissionPathForTest("src/a.ts", tempDir)).toBe(resolve(tempDir, "src/a.ts"));
	});

	async function createSessionWithPermissions(permission?: PermissionConfig) {
		const settingsManager = SettingsManager.inMemory({ permission });
		const authStorage = AuthStorage.inMemory();
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		authStorage.setRuntimeApiKey(model.provider, "test-key");

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			authStorage,
		});
		return session;
	}

	it("does not expose tools with explicit deny permissions", async () => {
		const session = await createSessionWithPermissions({
			"*": "allow",
			bash: "deny",
			read: {
				"*": "allow",
				"*.env": "deny",
			},
		});

		expect(session.getActiveToolNames()).not.toContain("bash");
		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("bash");
		expect(session.getActiveToolNames()).toContain("read");

		session.dispose();
	});

	it("prompts once and then honors session approval through the agent hook", async () => {
		const session = await createSessionWithPermissions({
			"*": "allow",
			bash: {
				"git *": "ask",
			},
		});
		const uiContext = createSelectUiContext("Approve bash:git * for this session");
		await session.bindExtensions({ uiContext, mode: "tui" });

		const first = await session.agent.beforeToolCall?.({
			assistantMessage: emptyAssistantMessage(),
			toolCall: { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "git diff" } },
			args: { command: "git diff" },
			context: session.state,
		});
		const second = await session.agent.beforeToolCall?.({
			assistantMessage: emptyAssistantMessage(),
			toolCall: { type: "toolCall", id: "call-2", name: "bash", arguments: { command: "git status" } },
			args: { command: "git status" },
			context: session.state,
		});

		expect(first).toBeUndefined();
		expect(second).toBeUndefined();
		expect(uiContext.selectCalls).toBe(1);

		session.dispose();
	});

	it("blocks ask permissions without an interactive UI", async () => {
		const session = await createSessionWithPermissions();
		await session.bindExtensions({ mode: "print" });

		const result = await session.agent.beforeToolCall?.({
			assistantMessage: emptyAssistantMessage(),
			toolCall: { type: "toolCall", id: "call-1", name: "write", arguments: { path: "out.txt", content: "x" } },
			args: { path: "out.txt", content: "x" },
			context: session.state,
		});

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("no interactive permission UI is available");

		session.dispose();
	});

	it("parses --permission-mode from the CLI", () => {
		expect(parseArgs(["--permission-mode", "allow", "-p", "hi"]).permissionMode).toBe("allow");
		expect(parseArgs(["--permission-mode", "bypass"]).permissionMode).toBe("bypass");
		expect(parseArgs(["-p", "hi"]).permissionMode).toBeUndefined();
	});

	it("warns on an invalid --permission-mode value and leaves it unset", () => {
		const parsed = parseArgs(["--permission-mode", "bogus"]);
		expect(parsed.permissionMode).toBeUndefined();
		expect(parsed.diagnostics.some((d) => d.type === "warning" && d.message.includes("permission mode"))).toBe(true);
	});

	it("injects --permission-mode into subagent child args", () => {
		const { args } = buildOaArgs({
			baseArgs: ["--mode", "json", "-p"],
			task: "do work",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			permissionMode: "allow",
		});
		const idx = args.indexOf("--permission-mode");
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(args[idx + 1]).toBe("allow");
	});

	it("omits --permission-mode from child args when unset", () => {
		const { args } = buildOaArgs({
			baseArgs: ["--mode", "json", "-p"],
			task: "do work",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
		});
		expect(args).not.toContain("--permission-mode");
	});
});

function emptyAssistantMessage() {
	return {
		role: "assistant" as const,
		content: [],
		api: "responses" as const,
		provider: "anthropic" as const,
		model: "claude-sonnet-4-5",
		stopReason: "stop" as const,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function createSelectUiContext(selection: string): ExtensionUIContext & { selectCalls: number } {
	return {
		selectCalls: 0,
		async select() {
			this.selectCalls++;
			return selection;
		},
		async confirm() {
			return false;
		},
		async input() {
			return undefined;
		},
		notify() {},
		onTerminalInput() {
			return () => {};
		},
		setStatus() {},
		setWorkingMessage() {},
		setWorkingVisible() {},
		setWorkingIndicator() {},
		setHiddenThinkingLabel() {},
		setWidget() {},
		setFooter() {},
		setHeader() {},
		setTitle() {},
		async custom(factory, _options) {
			let value: unknown;
			const done = (result: unknown) => {
				value = result;
			};
			await factory(undefined as never, undefined as never, undefined as never, done as never);
			return value as never;
		},
		pasteToEditor() {},
		setEditorText() {},
		getEditorText() {
			return "";
		},
		async editor() {
			return undefined;
		},
		addAutocompleteProvider() {},
		setEditorComponent() {},
		getEditorComponent() {
			return undefined;
		},
		theme: undefined as never,
		getAllThemes() {
			return [];
		},
		getTheme() {
			return undefined;
		},
		setTheme() {
			return { success: true };
		},
		getToolsExpanded() {
			return false;
		},
		setToolsExpanded() {},
	};
}
