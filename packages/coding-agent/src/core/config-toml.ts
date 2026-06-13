/**
 * Loader for config.toml — a hand-friendly TOML config that layers on top of
 * settings.json and models.json:
 *   - `[settings]`      → partial Settings overlay (merged by SettingsManager)
 *   - `[providers.*]`   → provider/model definitions (merged by ModelRegistry)
 *
 * config.toml is read-only; the agent never writes back to it. Parsing or shape
 * errors are returned (not thrown) so built-in config is preserved.
 */

import { existsSync, readFileSync } from "fs";
import { parse as parseToml } from "smol-toml";
import type { Settings } from "./settings-manager.ts";

export interface ConfigTomlResult {
	/** `[settings]` table as a partial Settings overlay (undefined if absent). */
	settings?: Partial<Settings>;
	/** `[providers.*]` tables with the `models` shorthand normalized (undefined if absent). */
	providers?: Record<string, unknown>;
	/** Parse/shape error message, if any. */
	error?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Expand each provider's `models` shorthand: a string element (model id) becomes
 * `{ id }`; full tables are preserved as-is. Non-table provider entries are passed
 * through so downstream schema validation can produce a friendly error.
 */
function normalizeProviders(providers: Record<string, unknown>): Record<string, unknown> {
	const normalized: Record<string, unknown> = {};
	for (const [name, config] of Object.entries(providers)) {
		if (!isPlainObject(config)) {
			normalized[name] = config;
			continue;
		}
		const providerConfig = { ...config };
		if (Array.isArray(providerConfig.models)) {
			providerConfig.models = providerConfig.models.map((model) =>
				typeof model === "string" ? { id: model } : model,
			);
		}
		normalized[name] = providerConfig;
	}
	return normalized;
}

export function loadConfigToml(path: string): ConfigTomlResult {
	if (!existsSync(path)) {
		return {};
	}

	let parsed: unknown;
	try {
		parsed = parseToml(readFileSync(path, "utf-8"));
	} catch (error) {
		return {
			error: `Failed to parse config.toml: ${error instanceof Error ? error.message : String(error)}\n\nFile: ${path}`,
		};
	}

	if (!isPlainObject(parsed)) {
		return { error: `Invalid config.toml: expected a top-level table.\n\nFile: ${path}` };
	}

	const result: ConfigTomlResult = {};

	if (parsed.settings !== undefined) {
		if (!isPlainObject(parsed.settings)) {
			return { error: `Invalid config.toml: [settings] must be a table.\n\nFile: ${path}` };
		}
		result.settings = parsed.settings as Partial<Settings>;
	}

	if (parsed.providers !== undefined) {
		if (!isPlainObject(parsed.providers)) {
			return { error: `Invalid config.toml: [providers] must be a table.\n\nFile: ${path}` };
		}
		result.providers = normalizeProviders(parsed.providers);
	}

	return result;
}
