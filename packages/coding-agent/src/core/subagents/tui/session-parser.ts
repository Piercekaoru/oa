/**
 * Session JSONL parser for subagent conversation viewer
 * Reads and parses .jsonl session files to extract messages, tool calls, and thinking blocks
 */

import * as fs from "node:fs";
import { createInterface } from "node:readline";
import type { Message } from "../compat/ai.ts";

export interface ParsedMessage {
	role: "user" | "assistant";
	content: string;
	toolCalls?: ParsedToolCall[];
	thinking?: string;
	timestamp: string;
}

export interface ParsedToolCall {
	name: string;
	args: string; // JSON string
	result?: string;
}

export interface SessionParseResult {
	messages: ParsedMessage[];
	header?: {
		id: string;
		timestamp: string;
		cwd: string;
	};
}

interface SessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	message?: Message;
	[key: string]: unknown;
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(item): item is { type: "text"; text: string } => item?.type === "text" && typeof item.text === "string",
			)
			.map((item) => item.text)
			.join("\n");
	}
	return "";
}

function extractThinking(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const thinkingBlock = content.find(
		(item): item is { type: "thinking"; thinking: string } =>
			item?.type === "thinking" && typeof item.thinking === "string",
	);
	return thinkingBlock?.thinking;
}

function extractToolCalls(content: unknown): ParsedToolCall[] | undefined {
	if (!Array.isArray(content)) return undefined;
	const toolUseBlocks = content.filter(
		(item): item is { type: "toolCall"; id: string; name: string; arguments: unknown } =>
			item?.type === "toolCall" && typeof item.name === "string",
	);
	if (toolUseBlocks.length === 0) return undefined;
	return toolUseBlocks.map((block) => ({
		name: block.name,
		args: JSON.stringify(block.arguments, null, 2),
	}));
}

/**
 * Parse a session.jsonl file and extract messages with tool calls
 * @param sessionFile Absolute path to session.jsonl file
 * @param maxLines Maximum number of lines to read (default: all)
 * @returns Parsed messages in chronological order
 */
export async function parseSessionFile(sessionFile: string, maxLines?: number): Promise<SessionParseResult> {
	if (!fs.existsSync(sessionFile)) {
		throw new Error(`Session file not found: ${sessionFile}`);
	}

	const messages: ParsedMessage[] = [];
	const toolResultMap = new Map<string, string>();
	const assistantMessages: Array<{ entry: SessionEntry; content: unknown }> = [];
	let header: SessionParseResult["header"];
	let lineCount = 0;

	const fileStream = fs.createReadStream(sessionFile);
	const rl = createInterface({
		input: fileStream,
		crlfDelay: Number.POSITIVE_INFINITY,
	});

	for await (const line of rl) {
		if (maxLines && lineCount >= maxLines) break;
		lineCount++;

		try {
			const entry = JSON.parse(line) as SessionEntry;

			// Extract session header
			if (entry.type === "session") {
				header = {
					id: entry.id,
					timestamp: entry.timestamp,
					cwd: (entry as { cwd?: string }).cwd || "",
				};
				continue;
			}

			// Extract tool results from ToolResultMessage
			if (entry.type === "message" && (entry.message as any)?.role === "toolResult") {
				const msg = entry.message as any;
				if (msg.toolCallId && msg.result) {
					const resultContent = typeof msg.result === "string" ? msg.result : JSON.stringify(msg.result);
					toolResultMap.set(msg.toolCallId, resultContent);
				}
			}

			// Also check for user messages with tool results in older format
			if (entry.type === "message" && entry.message?.role === "user") {
				const content = entry.message.content;
				if (Array.isArray(content)) {
					for (const block of content) {
						if ((block as any)?.type === "tool_result" && typeof (block as any).tool_use_id === "string") {
							const resultContent = extractTextContent((block as { content?: unknown }).content);
							toolResultMap.set((block as any).tool_use_id, resultContent);
						}
					}
				}
			}

			// Extract assistant messages (defer processing until after tool results)
			if (entry.type === "message" && entry.message?.role === "assistant") {
				assistantMessages.push({ entry, content: entry.message.content });
			}

			// Extract user messages
			if (entry.type === "message" && entry.message?.role === "user") {
				// Skip tool_result-only messages (already processed above)
				const content = entry.message.content;
				if (Array.isArray(content) && content.every((block: any) => block?.type === "tool_result")) {
					continue;
				}

				const textContent = extractTextContent(content);
				if (textContent) {
					messages.push({
						role: "user",
						content: textContent,
						timestamp: entry.timestamp,
					});
				}
			}
		} catch (error) {
			// Skip malformed lines
			console.error(`Failed to parse session line: ${error}`);
		}
	}

	// Now process assistant messages and attach tool results
	for (const { entry, content } of assistantMessages) {
		const textContent = extractTextContent(content);
		const thinking = extractThinking(content);
		const toolCalls = extractToolCalls(content);

		// Attach tool results to tool calls
		if (toolCalls && Array.isArray(content)) {
			for (const toolCall of toolCalls) {
				const toolUseBlock = content.find(
					(item: any) => item?.type === "toolCall" && item.name === toolCall.name,
				) as { type: "toolCall"; id: string; name: string } | undefined;
				if (toolUseBlock) {
					const result = toolResultMap.get(toolUseBlock.id);
					if (result) {
						toolCall.result = result;
					}
				}
			}
		}

		messages.push({
			role: "assistant",
			content: textContent,
			toolCalls,
			thinking,
			timestamp: entry.timestamp,
		});
	}

	return { messages, header };
}

/**
 * Get the last N messages from a session file (efficient for large files)
 * @param sessionFile Absolute path to session.jsonl file
 * @param count Number of messages to retrieve from the end
 * @returns Parsed messages
 */
export async function getLastMessages(sessionFile: string, count: number): Promise<ParsedMessage[]> {
	if (!fs.existsSync(sessionFile)) {
		return [];
	}

	const result = await parseSessionFile(sessionFile);
	return result.messages.slice(-count);
}

/**
 * Check if a session file exists and is readable
 */
export function isSessionFileReadable(sessionFile: string): boolean {
	try {
		return fs.existsSync(sessionFile) && fs.statSync(sessionFile).isFile();
	} catch {
		return false;
	}
}
