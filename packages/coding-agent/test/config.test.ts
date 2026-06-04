import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import { afterEach, describe, expect, test } from "vitest";
import {
	APP_NAME,
	APP_TITLE,
	CONFIG_DIR_NAME,
	detectInstallMethod,
	ENV_AGENT_DIR,
	ENV_SESSION_DIR,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	getShareViewerUrl,
	getUpdateInstruction,
} from "../src/config.ts";

const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");
const originalPath = process.env.PATH;
const originalOpenachievePackageDir = process.env.OPENACHIEVE_PACKAGE_DIR;
const originalOpenachieveShareViewerUrl = process.env.OPENACHIEVE_SHARE_VIEWER_URL;
const originalArgv1 = process.argv[1];
let tempDir: string | undefined;

function setExecPath(value: string): void {
	Object.defineProperty(process, "execPath", {
		value,
		configurable: true,
	});
}

afterEach(() => {
	if (execPathDescriptor) {
		Object.defineProperty(process, "execPath", execPathDescriptor);
	}
	if (originalPath === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = originalPath;
	}
	if (originalOpenachievePackageDir === undefined) {
		delete process.env.OPENACHIEVE_PACKAGE_DIR;
	} else {
		process.env.OPENACHIEVE_PACKAGE_DIR = originalOpenachievePackageDir;
	}
	if (originalOpenachieveShareViewerUrl === undefined) {
		delete process.env.OPENACHIEVE_SHARE_VIEWER_URL;
	} else {
		process.env.OPENACHIEVE_SHARE_VIEWER_URL = originalOpenachieveShareViewerUrl;
	}
	if (originalArgv1 === undefined) {
		process.argv.splice(1, 1);
	} else {
		process.argv[1] = originalArgv1;
	}
	if (tempDir) {
		chmodSync(tempDir, 0o700);
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function createNpmPrefixInstall(template = "openachieve-prefix-"): { prefix: string; packageDir: string } {
	const prefix = mkdtempSync(join(tmpdir(), template));
	const root = join(prefix, "lib", "node_modules");
	const scopeDir = join(root, "@openachieve");
	const packageDir = join(scopeDir, "agent");
	mkdirSync(packageDir, { recursive: true });
	tempDir = prefix;
	process.env.OPENACHIEVE_PACKAGE_DIR = packageDir;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { prefix, packageDir };
}

function createPnpmGlobalInstall(): { root: string; packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "openachieve-pnpm-"));
	const binDir = join(temp, "bin");
	const root = join(temp, "pnpm", "global", "5", "node_modules");
	const packageDir = join(root, "@openachieve", "agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), createFakePnpmScript(root));
	chmodSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), 0o755);
	tempDir = temp;
	process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
	process.env.OPENACHIEVE_PACKAGE_DIR = packageDir;
	setExecPath(
		join(root, ".pnpm", "@openachieve+agent@0.0.0", "node_modules", "@openachieve", "agent", "dist", "cli.js"),
	);
	return { root, packageDir };
}

function createYarnGlobalInstall(): { globalDir: string; packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "openachieve-yarn-"));
	const binDir = join(temp, "bin");
	const globalDir = join(temp, "yarn", "global");
	const packageDir = join(globalDir, "node_modules", "@openachieve", "agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, process.platform === "win32" ? "yarn.cmd" : "yarn"), createFakeYarnScript(globalDir));
	chmodSync(join(binDir, process.platform === "win32" ? "yarn.cmd" : "yarn"), 0o755);
	tempDir = temp;
	process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
	process.env.OPENACHIEVE_PACKAGE_DIR = packageDir;
	setExecPath(join(globalDir, ".yarn", "@openachieve", "agent", "dist", "cli.js"));
	return { globalDir, packageDir };
}

function createBunGlobalInstall(): { packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "openachieve-bun-"));
	const prefix = join(temp, ".bun");
	const bunBin = join(prefix, "bin");
	const root = join(prefix, "install", "global", "node_modules");
	const scopeDir = join(root, "@openachieve");
	const packageDir = join(scopeDir, "agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(bunBin, { recursive: true });
	writeFileSync(join(bunBin, process.platform === "win32" ? "bun.cmd" : "bun"), createFakeBunScript(bunBin));
	chmodSync(join(bunBin, process.platform === "win32" ? "bun.cmd" : "bun"), 0o755);
	tempDir = temp;
	process.env.PATH = `${bunBin}${delimiter}${originalPath ?? ""}`;
	process.env.OPENACHIEVE_PACKAGE_DIR = packageDir;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { packageDir };
}

function createFakePnpmScript(root: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="root" if "%2"=="-g" echo ${root}\r\n`;
	}
	const escapedRoot = root.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "root" ] && [ "$2" = "-g" ]; then\n\tprintf '%s\\n' '${escapedRoot}'\n\texit 0\nfi\nexit 1\n`;
}

function createFakeYarnScript(globalDir: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="global" if "%2"=="dir" echo ${globalDir}\r\n`;
	}
	const escapedGlobalDir = globalDir.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "global" ] && [ "$2" = "dir" ]; then\n\tprintf '%s\\n' '${escapedGlobalDir}'\n\texit 0\nfi\nexit 1\n`;
}

function createFakeBunScript(bunBin: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="pm" if "%2"=="bin" if "%3"=="-g" echo ${bunBin}\r\n`;
	}
	const escapedBunBin = bunBin.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "pm" ] && [ "$2" = "bin" ] && [ "$3" = "-g" ]; then\n\tprintf '%s\\n' '${escapedBunBin}'\n\texit 0\nfi\nexit 1\n`;
}

describe("detectInstallMethod", () => {
	test("uses Openachieve product identity", () => {
		expect(APP_NAME).toBe("oa");
		expect(APP_TITLE).toBe("Openachieve Agent");
		expect(CONFIG_DIR_NAME).toBe(".openachieve");
		expect(ENV_AGENT_DIR).toBe("OPENACHIEVE_CODING_AGENT_DIR");
		expect(ENV_SESSION_DIR).toBe("OPENACHIEVE_CODING_AGENT_SESSION_DIR");
	});

	test("does not provide a share viewer URL unless Openachieve configures one", () => {
		expect(getShareViewerUrl("abc123")).toBeUndefined();

		process.env.OPENACHIEVE_SHARE_VIEWER_URL = "https://agent.openachieve.example/session/";
		expect(getShareViewerUrl("abc123")).toBe("https://agent.openachieve.example/session/#abc123");
	});

	test("detects pnpm from Windows .pnpm install paths", () => {
		setExecPath(
			"C:\\Users\\Admin\\Documents\\pnpm-repository\\global\\5\\.pnpm\\@openachieve+agent@0.67.68\\node_modules\\@openachieve\\agent\\dist\\cli.js",
		);

		expect(detectInstallMethod()).toBe("pnpm");
		expect(getUpdateInstruction("@openachieve/agent")).toBe(
			"Run: pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 @openachieve/agent",
		);
	});

	test("does not self-update unknown wrapper installs", () => {
		setExecPath("/usr/local/bin/node");

		expect(detectInstallMethod()).toBe("unknown");
		expect(getSelfUpdateCommand("@openachieve/agent")).toBeUndefined();
		expect(getUpdateInstruction("@openachieve/agent")).toBe(
			"Update @openachieve/agent using the package manager, wrapper, or source checkout that provides this installation.",
		);
	});

	test("self-updates npm installs from custom prefixes", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@openachieve/agent");

		expect(detectInstallMethod()).toBe("npm");
		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "--ignore-scripts", "--min-release-age=0", "@openachieve/agent"],
			display: `npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @openachieve/agent`,
		});
	});

	test("self-updates renamed packages from the current install prefix", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@legacy/agent-core", undefined, "@new-scope/agent");

		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "--ignore-scripts", "--min-release-age=0", "@new-scope/agent"],
			display: `npm --prefix ${prefix} uninstall -g @legacy/agent-core && npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @new-scope/agent`,
			steps: [
				{
					command: "npm",
					args: ["--prefix", prefix, "uninstall", "-g", "@legacy/agent-core"],
					display: `npm --prefix ${prefix} uninstall -g @legacy/agent-core`,
				},
				{
					command: "npm",
					args: [
						"--prefix",
						prefix,
						"install",
						"-g",
						"--ignore-scripts",
						"--min-release-age=0",
						"@new-scope/agent",
					],
					display: `npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @new-scope/agent`,
				},
			],
		});
	});

	test("self-update respects configured npmCommand", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@openachieve/agent", ["npm", "--prefix", prefix]);

		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "--ignore-scripts", "--min-release-age=0", "@openachieve/agent"],
			display: `npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @openachieve/agent`,
		});
	});

	test("self-update treats empty npmCommand as unset", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@openachieve/agent", []);

		expect(command?.args).toEqual([
			"--prefix",
			prefix,
			"install",
			"-g",
			"--ignore-scripts",
			"--min-release-age=0",
			"@openachieve/agent",
		]);
	});

	test("quotes npm self-update display paths", () => {
		const { prefix } = createNpmPrefixInstall("openachieve prefix ");

		const command = getSelfUpdateCommand("@openachieve/agent");

		expect(command?.display).toBe(
			`npm --prefix "${prefix}" install -g --ignore-scripts --min-release-age=0 @openachieve/agent`,
		);
	});

	test("does not infer Windows npm custom prefixes from package paths", () => {
		const packageDir = "C:\\Users\\Admin\\npm prefix\\node_modules\\@openachieve\\agent";
		process.env.OPENACHIEVE_PACKAGE_DIR = packageDir;
		setExecPath(`${packageDir}\\dist\\cli.js`);

		expect(detectInstallMethod()).toBe("npm");
		expect(getUpdateInstruction("@openachieve/agent")).toBe(
			"Run: npm install -g --ignore-scripts --min-release-age=0 @openachieve/agent",
		);
	});

	test("self-updates bun global installs from bun pm bin", () => {
		createBunGlobalInstall();

		const command = getSelfUpdateCommand("@openachieve/agent");

		expect(detectInstallMethod()).toBe("bun");
		expect(command).toEqual({
			command: "bun",
			args: ["install", "-g", "--ignore-scripts", "--minimum-release-age=0", "@openachieve/agent"],
			display: "bun install -g --ignore-scripts --minimum-release-age=0 @openachieve/agent",
		});
	});

	test("self-updates renamed pnpm global installs by removing the old package first", () => {
		createPnpmGlobalInstall();

		const command = getSelfUpdateCommand("@legacy/agent-core", undefined, "@new-scope/agent");

		expect(detectInstallMethod()).toBe("pnpm");
		expect(command).toEqual({
			command: "pnpm",
			args: ["install", "-g", "--ignore-scripts", "--config.minimumReleaseAge=0", "@new-scope/agent"],
			display:
				"pnpm remove -g @legacy/agent-core && pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 @new-scope/agent",
			steps: [
				{
					command: "pnpm",
					args: ["remove", "-g", "@legacy/agent-core"],
					display: "pnpm remove -g @legacy/agent-core",
				},
				{
					command: "pnpm",
					args: ["install", "-g", "--ignore-scripts", "--config.minimumReleaseAge=0", "@new-scope/agent"],
					display: "pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 @new-scope/agent",
				},
			],
		});
	});

	test("self-updates pnpm v11 global installs resolved through the store", () => {
		const temp = mkdtempSync(join(tmpdir(), "openachieve-pnpm11-"));
		const binDir = join(temp, "bin");
		const root = join(temp, "Library", "pnpm", "global", "v11");
		const packageName = "@openachieve/agent";
		const globalPackageDir = join(root, "11e9a", "node_modules", "@openachieve", "agent");
		const storePackageDir = join(
			temp,
			"Library",
			"pnpm",
			"store",
			"v11",
			"links",
			"@openachieve",
			"agent",
			"0.75.0",
			"hash",
			"node_modules",
			"@openachieve",
			"agent",
		);
		mkdirSync(globalPackageDir, { recursive: true });
		mkdirSync(storePackageDir, { recursive: true });
		mkdirSync(binDir, { recursive: true });
		writeFileSync(join(globalPackageDir, "package.json"), "{}");
		writeFileSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), createFakePnpmScript(root));
		chmodSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), 0o755);
		tempDir = temp;
		process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
		process.env.OPENACHIEVE_PACKAGE_DIR = storePackageDir;
		process.argv[1] = join(globalPackageDir, "dist", "cli.js");
		setExecPath(join(storePackageDir, "dist", "cli.js"));

		const command = getSelfUpdateCommand(packageName);

		expect(detectInstallMethod()).toBe("pnpm");
		expect(command).toEqual({
			command: "pnpm",
			args: ["install", "-g", "--ignore-scripts", "--config.minimumReleaseAge=0", packageName],
			display: `pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 ${packageName}`,
		});
	});

	test("self-updates renamed yarn global installs by removing the old package first", () => {
		createYarnGlobalInstall();

		const command = getSelfUpdateCommand("@legacy/agent-core", undefined, "@new-scope/agent");

		expect(detectInstallMethod()).toBe("yarn");
		expect(command).toEqual({
			command: "yarn",
			args: ["global", "add", "--ignore-scripts", "@new-scope/agent"],
			display: "yarn global remove @legacy/agent-core && yarn global add --ignore-scripts @new-scope/agent",
			steps: [
				{
					command: "yarn",
					args: ["global", "remove", "@legacy/agent-core"],
					display: "yarn global remove @legacy/agent-core",
				},
				{
					command: "yarn",
					args: ["global", "add", "--ignore-scripts", "@new-scope/agent"],
					display: "yarn global add --ignore-scripts @new-scope/agent",
				},
			],
		});
	});

	test("self-updates renamed bun global installs by removing the old package first", () => {
		createBunGlobalInstall();

		const command = getSelfUpdateCommand("@legacy/agent-core", undefined, "@new-scope/agent");

		expect(detectInstallMethod()).toBe("bun");
		expect(command).toEqual({
			command: "bun",
			args: ["install", "-g", "--ignore-scripts", "--minimum-release-age=0", "@new-scope/agent"],
			display:
				"bun uninstall -g @legacy/agent-core && bun install -g --ignore-scripts --minimum-release-age=0 @new-scope/agent",
			steps: [
				{
					command: "bun",
					args: ["uninstall", "-g", "@legacy/agent-core"],
					display: "bun uninstall -g @legacy/agent-core",
				},
				{
					command: "bun",
					args: ["install", "-g", "--ignore-scripts", "--minimum-release-age=0", "@new-scope/agent"],
					display: "bun install -g --ignore-scripts --minimum-release-age=0 @new-scope/agent",
				},
			],
		});
	});

	test("does not self-update when npm install path is not writable", () => {
		const { packageDir } = createNpmPrefixInstall();
		chmodSync(packageDir, 0o500);

		expect(getSelfUpdateCommand("@openachieve/agent")).toBeUndefined();
		expect(getSelfUpdateUnavailableInstruction("@openachieve/agent")).toContain("the install path is not writable");
	});
});
