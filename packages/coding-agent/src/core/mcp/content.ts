import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { ImageContent, TextContent } from "@openachieve/ai";
import { DEFAULT_MAX_BYTES, truncateTail } from "../tools/truncate.ts";

export type McpResultContent = (TextContent | ImageContent)[];

/**
 * Map an MCP tool call result to agent tool result content.
 * Throws when the server flagged the result as an error so the agent loop
 * records a proper tool error.
 */
export function mapCallToolResult(result: CallToolResult, label: string): McpResultContent {
	const content = mapContentBlocks(result.content ?? []);
	if (result.isError) {
		const text = content
			.map((block) => (block.type === "text" ? block.text : "(non-text content)"))
			.join("\n")
			.trim();
		throw new Error(text || `MCP tool ${label} reported an error without details`);
	}
	if (content.length === 0) {
		content.push({ type: "text", text: `(${label} returned no content)` });
	}
	return content;
}

export function mapReadResourceResult(result: ReadResourceResult): McpResultContent {
	const content: McpResultContent = [];
	for (const item of result.contents ?? []) {
		if (typeof (item as { text?: unknown }).text === "string") {
			content.push(text(`${item.uri}:\n${(item as { text: string }).text}`));
		} else if (typeof (item as { blob?: unknown }).blob === "string" && item.mimeType?.startsWith("image/")) {
			content.push({ type: "image", data: (item as { blob: string }).blob, mimeType: item.mimeType });
		} else {
			content.push(text(`${item.uri}: (binary content${item.mimeType ? `, ${item.mimeType}` : ""})`));
		}
	}
	if (content.length === 0) content.push(text("(resource has no content)"));
	return content;
}

function mapContentBlocks(blocks: CallToolResult["content"]): McpResultContent {
	const content: McpResultContent = [];
	for (const block of blocks) {
		switch (block.type) {
			case "text":
				content.push(text(block.text));
				break;
			case "image":
				content.push({ type: "image", data: block.data, mimeType: block.mimeType });
				break;
			case "audio":
				content.push(text(`(audio content, ${block.mimeType})`));
				break;
			case "resource_link":
				content.push(text(`Resource link: ${block.uri}${block.name ? ` (${block.name})` : ""}`));
				break;
			case "resource": {
				const resource = block.resource;
				if (typeof (resource as { text?: unknown }).text === "string") {
					content.push(text(`${resource.uri}:\n${(resource as { text: string }).text}`));
				} else {
					content.push(
						text(`${resource.uri}: (binary content${resource.mimeType ? `, ${resource.mimeType}` : ""})`),
					);
				}
				break;
			}
			default:
				content.push(text(`(unsupported content type: ${(block as { type: string }).type})`));
		}
	}
	return content;
}

function text(value: string): TextContent {
	const truncation = truncateTail(value, { maxBytes: DEFAULT_MAX_BYTES });
	return {
		type: "text",
		text: truncation.truncated
			? `${truncation.content}\n\n[Output truncated: showing first ${truncation.outputBytes} of ${truncation.totalBytes} bytes]`
			: value,
	};
}
