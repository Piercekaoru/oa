/**
 * /view-agent command - open conversation viewer for a running subagent
 */

import type { ExtensionContext } from "../compat/coding-agent.ts";
import type { AsyncJobState, SubagentState } from "../shared/types.ts";
import { ConversationViewer } from "../tui/conversation-viewer.ts";

export function registerViewAgentCommand(
	registerCommand: (
		name: string,
		options: {
			description: string;
			handler: (args: string, ctx: ExtensionContext) => Promise<void>;
			getArgumentCompletions?: (prefix: string) => { value: string; label: string }[] | null;
		},
	) => void,
	getState: () => SubagentState,
): void {
	registerCommand("view-agent", {
		description: "View live conversation for a running subagent: /view-agent [runId]",
		getArgumentCompletions: (prefix: string) => {
			const state = getState();
			const jobs = Array.from(state.asyncJobs.values());
			const runningJobs = jobs.filter((j) => j.status === "running" && j.sessionFile);

			return runningJobs
				.filter((j) => j.asyncId.startsWith(prefix))
				.map((j) => ({
					value: j.asyncId,
					label: `${j.asyncId} (${j.agents?.[0] || "unknown"})`,
				}));
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Conversation viewer requires an interactive session", "error");
				return;
			}

			const state = getState();
			const jobs = Array.from(state.asyncJobs.values());

			// If no args, show list of running agents
			if (!args.trim()) {
				const runningJobs = jobs.filter((j) => j.status === "running" && j.sessionFile);
				if (runningJobs.length === 0) {
					ctx.ui.notify("No running subagents found. Use /view-agent <asyncId> to view a specific agent.", "warning");
					return;
				}

				const list = runningJobs
					.map((j, i) => {
						const agent = j.agents?.[0] || "unknown";
						const asyncId = j.asyncId;
						return `${i + 1}. ${agent} (${asyncId})`;
					})
					.join("\n");

				ctx.ui.notify(`Running subagents:\n\n${list}\n\nUse /view-agent <asyncId> to view conversation`, "info");
				return;
			}

			// Find job by asyncId (or prefix)
			const targetId = args.trim();
			const job = jobs.find((j) => j.asyncId === targetId || j.asyncId.startsWith(targetId));

			if (!job) {
				ctx.ui.notify(`Subagent not found: ${targetId}. Use /view-agent to list running agents.`, "error");
				return;
			}

			// Find session file
			if (!job.sessionFile) {
				ctx.ui.notify(`No session file found for ${job.asyncId}`, "error");
				return;
			}

			// Open conversation viewer overlay
			const termWidth = process.stdout.columns || 120;
			const termHeight = process.stdout.rows || 40;
			const viewerWidth = Math.min(Math.floor(termWidth * 0.9), 120);
			const viewerHeight = Math.min(termHeight - 4, 40);

			const viewer = new ConversationViewer({
				sessionFile: job.sessionFile,
				agentName: job.agents?.[0] || "subagent",
				width: viewerWidth,
				height: viewerHeight,
				theme: ctx.ui.theme as any, // Theme type compatibility
				onClose: () => {
					// Handled by ctx.ui.custom done() callback
				},
			});

			// Use ctx.ui.custom for overlay support
			const overlayPromise = ctx.ui.custom(
				(tui, theme, keybindings, done) => {
					// Set up keyboard handler for viewer
					const container = viewer as any;
					const originalHandleKey = container.handleKey?.bind(container);
					if (originalHandleKey) {
						// Intercept Escape to close
						const wrappedHandleKey = (key: string) => {
							if (key === "\x1b") {
								// Escape
								done(undefined);
								return true;
							}
							return originalHandleKey(key);
						};
						(container as any).handleKey = wrappedHandleKey;
					}
					return viewer;
				},
				{ overlay: true },
			);

			await overlayPromise;
		},
	});
}
