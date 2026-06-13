import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { clearServerAuth, McpOAuthProvider } from "../src/core/mcp/oauth.ts";

const tempDirs: string[] = [];
const envBackup = new Map<string, string | undefined>();

function makeAgentDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-mcp-oauth-"));
	tempDirs.push(dir);
	if (!envBackup.has(ENV_AGENT_DIR)) envBackup.set(ENV_AGENT_DIR, process.env[ENV_AGENT_DIR]);
	process.env[ENV_AGENT_DIR] = dir;
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	for (const [key, value] of envBackup) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	envBackup.clear();
});

describe("McpOAuthProvider", () => {
	it("round-trips tokens, client info, and code verifier per server", () => {
		const agentDir = makeAgentDir();
		const provider = new McpOAuthProvider("remote");

		expect(provider.tokens()).toBeUndefined();
		provider.saveTokens({ access_token: "at", token_type: "Bearer", refresh_token: "rt" });
		provider.saveClientInformation({ client_id: "cid", redirect_uris: [] });
		provider.saveCodeVerifier("verifier-123");

		expect(provider.tokens()).toMatchObject({ access_token: "at", refresh_token: "rt" });
		expect(provider.clientInformation()).toMatchObject({ client_id: "cid" });
		expect(provider.codeVerifier()).toBe("verifier-123");

		const other = new McpOAuthProvider("other-server");
		expect(other.tokens()).toBeUndefined();

		const storePath = path.join(agentDir, "mcp-auth.json");
		expect(fs.existsSync(storePath)).toBe(true);
		expect(fs.statSync(storePath).mode & 0o777).toBe(0o600);
	});

	it("invalidates credentials by scope and clears servers", () => {
		makeAgentDir();
		const provider = new McpOAuthProvider("remote");
		provider.saveTokens({ access_token: "at", token_type: "Bearer" });
		provider.saveClientInformation({ client_id: "cid", redirect_uris: [] });

		provider.invalidateCredentials("tokens");
		expect(provider.tokens()).toBeUndefined();
		expect(provider.clientInformation()).toMatchObject({ client_id: "cid" });

		provider.invalidateCredentials("all");
		expect(provider.clientInformation()).toBeUndefined();

		provider.saveTokens({ access_token: "again", token_type: "Bearer" });
		clearServerAuth("remote");
		expect(provider.tokens()).toBeUndefined();
	});

	it("refuses surprise browser redirects outside the interactive flow", () => {
		makeAgentDir();
		const provider = new McpOAuthProvider("remote");
		expect(() => provider.redirectToAuthorization(new URL("https://auth.example.com"))).toThrow(/\/mcp auth remote/);
	});

	it("uses the callback redirect URL and state during the interactive flow", () => {
		makeAgentDir();
		const provider = new McpOAuthProvider("remote");
		expect(provider.redirectUrl).toBe("http://127.0.0.1/unavailable");

		provider.beginInteractive("http://127.0.0.1:54321/callback");
		expect(provider.redirectUrl).toBe("http://127.0.0.1:54321/callback");
		expect(provider.clientMetadata.redirect_uris).toEqual(["http://127.0.0.1:54321/callback"]);
		expect(provider.state()).toBe(provider.expectedState);

		provider.endInteractive();
		expect(provider.expectedState).toBeUndefined();
		expect(provider.redirectUrl).toBe("http://127.0.0.1/unavailable");
	});
});
