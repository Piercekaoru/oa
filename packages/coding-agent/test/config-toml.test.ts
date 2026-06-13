import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { loadConfigToml } from "../src/core/config-toml.ts";
import { clearApiKeyCache, ModelRegistry } from "../src/core/model-registry.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("config.toml", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `openachieve-test-config-toml-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		clearApiKeyCache();
	});

	function writeConfigToml(content: string): string {
		const path = join(tempDir, "config.toml");
		writeFileSync(path, content);
		return path;
	}

	describe("loadConfigToml", () => {
		test("returns empty result when the file does not exist", () => {
			const result = loadConfigToml(join(tempDir, "config.toml"));
			expect(result).toEqual({});
		});

		test("passes the [settings] table through as a partial Settings overlay", () => {
			const path = writeConfigToml(`[settings]
defaultModel = "my-relay/gpt-4o"
defaultThinkingLevel = "medium"
theme = "dark"
`);
			const result = loadConfigToml(path);
			expect(result.error).toBeUndefined();
			expect(result.settings).toEqual({
				defaultModel: "my-relay/gpt-4o",
				defaultThinkingLevel: "medium",
				theme: "dark",
			});
		});

		test("expands the string-array models shorthand into { id } objects", () => {
			const path = writeConfigToml(`[providers.my-relay]
baseUrl = "https://api.relay.test/v1"
api = "openai-completions"
apiKey = "sk-test"
models = ["gpt-4o", "deepseek-chat"]
`);
			const result = loadConfigToml(path);
			expect(result.error).toBeUndefined();
			const provider = result.providers?.["my-relay"] as Record<string, unknown>;
			expect(provider.models).toEqual([{ id: "gpt-4o" }, { id: "deepseek-chat" }]);
		});

		test("preserves full table model definitions", () => {
			const path = writeConfigToml(`[providers.my-relay]
baseUrl = "https://api.relay.test/v1"
api = "anthropic-messages"
apiKey = "sk-test"

[[providers.my-relay.models]]
id = "claude-sonnet"
reasoning = true
contextWindow = 200000
`);
			const result = loadConfigToml(path);
			expect(result.error).toBeUndefined();
			const provider = result.providers?.["my-relay"] as Record<string, unknown>;
			expect(provider.models).toEqual([{ id: "claude-sonnet", reasoning: true, contextWindow: 200000 }]);
		});

		test("normalizes mixed string + table model entries element-wise", () => {
			const path = writeConfigToml(`[providers.p]
baseUrl = "https://api.relay.test/v1"
api = "openai-completions"
apiKey = "sk-test"
models = ["gpt-4o", { id = "manual", reasoning = true }]
`);
			const result = loadConfigToml(path);
			expect(result.error).toBeUndefined();
			const provider = result.providers?.["p"] as Record<string, unknown>;
			expect(provider.models).toEqual([{ id: "gpt-4o" }, { id: "manual", reasoning: true }]);
		});

		test("returns an error (does not throw) on invalid TOML", () => {
			const path = writeConfigToml("[settings\nbroken = ");
			const result = loadConfigToml(path);
			expect(result.error).toBeDefined();
			expect(result.error).toContain("config.toml");
			expect(result.settings).toBeUndefined();
			expect(result.providers).toBeUndefined();
		});

		test("rejects a non-table [settings] value", () => {
			const path = writeConfigToml(`settings = "oops"`);
			const result = loadConfigToml(path);
			expect(result.error).toContain("[settings] must be a table");
		});

		test("rejects a non-table [providers] value", () => {
			const path = writeConfigToml(`providers = "oops"`);
			const result = loadConfigToml(path);
			expect(result.error).toContain("[providers] must be a table");
		});
	});

	describe("ModelRegistry integration", () => {
		let authStorage: AuthStorage;
		let modelsJsonPath: string;

		beforeEach(() => {
			authStorage = AuthStorage.create(join(tempDir, "auth.json"));
			modelsJsonPath = join(tempDir, "models.json");
		});

		test("loads providers/models from config.toml when no models.json exists", () => {
			writeConfigToml(`[providers.my-relay]
baseUrl = "https://api.relay.test/v1"
api = "openai-completions"
apiKey = "sk-test"
models = ["gpt-4o"]
`);
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			expect(registry.getError()).toBeUndefined();

			const model = registry.find("my-relay", "gpt-4o");
			expect(model).toBeDefined();
			expect(model!.baseUrl).toBe("https://api.relay.test/v1");
			expect(model!.api).toBe("openai-completions");
			// Smart defaults from parseModels
			expect(model!.name).toBe("gpt-4o");
			expect(model!.reasoning).toBe(false);
			expect(model!.contextWindow).toBe(128000);
			expect(model!.maxTokens).toBe(16384);
			expect(model!.input).toEqual(["text"]);
		});

		test("applies full-table fields from config.toml", () => {
			writeConfigToml(`[providers.my-relay]
baseUrl = "https://api.relay.test/v1"
api = "openai-completions"
apiKey = "sk-test"

[[providers.my-relay.models]]
id = "big"
reasoning = true
contextWindow = 200000
`);
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const model = registry.find("my-relay", "big");
			expect(model).toBeDefined();
			expect(model!.reasoning).toBe(true);
			expect(model!.contextWindow).toBe(200000);
		});

		test("resolves a literal apiKey for a config.toml provider", async () => {
			writeConfigToml(`[providers.my-relay]
baseUrl = "https://api.relay.test/v1"
api = "openai-completions"
apiKey = "sk-literal"
models = ["gpt-4o"]
`);
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const model = registry.find("my-relay", "gpt-4o");
			const auth = await registry.getApiKeyAndHeaders(model!);
			expect(auth).toEqual({ ok: true, apiKey: "sk-literal", headers: undefined });
		});

		test("resolves a $ENV apiKey reference for a config.toml provider", async () => {
			process.env.TEST_RELAY_KEY = "env-secret";
			try {
				writeConfigToml(`[providers.my-relay]
baseUrl = "https://api.relay.test/v1"
api = "openai-completions"
apiKey = "$TEST_RELAY_KEY"
models = ["gpt-4o"]
`);
				const registry = ModelRegistry.create(authStorage, modelsJsonPath);
				const model = registry.find("my-relay", "gpt-4o");
				const auth = await registry.getApiKeyAndHeaders(model!);
				expect(auth.ok).toBe(true);
				if (auth.ok) {
					expect(auth.apiKey).toBe("env-secret");
				}
			} finally {
				delete process.env.TEST_RELAY_KEY;
			}
		});

		test("merges providers from models.json and config.toml", () => {
			writeFileSync(
				modelsJsonPath,
				JSON.stringify({
					providers: {
						"json-relay": {
							baseUrl: "https://json.test/v1",
							api: "openai-completions",
							apiKey: "json-key",
							models: [{ id: "json-model" }],
						},
					},
				}),
			);
			writeConfigToml(`[providers.toml-relay]
baseUrl = "https://toml.test/v1"
api = "openai-completions"
apiKey = "toml-key"
models = ["toml-model"]
`);
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			expect(registry.getError()).toBeUndefined();
			expect(registry.find("json-relay", "json-model")).toBeDefined();
			expect(registry.find("toml-relay", "toml-model")).toBeDefined();
		});

		test("config.toml wins over models.json on a provider name conflict", () => {
			writeFileSync(
				modelsJsonPath,
				JSON.stringify({
					providers: {
						shared: {
							baseUrl: "https://json.test/v1",
							api: "openai-completions",
							apiKey: "json-key",
							models: [{ id: "json-only" }],
						},
					},
				}),
			);
			writeConfigToml(`[providers.shared]
baseUrl = "https://toml.test/v1"
api = "openai-completions"
apiKey = "toml-key"
models = ["toml-only"]
`);
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const model = registry.find("shared", "toml-only");
			expect(model).toBeDefined();
			expect(model!.baseUrl).toBe("https://toml.test/v1");
			// The models.json definition for the same provider is fully replaced.
			expect(registry.find("shared", "json-only")).toBeUndefined();
		});

		test("surfaces an error but keeps built-in models when config.toml is invalid", () => {
			writeConfigToml("[providers.broken\n");
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			expect(registry.getError()).toBeDefined();
			expect(registry.getAll().length).toBeGreaterThan(0);
		});
	});

	describe("SettingsManager integration", () => {
		let agentDir: string;
		let projectDir: string;

		beforeEach(() => {
			agentDir = join(tempDir, "agent");
			projectDir = join(tempDir, "project");
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(join(projectDir, ".openachieve"), { recursive: true });
		});

		function writeAgentConfigToml(content: string): void {
			writeFileSync(join(agentDir, "config.toml"), content);
		}

		test("config.toml [settings] overrides global settings.json", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "light", defaultModel: "from-json" }));
			writeAgentConfigToml(`[settings]
theme = "dark"
`);
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getTheme()).toBe("dark");
			// Untouched keys still come from settings.json
			expect(manager.getDefaultModel()).toBe("from-json");
		});

		test("project settings.json wins over config.toml [settings]", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "light" }));
			writeAgentConfigToml(`[settings]
theme = "dark"
`);
			writeFileSync(join(projectDir, ".openachieve", "settings.json"), JSON.stringify({ theme: "green" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getTheme()).toBe("green");
		});

		test("does not persist config.toml values into settings.json on save", async () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultModel: "from-json" }));
			writeAgentConfigToml(`[settings]
theme = "dark"
`);
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getTheme()).toBe("dark");

			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(saved.defaultThinkingLevel).toBe("high");
			expect(saved.defaultModel).toBe("from-json");
			// The config.toml-only value must never leak into settings.json
			expect(saved.theme).toBeUndefined();
		});

		test("surfaces a config.toml parse error via drainErrors", () => {
			writeAgentConfigToml("[settings\n");
			const manager = SettingsManager.create(projectDir, agentDir);
			const errors = manager.drainErrors();
			expect(errors.some((e) => e.error.message.includes("config.toml"))).toBe(true);
		});
	});
});
