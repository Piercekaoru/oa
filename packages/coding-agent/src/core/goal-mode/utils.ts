/**
 * Pure utility functions and types for goal mode.
 * Extracted for testability (no I/O, no extension API access).
 */

/** How completion is judged. Cross-model is the default; same-model is an explicit opt-in. */
export type JudgeSpec = { provider: string; modelId: string } | { sameModel: true };

/** The locked "North Star" contract for an active goal. */
export interface GoalContract {
	/** Outcome the agent is pursuing. */
	goal: string;
	/** Concrete, checkable done-criteria. */
	doneCriteria: string[];
	/** Shell command whose success proves the goal is done. */
	verifyCommand: string;
	/** Substrings; a bash command containing any of these requires user confirmation. */
	askBefore: string[];
	/** Max auto-continue turns before the loop pauses. */
	budget: number;
	/** Judge configuration gating completion. */
	judge: JudgeSpec;
}

export type GoalStatus = "idle" | "active" | "blocked" | "done";

/** Persisted goal-mode state (stored as a session custom entry). */
export interface GoalState {
	status: GoalStatus;
	/** When true the auto-continue loop is halted but contract is kept. */
	paused: boolean;
	contract?: GoalContract;
	/** Auto-continue turns spent so far against the current budget. */
	turnsUsed: number;
	/** Accumulated proof and judge reasoning. */
	evidence: string[];
	lastNote?: string;
	lastPhase?: string;
	lastBlockReason?: string;
	/** Session-level judge default applied when a goal_set omits its own. */
	judgeDefault?: JudgeSpec;
	/** When true, skip the contract confirmation dialog at setup. */
	autopilot: boolean;
}

export const DEFAULT_BUDGET = 20;
export const MAX_BUDGET = 20000;
/** Budgets above this prompt for confirmation (guards runaway loops). */
export const BUDGET_CONFIRM_THRESHOLD = 500;
/** Default timeout for the verifyCommand run, in milliseconds. */
export const VERIFY_TIMEOUT_MS = 120000;

export function createInitialGoalState(): GoalState {
	return { status: "idle", paused: false, turnsUsed: 0, evidence: [], autopilot: false };
}

/** Clamp an arbitrary number to a valid integer budget in [1, MAX_BUDGET]. */
export function clampBudget(n: number): number {
	if (!Number.isFinite(n)) return DEFAULT_BUDGET;
	return Math.min(MAX_BUDGET, Math.max(1, Math.floor(n)));
}

/**
 * Parse a `/goal judge <arg>` argument.
 * - "same" -> same-model self-judge
 * - "clear" -> unset session default
 * - "provider/modelId" -> cross-model judge
 * - anything else -> null (invalid)
 */
export function parseJudgeSpec(arg: string): JudgeSpec | "clear" | null {
	const trimmed = arg.trim();
	if (trimmed === "") return null;
	if (trimmed === "same") return { sameModel: true };
	if (trimmed === "clear") return "clear";
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return null;
	const provider = trimmed.slice(0, slash).trim();
	const modelId = trimmed.slice(slash + 1).trim();
	if (!provider || !modelId) return null;
	return { provider, modelId };
}

/** Normalize a loose judge object from tool arguments into a JudgeSpec, or null if absent/invalid. */
export function normalizeJudgeParam(
	judge: { provider?: string; modelId?: string; sameModel?: boolean } | undefined,
): JudgeSpec | null {
	if (!judge) return null;
	if (judge.sameModel === true) return { sameModel: true };
	if (judge.provider && judge.modelId) return { provider: judge.provider, modelId: judge.modelId };
	return null;
}

/**
 * Resolve the judge for a goal_set call: per-goal argument wins over the session default.
 * Returns null when neither is available (caller should refuse with judge_unspecified).
 */
export function resolveJudgeForSet(
	paramJudge: JudgeSpec | null,
	sessionDefault: JudgeSpec | undefined,
): JudgeSpec | null {
	return paramJudge ?? sessionDefault ?? null;
}

export function formatJudge(spec: JudgeSpec | undefined): string {
	if (!spec) return "none";
	if ("sameModel" in spec) return "same-model";
	return `${spec.provider}/${spec.modelId}`;
}

/** True if a bash command contains any ask-before substring (case-insensitive). */
export function matchesAskBefore(command: string, patterns: string[]): boolean {
	if (!patterns || patterns.length === 0) return false;
	const haystack = command.toLowerCase();
	return patterns.some((p) => {
		const needle = p.trim().toLowerCase();
		return needle.length > 0 && haystack.includes(needle);
	});
}

export interface JudgeVerdict {
	verdict: "done" | "continue";
	reason: string;
}

/**
 * Extract a strict-JSON verdict from a judge model response.
 * Tolerates surrounding prose by scanning for the first balanced-looking object.
 * Returns null on any failure so callers can fail open.
 */
export function parseJudgeVerdict(text: string): JudgeVerdict | null {
	if (!text) return null;
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const obj = parsed as Record<string, unknown>;
	const verdict = obj.verdict;
	if (verdict !== "done" && verdict !== "continue") return null;
	const reason = typeof obj.reason === "string" ? obj.reason : "";
	return { verdict, reason };
}

/** One-line human summary of the current goal state for status output. */
export function statusSummary(state: GoalState): string {
	if (!state.contract || state.status === "idle") return "No active goal.";
	const c = state.contract;
	switch (state.status) {
		case "active":
			return state.paused
				? `Goal paused — "${c.goal}" (${state.turnsUsed}/${c.budget} turns). /goal resume to continue.`
				: `Goal active — "${c.goal}" (${state.turnsUsed}/${c.budget} turns, judge ${formatJudge(c.judge)}).`;
		case "blocked":
			return `Goal blocked — ${state.lastBlockReason ?? "needs input"}. /goal resume after addressing it.`;
		case "done":
			return `Goal done — "${c.goal}".`;
		default:
			return "No active goal.";
	}
}
