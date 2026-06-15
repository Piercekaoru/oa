/**
 * Prompt text and user-facing copy for goal mode.
 * Kept separate from logic so the wording is easy to audit and tune.
 */

import type { ExecResult } from "../exec.ts";
import { formatJudge, type GoalContract, type GoalState } from "./utils.ts";

/** Sent when the user starts a goal, instructing the model to draft a contract. */
export function setupInstructions(intent: string, judgeDefault: string): string {
	return `[GOAL MODE — SETUP]
The user wants to pursue this goal autonomously until it is verifiably done:

"${intent}"

Before locking anything in:
1. If the goal is vague or you are missing context, ask concise clarifying questions in your reply and stop — do NOT call goal_set yet.
2. Otherwise, propose a contract and call \`goal_set\` exactly once with:
   - goal: a sharp one-line outcome.
   - doneCriteria: concrete, checkable bullet points.
   - verifyCommand: a single shell command (run via bash) whose success proves the goal is done — e.g. the test/lint/build command. Prefer commands that exit non-zero on failure.
   - askBefore (optional): substrings of bash commands that should require user confirmation (e.g. "git push", "rm ").
   - budget (optional): max auto-continue turns (default 20).
   - judge: the completion judge. Session default is: ${judgeDefault}. ${
		judgeDefault === "none"
			? "No default is set, so you MUST provide one: either judge:{provider,modelId} for a model different from yourself (recommended), or judge:{sameModel:true} only if no second model is available."
			: "You may omit judge to use the session default, or override it."
	}

After goal_set, work toward the goal. The harness will automatically continue your turns until the goal is done, blocked, or the budget is exhausted.`;
}

/** Hidden nudge that drives the next auto-continue turn. */
export const CONTINUE_NUDGE = `[GOAL MODE] Continue working toward the goal. Take the next concrete action now. When the done-criteria are met, run the verifyCommand and call goal_complete with its output as evidence. If you are blocked on a decision only the user can make, call goal_block.`;

/** Per-turn reminder appended (never replacing) to the system prompt while a goal is active. */
export function goalReminder(state: GoalState): string {
	const c = state.contract;
	if (!c) return "";
	const remaining = Math.max(0, c.budget - state.turnsUsed);
	const criteria = c.doneCriteria.map((x) => `  - ${x}`).join("\n");
	const askBefore =
		c.askBefore.length > 0
			? `\nAsk the user before running bash commands containing: ${c.askBefore.join(", ")}.`
			: "";
	const lastNote = state.lastNote ? `\nLast progress note: ${state.lastNote}` : "";
	return `[GOAL MODE ACTIVE]
You are autonomously pursuing a locked goal. Stay focused on it; do not drift.

Goal: ${c.goal}
Done when:
${criteria}
Verify with: ${c.verifyCommand}
Auto-continue budget: ${remaining} turn(s) remaining.${askBefore}${lastNote}

Each turn, make real progress (edit/write/run), not just commentary. Use goal_progress to record a one-line status. When the done-criteria hold, run the verifyCommand and call goal_complete with the quoted output as evidence — completion is verified by an independent judge (${formatJudge(
		c.judge,
	)}), so cite concrete evidence. If you need a human decision, call goal_block.`;
}

/** System prompt for the completion judge. It sees no executor history. */
export const JUDGE_SYSTEM_PROMPT = `You are an impartial completion judge for an autonomous coding agent. You are deliberately given NO access to the executor's reasoning or history — only the goal, the done-criteria, the verify command, its actual output, and the evidence the executor cited.

Decide whether the goal is genuinely complete. Be strict: a single model evaluating its own work tends to declare success prematurely. Approve only when the verify command actually succeeded AND the cited evidence demonstrates every done-criterion is met. If the verify command failed, output is missing, or evidence is hand-wavy, do not approve.

Respond with STRICT JSON and nothing else, in exactly this shape:
{"verdict":"done","reason":"<one or two sentences>"}
or
{"verdict":"continue","reason":"<what is still missing>"}`;

/** User content for the judge call: goal facts + actual verify result + cited evidence. */
export function buildJudgeUserContent(contract: GoalContract, evidence: string, verify: ExecResult): string {
	const criteria = contract.doneCriteria.map((x) => `- ${x}`).join("\n");
	const out = truncate(verify.stdout, 4000);
	const err = truncate(verify.stderr, 2000);
	return `GOAL: ${contract.goal}

DONE-CRITERIA:
${criteria}

VERIFY COMMAND: ${contract.verifyCommand}
VERIFY EXIT CODE: ${verify.code}${verify.killed ? " (killed/timeout)" : ""}
VERIFY STDOUT:
${out || "(empty)"}
VERIFY STDERR:
${err || "(empty)"}

EXECUTOR'S CITED EVIDENCE:
${evidence.trim() || "(none provided)"}

Is the goal complete? Respond with strict JSON only.`;
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

export const JUDGE_UNSPECIFIED_MESSAGE = `judge_unspecified: a completion judge is required. Provide judge:{provider,modelId} for a model different from the executor (recommended), or judge:{sameModel:true} to self-judge with the active model. The user can also set a session default with "/goal judge <provider>/<modelId>".`;

export function helpText(): string {
	return `Goal mode — pursue a goal autonomously until verifiably done (judged).

/goal <intent>            Start setup for a new goal
/goal status              One-line current state
/goal pause               Halt the auto-continue loop, keep state
/goal resume              Resume and reset the turn budget
/goal cancel              Clear the current goal
/goal budget <n>          Change the turn budget (1..${"20000"})
/goal judge <p>/<m>       Set a cross-model judge default (recommended)
/goal judge same          Use same-model self-judge by default
/goal judge clear         Unset the judge default
/goal autopilot           Toggle skipping the contract confirmation
/goal ask <question>      Ask a side question without preempting the loop
/goal help                Show this list

Also: --goal "<intent>" CLI flag, and Ctrl+Alt+G to show status.`;
}
