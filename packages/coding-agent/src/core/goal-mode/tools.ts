/**
 * Built-in goal-mode tools the LLM calls to drive the loop:
 * goal_set, goal_progress, goal_complete (judge-gated), goal_block.
 */

import { Type } from "typebox";
import type { ExecOptions, ExecResult } from "../exec.ts";
import type { ExtensionAPI, ExtensionContext } from "../extensions/types.ts";
import { runJudge } from "./judge.ts";
import { JUDGE_UNSPECIFIED_MESSAGE } from "./strings.ts";
import {
	clampBudget,
	DEFAULT_BUDGET,
	formatJudge,
	type GoalState,
	normalizeJudgeParam,
	resolveJudgeForSet,
	VERIFY_TIMEOUT_MS,
} from "./utils.ts";

/** Hooks the tools use to read/mutate shared goal state and run the verify command. */
export interface GoalToolDeps {
	getState(): GoalState;
	persist(): void;
	updateStatus(ctx: ExtensionContext): void;
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
}

function text(content: string) {
	return { content: [{ type: "text" as const, text: content }], details: {} };
}

export function registerGoalTools(api: ExtensionAPI, deps: GoalToolDeps): void {
	api.registerTool({
		name: "goal_set",
		label: "Goal: set",
		description:
			"Lock the goal contract after the user approves. Call once at the start of goal mode. Completion is gated by an independent judge, so a judge must be specified (cross-model recommended) unless a session default exists.",
		parameters: Type.Object({
			goal: Type.String({ description: "Sharp one-line outcome." }),
			doneCriteria: Type.Array(Type.String(), { description: "Concrete, checkable done-criteria." }),
			verifyCommand: Type.String({
				description: "A single shell command (run via bash) whose success proves the goal is done.",
			}),
			askBefore: Type.Optional(
				Type.Array(Type.String(), {
					description: 'Substrings of bash commands that require user confirmation (e.g. "git push").',
				}),
			),
			budget: Type.Optional(Type.Number({ description: "Max auto-continue turns (default 20)." })),
			judge: Type.Optional(
				Type.Object(
					{
						provider: Type.Optional(Type.String()),
						modelId: Type.Optional(Type.String()),
						sameModel: Type.Optional(Type.Boolean()),
					},
					{ description: "Completion judge: {provider,modelId} for cross-model, or {sameModel:true}." },
				),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const state = deps.getState();
			const judge = resolveJudgeForSet(normalizeJudgeParam(params.judge), state.judgeDefault);
			if (!judge) throw new Error(JUDGE_UNSPECIFIED_MESSAGE);
			if (!params.goal.trim()) throw new Error("goal must not be empty.");
			if (!params.verifyCommand.trim()) throw new Error("verifyCommand must not be empty.");
			const doneCriteria = params.doneCriteria.map((s) => s.trim()).filter(Boolean);
			if (doneCriteria.length === 0) throw new Error("doneCriteria must have at least one item.");

			const contract = {
				goal: params.goal.trim(),
				doneCriteria,
				verifyCommand: params.verifyCommand.trim(),
				askBefore: (params.askBefore ?? []).map((s) => s.trim()).filter(Boolean),
				budget: clampBudget(params.budget ?? DEFAULT_BUDGET),
				judge,
			};

			if (ctx.hasUI && !state.autopilot) {
				const summary = `Goal: ${contract.goal}\nDone when:\n${contract.doneCriteria
					.map((x) => `  - ${x}`)
					.join("\n")}\nVerify: ${contract.verifyCommand}\nJudge: ${formatJudge(contract.judge)} · Budget: ${
					contract.budget
				}`;
				const ok = await ctx.ui.confirm("Lock this goal contract?", summary);
				if (!ok) throw new Error("Goal setup cancelled by the user.");
			}

			state.status = "active";
			state.paused = false;
			state.contract = contract;
			state.turnsUsed = 0;
			state.evidence = [];
			state.lastNote = undefined;
			state.lastBlockReason = undefined;
			deps.persist();
			deps.updateStatus(ctx);

			return text(
				`Goal locked. Pursuing: "${contract.goal}". I'll continue automatically until the verifyCommand passes and the judge (${formatJudge(
					contract.judge,
				)}) approves, or the budget (${contract.budget} turns) is reached.`,
			);
		},
	});

	api.registerTool({
		name: "goal_progress",
		label: "Goal: progress",
		description: "Record a one-line progress note while pursuing the goal. Optionally tag a short phase label.",
		parameters: Type.Object({
			note: Type.String({ description: "One-line progress note." }),
			phase: Type.Optional(Type.String({ description: "Short phase label shown in the status line." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const state = deps.getState();
			state.lastNote = params.note.trim();
			if (params.phase) state.lastPhase = params.phase.trim();
			deps.persist();
			deps.updateStatus(ctx);
			return text(`Progress noted: ${state.lastNote}`);
		},
	});

	api.registerTool({
		name: "goal_complete",
		label: "Goal: complete",
		description:
			"Declare the goal done. Runs the contract's verifyCommand and submits your cited evidence to an independent judge. The goal only transitions to done if the judge approves.",
		parameters: Type.Object({
			evidence: Type.String({
				description: "Concrete evidence the done-criteria are met (e.g. quoted verifyCommand output).",
			}),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const state = deps.getState();
			if (!state.contract) throw new Error("No active goal to complete.");
			const verify = await deps.exec("bash", ["-lc", state.contract.verifyCommand], {
				cwd: ctx.cwd,
				timeout: VERIFY_TIMEOUT_MS,
				signal,
			});
			const judge = await runJudge(ctx, state.contract, params.evidence, verify);
			const verifyLine = `verify exit ${verify.code}${verify.killed ? " (timeout)" : ""}`;

			if (judge.verdict === "done") {
				state.status = "done";
				state.paused = false;
				state.evidence.push(
					`COMPLETE: ${verifyLine}. judge(${judge.judged ? "real" : "fail-open"}): ${judge.reason}`,
				);
				deps.persist();
				deps.updateStatus(ctx);
				ctx.ui.notify("Goal complete — judge approved.", "info");
				return text(`Goal complete — judge approved (${verifyLine}). ${judge.reason}`);
			}

			state.evidence.push(`COMPLETE-REJECTED: ${verifyLine}. judge: ${judge.reason}`);
			deps.persist();
			deps.updateStatus(ctx);
			return text(
				`Completion refused by the judge. ${judge.reason}\n(${verifyLine}). Address the gap with stronger evidence, then call goal_complete again.`,
			);
		},
	});

	api.registerTool({
		name: "goal_block",
		label: "Goal: block",
		description: "Pause the goal because you need a decision only the user can make. Provide the question.",
		parameters: Type.Object({
			question: Type.String({ description: "The decision or input you need from the user." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const state = deps.getState();
			state.status = "blocked";
			state.paused = false;
			state.lastBlockReason = params.question.trim();
			deps.persist();
			deps.updateStatus(ctx);
			ctx.ui.notify("Goal blocked — needs your input. Use /goal resume after answering.", "warning");
			return text(`Goal blocked: ${state.lastBlockReason}\nThe user can answer and run /goal resume to continue.`);
		},
	});
}
