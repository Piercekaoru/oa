import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../extensions/types.ts";
import { SUBAGENT_CHILD_ENV } from "../subagents/runs/shared/oa-args.ts";
import { isServerCacheValid } from "./cache.ts";
import { errorMessage } from "./connection.ts";
import { buildDirectToolDefinition, selectDirectTools } from "./direct-tools.ts";
import { McpManager } from "./manager.ts";
import { createAuthProviderFactory } from "./oauth.ts";
import { createMcpProxyTool } from "./proxy-tool.ts";
import { buildDirectToolsFilter } from "./selection.ts";
import { registerMcpSlashCommand } from "./slash-command.ts";

/**
 * Built-in extension that wires MCP support into the agent session:
 * - registers the "mcp" proxy tool when servers are configured
 * - registers directTools-promoted MCP tools as first-class tools
 *   (from cache at startup, refreshed in the background)
 * - registers the /mcp command
 * - manages connection lifecycle across reloads and shutdown
 */
export default function registerMcpExtension(pi: ExtensionAPI): void {
	const isSubagentChild = process.env[SUBAGENT_CHILD_ENV] === "1";
	const manager = McpManager.getOrCreate(process.cwd());
	manager.authProviderFactory = createAuthProviderFactory();

	const registeredToolNames = new Set<string>();

	const registerDirectTools = (notify?: (message: string, type: "info" | "warning") => void): void => {
		const perServer = new Map<string, number>();
		for (const entry of selectDirectTools(manager)) {
			if (registeredToolNames.has(entry.exposedName)) continue;
			registeredToolNames.add(entry.exposedName);
			pi.registerTool(buildDirectToolDefinition(manager, entry));
			perServer.set(entry.server, (perServer.get(entry.server) ?? 0) + 1);
		}
		if (notify) {
			for (const [server, count] of perServer) {
				notify(`MCP: registered ${count} tool${count === 1 ? "" : "s"} from ${server}`, "info");
			}
		}
	};

	if (!isSubagentChild) {
		registerMcpSlashCommand(pi, manager, {
			syncDirectTools: (ctx: ExtensionCommandContext) => {
				registerDirectTools((message, type) => ctx.ui.notify(message, type));
			},
		});
	}

	if (!manager.hasServers()) return;

	pi.registerTool(createMcpProxyTool(manager));
	registerDirectTools();

	if (isSubagentChild) {
		// Children resolve tools from the shared cache only; eager refreshing here
		// would spawn one server process per parallel child.
		return;
	}

	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "startup" && event.reason !== "reload") return;
		manager.reloadConfig(ctx.cwd);
		if (!manager.hasServers()) return;
		registerDirectTools();
		// Skip eager connects under vitest: the suite instantiates many sessions
		// and would otherwise spawn the developer's real MCP servers.
		if (process.env.VITEST) return;
		void refreshStaleDirectToolServers(manager, ctx, registerDirectTools);
	});

	pi.on("session_shutdown", async (event) => {
		if (event.reason === "quit") {
			await manager.disposeAll();
		}
	});
}

/**
 * Servers with directTools enabled need fresh metadata so their tools can be
 * registered; connect to the stale ones in the background and register any
 * tools that appear.
 */
async function refreshStaleDirectToolServers(
	manager: McpManager,
	ctx: ExtensionContext,
	registerDirectTools: (notify?: (message: string, type: "info" | "warning") => void) => void,
): Promise<void> {
	const filter = buildDirectToolsFilter(manager.config);
	const cache = manager.getCache();
	const staleServers = manager.getServerNames().filter((name) => {
		if (!filter(name)) return false;
		const connection = manager.getConnection(name);
		if (connection?.isConnected()) return false;
		return !isServerCacheValid(cache.servers[name], manager.getServerEntry(name)!);
	});

	if (staleServers.length === 0) return;

	const results = await Promise.allSettled(
		staleServers.map(async (name) => {
			ctx.ui.setStatus("mcp", `connecting ${name}...`);
			await manager.refreshServer(name);
		}),
	);
	ctx.ui.setStatus("mcp", undefined);

	registerDirectTools((message, type) => ctx.ui.notify(message, type));

	results.forEach((result, index) => {
		if (result.status === "rejected") {
			ctx.ui.notify(`MCP: failed to connect to ${staleServers[index]}: ${errorMessage(result.reason)}`, "warning");
		}
	});
}
