/**
 * /agents command - list and inspect available subagents
 */

import type { AgentConfig } from "../agents/agents.ts";
import { discoverAgentsAll } from "../agents/agents.ts";
import type { ExtensionContext } from "../compat/coding-agent.ts";

interface AgentListEntry {
	name: string;
	scope: "builtin" | "user" | "project";
	description: string;
	disabled: boolean;
	model?: string;
	filePath: string;
}

function formatAgentList(agents: AgentListEntry[], theme: ExtensionContext["ui"]["theme"]): string {
	if (agents.length === 0) {
		return theme.fg("dim", "No agents found.");
	}

	// Calculate column widths
	const nameWidth = Math.max(8, ...agents.map((a) => a.name.length));
	const scopeWidth = 8;
	const modelWidth = Math.max(8, ...agents.map((a) => (a.model || "").length));

	// Header
	const header = [
		theme.bold("Name".padEnd(nameWidth)),
		theme.bold("Scope".padEnd(scopeWidth)),
		theme.bold("Model".padEnd(modelWidth)),
		theme.bold("Description"),
	].join("  ");

	const separator = theme.fg("dim", "─".repeat(80));

	// Rows
	const rows = agents.map((agent) => {
		const scopeIndicator =
			agent.scope === "builtin"
				? theme.fg("dim", "●")
				: agent.scope === "user"
					? theme.fg("accent", "◦")
					: theme.fg("success", "•");
		const scopeLabel = `${scopeIndicator} ${agent.scope}`.padEnd(scopeWidth + 2); // +2 for indicator
		const nameDisplay = agent.disabled ? theme.fg("dim", `✕ ${agent.name}`) : agent.name;
		const modelDisplay = (agent.model || theme.fg("dim", "inherit")).padEnd(modelWidth);
		const descDisplay = agent.description || theme.fg("dim", "(no description)");

		return [nameDisplay.padEnd(nameWidth), scopeLabel, modelDisplay, descDisplay].join("  ");
	});

	return [header, separator, ...rows].join("\n");
}

function formatAgentDetail(agent: AgentConfig, theme: ExtensionContext["ui"]["theme"]): string {
	const sections: string[] = [];

	// Header
	const scopeLabel =
		agent.source === "builtin"
			? theme.fg("dim", "[builtin]")
			: agent.source === "user"
				? theme.fg("accent", "[user]")
				: theme.fg("success", "[project]");
	sections.push(`${theme.bold(agent.name)} ${scopeLabel}`);
	sections.push(theme.fg("dim", "─".repeat(60)));

	// Description
	sections.push(theme.bold("Description:"));
	sections.push(agent.description || theme.fg("dim", "(no description)"));
	sections.push("");

	// File path
	if (agent.source !== "builtin" || agent.override) {
		sections.push(theme.bold("File:"));
		sections.push(theme.fg("dim", agent.filePath));
		sections.push("");
	}

	// Configuration
	sections.push(theme.bold("Configuration:"));
	const config: string[] = [];
	if (agent.model) config.push(`  Model: ${agent.model}`);
	if (agent.thinking) config.push(`  Thinking: ${agent.thinking}`);
	if (agent.fallbackModels?.length) config.push(`  Fallback models: ${agent.fallbackModels.join(", ")}`);
	config.push(`  System prompt mode: ${agent.systemPromptMode}`);
	config.push(`  Inherit project context: ${agent.inheritProjectContext}`);
	config.push(`  Inherit skills: ${agent.inheritSkills}`);
	if (agent.defaultContext) config.push(`  Default context: ${agent.defaultContext}`);
	if (agent.tools?.length) config.push(`  Tools: ${agent.tools.join(", ")}`);
	if (agent.skills?.length) config.push(`  Skills: ${agent.skills.join(", ")}`);
	if (agent.extensions?.length) config.push(`  Extensions: ${agent.extensions.join(", ")}`);
	if (agent.output) config.push(`  Output: ${agent.output}`);
	if (agent.defaultReads?.length) config.push(`  Default reads: ${agent.defaultReads.join(", ")}`);
	if (agent.defaultProgress !== undefined) config.push(`  Default progress: ${agent.defaultProgress}`);
	if (agent.maxSubagentDepth !== undefined) config.push(`  Max subagent depth: ${agent.maxSubagentDepth}`);
	if (agent.completionGuard !== undefined) config.push(`  Completion guard: ${agent.completionGuard}`);
	if (agent.disabled) config.push(theme.fg("warning", "  Status: DISABLED"));

	sections.push(config.join("\n"));
	sections.push("");

	// Overrides
	if (agent.override) {
		sections.push(theme.bold("Overrides:"));
		sections.push(theme.fg("accent", `  Scope: ${agent.override.scope}`));
		sections.push(theme.fg("dim", `  Path: ${agent.override.path}`));
		sections.push("");
	}

	// System prompt preview
	sections.push(theme.bold("System prompt preview:"));
	const promptLines = agent.systemPrompt.split("\n").slice(0, 5);
	const preview = promptLines.join("\n");
	const truncated = agent.systemPrompt.split("\n").length > 5;
	sections.push(theme.fg("dim", preview));
	if (truncated) {
		sections.push(theme.fg("dim", "..."));
		sections.push(theme.fg("dim", `(${agent.systemPrompt.split("\n").length} lines total)`));
	}

	return sections.join("\n");
}

function parseAgentsArgs(args: string): {
	name?: string;
	scope?: "builtin" | "user" | "project";
	showChains?: boolean;
} {
	const trimmed = args.trim();
	if (!trimmed) return {};

	// Check for --scope=<value> flag
	const scopeMatch = trimmed.match(/--scope=(builtin|user|project)/);
	const scope = scopeMatch?.[1] as "builtin" | "user" | "project" | undefined;

	// Check for --chains flag
	const showChains = /--chains/.test(trimmed);

	// Remove flags to get agent name
	const name =
		trimmed
			.replace(/--scope=(builtin|user|project)/, "")
			.replace(/--chains/, "")
			.trim() || undefined;

	return { name, scope, showChains };
}

export function registerAgentsCommand(
	registerCommand: (
		name: string,
		options: {
			description: string;
			handler: (args: string, ctx: ExtensionContext) => Promise<void>;
			getArgumentCompletions?: (prefix: string) => { value: string; label: string }[] | null;
		},
	) => void,
	getBaseCwd: () => string | null,
): void {
	registerCommand("agents", {
		description: "List and inspect subagents: /agents [name] [--scope=builtin|user|project] [--chains]",
		getArgumentCompletions: (prefix: string) => {
			const cwd = getBaseCwd();
			if (!cwd) return null;

			// If prefix starts with --, show flag completions
			if (prefix.startsWith("--")) {
				const flags = ["--scope=builtin", "--scope=user", "--scope=project", "--chains"];
				return flags.filter((f) => f.startsWith(prefix)).map((f) => ({ value: f, label: f }));
			}

			// Otherwise show agent name completions
			const discovery = discoverAgentsAll(cwd);
			const allAgents = [...discovery.builtin, ...discovery.user, ...discovery.project];
			return allAgents.filter((a) => a.name.startsWith(prefix)).map((a) => ({ value: a.name, label: a.name }));
		},
		handler: async (args, ctx) => {
			const cwd = getBaseCwd();
			if (!cwd) {
				ctx.ui.notify("Subagent session cwd is not initialized yet", "error");
				return;
			}

			const { name, scope, showChains } = parseAgentsArgs(args);
			const discovery = discoverAgentsAll(cwd);

			// If name provided, show detail for that agent
			if (name) {
				const allAgents = [...discovery.builtin, ...discovery.user, ...discovery.project];
				const agent = allAgents.find((a) => a.name === name);
				if (!agent) {
					ctx.ui.notify(`Unknown agent: ${name}`, "error");
					return;
				}
				const detail = formatAgentDetail(agent, ctx.ui.theme);
				ctx.ui.notify(detail, "info");
				return;
			}

			// List mode
			const agentsToShow: AgentListEntry[] = [];

			// Filter by scope
			if (scope === "builtin" || !scope) {
				agentsToShow.push(
					...discovery.builtin.map((a) => ({
						name: a.name,
						scope: "builtin" as const,
						description: a.description,
						disabled: a.disabled || false,
						model: a.model,
						filePath: a.filePath,
					})),
				);
			}
			if (scope === "user" || !scope) {
				agentsToShow.push(
					...discovery.user.map((a) => ({
						name: a.name,
						scope: "user" as const,
						description: a.description,
						disabled: a.disabled || false,
						model: a.model,
						filePath: a.filePath,
					})),
				);
			}
			if (scope === "project" || !scope) {
				agentsToShow.push(
					...discovery.project.map((a) => ({
						name: a.name,
						scope: "project" as const,
						description: a.description,
						disabled: a.disabled || false,
						model: a.model,
						filePath: a.filePath,
					})),
				);
			}

			// Sort: project > user > builtin, then by name
			agentsToShow.sort((a, b) => {
				const scopeOrder = { project: 0, user: 1, builtin: 2 };
				const scopeDiff = scopeOrder[a.scope] - scopeOrder[b.scope];
				if (scopeDiff !== 0) return scopeDiff;
				return a.name.localeCompare(b.name);
			});

			const output: string[] = [];
			output.push(ctx.ui.theme.bold("Available Agents"));
			output.push("");
			output.push(formatAgentList(agentsToShow, ctx.ui.theme));
			output.push("");
			output.push(ctx.ui.theme.fg("dim", `Total: ${agentsToShow.length} agents`));
			output.push("");
			output.push(ctx.ui.theme.fg("dim", "Legend: ● builtin  ◦ user  • project  ✕ disabled"));
			output.push("");
			output.push(ctx.ui.theme.fg("dim", "Use /agents <name> to inspect a specific agent"));
			output.push(ctx.ui.theme.fg("dim", "Use /agents --scope=<builtin|user|project> to filter by scope"));

			// Show chains if requested
			if (showChains && discovery.chains.length > 0) {
				output.push("");
				output.push(ctx.ui.theme.bold("Available Chains"));
				output.push("");
				const chainList = discovery.chains
					.map((c) => {
						const source =
							c.source === "user"
								? ctx.ui.theme.fg("accent", "[user]")
								: ctx.ui.theme.fg("success", "[project]");
						return `  ${ctx.ui.theme.bold(c.name)} ${source} - ${c.description || ctx.ui.theme.fg("dim", "(no description)")}`;
					})
					.join("\n");
				output.push(chainList);
			}

			ctx.ui.notify(output.join("\n"), "info");
		},
	});
}
