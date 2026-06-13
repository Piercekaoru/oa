import { describe, expect, it } from "vitest";
import { computeMcpServerHash } from "../src/core/mcp/config.ts";
import {
	buildDirectToolsFilter,
	buildSelectionFilter,
	collectExposedEntries,
	parseSelections,
} from "../src/core/mcp/selection.ts";
import type { McpConfig, MetadataCache } from "../src/core/mcp/types.ts";

function makeCache(
	config: McpConfig,
	data: Record<string, { tools?: string[]; resources?: [string, string][] }>,
): MetadataCache {
	const servers: MetadataCache["servers"] = {};
	for (const [name, entry] of Object.entries(data)) {
		servers[name] = {
			configHash: computeMcpServerHash(config.mcpServers[name] ?? {}),
			tools: (entry.tools ?? []).map((tool) => ({ name: tool })),
			resources: (entry.resources ?? []).map(([uri, resourceName]) => ({ uri, name: resourceName })),
			cachedAt: Date.now(),
		};
	}
	return { version: 1, servers };
}

describe("parseSelections", () => {
	it("splits server and server/tool selections", () => {
		const { servers, tools } = parseSelections(["github", "jira/create_ticket", "jira/close_ticket", "x/"]);
		expect(servers).toEqual(new Set(["github", "x"]));
		expect(tools.get("jira")).toEqual(new Set(["create_ticket", "close_ticket"]));
	});
});

describe("buildDirectToolsFilter", () => {
	it("uses per-server settings over the global default", () => {
		const config: McpConfig = {
			mcpServers: {
				all: { directTools: true },
				some: { directTools: ["a", "b"] },
				none: { directTools: false },
				unset: {},
			},
			settings: { directTools: false },
		};
		const filter = buildDirectToolsFilter(config);
		expect(filter("all")).toBe(true);
		expect(filter("some")).toEqual(new Set(["a", "b"]));
		expect(filter("none")).toBeUndefined();
		expect(filter("unset")).toBeUndefined();
	});

	it("applies the global default when per-server is unset", () => {
		const config: McpConfig = {
			mcpServers: { unset: {}, optedOut: { directTools: false } },
			settings: { directTools: true },
		};
		const filter = buildDirectToolsFilter(config);
		expect(filter("unset")).toBe(true);
		expect(filter("optedOut")).toBeUndefined();
	});
});

describe("collectExposedEntries", () => {
	it("collects tools and resources with prefixed names", () => {
		const config: McpConfig = { mcpServers: { github: { command: "x" } } };
		const cache = makeCache(config, {
			github: { tools: ["create_issue"], resources: [["file:///notes", "Project Notes"]] },
		});

		const entries = collectExposedEntries(config, cache, () => true);
		expect(entries.map((entry) => entry.exposedName)).toEqual(["github_create_issue", "github_get_project_notes"]);
		expect(entries[0]).toMatchObject({ server: "github", kind: "tool", baseName: "create_issue" });
		expect(entries[1]).toMatchObject({ server: "github", kind: "resource", baseName: "get_project_notes" });
	});

	it("skips servers with invalid cache entries", () => {
		const config: McpConfig = { mcpServers: { github: { command: "x" } } };
		const cache: MetadataCache = {
			version: 1,
			servers: { github: { configHash: "stale", tools: [{ name: "t" }], cachedAt: Date.now() } },
		};
		expect(collectExposedEntries(config, cache, () => true)).toEqual([]);
	});

	it("filters by base name including resource get_* names", () => {
		const config: McpConfig = { mcpServers: { github: { command: "x" } } };
		const cache = makeCache(config, {
			github: { tools: ["a", "b"], resources: [["file:///n", "Notes"]] },
		});

		const filter = buildSelectionFilter(["github/a", "github/get_notes"]);
		const entries = collectExposedEntries(config, cache, filter);
		expect(entries.map((entry) => entry.exposedName)).toEqual(["github_a", "github_get_notes"]);
	});

	it("respects excludeTools and exposeResources", () => {
		const config: McpConfig = {
			mcpServers: { github: { command: "x", excludeTools: ["b"], exposeResources: false } },
		};
		const cache = makeCache(config, {
			github: { tools: ["a", "b"], resources: [["file:///n", "Notes"]] },
		});

		const entries = collectExposedEntries(config, cache, () => true);
		expect(entries.map((entry) => entry.exposedName)).toEqual(["github_a"]);
	});

	it("skips builtin-colliding and duplicate names", () => {
		const config: McpConfig = {
			mcpServers: { one: { command: "x" }, two: { command: "y" } },
			settings: { toolPrefix: "none" },
		};
		const cache = makeCache(config, {
			one: { tools: ["bash", "shared"] },
			two: { tools: ["shared", "unique"] },
		});

		const entries = collectExposedEntries(config, cache, () => true);
		expect(entries.map((entry) => entry.exposedName)).toEqual(["shared", "unique"]);
	});
});
