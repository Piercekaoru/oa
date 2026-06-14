import { describe, expect, test } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import registerPlanModeExtension from "../src/core/plan-mode/extension.ts";

type CommandHandler = (args: string, ctx: ExtensionContext) => unknown;
type EventHandler = (event: any, ctx?: ExtensionContext) => unknown;

function setup() {
	const commands = new Map<string, CommandHandler>();
	const events = new Map<string, EventHandler>();
	const setActiveToolsCalls: string[][] = [];

	const api = {
		registerFlag: () => {},
		registerCommand: (name: string, opts: { handler: CommandHandler }) => {
			commands.set(name, opts.handler);
		},
		registerShortcut: () => {},
		on: (event: string, handler: EventHandler) => {
			events.set(event, handler);
		},
		getFlag: () => false,
		setActiveTools: (names: string[]) => {
			setActiveToolsCalls.push(names);
		},
		appendEntry: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
	} as unknown as ExtensionAPI;

	registerPlanModeExtension(api);

	const ctx = {
		hasUI: true,
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			theme: {
				fg: (_role: string, text: string) => text,
				strikethrough: (text: string) => text,
			},
		},
		sessionManager: { getEntries: () => [] },
	} as unknown as ExtensionContext;

	return { commands, events, setActiveToolsCalls, ctx };
}

describe("plan-mode extension", () => {
	test("/plan toggles between the read-only and full tool sets", async () => {
		const { commands, setActiveToolsCalls, ctx } = setup();
		const plan = commands.get("plan");
		expect(plan).toBeDefined();

		await plan!("", ctx);
		expect(setActiveToolsCalls.at(-1)).toEqual(["read", "bash", "grep", "find", "ls"]);

		await plan!("", ctx);
		expect(setActiveToolsCalls.at(-1)).toEqual(["read", "bash", "edit", "write"]);
	});

	test("blocks non-allowlisted bash commands only while in plan mode", async () => {
		const { commands, events, ctx } = setup();
		const plan = commands.get("plan");
		const toolCall = events.get("tool_call");
		expect(toolCall).toBeDefined();

		// Not in plan mode → nothing is intercepted.
		expect(await toolCall!({ toolName: "bash", input: { command: "rm -rf /" } })).toBeUndefined();

		await plan!("", ctx); // enable plan mode

		expect(await toolCall!({ toolName: "bash", input: { command: "rm -rf /" } })).toMatchObject({ block: true });
		expect(await toolCall!({ toolName: "bash", input: { command: "cat file.ts" } })).toBeUndefined();
		// Non-bash tools are never intercepted by plan mode.
		expect(await toolCall!({ toolName: "read", input: { path: "x" } })).toBeUndefined();
	});
});
