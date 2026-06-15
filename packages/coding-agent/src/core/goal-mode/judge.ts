/**
 * Cross-model completion judge.
 *
 * Every goal_complete is gated by an independent judge call. The judge is a
 * fresh, history-free LLM context (a different model by default) that must
 * agree the goal is done. On any judge-infra failure we fail open so glitches
 * don't block legitimate completion.
 */

import type { Model, TextContent } from "@openachieve/ai";
import { complete } from "@openachieve/ai";
import type { ExecResult } from "../exec.ts";
import type { ExtensionContext } from "../extensions/types.ts";
import { buildJudgeUserContent, JUDGE_SYSTEM_PROMPT } from "./strings.ts";
import { type GoalContract, parseJudgeVerdict } from "./utils.ts";

export interface JudgeResult {
	verdict: "done" | "continue";
	reason: string;
	/** False when the verdict came from fail-open rather than a real judge call. */
	judged: boolean;
}

function failOpen(reason: string): JudgeResult {
	return { verdict: "done", reason: `(judge unavailable, fail-open) ${reason}`, judged: false };
}

export async function runJudge(
	ctx: ExtensionContext,
	contract: GoalContract,
	evidence: string,
	verify: ExecResult,
): Promise<JudgeResult> {
	const model: Model<any> | undefined =
		"sameModel" in contract.judge
			? ctx.model
			: ctx.modelRegistry.find(contract.judge.provider, contract.judge.modelId);
	if (!model) return failOpen("judge model not available");

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return failOpen(`judge auth failed: ${auth.error}`);

	try {
		const response = await complete(
			model,
			{
				systemPrompt: JUDGE_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: buildJudgeUserContent(contract, evidence, verify) }],
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal },
		);
		if (response.stopReason === "aborted") return failOpen("judge call aborted");
		const text = response.content
			.filter((c): c is TextContent => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		const parsed = parseJudgeVerdict(text);
		if (!parsed) return failOpen("judge response was not valid JSON");
		return { ...parsed, judged: true };
	} catch (error) {
		return failOpen(error instanceof Error ? error.message : String(error));
	}
}
