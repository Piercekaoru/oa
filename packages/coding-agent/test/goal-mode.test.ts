import { describe, expect, it } from "vitest";
import {
	clampBudget,
	createInitialGoalState,
	DEFAULT_BUDGET,
	formatJudge,
	type GoalState,
	MAX_BUDGET,
	matchesAskBefore,
	normalizeJudgeParam,
	parseJudgeSpec,
	parseJudgeVerdict,
	resolveJudgeForSet,
	statusSummary,
} from "../src/core/goal-mode/utils.ts";

describe("parseJudgeSpec", () => {
	it("parses provider/modelId into a cross-model spec", () => {
		expect(parseJudgeSpec("anthropic/claude-opus-4-7")).toEqual({
			provider: "anthropic",
			modelId: "claude-opus-4-7",
		});
	});

	it("trims surrounding whitespace", () => {
		expect(parseJudgeSpec("  openai/gpt-5  ")).toEqual({ provider: "openai", modelId: "gpt-5" });
	});

	it("recognizes same and clear", () => {
		expect(parseJudgeSpec("same")).toEqual({ sameModel: true });
		expect(parseJudgeSpec("clear")).toBe("clear");
	});

	it("rejects malformed input", () => {
		expect(parseJudgeSpec("")).toBeNull();
		expect(parseJudgeSpec("anthropic")).toBeNull();
		expect(parseJudgeSpec("/claude")).toBeNull();
		expect(parseJudgeSpec("anthropic/")).toBeNull();
	});
});

describe("normalizeJudgeParam", () => {
	it("returns sameModel when flagged", () => {
		expect(normalizeJudgeParam({ sameModel: true })).toEqual({ sameModel: true });
	});

	it("returns cross-model when both fields present", () => {
		expect(normalizeJudgeParam({ provider: "openai", modelId: "gpt-5" })).toEqual({
			provider: "openai",
			modelId: "gpt-5",
		});
	});

	it("returns null for absent or partial input", () => {
		expect(normalizeJudgeParam(undefined)).toBeNull();
		expect(normalizeJudgeParam({ provider: "openai" })).toBeNull();
		expect(normalizeJudgeParam({})).toBeNull();
	});
});

describe("resolveJudgeForSet", () => {
	it("prefers the per-goal argument over the session default", () => {
		expect(resolveJudgeForSet({ sameModel: true }, { provider: "a", modelId: "b" })).toEqual({ sameModel: true });
	});

	it("falls back to the session default", () => {
		expect(resolveJudgeForSet(null, { provider: "a", modelId: "b" })).toEqual({ provider: "a", modelId: "b" });
	});

	it("returns null when neither is available (judge_unspecified)", () => {
		expect(resolveJudgeForSet(null, undefined)).toBeNull();
	});
});

describe("formatJudge", () => {
	it("formats each variant", () => {
		expect(formatJudge(undefined)).toBe("none");
		expect(formatJudge({ sameModel: true })).toBe("same-model");
		expect(formatJudge({ provider: "anthropic", modelId: "claude-opus-4-7" })).toBe("anthropic/claude-opus-4-7");
	});
});

describe("clampBudget", () => {
	it("clamps to [1, MAX_BUDGET] and floors", () => {
		expect(clampBudget(0)).toBe(1);
		expect(clampBudget(-5)).toBe(1);
		expect(clampBudget(20.9)).toBe(20);
		expect(clampBudget(MAX_BUDGET + 100)).toBe(MAX_BUDGET);
	});

	it("falls back to the default for non-finite input", () => {
		expect(clampBudget(Number.NaN)).toBe(DEFAULT_BUDGET);
	});
});

describe("matchesAskBefore", () => {
	it("matches case-insensitive substrings", () => {
		expect(matchesAskBefore("git push origin main", ["git push"])).toBe(true);
		expect(matchesAskBefore("GIT PUSH --force", ["git push"])).toBe(true);
		expect(matchesAskBefore("rm -rf build", ["rm "])).toBe(true);
	});

	it("returns false when nothing matches or patterns are empty", () => {
		expect(matchesAskBefore("ls -la", ["git push"])).toBe(false);
		expect(matchesAskBefore("anything", [])).toBe(false);
		expect(matchesAskBefore("anything", ["   "])).toBe(false);
	});
});

describe("parseJudgeVerdict", () => {
	it("parses a clean JSON verdict", () => {
		expect(parseJudgeVerdict('{"verdict":"done","reason":"tests pass"}')).toEqual({
			verdict: "done",
			reason: "tests pass",
		});
	});

	it("extracts JSON embedded in surrounding prose", () => {
		const text = 'Here is my decision:\n{"verdict":"continue","reason":"missing coverage"}\nThanks.';
		expect(parseJudgeVerdict(text)).toEqual({ verdict: "continue", reason: "missing coverage" });
	});

	it("defaults reason to empty string when missing", () => {
		expect(parseJudgeVerdict('{"verdict":"done"}')).toEqual({ verdict: "done", reason: "" });
	});

	it("returns null on bad JSON or invalid verdict (fail-open path)", () => {
		expect(parseJudgeVerdict("not json at all")).toBeNull();
		expect(parseJudgeVerdict('{"verdict":"maybe","reason":"x"}')).toBeNull();
		expect(parseJudgeVerdict("{ broken")).toBeNull();
		expect(parseJudgeVerdict("")).toBeNull();
	});
});

describe("statusSummary", () => {
	function withContract(overrides: Partial<GoalState> = {}): GoalState {
		return {
			...createInitialGoalState(),
			status: "active",
			contract: {
				goal: "migrate auth tests",
				doneCriteria: ["all tests green"],
				verifyCommand: "npm test",
				askBefore: [],
				budget: 20,
				judge: { provider: "anthropic", modelId: "claude-opus-4-7" },
			},
			...overrides,
		};
	}

	it("reports idle state", () => {
		expect(statusSummary(createInitialGoalState())).toBe("No active goal.");
	});

	it("reports active progress with judge", () => {
		const s = withContract({ turnsUsed: 3 });
		expect(statusSummary(s)).toContain("Goal active");
		expect(statusSummary(s)).toContain("3/20");
		expect(statusSummary(s)).toContain("anthropic/claude-opus-4-7");
	});

	it("reports paused, blocked, and done variants", () => {
		expect(statusSummary(withContract({ paused: true }))).toContain("Goal paused");
		expect(statusSummary(withContract({ status: "blocked", lastBlockReason: "need creds" }))).toContain("need creds");
		expect(statusSummary(withContract({ status: "done" }))).toContain("Goal done");
	});
});
