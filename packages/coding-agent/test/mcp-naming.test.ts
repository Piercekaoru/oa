import { describe, expect, it } from "vitest";
import {
	BUILTIN_TOOL_NAMES,
	formatToolName,
	getServerPrefix,
	getToolPrefix,
	isToolExcluded,
	normalizeToolName,
	resourceNameToToolName,
} from "../src/core/mcp/naming.ts";

describe("getToolPrefix", () => {
	it("defaults to server for unknown values", () => {
		expect(getToolPrefix(undefined)).toBe("server");
		expect(getToolPrefix("bogus")).toBe("server");
		expect(getToolPrefix("none")).toBe("none");
		expect(getToolPrefix("short")).toBe("short");
		expect(getToolPrefix("server")).toBe("server");
	});
});

describe("getServerPrefix", () => {
	it("converts dashes for server mode", () => {
		expect(getServerPrefix("github-tools", "server")).toBe("github_tools");
	});

	it("strips trailing -mcp for short mode", () => {
		expect(getServerPrefix("github-mcp", "short")).toBe("github");
		expect(getServerPrefix("playwright", "short")).toBe("playwright");
		expect(getServerPrefix("mcp", "short")).toBe("mcp");
	});

	it("returns empty for none mode", () => {
		expect(getServerPrefix("github", "none")).toBe("");
	});
});

describe("formatToolName", () => {
	it("prefixes by mode", () => {
		expect(formatToolName("create_issue", "github", "server")).toBe("github_create_issue");
		expect(formatToolName("create_issue", "github-mcp", "short")).toBe("github_create_issue");
		expect(formatToolName("create_issue", "github", "none")).toBe("create_issue");
	});

	it("sanitizes characters providers reject", () => {
		expect(formatToolName("repo.create", "github", "server")).toBe("github_repo_create");
		expect(formatToolName("a:b/c", "x", "none")).toBe("a_b_c");
		expect(formatToolName("keep-dash", "x", "none")).toBe("keep-dash");
	});
});

describe("isToolExcluded", () => {
	it("matches raw, prefixed, and normalized variants", () => {
		expect(isToolExcluded("create-issue", "github", "server", ["create_issue"])).toBe(true);
		expect(isToolExcluded("create-issue", "github", "server", ["github_create_issue"])).toBe(true);
		expect(isToolExcluded("create-issue", "github-mcp", "server", ["github_create_issue"])).toBe(true);
		expect(isToolExcluded("create-issue", "github", "server", ["other_tool"])).toBe(false);
		expect(isToolExcluded("create-issue", "github", "server", [])).toBe(false);
		expect(isToolExcluded("create-issue", "github", "server", undefined)).toBe(false);
	});
});

describe("normalizeToolName", () => {
	it("converts dashes to underscores", () => {
		expect(normalizeToolName("a-b-c")).toBe("a_b_c");
	});
});

describe("resourceNameToToolName", () => {
	it("sanitizes and lowercases", () => {
		expect(resourceNameToToolName("Project Notes")).toBe("project_notes");
		expect(resourceNameToToolName("My!! Weird--Name")).toBe("my_weird_name");
	});

	it("handles names that start with digits or collapse to nothing", () => {
		expect(resourceNameToToolName("123abc")).toBe("resource_123abc");
		expect(resourceNameToToolName("!!!")).toBe("resource");
	});
});

describe("BUILTIN_TOOL_NAMES", () => {
	it("reserves the proxy tool name", () => {
		expect(BUILTIN_TOOL_NAMES.has("mcp")).toBe(true);
		expect(BUILTIN_TOOL_NAMES.has("bash")).toBe(true);
	});
});
