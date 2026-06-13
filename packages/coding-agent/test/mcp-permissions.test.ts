import { describe, expect, it } from "vitest";
import {
	type PermissionConfig,
	PermissionManager,
	registerMcpToolPermissionTarget,
} from "../src/core/permission-system.ts";

function createManager(config: PermissionConfig | undefined): PermissionManager {
	return new PermissionManager(process.cwd(), () => config);
}

describe("mcp permission surface", () => {
	it("allows metadata actions and asks for calls by default", () => {
		const manager = createManager(undefined);
		expect(manager.resolve("mcp", { action: "list" }).state).toBe("allow");
		expect(manager.resolve("mcp", { action: "list", server: "github" }).state).toBe("allow");
		expect(manager.resolve("mcp", { action: "describe", server: "github", tool: "x" }).state).toBe("allow");

		const call = manager.resolve("mcp", { action: "call", server: "github", tool: "create_issue" });
		expect(call.state).toBe("ask");
		expect(call.surface).toBe("mcp");
		expect(call.target).toBe("github/create_issue");
		expect(call.sessionApproval).toEqual({ surface: "mcp", pattern: "github/*" });
	});

	it("honors server-scoped config rules for proxy calls", () => {
		const manager = createManager({ mcp: { "github/*": "allow", "danger/*": "deny" } });
		expect(manager.resolve("mcp", { action: "call", server: "github", tool: "x" }).state).toBe("allow");
		expect(manager.resolve("mcp", { action: "call", server: "danger", tool: "x" }).state).toBe("deny");
		expect(manager.resolve("mcp", { action: "call", server: "other", tool: "x" }).state).toBe("ask");
		expect(manager.resolve("mcp", { action: "list" }).state).toBe("allow");
	});

	it("routes direct-registered MCP tools through the mcp surface", () => {
		registerMcpToolPermissionTarget("github_create_issue", "github", "create_issue");

		const defaults = createManager(undefined);
		const result = defaults.resolve("github_create_issue", { title: "x" });
		expect(result.state).toBe("ask");
		expect(result.surface).toBe("mcp");
		expect(result.target).toBe("github/create_issue");
		expect(result.sessionApproval).toEqual({ surface: "mcp", pattern: "github/*" });

		const allowed = createManager({ mcp: { "github/*": "allow" } });
		expect(allowed.resolve("github_create_issue", { title: "x" }).state).toBe("allow");
	});

	it("supports session approvals for server patterns", () => {
		const manager = createManager(undefined);
		manager.addSessionApproval("mcp", "github/*");
		expect(manager.resolve("mcp", { action: "call", server: "github", tool: "anything" }).state).toBe("allow");
		expect(manager.resolve("mcp", { action: "call", server: "other", tool: "x" }).state).toBe("ask");
	});

	it("can hide the proxy tool entirely", () => {
		const manager = createManager({ mcp: "deny" });
		expect(manager.shouldExposeTool("mcp")).toBe(false);
		expect(manager.resolve("mcp", { action: "call", server: "a", tool: "b" }).state).toBe("deny");
	});

	it("treats malformed proxy input conservatively", () => {
		const manager = createManager(undefined);
		expect(manager.resolve("mcp", undefined).state).toBe("ask");
		expect(manager.resolve("mcp", { action: 42 }).state).toBe("ask");
		expect(manager.resolve("mcp", { action: "call" }).state).toBe("ask");
	});
});
