/**
 * Built-in OpenAchieve provider: OAuth 2.0 device login + an OpenAI-compatible
 * metered proxy. Registered unconditionally at startup so a normally-installed
 * `oa` shows "OpenAchieve" in /login without loading an extension.
 *
 * Override the backend with OPENACHIEVE_BASE_URL (e.g. http://localhost:8080).
 */

import type { OAuthCredentials, OAuthLoginCallbacks } from "@openachieve/ai";
import type { ProviderConfig } from "../extensions/types.ts";

const BASE = (process.env.OPENACHIEVE_BASE_URL ?? "https://openachieve.asia").replace(/\/+$/, "");

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
	},
};
