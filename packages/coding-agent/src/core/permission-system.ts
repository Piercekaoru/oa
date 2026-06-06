import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";

export type PermissionState = "allow" | "ask" | "deny";
/**
 * Process-level permission override, independent of the per-surface config.
 * - "ask": no override; use the resolved policy as-is (interactive prompts, non-interactive `ask` blocks).
 * - "allow": treat `ask` as `allow`, but keep `deny` (credential paths stay protected).
 * - "bypass": skip permissions entirely (including `deny`); for fully trusted sandboxes/CI.
 */
export type PermissionMode = "ask" | "allow" | "bypass";
export type PermissionPatternMap = Record<string, PermissionState>;
export type PermissionConfig = Record<string, PermissionState | PermissionPatternMap>;

export interface PermissionRule {
	surface: string;
	pattern: string;
	state: PermissionState;
	layer: "default" | "builtin" | "config" | "session";
}

export interface PermissionCheckResult {
	toolName: string;
	state: PermissionState;
	surface: string;
	matchedPattern: string;
	target: string;
	reason: string;
	rule: PermissionRule;
	sessionApproval?: {
		surface: string;
		pattern: string;
	};
}

export interface PermissionPromptChoice {
	label: string;
	approval?: {
		surface: string;
		pattern: string;
	};
}

const DEFAULT_PERMISSION_STATE: PermissionState = "ask";
const PATH_BEARING_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const MOST_RESTRICTIVE_ORDER: Record<PermissionState, number> = {
	allow: 0,
	ask: 1,
	deny: 2,
};
const BUILTIN_PERMISSION_CONFIG: PermissionConfig = {
	"*": "ask",
	path: {
		"*": "allow",
		".env": "deny",
		".env.*": "deny",
		"*.env": "deny",
		"*.env.*": "deny",
		"~/.ssh/*": "deny",
		"*.pem": "deny",
		"*.key": "deny",
		id_rsa: "deny",
		id_ed25519: "deny",
	},
	external_directory: "ask",
	read: "allow",
	grep: "allow",
	find: "allow",
	ls: "allow",
	write: "ask",
	edit: "ask",
	bash: "ask",
};

function isPermissionState(value: unknown): value is PermissionState {
	return value === "allow" || value === "ask" || value === "deny";
}

function isPermissionPatternMap(value: unknown): value is PermissionPatternMap {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	for (const entry of Object.values(value)) {
		if (!isPermissionState(entry)) {
			return false;
		}
	}
	return true;
}

export function normalizePermissionConfig(value: unknown): PermissionConfig | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const normalized: PermissionConfig = {};
	for (const [surface, rawRule] of Object.entries(value)) {
		if (isPermissionState(rawRule)) {
			normalized[surface] = rawRule;
			continue;
		}
		if (isPermissionPatternMap(rawRule)) {
			normalized[surface] = { ...rawRule };
		}
	}
	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function mergePermissionConfig(
	base: PermissionConfig | undefined,
	override: PermissionConfig | undefined,
): PermissionConfig | undefined {
	if (!base && !override) {
		return undefined;
	}
	if (!base) {
		return override ? structuredClone(override) : undefined;
	}
	if (!override) {
		return structuredClone(base);
	}

	const merged: PermissionConfig = structuredClone(base);
	for (const [surface, overrideValue] of Object.entries(override)) {
		const baseValue = merged[surface];
		if (
			typeof baseValue === "object" &&
			baseValue !== null &&
			typeof overrideValue === "object" &&
			overrideValue !== null
		) {
			merged[surface] = { ...baseValue, ...overrideValue };
		} else {
			merged[surface] = structuredClone(overrideValue);
		}
	}
	return merged;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function wildcardMatch(pattern: string, value: string): boolean {
	let escaped = pattern
		.split("*")
		.map((part) => escapeRegExp(part).replaceAll("\\?", "."))
		.join(".*");

	if (escaped.endsWith(" .*")) {
		escaped = `${escaped.slice(0, -3)}( .*)?`;
	}

	return new RegExp(`^${escaped}$`, "s").test(value);
}

function rulesForSurface(
	surface: string,
	value: PermissionState | PermissionPatternMap | undefined,
	layer: PermissionRule["layer"],
): PermissionRule[] {
	if (value === undefined) {
		return [];
	}
	if (isPermissionState(value)) {
		return [{ surface, pattern: "*", state: value, layer }];
	}
	return Object.entries(value).map(([pattern, state]) => ({
		surface,
		pattern,
		state,
		layer,
	}));
}

function buildRules(config: PermissionConfig | undefined, sessionRules: PermissionRule[]): PermissionRule[] {
	const builtinUniversal = BUILTIN_PERMISSION_CONFIG["*"];
	const defaultState = isPermissionState(builtinUniversal) ? builtinUniversal : DEFAULT_PERMISSION_STATE;
	const rules: PermissionRule[] = [
		{
			surface: "*",
			pattern: "*",
			state: defaultState,
			layer: "default",
		},
	];

	for (const [surface, value] of Object.entries(BUILTIN_PERMISSION_CONFIG)) {
		if (surface !== "*") {
			rules.push(...rulesForSurface(surface, value, "builtin"));
		}
	}

	if (config) {
		const universal = config["*"];
		if (isPermissionState(universal)) {
			rules.push({
				surface: "*",
				pattern: "*",
				state: universal,
				layer: "config",
			});
		}
		for (const [surface, value] of Object.entries(config)) {
			if (surface !== "*") {
				rules.push(...rulesForSurface(surface, value, "config"));
			}
		}
	}

	rules.push(...sessionRules);
	return rules;
}

function evaluate(surface: string, target: string, rules: PermissionRule[]): PermissionCheckResult["rule"] {
	for (let index = rules.length - 1; index >= 0; index--) {
		const rule = rules[index];
		if (wildcardMatch(rule.surface, surface) && wildcardMatch(rule.pattern, target)) {
			return rule;
		}
	}
	return {
		surface,
		pattern: target,
		state: DEFAULT_PERMISSION_STATE,
		layer: "default",
	};
}

function isMoreRestrictive(left: PermissionState, right: PermissionState): boolean {
	return MOST_RESTRICTIVE_ORDER[left] > MOST_RESTRICTIVE_ORDER[right];
}

function toPosixPath(value: string): string {
	return value.split(sep).join("/");
}

function expandHomePath(path: string): string {
	if (path === "~") {
		return homedir();
	}
	if (path.startsWith("~/")) {
		return `${homedir()}${sep}${path.slice(2)}`;
	}
	return path;
}

function normalizePathForPermission(path: string, cwd: string): string {
	return toPosixPath(resolve(cwd, expandHomePath(path)));
}

function getPathPermissionTargets(path: string, cwd: string): string[] {
	const expandedPath = expandHomePath(path);
	const absolutePath = resolve(cwd, expandedPath);
	const relativePath = relative(resolve(cwd), absolutePath);
	const homeRelativePath = relative(homedir(), absolutePath);
	return Array.from(
		new Set(
			[
				path,
				toPosixPath(path),
				expandedPath,
				toPosixPath(expandedPath),
				toPosixPath(absolutePath),
				relativePath && !relativePath.startsWith("..") ? toPosixPath(relativePath) : undefined,
				homeRelativePath && !homeRelativePath.startsWith("..") ? `~/${toPosixPath(homeRelativePath)}` : undefined,
			].filter((value): value is string => typeof value === "string" && value.length > 0),
		),
	);
}

function isOutsideCwd(path: string, cwd: string): boolean {
	const absolutePath = resolve(cwd, expandHomePath(path));
	const absoluteCwd = resolve(cwd);
	if (absolutePath === absoluteCwd) {
		return false;
	}
	return !absolutePath.startsWith(`${absoluteCwd}${sep}`);
}

function toRecord(input: unknown): Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: {};
}

function getPathBearingToolPath(toolName: string, input: unknown): string | undefined {
	const record = toRecord(input);
	const pathValue = record.path;
	if (typeof pathValue === "string") {
		return pathValue;
	}
	if (toolName === "grep" || toolName === "find" || toolName === "ls") {
		return ".";
	}
	return undefined;
}

export function splitBashCommands(command: string): string[] {
	const commands: string[] = [];
	let start = 0;
	let quote: "'" | '"' | undefined;
	let escaped = false;

	for (let index = 0; index < command.length; index++) {
		const char = command[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = undefined;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}

		const next = command[index + 1];
		let operatorLength = 0;
		if (char === "\n" || char === ";") {
			operatorLength = 1;
		} else if (char === "&" && next === "&") {
			operatorLength = 2;
		} else if (char === "|" && next === "|") {
			operatorLength = 2;
		} else if (char === "|" || char === "&") {
			operatorLength = 1;
		}

		if (operatorLength > 0) {
			const part = command.slice(start, index).trim();
			if (part.length > 0) {
				commands.push(part);
			}
			index += operatorLength - 1;
			start = index + 1;
		}
	}

	const tail = command.slice(start).trim();
	if (tail.length > 0) {
		commands.push(tail);
	}
	return commands.length > 0 ? commands : [command.trim()].filter((part) => part.length > 0);
}

function findMatchingParen(command: string, openIndex: number): number | undefined {
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let depth = 1;

	for (let index = openIndex + 1; index < command.length; index++) {
		const char = command[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = undefined;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === "(") {
			depth++;
		} else if (char === ")") {
			depth--;
			if (depth === 0) {
				return index;
			}
		}
	}

	return undefined;
}

function findMatchingBacktick(command: string, openIndex: number): number | undefined {
	let escaped = false;
	for (let index = openIndex + 1; index < command.length; index++) {
		const char = command[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === "`") {
			return index;
		}
	}
	return undefined;
}

function isSubshellStart(command: string, index: number): boolean {
	const before = command.slice(0, index).trimEnd();
	if (before.length === 0) {
		return true;
	}
	const previous = before[before.length - 1];
	return previous === ";" || previous === "&" || previous === "|" || previous === "(" || previous === "\n";
}

function extractNestedBashCommands(command: string): string[] {
	const nested: string[] = [];
	let quote: "'" | '"' | undefined;
	let escaped = false;

	for (let index = 0; index < command.length; index++) {
		const char = command[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			const isDoubleQuote = quote === '"';
			if (char === quote) {
				quote = undefined;
				continue;
			}
			if (!isDoubleQuote) {
				continue;
			}
			if (char === "`") {
				const end = findMatchingBacktick(command, index);
				if (end !== undefined) {
					nested.push(command.slice(index + 1, end).trim());
					index = end;
				}
				continue;
			}
			if (char === "$" && command[index + 1] === "(") {
				const end = findMatchingParen(command, index + 1);
				if (end !== undefined) {
					nested.push(command.slice(index + 2, end).trim());
					index = end;
				}
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}

		if (char === "`") {
			const end = findMatchingBacktick(command, index);
			if (end !== undefined) {
				nested.push(command.slice(index + 1, end).trim());
				index = end;
			}
			continue;
		}

		if (char === "$" && command[index + 1] === "(") {
			const end = findMatchingParen(command, index + 1);
			if (end !== undefined) {
				nested.push(command.slice(index + 2, end).trim());
				index = end;
			}
			continue;
		}

		if (char === "(" && isSubshellStart(command, index)) {
			const end = findMatchingParen(command, index);
			if (end !== undefined) {
				nested.push(command.slice(index + 1, end).trim());
				index = end;
			}
		}
	}

	return nested.filter((part) => part.length > 0);
}

export function extractBashCommands(command: string): string[] {
	const commands = new Set<string>();
	const visit = (value: string): void => {
		for (const part of splitBashCommands(value)) {
			commands.add(part);
		}
		for (const nested of extractNestedBashCommands(value)) {
			visit(nested);
		}
	};
	visit(command);
	return [...commands];
}

function unquoteToken(token: string): string {
	if (
		(token.startsWith("'") && token.endsWith("'") && token.length >= 2) ||
		(token.startsWith('"') && token.endsWith('"') && token.length >= 2)
	) {
		return token.slice(1, -1);
	}
	return token;
}

function isPathLikeToken(token: string): boolean {
	if (
		token === "." ||
		token === ".." ||
		token.startsWith("./") ||
		token.startsWith("../") ||
		token.startsWith("/") ||
		token.startsWith("~/") ||
		token.includes("/") ||
		token.startsWith(".")
	) {
		return true;
	}
	if (token === "id_rsa" || token === "id_ed25519") {
		return true;
	}
	return !token.startsWith("-") && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+$/.test(token);
}

export function extractBashPathCandidates(command: string): string[] {
	const candidates = new Set<string>();
	for (const match of command.matchAll(/(?:"[^"]+"|'[^']+'|[^\s]+)/g)) {
		const rawToken = match[0];
		const token = unquoteToken(rawToken).replace(/[),]+$/g, "");
		if (isPathLikeToken(token)) {
			candidates.add(token);
		}
	}
	return [...candidates];
}

function resultForRule(args: {
	toolName: string;
	surface: string;
	target: string;
	rule: PermissionRule;
	reason: string;
	sessionApproval?: { surface: string; pattern: string };
}): PermissionCheckResult {
	const sessionApproval =
		args.sessionApproval ??
		(args.rule.layer !== "default" ? { surface: args.rule.surface, pattern: args.rule.pattern } : undefined);
	return {
		toolName: args.toolName,
		state: args.rule.state,
		surface: args.surface,
		matchedPattern: args.rule.pattern,
		target: args.target,
		reason: args.reason,
		rule: args.rule,
		sessionApproval,
	};
}

export function formatPermissionReason(result: PermissionCheckResult): string {
	return `${result.state.toUpperCase()} ${result.toolName}: ${result.reason} (matched ${result.surface}:${result.matchedPattern})`;
}

export function formatPermissionPrompt(result: PermissionCheckResult): string {
	return [
		`Tool: ${result.toolName}`,
		`Target: ${result.target}`,
		`Matched: ${result.surface}:${result.matchedPattern}`,
		`Decision: ${result.state}`,
	].join("\n");
}

export class PermissionManager {
	private sessionRules: PermissionRule[] = [];
	private readonly cwd: string;
	private readonly getConfig: () => PermissionConfig | undefined;
	private readonly modeOverride: PermissionMode;

	constructor(cwd: string, getConfig: () => PermissionConfig | undefined, modeOverride: PermissionMode = "ask") {
		this.cwd = cwd;
		this.getConfig = getConfig;
		this.modeOverride = modeOverride;
	}

	resetSessionApprovals(): void {
		this.sessionRules = [];
	}

	addSessionApproval(surface: string, pattern: string): void {
		this.sessionRules.push({
			surface,
			pattern,
			state: "allow",
			layer: "session",
		});
	}

	getPromptChoices(result: PermissionCheckResult): PermissionPromptChoice[] {
		const choices: PermissionPromptChoice[] = [{ label: "Approve once" }];
		if (result.sessionApproval) {
			choices.push({
				label: `Approve ${result.sessionApproval.surface}:${result.sessionApproval.pattern} for this session`,
				approval: result.sessionApproval,
			});
		}
		return choices;
	}

	getToolPermission(toolName: string): PermissionState {
		const config = this.getConfig();
		const value = config?.[toolName];
		if (isPermissionState(value)) {
			return value;
		}
		if (isPermissionPatternMap(value)) {
			const catchAll = value["*"];
			return catchAll ?? "allow";
		}
		const universal = config?.["*"];
		if (isPermissionState(universal)) {
			return universal;
		}
		const builtinValue = BUILTIN_PERMISSION_CONFIG[toolName];
		if (isPermissionState(builtinValue)) {
			return builtinValue;
		}
		if (isPermissionPatternMap(builtinValue)) {
			return builtinValue["*"] ?? DEFAULT_PERMISSION_STATE;
		}
		return DEFAULT_PERMISSION_STATE;
	}

	shouldExposeTool(toolName: string): boolean {
		// In bypass mode every tool is exposed, even ones the config denies.
		if (this.modeOverride === "bypass") {
			return true;
		}
		const config = this.getConfig();
		const value = config?.[toolName];
		if (isPermissionState(value)) {
			return value !== "deny";
		}
		if (isPermissionPatternMap(value)) {
			return true;
		}
		const universal = config?.["*"];
		if (isPermissionState(universal)) {
			return universal !== "deny";
		}
		return this.getToolPermission(toolName) !== "deny";
	}

	resolve(toolName: string, input: unknown): PermissionCheckResult {
		return this.applyModeOverride(this.resolveBase(toolName, input));
	}

	private resolveBase(toolName: string, input: unknown): PermissionCheckResult {
		const config = this.getConfig();
		const rules = buildRules(config, this.sessionRules);
		if (toolName === "bash") {
			return this.resolveBash(input, rules);
		}
		if (PATH_BEARING_TOOLS.has(toolName)) {
			return this.resolvePathBearingTool(toolName, input, rules);
		}
		return this.resolveSurface(toolName, toolName, "*", rules, `${toolName} tool policy`, {
			surface: toolName,
			pattern: "*",
		});
	}

	/**
	 * Apply the process-level permission mode on top of the resolved policy.
	 * `bypass` overrides everything (including `deny`); `allow` only upgrades
	 * `ask` to `allow` and leaves `deny` decisions intact.
	 */
	private applyModeOverride(result: PermissionCheckResult): PermissionCheckResult {
		if (this.modeOverride === "bypass") {
			return { ...result, state: "allow", reason: `${result.reason} (permission-mode: bypass)` };
		}
		if (this.modeOverride === "allow" && result.state === "ask") {
			return { ...result, state: "allow", reason: `${result.reason} (permission-mode: allow)` };
		}
		return result;
	}

	private resolveSurface(
		toolName: string,
		surface: string,
		target: string,
		rules: PermissionRule[],
		reason: string,
		sessionApproval?: { surface: string; pattern: string },
	): PermissionCheckResult {
		const rule = evaluate(surface, target, rules);
		return resultForRule({
			toolName,
			surface,
			target,
			rule,
			reason,
			sessionApproval,
		});
	}

	private resolveFirstMatchingSurface(
		toolName: string,
		surface: string,
		targets: string[],
		rules: PermissionRule[],
		reason: string,
		sessionApproval?: { surface: string; pattern: string },
	): PermissionCheckResult {
		for (const target of targets) {
			const rule = evaluate(surface, target, rules);
			if (rule.layer !== "default") {
				return resultForRule({
					toolName,
					surface,
					target,
					rule,
					reason,
					sessionApproval,
				});
			}
		}
		return this.resolveSurface(toolName, surface, targets[0] ?? "*", rules, reason, sessionApproval);
	}

	private pickMostRestrictive(results: PermissionCheckResult[]): PermissionCheckResult {
		let selected = results[0];
		for (const result of results.slice(1)) {
			if (isMoreRestrictive(result.state, selected.state)) {
				selected = result;
			}
		}
		return selected;
	}

	private resolvePaths(toolName: string, paths: string[], rules: PermissionRule[]): PermissionCheckResult | undefined {
		const results: PermissionCheckResult[] = [];
		for (const path of paths) {
			results.push(
				this.resolveFirstMatchingSurface(
					toolName,
					"path",
					getPathPermissionTargets(path, this.cwd),
					rules,
					`path policy for ${path}`,
				),
			);
		}
		const restrictive = results.filter((result) => result.state !== "allow");
		return restrictive.length > 0 ? this.pickMostRestrictive(restrictive) : undefined;
	}

	private resolveExternalDirectory(
		toolName: string,
		paths: string[],
		rules: PermissionRule[],
	): PermissionCheckResult | undefined {
		const results: PermissionCheckResult[] = [];
		for (const path of paths) {
			if (!isOutsideCwd(path, this.cwd)) {
				continue;
			}
			const normalizedPath = normalizePathForPermission(path, this.cwd);
			results.push(
				this.resolveSurface(
					toolName,
					"external_directory",
					normalizedPath,
					rules,
					`external directory access for ${path}`,
				),
			);
		}
		const restrictive = results.filter((result) => result.state !== "allow");
		return restrictive.length > 0 ? this.pickMostRestrictive(restrictive) : undefined;
	}

	private resolvePathBearingTool(toolName: string, input: unknown, rules: PermissionRule[]): PermissionCheckResult {
		const toolPath = getPathBearingToolPath(toolName, input);
		if (toolPath) {
			const pathResult = this.resolvePaths(toolName, [toolPath], rules);
			if (pathResult) {
				return pathResult;
			}

			const externalResult = this.resolveExternalDirectory(toolName, [toolPath], rules);
			if (externalResult) {
				return externalResult;
			}
		}

		const targets = toolPath ? getPathPermissionTargets(toolPath, this.cwd) : ["*"];
		return this.resolveFirstMatchingSurface(
			toolName,
			toolName,
			targets,
			rules,
			`${toolName} tool policy for ${toolPath ?? "*"}`,
		);
	}

	private resolveBash(input: unknown, rules: PermissionRule[]): PermissionCheckResult {
		const record = toRecord(input);
		const command = typeof record.command === "string" ? record.command : "";
		const bashCommands = extractBashCommands(command);
		const pathCandidates = Array.from(new Set(bashCommands.flatMap((part) => extractBashPathCandidates(part))));
		if (pathCandidates.length > 0) {
			const pathResult = this.resolvePaths("bash", pathCandidates, rules);
			if (pathResult) {
				return pathResult;
			}

			const externalResult = this.resolveExternalDirectory("bash", pathCandidates, rules);
			if (externalResult) {
				return externalResult;
			}
		}

		const commandResults = bashCommands.map((part) =>
			this.resolveSurface("bash", "bash", part, rules, `bash command policy for ${part}`),
		);

		if (commandResults.length === 0) {
			return this.resolveSurface("bash", "bash", command, rules, "bash command policy");
		}

		return this.pickMostRestrictive(commandResults);
	}
}

export function normalizePermissionPathForTest(path: string, cwd: string): string {
	return normalizePathForPermission(path, cwd);
}
