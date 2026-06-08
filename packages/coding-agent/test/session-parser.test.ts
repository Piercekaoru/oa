/**
 * Tests for session-parser.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseSessionFile, getLastMessages, isSessionFileReadable } from "../src/core/subagents/tui/session-parser.ts";

describe("session-parser", () => {
	let tempDir: string;
	let testSessionFile: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-parser-test-"));
		testSessionFile = path.join(tempDir, "test-session.jsonl");
	});

	afterEach(() => {
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	describe("parseSessionFile", () => {
		it("should parse session header", async () => {
			const sessionData = [
				JSON.stringify({
					type: "session",
					id: "test-session-123",
					timestamp: "2024-01-01T00:00:00.000Z",
					cwd: "/test/path",
				}),
			].join("\n");

			fs.writeFileSync(testSessionFile, sessionData);
			const result = await parseSessionFile(testSessionFile);

			expect(result.header).toEqual({
				id: "test-session-123",
				timestamp: "2024-01-01T00:00:00.000Z",
				cwd: "/test/path",
			});
		});

		it("should parse assistant messages with text content", async () => {
			const sessionData = [
				JSON.stringify({
					type: "message",
					id: "msg-1",
					parentId: null,
					timestamp: "2024-01-01T00:00:00.000Z",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Hello, how can I help you?" }],
					},
				}),
			].join("\n");

			fs.writeFileSync(testSessionFile, sessionData);
			const result = await parseSessionFile(testSessionFile);

			expect(result.messages).toHaveLength(1);
			expect(result.messages[0]).toEqual({
				role: "assistant",
				content: "Hello, how can I help you?",
				timestamp: "2024-01-01T00:00:00.000Z",
			});
		});

		it("should parse assistant messages with thinking blocks", async () => {
			const sessionData = [
				JSON.stringify({
					type: "message",
					id: "msg-1",
					parentId: null,
					timestamp: "2024-01-01T00:00:00.000Z",
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "Let me think about this..." },
							{ type: "text", text: "The answer is 42." },
						],
					},
				}),
			].join("\n");

			fs.writeFileSync(testSessionFile, sessionData);
			const result = await parseSessionFile(testSessionFile);

			expect(result.messages).toHaveLength(1);
			expect(result.messages[0]?.thinking).toBe("Let me think about this...");
			expect(result.messages[0]?.content).toBe("The answer is 42.");
		});

		it("should parse assistant messages with tool calls", async () => {
			const sessionData = [
				JSON.stringify({
					type: "message",
					id: "msg-1",
					parentId: null,
					timestamp: "2024-01-01T00:00:00.000Z",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "tool-1",
								name: "read_file",
								arguments: { path: "/test/file.txt" },
							},
						],
					},
				}),
			].join("\n");

			fs.writeFileSync(testSessionFile, sessionData);
			const result = await parseSessionFile(testSessionFile);

			expect(result.messages).toHaveLength(1);
			expect(result.messages[0]?.toolCalls).toHaveLength(1);
			expect(result.messages[0]?.toolCalls?.[0]).toMatchObject({
				name: "read_file",
				args: expect.stringContaining("/test/file.txt"),
			});
		});

		it("should parse user messages", async () => {
			const sessionData = [
				JSON.stringify({
					type: "message",
					id: "msg-1",
					parentId: null,
					timestamp: "2024-01-01T00:00:00.000Z",
					message: {
						role: "user",
						content: [{ type: "text", text: "What is the weather?" }],
					},
				}),
			].join("\n");

			fs.writeFileSync(testSessionFile, sessionData);
			const result = await parseSessionFile(testSessionFile);

			expect(result.messages).toHaveLength(1);
			expect(result.messages[0]).toEqual({
				role: "user",
				content: "What is the weather?",
				timestamp: "2024-01-01T00:00:00.000Z",
			});
		});

		it("should handle tool results from ToolResultMessage", async () => {
			const sessionData = [
				JSON.stringify({
					type: "message",
					id: "msg-1",
					parentId: null,
					timestamp: "2024-01-01T00:00:00.000Z",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "tool-1",
								name: "read_file",
								arguments: { path: "/test/file.txt" },
							},
						],
					},
				}),
				JSON.stringify({
					type: "message",
					id: "msg-2",
					parentId: "msg-1",
					timestamp: "2024-01-01T00:00:01.000Z",
					message: {
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool-1",
								content: [{ type: "text", text: "File contents here" }],
							},
						],
					},
				}),
			].join("\n");

			fs.writeFileSync(testSessionFile, sessionData);
			const result = await parseSessionFile(testSessionFile);

			expect(result.messages).toHaveLength(1); // Only assistant message with tool call
			expect(result.messages[0]?.toolCalls?.[0]?.result).toBe("File contents here");
		});

		it("should handle malformed lines gracefully", async () => {
			const sessionData = [
				JSON.stringify({
					type: "message",
					id: "msg-1",
					parentId: null,
					timestamp: "2024-01-01T00:00:00.000Z",
					message: {
						role: "user",
						content: [{ type: "text", text: "Valid message" }],
					},
				}),
				"{ invalid json",
				JSON.stringify({
					type: "message",
					id: "msg-2",
					parentId: null,
					timestamp: "2024-01-01T00:00:01.000Z",
					message: {
						role: "user",
						content: [{ type: "text", text: "Another valid message" }],
					},
				}),
			].join("\n");

			fs.writeFileSync(testSessionFile, sessionData);
			const result = await parseSessionFile(testSessionFile);

			expect(result.messages).toHaveLength(2); // Malformed line is skipped
			expect(result.messages[0]?.content).toBe("Valid message");
			expect(result.messages[1]?.content).toBe("Another valid message");
		});

		it("should respect maxLines parameter", async () => {
			const sessionData = [
				JSON.stringify({ type: "session", id: "s1", parentId: null, timestamp: "2024-01-01T00:00:00.000Z" }),
				JSON.stringify({
					type: "message",
					id: "msg-1",
					parentId: null,
					timestamp: "2024-01-01T00:00:00.000Z",
					message: { role: "user", content: [{ type: "text", text: "Message 1" }] },
				}),
				JSON.stringify({
					type: "message",
					id: "msg-2",
					parentId: null,
					timestamp: "2024-01-01T00:00:01.000Z",
					message: { role: "user", content: [{ type: "text", text: "Message 2" }] },
				}),
				JSON.stringify({
					type: "message",
					id: "msg-3",
					parentId: null,
					timestamp: "2024-01-01T00:00:02.000Z",
					message: { role: "user", content: [{ type: "text", text: "Message 3" }] },
				}),
			].join("\n");

			fs.writeFileSync(testSessionFile, sessionData);
			const result = await parseSessionFile(testSessionFile, 3);

			expect(result.messages.length).toBeLessThanOrEqual(2); // maxLines=3 means first 3 lines (header + 2 messages)
		});

		it("should throw error for non-existent file", async () => {
			await expect(parseSessionFile("/nonexistent/file.jsonl")).rejects.toThrow("Session file not found");
		});
	});

	describe("getLastMessages", () => {
		it("should return last N messages", async () => {
			const sessionData = [
				JSON.stringify({
					type: "message",
					id: "msg-1",
					parentId: null,
					timestamp: "2024-01-01T00:00:00.000Z",
					message: { role: "user", content: [{ type: "text", text: "Message 1" }] },
				}),
				JSON.stringify({
					type: "message",
					id: "msg-2",
					parentId: null,
					timestamp: "2024-01-01T00:00:01.000Z",
					message: { role: "user", content: [{ type: "text", text: "Message 2" }] },
				}),
				JSON.stringify({
					type: "message",
					id: "msg-3",
					parentId: null,
					timestamp: "2024-01-01T00:00:02.000Z",
					message: { role: "user", content: [{ type: "text", text: "Message 3" }] },
				}),
			].join("\n");

			fs.writeFileSync(testSessionFile, sessionData);
			const result = await getLastMessages(testSessionFile, 2);

			expect(result).toHaveLength(2);
			expect(result[0]?.content).toBe("Message 2");
			expect(result[1]?.content).toBe("Message 3");
		});

		it("should return empty array for non-existent file", async () => {
			const result = await getLastMessages("/nonexistent/file.jsonl", 5);
			expect(result).toEqual([]);
		});
	});

	describe("isSessionFileReadable", () => {
		it("should return true for existing file", () => {
			fs.writeFileSync(testSessionFile, "test");
			expect(isSessionFileReadable(testSessionFile)).toBe(true);
		});

		it("should return false for non-existent file", () => {
			expect(isSessionFileReadable("/nonexistent/file.jsonl")).toBe(false);
		});

		it("should return false for directory", () => {
			expect(isSessionFileReadable(tempDir)).toBe(false);
		});
	});
});
