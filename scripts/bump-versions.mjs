#!/usr/bin/env node

/**
 * Bumps all core workspace packages (packages/*) to the next version and
 * rewrites inter-package dependency ranges in lockstep.
 *
 * This deliberately does NOT use `npm version -ws`: in workspace mode that
 * command reifies the workspace immediately after writing the new version,
 * which resolves the *pre-bump* inter-package ranges (e.g. `^0.78.1`). On a
 * minor/major bump the freshly written local packages (e.g. 0.79.0) no longer
 * satisfy that range, so npm falls back to a registry lookup that fails under
 * `min-release-age` (ETARGET). By rewriting versions and ranges with plain
 * file edits first, the subsequent `npm install --package-lock-only` resolves
 * every inter-package dependency against the local workspace — no network.
 *
 * Usage: node scripts/bump-versions.mjs <patch|minor|major>
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const bump = process.argv[2];
if (!["patch", "minor", "major"].includes(bump)) {
	console.error("Usage: node scripts/bump-versions.mjs <patch|minor|major>");
	process.exit(1);
}

const packagesDir = join(process.cwd(), "packages");
const core = [];
for (const dirent of readdirSync(packagesDir, { withFileTypes: true })) {
	if (!dirent.isDirectory()) {
		continue;
	}
	const path = join(packagesDir, dirent.name, "package.json");
	try {
		core.push({ path, pkg: JSON.parse(readFileSync(path, "utf8")) });
	} catch {
		// Not a package directory; skip.
	}
}

if (core.length === 0) {
	console.error("❌ No core packages found under packages/.");
	process.exit(1);
}

// Require lockstep before bumping.
const currentVersions = new Set(core.map((c) => c.pkg.version));
if (currentVersions.size !== 1) {
	console.error(`❌ Core packages are not in lockstep: ${[...currentVersions].join(", ")}`);
	process.exit(1);
}

const current = [...currentVersions][0];
const match = current.match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!match) {
	console.error(`❌ Unexpected version format: ${current} (expected x.y.z)`);
	process.exit(1);
}

let [major, minor, patch] = match.slice(1).map(Number);
if (bump === "major") {
	major += 1;
	minor = 0;
	patch = 0;
} else if (bump === "minor") {
	minor += 1;
	patch = 0;
} else {
	patch += 1;
}
const next = `${major}.${minor}.${patch}`;

const coreNames = new Set(core.map((c) => c.pkg.name));
const depFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

let depUpdates = 0;
for (const { path, pkg } of core) {
	pkg.version = next;
	for (const field of depFields) {
		if (!pkg[field]) {
			continue;
		}
		for (const depName of Object.keys(pkg[field])) {
			if (coreNames.has(depName)) {
				const range = `^${next}`;
				if (pkg[field][depName] !== range) {
					pkg[field][depName] = range;
					depUpdates += 1;
				}
			}
		}
	}
	writeFileSync(path, JSON.stringify(pkg, null, "\t") + "\n");
}

console.log(`Bumped ${core.length} core package(s): ${current} → ${next}`);
console.log(`Rewrote ${depUpdates} inter-package dependency range(s) to ^${next}`);
