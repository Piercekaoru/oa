#!/usr/bin/env node
/**
 * Quick release script - skips npm run check
 * Usage: node scripts/release-quick.mjs patch
 */

import { execSync } from "child_process";
import { readFileSync } from "fs";

const RELEASE_TARGET = process.argv[2] || "patch";

function run(cmd) {
	console.log(`$ ${cmd}`);
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: "inherit" });
	} catch (e) {
		console.error(`Command failed: ${cmd}`);
		process.exit(1);
	}
}

function getVersion() {
	const pkg = JSON.parse(readFileSync("packages/ai/package.json", "utf-8"));
	return pkg.version;
}

console.log("=== Quick Release (skip check) ===\n");

// 1. Check clean
console.log("Checking for uncommitted changes...");
const status = execSync("git status --porcelain", { encoding: "utf-8" });
if (status.trim()) {
	console.error("Error: Uncommitted changes detected. Commit or stash first.");
	process.exit(1);
}

// 2. Bump version
console.log("\nBumping version...");
run(`npm run version:${RELEASE_TARGET}`);

const newVersion = getVersion();
console.log(`\nNew version: ${newVersion}`);

// 3. Update CHANGELOG
console.log("\nUpdating CHANGELOG...");
run("node scripts/update-changelog.mjs");

// 4. Regenerate artifacts
console.log("\nRegenerating artifacts...");
run("npm run shrinkwrap:coding-agent");

// 5. Build (no full check)
console.log("\nBuilding packages...");
run("npm run build");

// 6. Commit and tag
console.log("\nCommitting and tagging...");
const changedFiles = execSync("git ls-files -m -o -d --exclude-standard", { encoding: "utf-8" })
	.split("\n")
	.filter(Boolean);
if (changedFiles.length > 0) {
	run(`git add ${changedFiles.map((f) => `"${f}"`).join(" ")}`);
}
run(`git commit -m "Release v${newVersion}"`);
run(`git tag v${newVersion}`);

// 7. Add [Unreleased] section
console.log("\nAdding [Unreleased] section...");
run("node scripts/add-unreleased-section.mjs");

const changedFiles2 = execSync("git ls-files -m", { encoding: "utf-8" }).split("\n").filter(Boolean);
if (changedFiles2.length > 0) {
	run(`git add ${changedFiles2.map((f) => `"${f}"`).join(" ")}`);
	run(`git commit -m "Add [Unreleased] section for next cycle"`);
}

console.log(`\n✅ Release v${newVersion} ready!`);
console.log("\nNext steps:");
console.log(`  npm run publish        # Publish to npm`);
console.log(`  git push oa main && git push oa v${newVersion}`);
