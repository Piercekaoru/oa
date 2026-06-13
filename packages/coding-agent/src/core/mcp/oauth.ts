import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
	OAuthClientInformation,
	OAuthClientInformationFull,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { getAgentDir, VERSION } from "../../config.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { errorMessage } from "./connection.ts";
import type { McpManager } from "./manager.ts";

const AUTH_STORE_VERSION = 1;
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

interface StoredServerAuth {
	tokens?: OAuthTokens;
	clientInformation?: OAuthClientInformationFull;
	codeVerifier?: string;
}

interface AuthStore {
	version: number;
	servers: Record<string, StoredServerAuth>;
}

function getAuthStorePath(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "mcp-auth.json");
}

function loadAuthStore(agentDir?: string): AuthStore {
	try {
		const parsed = JSON.parse(fs.readFileSync(getAuthStorePath(agentDir), "utf-8")) as AuthStore;
		if (parsed && typeof parsed === "object" && parsed.version === AUTH_STORE_VERSION && parsed.servers) {
			return parsed;
		}
	} catch {
		// Missing or malformed store: start fresh.
	}
	return { version: AUTH_STORE_VERSION, servers: {} };
}

function saveAuthStore(store: AuthStore, agentDir?: string): void {
	const storePath = getAuthStorePath(agentDir);
	fs.mkdirSync(path.dirname(storePath), { recursive: true });
	fs.writeFileSync(storePath, JSON.stringify(store, null, "\t"), { mode: 0o600 });
	try {
		fs.chmodSync(storePath, 0o600);
	} catch {
		// chmod is best-effort (e.g. some filesystems).
	}
}

function updateServerAuth(serverName: string, update: (auth: StoredServerAuth) => void, agentDir?: string): void {
	const store = loadAuthStore(agentDir);
	const auth = store.servers[serverName] ?? {};
	update(auth);
	store.servers[serverName] = auth;
	saveAuthStore(store, agentDir);
}

export function clearServerAuth(serverName: string, agentDir?: string): void {
	const store = loadAuthStore(agentDir);
	if (store.servers[serverName]) {
		delete store.servers[serverName];
		saveAuthStore(store, agentDir);
	}
}

/**
 * OAuthClientProvider backed by <agentDir>/mcp-auth.json.
 *
 * In normal (non-interactive) connects the provider serves stored tokens and
 * lets the SDK refresh them. The browser-based authorization flow only runs
 * through authorizeServer(); outside of it redirectToAuthorization fails with
 * an actionable message instead of surprise-opening a browser.
 */
export class McpOAuthProvider implements OAuthClientProvider {
	private readonly serverName: string;
	private interactiveRedirectUrl: string | undefined;
	private pendingState: string | undefined;
	onAuthorizationUrl: ((url: URL) => void) | undefined;

	constructor(serverName: string) {
		this.serverName = serverName;
	}

	/** Called by authorizeServer once the local callback server is listening. */
	beginInteractive(redirectUrl: string): void {
		this.interactiveRedirectUrl = redirectUrl;
		this.pendingState = randomBytes(16).toString("hex");
	}

	endInteractive(): void {
		this.interactiveRedirectUrl = undefined;
		this.pendingState = undefined;
	}

	get expectedState(): string | undefined {
		return this.pendingState;
	}

	get redirectUrl(): string {
		return this.interactiveRedirectUrl ?? "http://127.0.0.1/unavailable";
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: "Openachieve Agent",
			client_uri: "https://github.com/openachieve/openachieve-agent",
			redirect_uris: [this.redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	}

	state(): string {
		return this.pendingState ?? randomBytes(16).toString("hex");
	}

	clientInformation(): OAuthClientInformation | undefined {
		return loadAuthStore().servers[this.serverName]?.clientInformation;
	}

	saveClientInformation(clientInformation: OAuthClientInformationFull): void {
		updateServerAuth(this.serverName, (auth) => {
			auth.clientInformation = clientInformation;
		});
	}

	tokens(): OAuthTokens | undefined {
		return loadAuthStore().servers[this.serverName]?.tokens;
	}

	saveTokens(tokens: OAuthTokens): void {
		updateServerAuth(this.serverName, (auth) => {
			auth.tokens = tokens;
		});
	}

	redirectToAuthorization(authorizationUrl: URL): void {
		if (!this.interactiveRedirectUrl) {
			throw new UnauthorizedError(
				`MCP server "${this.serverName}" requires authorization. Run /mcp auth ${this.serverName}`,
			);
		}
		this.onAuthorizationUrl?.(authorizationUrl);
		openBrowser(authorizationUrl.toString());
	}

	saveCodeVerifier(codeVerifier: string): void {
		updateServerAuth(this.serverName, (auth) => {
			auth.codeVerifier = codeVerifier;
		});
	}

	codeVerifier(): string {
		const verifier = loadAuthStore().servers[this.serverName]?.codeVerifier;
		if (!verifier) throw new Error(`No code verifier stored for MCP server "${this.serverName}"`);
		return verifier;
	}

	invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier"): void {
		if (scope === "all") {
			clearServerAuth(this.serverName);
			return;
		}
		updateServerAuth(this.serverName, (auth) => {
			if (scope === "client") auth.clientInformation = undefined;
			if (scope === "tokens") auth.tokens = undefined;
			if (scope === "verifier") auth.codeVerifier = undefined;
		});
	}
}

interface CallbackServer {
	redirectUrl: string;
	waitForCode: Promise<{ code: string; state: string | undefined }>;
	close: () => void;
}

function startCallbackServer(): Promise<CallbackServer> {
	return new Promise((resolveServer, rejectServer) => {
		let settled = false;
		let resolveCode: (value: { code: string; state: string | undefined }) => void;
		let rejectCode: (reason: Error) => void;
		const waitForCode = new Promise<{ code: string; state: string | undefined }>((resolve, reject) => {
			resolveCode = resolve;
			rejectCode = reject;
		});

		const server = http.createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			if (url.pathname !== "/callback") {
				res.writeHead(404).end();
				return;
			}
			const error = url.searchParams.get("error");
			if (error) {
				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(
					`<html><body><h3>Authorization failed: ${escapeHtml(error)}</h3>You can close this tab.</body></html>`,
				);
				if (!settled) {
					settled = true;
					rejectCode(
						new Error(
							`Authorization failed: ${error}${url.searchParams.get("error_description") ? ` (${url.searchParams.get("error_description")})` : ""}`,
						),
					);
				}
				return;
			}
			const code = url.searchParams.get("code");
			if (!code) {
				res.writeHead(400).end("Missing code");
				return;
			}
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(
				"<html><body><h3>Authorization complete.</h3>You can close this tab and return to the terminal.</body></html>",
			);
			if (!settled) {
				settled = true;
				resolveCode({ code, state: url.searchParams.get("state") ?? undefined });
			}
		});

		const timeout = setTimeout(() => {
			if (!settled) {
				settled = true;
				rejectCode(new Error("Timed out waiting for authorization (5 minutes)"));
			}
			server.close();
		}, CALLBACK_TIMEOUT_MS);
		timeout.unref?.();

		server.on("error", (error) => rejectServer(error));
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				rejectServer(new Error("Failed to bind OAuth callback server"));
				server.close();
				return;
			}
			resolveServer({
				redirectUrl: `http://127.0.0.1:${address.port}/callback`,
				waitForCode,
				close: () => {
					clearTimeout(timeout);
					server.close();
				},
			});
		});
	});
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export interface AuthorizeProgress {
	onAuthorizationUrl?: (url: string) => void;
	onStatus?: (message: string) => void;
}

/**
 * Run the interactive OAuth authorization-code flow for a remote MCP server,
 * then verify the stored tokens by reconnecting through the manager.
 */
export async function authorizeServer(
	manager: McpManager,
	serverName: string,
	progress: AuthorizeProgress = {},
): Promise<void> {
	const entry = manager.getServerEntry(serverName);
	if (!entry) {
		throw new Error(`Unknown MCP server "${serverName}". Configured servers: ${manager.formatServerList()}`);
	}
	if (!entry.url)
		throw new Error(`MCP server "${serverName}" is a stdio server; OAuth applies to remote servers only.`);
	if (entry.auth !== "oauth") {
		throw new Error(`MCP server "${serverName}" is not configured with "auth": "oauth" in mcp.json.`);
	}

	const provider = new McpOAuthProvider(serverName);
	const callback = await startCallbackServer();
	provider.beginInteractive(callback.redirectUrl);
	provider.onAuthorizationUrl = (url) => progress.onAuthorizationUrl?.(url.toString());

	const transport = new StreamableHTTPClientTransport(new URL(entry.url), { authProvider: provider });
	const client = new Client({ name: "openachieve-agent", version: VERSION });

	try {
		progress.onStatus?.("Starting authorization...");
		try {
			await client.connect(transport);
			// Already authorized (stored/refreshed tokens worked).
			progress.onStatus?.("Already authorized.");
			return;
		} catch (error) {
			if (!(error instanceof UnauthorizedError) && !/unauthorized/i.test(errorMessage(error))) {
				throw error;
			}
		}

		progress.onStatus?.("Waiting for authorization in your browser...");
		const { code, state } = await callback.waitForCode;
		if (provider.expectedState && state !== provider.expectedState) {
			throw new Error("Authorization state mismatch; aborting (possible CSRF).");
		}
		await transport.finishAuth(code);
		progress.onStatus?.("Authorization complete.");
	} finally {
		provider.endInteractive();
		callback.close();
		try {
			await client.close();
		} catch {
			// Probe client may not have fully connected.
		}
	}

	// Reconnect through the manager using the freshly stored tokens.
	await manager.disconnect(serverName);
	await manager.ensureConnected(serverName);
}

export function createAuthProviderFactory(): (
	serverName: string,
	entry: { auth?: "oauth" | "bearer" | false },
) => McpOAuthProvider | undefined {
	return (serverName, entry) => (entry.auth === "oauth" ? new McpOAuthProvider(serverName) : undefined);
}
