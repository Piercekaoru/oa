import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "../../config.ts";
import { interpolateEnvRecord, resolveBearerToken, resolveConfigPath } from "./config.ts";
import type { CachedResourceMeta, CachedToolMeta, McpServerEntry, McpServerState, McpTransportKind } from "./types.ts";

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 120_000;
const STDERR_RING_SIZE = 50;

export interface McpConnectionOptions {
	idleTimeoutMs?: number;
	onStateChange?: (connection: McpConnection) => void;
	authProvider?: OAuthClientProvider;
}

export class McpConnection {
	readonly name: string;
	readonly entry: McpServerEntry;
	state: McpServerState = "disconnected";
	lastError: string | undefined;
	lastUsedAt: number | undefined;

	private client: Client | undefined;
	private idleTimer: NodeJS.Timeout | undefined;
	private readonly idleTimeoutMs: number;
	private readonly onStateChange: ((connection: McpConnection) => void) | undefined;
	private readonly authProvider: OAuthClientProvider | undefined;
	private stderrLines: string[] = [];
	private childPid: number | undefined;

	constructor(name: string, entry: McpServerEntry, options: McpConnectionOptions = {}) {
		this.name = name;
		this.entry = entry;
		this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
		this.onStateChange = options.onStateChange;
		this.authProvider = options.authProvider;
	}

	get transportKind(): McpTransportKind {
		return this.entry.url ? "http" : "stdio";
	}

	get pid(): number | undefined {
		return this.childPid;
	}

	getRecentStderr(): string[] {
		return [...this.stderrLines];
	}

	isConnected(): boolean {
		return this.state === "connected" && this.client !== undefined;
	}

	async connect(signal?: AbortSignal): Promise<void> {
		if (this.isConnected()) return;
		await this.closeClient();
		this.setState("connecting");

		try {
			if (this.entry.url) {
				await this.connectHttp(signal);
			} else if (this.entry.command) {
				await this.connectStdio();
			} else {
				throw new Error(`Server "${this.name}" has neither "command" nor "url" configured`);
			}
			this.setState("connected");
			this.touch();
		} catch (error) {
			this.lastError = errorMessage(error);
			this.setState("error");
			await this.closeClient();
			throw error;
		}
	}

	private async connectStdio(): Promise<void> {
		const transport = new StdioClientTransport({
			command: this.entry.command!,
			args: this.entry.args ?? [],
			env: { ...getDefaultEnvironment(), ...interpolateEnvRecord(this.entry.env) },
			cwd: resolveConfigPath(this.entry.cwd),
			stderr: "pipe",
		});
		await this.startClient(transport);
		this.childPid = transport.pid ?? undefined;
		transport.stderr?.on("data", (chunk: Buffer) => {
			for (const line of chunk.toString("utf-8").split("\n")) {
				if (!line.trim()) continue;
				this.stderrLines.push(line);
				if (this.stderrLines.length > STDERR_RING_SIZE) this.stderrLines.shift();
			}
		});
	}

	private async connectHttp(signal?: AbortSignal): Promise<void> {
		const url = new URL(this.entry.url!);
		const headers = this.buildHttpHeaders();
		try {
			await this.startClient(
				new StreamableHTTPClientTransport(url, {
					authProvider: this.authProvider,
					requestInit: { headers },
				}),
				signal,
			);
		} catch (error) {
			// Older servers only speak the deprecated HTTP+SSE transport; per the MCP
			// backwards-compatibility guidance, fall back when streamable HTTP fails.
			if (isUnauthorized(error)) throw error;
			await this.closeClient();
			await this.startClient(
				new SSEClientTransport(url, {
					authProvider: this.authProvider,
					requestInit: { headers },
				}),
				signal,
			);
		}
	}

	private buildHttpHeaders(): Record<string, string> {
		const headers: Record<string, string> = { ...interpolateEnvRecord(this.entry.headers) };
		if (
			this.entry.auth === "bearer" ||
			(this.entry.auth === undefined && (this.entry.bearerToken || this.entry.bearerTokenEnv))
		) {
			const token = resolveBearerToken(this.entry);
			if (token) headers.Authorization = `Bearer ${token}`;
		}
		return headers;
	}

	private async startClient(transport: Transport, signal?: AbortSignal): Promise<void> {
		const client = new Client({ name: "openachieve-agent", version: VERSION });
		client.onclose = () => {
			if (this.client === client && this.state === "connected") {
				this.setState("disconnected");
				this.client = undefined;
			}
		};
		client.onerror = (error) => {
			if (this.client === client) this.lastError = errorMessage(error);
		};
		await client.connect(transport, { signal, timeout: REQUEST_TIMEOUT_MS });
		this.client = client;
	}

	async listTools(signal?: AbortSignal): Promise<CachedToolMeta[]> {
		const client = this.requireClient();
		this.touch();
		const tools: CachedToolMeta[] = [];
		let cursor: string | undefined;
		do {
			const result = await client.listTools({ cursor }, this.requestOptions(signal));
			for (const tool of result.tools) {
				tools.push({
					name: tool.name,
					description: tool.description,
					inputSchema: tool.inputSchema as Record<string, unknown>,
				});
			}
			cursor = result.nextCursor;
		} while (cursor);
		this.touch();
		return tools;
	}

	async listResources(signal?: AbortSignal): Promise<CachedResourceMeta[]> {
		const client = this.requireClient();
		this.touch();
		const resources: CachedResourceMeta[] = [];
		let cursor: string | undefined;
		try {
			do {
				const result = await client.listResources({ cursor }, this.requestOptions(signal));
				for (const resource of result.resources) {
					resources.push({
						uri: resource.uri,
						name: resource.name,
						description: resource.description,
						mimeType: resource.mimeType,
					});
				}
				cursor = result.nextCursor;
			} while (cursor);
		} catch (error) {
			// Resources are optional; many servers don't implement them.
			if (error instanceof McpError && error.code === ErrorCode.MethodNotFound) return [];
			throw error;
		}
		this.touch();
		return resources;
	}

	async callTool(
		toolName: string,
		args: Record<string, unknown> | undefined,
		signal?: AbortSignal,
	): Promise<CallToolResult> {
		const client = this.requireClient();
		this.touch();
		const result = (await client.callTool(
			{ name: toolName, arguments: args ?? {} },
			undefined,
			this.requestOptions(signal),
		)) as CallToolResult;
		this.touch();
		return result;
	}

	async readResource(uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
		const client = this.requireClient();
		this.touch();
		const result = await client.readResource({ uri }, this.requestOptions(signal));
		this.touch();
		return result;
	}

	async close(): Promise<void> {
		this.clearIdleTimer();
		await this.closeClient();
		if (this.state !== "error") this.setState("disconnected");
	}

	private requestOptions(signal?: AbortSignal) {
		return { signal, timeout: REQUEST_TIMEOUT_MS, resetTimeoutOnProgress: true };
	}

	private requireClient(): Client {
		if (!this.client) throw new Error(`Server "${this.name}" is not connected`);
		return this.client;
	}

	private async closeClient(): Promise<void> {
		const client = this.client;
		this.client = undefined;
		this.childPid = undefined;
		if (client) {
			client.onclose = undefined;
			try {
				await client.close();
			} catch {
				// Best-effort: the transport may already be gone.
			}
		}
	}

	private touch(): void {
		this.lastUsedAt = Date.now();
		this.resetIdleTimer();
	}

	private resetIdleTimer(): void {
		this.clearIdleTimer();
		if (this.idleTimeoutMs <= 0) return;
		this.idleTimer = setTimeout(() => {
			void this.close();
		}, this.idleTimeoutMs);
		this.idleTimer.unref?.();
	}

	private clearIdleTimer(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = undefined;
		}
	}

	private setState(state: McpServerState): void {
		if (this.state === state) return;
		this.state = state;
		if (state === "connected") this.lastError = undefined;
		this.onStateChange?.(this);
	}
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function isUnauthorized(error: unknown): boolean {
	if (!error) return false;
	const name = (error as { name?: string }).name;
	if (name === "UnauthorizedError") return true;
	const message = errorMessage(error);
	return /\b401\b|unauthorized/i.test(message);
}
