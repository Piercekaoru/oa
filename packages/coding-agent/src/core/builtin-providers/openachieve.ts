/**
 * Built-in OpenAchieve provider: OAuth 2.0 device login + an OpenAI-compatible
 * metered proxy. Registered unconditionally at startup so a normally-installed
 * `oa` shows "OpenAchieve" in /login without loading an extension.
 *
 * Override the backend with OPENACHIEVE_BASE_URL (e.g. http://localhost:8080).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@openachieve/ai";
import { getAgentDir } from "../../config.ts";
import type { ProviderConfig } from "../extensions/types.ts";

const BASE = (process.env.OPENACHIEVE_BASE_URL ?? "https://openachieve.asia").replace(/\/+$/, "");

// The set of models is decided server-side per subscription tier. We cache the
// ids fetched at login/refresh here, and `modifyModels` rebuilds the provider's
// model list from this cache so new server-side models appear without a CLI
// release. Falls back to the static `models` list below when absent.
const MODELS_CACHE = join(getAgentDir(), "openachieve-models.json");

// Credits are metered server-side, so per-token cost is reported as 0 to keep
// dollar figures out of the CLI.
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Login cancelled"));
			return;
		}
		let timer: ReturnType<typeof setTimeout>;
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Login cancelled"));
		};
		timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

type DeviceCodeResponse = {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete?: string;
	interval?: number;
	expires_in?: number;
};

type TokenResponse = {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	error?: string;
};

// Throttle + concurrency guard so the background refresh (fired on every model
// load) doesn't hammer the backend: at most one in-flight fetch, and at most
// one successful fetch per minute.
let lastFetchAt = 0;
let fetching = false;
const REFRESH_INTERVAL_MS = 60_000;

/** Fetch the account's allowed models and cache their ids. Best-effort: any
 * network/non-2xx failure leaves the previous cache (or static fallback)
 * untouched. A 200 always writes the cache — even an empty list — so a plan
 * with no models is recorded as such rather than mistaken for "never fetched". */
async function fetchAndCacheModels(accessToken: string): Promise<void> {
	if (fetching || Date.now() - lastFetchAt < REFRESH_INTERVAL_MS) return;
	fetching = true;
	try {
		const res = await fetch(`${BASE}/api/v1/models`, {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		if (!res.ok) return;
		const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
		const ids = (body.data ?? [])
			.map((m) => m.id)
			.filter((id): id is string => typeof id === "string" && id.length > 0);
		mkdirSync(dirname(MODELS_CACHE), { recursive: true });
		writeFileSync(MODELS_CACHE, JSON.stringify({ ids }), "utf8");
		lastFetchAt = Date.now();
	} catch {
		// best-effort; keep existing cache / static fallback on any failure
	} finally {
		fetching = false;
	}
}

/** Cached model ids, or null when the cache is absent/unreadable (i.e. we have
 * never successfully fetched). An empty array means the server returned none. */
function readCachedModelIds(): string[] | null {
	try {
		const parsed = JSON.parse(readFileSync(MODELS_CACHE, "utf8")) as { ids?: unknown };
		if (!Array.isArray(parsed.ids)) return null;
		return parsed.ids.filter((id): id is string => typeof id === "string" && id.length > 0);
	} catch {
		return null;
	}
}

/** Display name for a branded model id, e.g. "openachieve/gpt-4.1" -> "gpt-4.1". */
function prettifyModelId(id: string): string {
	return id.replace(/^openachieve\//, "");
}

async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const codeRes = await fetch(`${BASE}/api/auth/device/code`, { method: "POST" });
	if (!codeRes.ok) {
		throw new Error(`Device code request failed: ${codeRes.status}`);
	}
	const info = (await codeRes.json()) as DeviceCodeResponse;

	callbacks.onDeviceCode({
		userCode: info.user_code,
		verificationUri: info.verification_uri_complete ?? info.verification_uri,
		intervalSeconds: info.interval,
		expiresInSeconds: info.expires_in,
	});

	const intervalMs = Math.max(1000, (info.interval ?? 5) * 1000);
	const deadline = Date.now() + (info.expires_in ?? 900) * 1000;

	while (Date.now() < deadline) {
		if (callbacks.signal?.aborted) {
			throw new Error("Login cancelled");
		}
		await sleep(intervalMs, callbacks.signal);

		const tokenRes = await fetch(`${BASE}/api/auth/token`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ grant_type: "device_code", device_code: info.device_code }),
		});
		const tok = (await tokenRes.json()) as TokenResponse;

		if (tokenRes.ok && tok.access_token) {
			await fetchAndCacheModels(tok.access_token);
			return {
				access: tok.access_token,
				refresh: tok.refresh_token ?? "",
				expires: Date.now() + (tok.expires_in ?? 0) * 1000 - 60_000,
			};
		}
		if (tok.error && tok.error !== "authorization_pending" && tok.error !== "slow_down") {
			throw new Error(`Login failed: ${tok.error}`);
		}
	}

	throw new Error("Device authorization timed out");
}

async function refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const res = await fetch(`${BASE}/api/auth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ grant_type: "refresh_token", refresh_token: credentials.refresh }),
	});
	if (!res.ok) {
		throw new Error(`Token refresh failed: ${res.status}`);
	}
	const tok = (await res.json()) as TokenResponse;
	if (!tok.access_token) {
		throw new Error("Token refresh returned no access token");
	}
	await fetchAndCacheModels(tok.access_token);
	return {
		access: tok.access_token,
		refresh: tok.refresh_token ?? credentials.refresh,
		expires: Date.now() + (tok.expires_in ?? 0) * 1000 - 60_000,
	};
}

export const OPENACHIEVE_PROVIDER_CONFIG: ProviderConfig = {
	name: "OpenAchieve",
	baseUrl: `${BASE}/api/v1`,
	api: "openai-completions",
	authHeader: true,
	models: [
		{
			id: "openachieve/grok-build-0.1",
			name: "Grok Build 0.1",
			reasoning: false,
			input: ["text", "image"],
			cost: ZERO_COST,
			contextWindow: 256000,
			maxTokens: 32768,
		},
		{
			id: "openachieve/grok-composer-2.5-fast",
			name: "Grok Composer 2.5 Fast",
			reasoning: false,
			input: ["text", "image"],
			cost: ZERO_COST,
			contextWindow: 256000,
			maxTokens: 32768,
		},
	],
	oauth: {
		name: "OpenAchieve",
		login,
		refreshToken,
		getApiKey: (credentials) => credentials.access,
		// Replace the static list with the server-decided set. Fire a throttled
		// background refresh (using the live token) so already-logged-in users
		// pick up the latest list without re-logging in; the next model load
		// reads the freshly written cache.
		modifyModels(models, credentials) {
			void fetchAndCacheModels(credentials.access);
			const cached = readCachedModelIds();
			if (cached === null) return models; // never fetched -> keep static fallback
			const others = models.filter((m) => m.provider !== "openachieve");
			if (cached.length === 0) return others; // server says none -> show no OpenAchieve models
			const template = models.find((m) => m.provider === "openachieve");
			if (!template) return models;
			const rebuilt = cached.map((id) => ({ ...template, id, name: prettifyModelId(id) }));
			return [...others, ...rebuilt];
		},
	},
};
