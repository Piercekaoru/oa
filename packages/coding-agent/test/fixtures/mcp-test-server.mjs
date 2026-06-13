#!/usr/bin/env node
// Minimal MCP stdio server used by the mcp-* test suites.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "oa-test-server", version: "1.0.0" });

server.registerTool(
	"echo",
	{
		description: "Echo back the input message",
		inputSchema: { message: z.string().describe("Message to echo") },
	},
	async ({ message }) => ({ content: [{ type: "text", text: `echo: ${message}` }] }),
);

server.registerTool(
	"fail_tool",
	{ description: "Always reports an error result" },
	async () => ({ content: [{ type: "text", text: "deliberate failure" }], isError: true }),
);

server.registerTool("die", { description: "Exit the server process shortly after responding" }, async () => {
	setTimeout(() => process.exit(1), 25);
	return { content: [{ type: "text", text: "dying" }] };
});

server.registerResource(
	"Test Notes",
	"memo://notes",
	{ description: "Notes used by tests" },
	async (uri) => ({ contents: [{ uri: uri.href, text: "the notes content" }] }),
);

await server.connect(new StdioServerTransport());
