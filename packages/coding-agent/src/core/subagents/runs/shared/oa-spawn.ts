import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_COMMAND } from "../../../../config.ts";

export const OA_CODING_AGENT_PACKAGE = "@openachieve/agent";

export function findOaPackageRootFromEntry(entryPoint: string): string | undefined {
	let dir = path.dirname(entryPoint);
	while (dir !== path.dirname(dir)) {
		const packageJsonPath = path.join(dir, "package.json");
		if (fs.existsSync(packageJsonPath)) {
			const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { name?: unknown };
			if (pkg.name === OA_CODING_AGENT_PACKAGE) return dir;
		}
		dir = path.dirname(dir);
	}
	return undefined;
}

export function resolveInstalledOaPackageRoot(): string | undefined {
	return findOaPackageRootFromEntry(fileURLToPath(import.meta.url));
}

export function resolveOaPackageRoot(): string | undefined {
	try {
		const entry = process.argv[1];
		return entry ? findOaPackageRootFromEntry(fs.realpathSync(entry)) : undefined;
	} catch {
		// process.argv[1] probing is best-effort; callers can fall back to PATH/package resolution.
		return undefined;
	}
}

export interface OaSpawnDeps {
	platform?: NodeJS.Platform;
	execPath?: string;
	argv1?: string;
	existsSync?: (filePath: string) => boolean;
	readFileSync?: (filePath: string, encoding: "utf-8") => string;
	resolvePackageJson?: () => string;
	resolvePackageEntry?: () => string;
	oaPackageRoot?: string;
}

interface OaSpawnCommand {
	command: string;
	args: string[];
}

function isRunnableNodeScript(filePath: string, existsSync: (filePath: string) => boolean): boolean {
	if (!existsSync(filePath)) return false;
	return /\.(?:mjs|cjs|js)$/i.test(filePath);
}

function normalizePath(filePath: string): string {
	return path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
}

export function resolveOaCliScript(deps: OaSpawnDeps = {}): string | undefined {
	const existsSync = deps.existsSync ?? fs.existsSync;
	const readFileSync = deps.readFileSync ?? ((filePath, encoding) => fs.readFileSync(filePath, encoding));
	const argv1 = deps.argv1 ?? process.argv[1];

	if (argv1) {
		const argvPath = normalizePath(argv1);
		if (isRunnableNodeScript(argvPath, existsSync)) {
			return argvPath;
		}
	}

	try {
		const resolvePackageJson =
			deps.resolvePackageJson ??
			(() => {
				const root = deps.oaPackageRoot ?? resolveOaPackageRoot();
				if (root) return path.join(root, "package.json");
				const packageRoot = deps.resolvePackageEntry
					? findOaPackageRootFromEntry(deps.resolvePackageEntry())
					: resolveInstalledOaPackageRoot();
				if (!packageRoot) throw new Error(`Could not resolve ${OA_CODING_AGENT_PACKAGE} package root`);
				return path.join(packageRoot, "package.json");
			});
		const packageJsonPath = resolvePackageJson();
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
			bin?: string | Record<string, string>;
		};
		const binField = packageJson.bin;
		const binPath = typeof binField === "string" ? binField : (binField?.oa ?? Object.values(binField ?? {})[0]);
		if (!binPath) return undefined;
		const candidate = path.resolve(path.dirname(packageJsonPath), binPath);
		if (isRunnableNodeScript(candidate, existsSync)) {
			return candidate;
		}
	} catch {
		// CLI script resolution is best-effort; the caller falls back to the configured command name.
		return undefined;
	}

	return undefined;
}

export function getOaSpawnCommand(args: string[], deps: OaSpawnDeps = {}): OaSpawnCommand {
	// Prefer launching the resolved CLI script directly via node on every platform, so
	// spawning a subagent never depends on a specific command name being present on PATH.
	const oaCliPath = resolveOaCliScript(deps);
	if (oaCliPath) {
		return {
			command: deps.execPath ?? process.execPath,
			args: [oaCliPath, ...args],
		};
	}

	// Fall back to the configured CLI command name (e.g. "oa") resolved via PATH.
	return { command: APP_COMMAND, args };
}
