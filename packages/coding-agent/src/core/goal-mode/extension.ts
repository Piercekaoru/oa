/**
 * Built-in Goal Mode extension.
 *
 * Pursue a goal autonomously until it is verifiably done. After the user
 * approves a contract (outcome, done-criteria, verifyCommand, budget, judge),
 * the agent auto-continues turn-by-turn (a "Ralph loop"): it works, self-reports
 * progress, and on goal_complete an independent judge must approve before the
 * goal transitions to done.
 *
 * Safeguards: a turn budget, a spin-guard (a turn with no tool actions blocks),
 * an ask-before policy gate on bash, and user input always preempts the loop.
 *
 * Features:
 * - `/goal <intent>` to start; subcommands status/pause/resume/cancel/budget/judge/autopilot/ask/help
 * - `--goal "<intent>"` flag and Ctrl+Alt+G to show status
 * - State is persisted with the session and restored on resume
 */

import { type AutocompleteItem, Key } from "@openachieve/tui";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../extensions/types.ts";
import { isToolCallEventType } from "../extensions/types.ts";
import { CONTINUE_NUDGE, goalReminder, helpText, setupInstructions } from "./strings.ts";
import { type GoalToolDeps, registerGoalTools } from "./tools.ts";
import {
	BUDGET_CONFIRM_THRESHOLD,
	clampBudget,
	createInitialGoalState,
	formatJudge,
	type GoalState,
	matchesAskBefore,
	parseJudgeSpec,
	statusSummary,
} from "./utils.ts";

const SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "status", label: "status", description: "One-line current state" },
	{ value: "pause", label: "pause", description: "Halt the auto-continue loop" },
	{ value: "resume", label: "resume", description: "Resume and reset the budget" },
	{ value: "cancel", label: "cancel", description: "Clear the current goal" },
	{ value: "budget", label: "budget <n>", description: "Change the turn budget" },
	{ value: "judge", label: "judge <p>/<m>|same|clear", description: "Configure the judge default" },
	{ value: "autopilot", label: "autopilot", description: "Toggle skipping the contract dialog" },
	{ value: "ask", label: "ask <question>", description: "Side question without preempting" },
	{ value: "help", label: "help", description: "Show goal-mode help" },
];

export default function registerGoalModeExtension(api: ExtensionAPI): void {
	let state: GoalState = createInitialGoalState();
	// Transient per-loop counters (not persisted).
	let progressSignalsThisTurn = 0;
	let flagHandled = false;

	function persist(): void {
		api.appendEntry("goal-mode", { ...state });
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!state.contract || state.status === "idle") {
			ctx.ui.setStatus("goal-mode", undefined);
			return;
		}
		const c = state.contract;
		let label: string;
		if (state.status === "done") label = ctx.ui.theme.fg("success", "✓ goal done");
		else if (state.status === "blocked") label = ctx.ui.theme.fg("warning", "⚠ goal blocked");
		else if (state.paused) label = ctx.ui.theme.fg("warning", "⏸ goal paused");
		else label = ctx.ui.theme.fg("accent", `◎ goal ${state.turnsUsed}/${c.budget}`);
		ctx.ui.setStatus("goal-mode", label);
	}

	const deps: GoalToolDeps = {
		getState: () => state,
		persist,
		updateStatus,
		exec: (command, args, options) => api.exec(command, args, options),
	};
	registerGoalTools(api, deps);

	function startSetup(intent: string, ctx: ExtensionContext): void {
		if (!ctx.model) {
			ctx.ui.notify("No model selected; cannot start goal mode.", "error");
			return;
		}
		ctx.ui.notify(`Drafting a goal contract for: ${intent}`, "info");
		api.sendMessage(
			{
				customType: "goal-setup",
				content: setupInstructions(intent, formatJudge(state.judgeDefault)),
				display: false,
			},
			{ triggerTurn: true },
		);
	}

	api.registerFlag("goal", {
		description: "Start pursuing a goal autonomously until verifiably done",
		type: "string",
	});

	api.registerShortcut(Key.ctrlAlt("g"), {
		description: "Show goal status",
		handler: (ctx) => ctx.ui.notify(statusSummary(state), "info"),
	});

	api.registerCommand("goal", {
		description: "Pursue a goal autonomously until done (judged)",
		getArgumentCompletions: (prefix) => {
			const p = prefix.trim().toLowerCase();
			if (p.includes(" ")) return null;
			return SUBCOMMANDS.filter((s) => s.value.startsWith(p));
		},
		handler: async (args, ctx) => handleCommand(args, ctx),
	});

	async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const trimmed = args.trim();
		if (!trimmed) {
			ctx.ui.notify(statusSummary(state), "info");
			return;
		}
		const sp = trimmed.indexOf(" ");
		const first = (sp === -1 ? trimmed : trimmed.slice(0, sp)).toLowerCase();
		const rest = sp === -1 ? "" : trimmed.slice(sp + 1).trim();

		switch (first) {
			case "status":
				ctx.ui.notify(statusSummary(state), "info");
				return;
			case "help":
				ctx.ui.notify(helpText(), "info");
				return;
			case "pause":
				if (state.status !== "active") {
					ctx.ui.notify("No active goal to pause.", "info");
					return;
				}
				state.paused = true;
				persist();
				updateStatus(ctx);
				ctx.ui.notify("Goal paused. /goal resume to continue.", "info");
				return;
			case "resume": {
				if (!state.contract) {
					ctx.ui.notify("No goal to resume.", "info");
					return;
				}
				if (state.status === "done") {
					ctx.ui.notify("Goal already done.", "info");
					return;
				}
				state.paused = false;
				state.status = "active";
				state.turnsUsed = 0;
				persist();
				updateStatus(ctx);
				ctx.ui.notify("Goal resumed (budget reset).", "info");
				api.sendMessage(
					{ customType: "goal-continue", content: CONTINUE_NUDGE, display: false },
					{ triggerTurn: true },
				);
				return;
			}
			case "cancel":
				if (!state.contract) {
					ctx.ui.notify("No goal to cancel.", "info");
					return;
				}
				state.status = "idle";
				state.paused = false;
				state.contract = undefined;
				state.turnsUsed = 0;
				state.evidence = [];
				state.lastNote = undefined;
				state.lastBlockReason = undefined;
				persist();
				updateStatus(ctx);
				ctx.ui.notify("Goal cleared.", "info");
				return;
			case "budget": {
				if (!state.contract) {
					ctx.ui.notify("No active goal; set a goal first.", "info");
					return;
				}
				const n = Number.parseInt(rest, 10);
				if (!Number.isFinite(n) || n < 1) {
					ctx.ui.notify("Usage: /goal budget <n>", "error");
					return;
				}
				const clamped = clampBudget(n);
				if (clamped > BUDGET_CONFIRM_THRESHOLD && ctx.hasUI) {
					const ok = await ctx.ui.confirm("Large budget", `Set the auto-continue budget to ${clamped} turns?`);
					if (!ok) return;
				}
				state.contract.budget = clamped;
				persist();
				updateStatus(ctx);
				ctx.ui.notify(`Budget set to ${clamped}.`, "info");
				return;
			}
			case "judge": {
				if (!rest) {
					ctx.ui.notify(`Judge default: ${formatJudge(state.judgeDefault)}`, "info");
					return;
				}
				const spec = parseJudgeSpec(rest);
				if (spec === null) {
					ctx.ui.notify("Usage: /goal judge <provider>/<modelId> | same | clear", "error");
					return;
				}
				if (spec === "clear") {
					state.judgeDefault = undefined;
					persist();
					ctx.ui.notify("Judge default cleared.", "info");
					return;
				}
				if ("provider" in spec && !ctx.modelRegistry.find(spec.provider, spec.modelId)) {
					ctx.ui.notify(
						`Note: ${spec.provider}/${spec.modelId} is not currently available; it will be used once configured.`,
						"warning",
					);
				}
				state.judgeDefault = spec;
				persist();
				ctx.ui.notify(`Judge default: ${formatJudge(spec)}`, "info");
				return;
			}
			case "autopilot":
				state.autopilot = !state.autopilot;
				persist();
				ctx.ui.notify(`Autopilot ${state.autopilot ? "on (contract dialog skipped)" : "off"}.`, "info");
				return;
			case "ask":
				if (!rest) {
					ctx.ui.notify("Usage: /goal ask <question>", "error");
					return;
				}
				api.sendUserMessage(rest, { deliverAs: "followUp" });
				return;
			default:
				startSetup(trimmed, ctx);
				return;
		}
	}

	// Reset per-loop progress tracking.
	api.on("agent_start", async () => {
		progressSignalsThisTurn = 0;
	});

	// Count tool actions (for spin-guard) and enforce the ask-before policy.
	api.on("tool_call", async (event, ctx) => {
		progressSignalsThisTurn += 1;
		if (state.status !== "active" || state.paused || !state.contract) return;
		if (isToolCallEventType("bash", event) && matchesAskBefore(event.input.command, state.contract.askBefore)) {
			if (ctx.hasUI) {
				const ok = await ctx.ui.confirm(
					"Goal: confirm command",
					`The goal contract asks to confirm before running:\n${event.input.command}\n\nAllow it?`,
				);
				if (!ok) {
					return {
						block: true,
						reason: "Blocked by goal ask-before policy (user declined). Adjust your approach or ask the user.",
					};
				}
			}
		}
	});

	// Inject the per-turn goal reminder (append, never replace).
	api.on("before_agent_start", async () => {
		if (state.status === "active" && !state.paused && state.contract) {
			return { message: { customType: "goal-reminder", content: goalReminder(state), display: false } };
		}
	});

	// The Ralph loop: auto-continue after each turn until done/blocked/budget.
	api.on("agent_end", async (_event, ctx) => {
		if (state.status !== "active" || state.paused || !state.contract) return;

		if (progressSignalsThisTurn === 0) {
			state.status = "blocked";
			state.lastBlockReason = "spin guard: the last turn produced no tool actions.";
			persist();
			updateStatus(ctx);
			ctx.ui.notify("Goal paused (spin guard): no progress last turn. /goal resume after addressing it.", "warning");
			return;
		}

		if (state.turnsUsed >= state.contract.budget) {
			state.paused = true;
			persist();
			updateStatus(ctx);
			ctx.ui.notify(
				`Goal budget reached (${state.contract.budget} turns). /goal resume to continue (resets budget).`,
				"warning",
			);
			return;
		}

		// User (or other extension) input takes priority over auto-continuation.
		if (ctx.hasPendingMessages()) return;

		state.turnsUsed += 1;
		persist();
		updateStatus(ctx);
		api.sendMessage({ customType: "goal-continue", content: CONTINUE_NUDGE, display: false }, { triggerTurn: true });
	});

	// Restore persisted state and honor the --goal flag on a fresh session.
	api.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as { type: string; customType?: string; data?: Partial<GoalState> };
			if (entry.type === "custom" && entry.customType === "goal-mode" && entry.data) {
				state = { ...createInitialGoalState(), ...entry.data };
				break;
			}
		}
		progressSignalsThisTurn = 0;
		updateStatus(ctx);

		const flag = api.getFlag("goal");
		if (!flagHandled && typeof flag === "string" && flag.trim() && state.status === "idle") {
			flagHandled = true;
			startSetup(flag.trim(), ctx);
		}
	});
}
