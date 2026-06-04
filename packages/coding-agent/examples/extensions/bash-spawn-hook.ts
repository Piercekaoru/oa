/**
 * Bash Spawn Hook Example
 *
 * Adjusts command, cwd, and env before execution.
 *
 * Usage:
 *   oa -e ./bash-spawn-hook.ts
 */

import type { ExtensionAPI } from "@openachieve/agent";
import { createBashTool } from "@openachieve/agent";

export default function (api: ExtensionAPI) {
	const cwd = process.cwd();

	const bashTool = createBashTool(cwd, {
		spawnHook: ({ command, cwd, env }) => ({
			command: `source ~/.profile\n${command}`,
			cwd,
			env: { ...env, OPENACHIEVE_SPAWN_HOOK: "1" },
		}),
	});

	api.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, _ctx) => {
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});
}
