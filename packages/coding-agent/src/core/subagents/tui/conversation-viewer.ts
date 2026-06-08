/**
 * Conversation Viewer Component
 * Displays formatted messages from a subagent session with auto-follow and manual scroll
 */

import type { Component } from "@openachieve/tui";
import { Container, Key, matchesKey, Spacer, Text, truncateToWidth } from "@openachieve/tui";
import { parseSessionFile, type ParsedMessage } from "./session-parser.ts";

interface ConversationViewerOptions {
	sessionFile: string;
	agentName: string;
	width: number;
	height: number;
	theme: {
		fg: (color: string, text: string) => string;
		bg: (color: string, text: string) => string;
		bold: (text: string) => string;
	};
	onClose: () => void;
}

export class ConversationViewer implements Component {
	private messages: ParsedMessage[] = [];
	private scrollOffset = 0;
	private autoFollow = true;
	private sessionFile: string;
	private agentName: string;
	private width: number;
	private height: number;
	private theme: ConversationViewerOptions["theme"];
	private onCloseCallback: () => void;
	private loadError?: string;
	private lastLoadTime = 0;
	private refreshInterval = 1000; // Refresh every 1s for live updates

	constructor(options: ConversationViewerOptions) {
		this.sessionFile = options.sessionFile;
		this.agentName = options.agentName;
		this.width = options.width;
		this.height = options.height;
		this.theme = options.theme;
		this.onCloseCallback = options.onClose;
		this.loadMessages();
	}

	private async loadMessages(): Promise<void> {
		try {
			const result = await parseSessionFile(this.sessionFile);
			this.messages = result.messages;
			this.lastLoadTime = Date.now();
			this.loadError = undefined;

			// Auto-scroll to bottom if following
			if (this.autoFollow) {
				this.scrollToBottom();
			}
		} catch (error) {
			this.loadError = error instanceof Error ? error.message : String(error);
		}
	}

	private scrollToBottom(): void {
		const contentHeight = this.getContentHeight();
		const viewportHeight = this.height - 4; // Header + footer
		this.scrollOffset = Math.max(0, contentHeight - viewportHeight);
	}

	private getContentHeight(): number {
		let height = 0;
		for (const msg of this.messages) {
			height += this.getMessageHeight(msg);
		}
		return height;
	}

	private getMessageHeight(msg: ParsedMessage): number {
		const bodyWidth = this.width - 4;
		let lines = 1; // Role line
		lines += Math.ceil(msg.content.length / bodyWidth) || 1;
		if (msg.thinking) {
			lines += 1; // Thinking header
			lines += Math.ceil(msg.thinking.length / bodyWidth) || 1;
		}
		if (msg.toolCalls) {
			for (const tool of msg.toolCalls) {
				lines += 1; // Tool name
				lines += Math.ceil(tool.args.length / bodyWidth) || 1;
				if (tool.result) {
					lines += 1; // Result header
					lines += Math.ceil(tool.result.length / (bodyWidth - 2)) || 1;
				}
			}
		}
		lines += 1; // Spacer
		return lines;
	}

	handleKey(key: string): boolean {
		// Escape to close
		if (matchesKey(key, Key.escape)) {
			this.onCloseCallback();
			return true;
		}

		// Arrow up
		if (matchesKey(key, Key.up)) {
			if (this.scrollOffset > 0) {
				this.scrollOffset--;
				this.autoFollow = false;
			}
			return true;
		}

		// Arrow down
		if (matchesKey(key, Key.down)) {
			const contentHeight = this.getContentHeight();
			const viewportHeight = this.height - 4;
			const maxScroll = Math.max(0, contentHeight - viewportHeight);
			if (this.scrollOffset < maxScroll) {
				this.scrollOffset++;
				// Re-enable auto-follow if at bottom
				if (this.scrollOffset >= maxScroll) {
					this.autoFollow = true;
				}
			}
			return true;
		}

		// Page up
		if (matchesKey(key, Key.pageUp)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - Math.floor((this.height - 4) / 2));
			this.autoFollow = false;
			return true;
		}

		// Page down
		if (matchesKey(key, Key.pageDown)) {
			const contentHeight = this.getContentHeight();
			const viewportHeight = this.height - 4;
			const maxScroll = Math.max(0, contentHeight - viewportHeight);
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + Math.floor((this.height - 4) / 2));
			if (this.scrollOffset >= maxScroll) {
				this.autoFollow = true;
			}
			return true;
		}

		// Home
		if (matchesKey(key, Key.home)) {
			this.scrollOffset = 0;
			this.autoFollow = false;
			return true;
		}

		// End
		if (matchesKey(key, Key.end)) {
			this.scrollToBottom();
			this.autoFollow = true;
			return true;
		}

		return false;
	}

	invalidate(): void {
		// Auto-refresh if following and enough time passed
		if (this.autoFollow && Date.now() - this.lastLoadTime > this.refreshInterval) {
			this.loadMessages();
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const bodyWidth = Math.max(1, width - 2);

		// Header
		const headerText = ` Conversation: ${this.agentName} `;
		const headerPadding = Math.max(0, bodyWidth - headerText.length);
		lines.push(this.theme.fg("accent", `╭${headerText}${"─".repeat(headerPadding)}╮`));

		if (this.loadError) {
			lines.push(this.theme.fg("accent", "│" + " ".repeat(bodyWidth) + "│"));
			lines.push(
				this.theme.fg(
					"accent",
					`│${this.theme.fg("error", truncateToWidth(` Error: ${this.loadError}`, bodyWidth))}${" ".repeat(Math.max(0, bodyWidth - ` Error: ${this.loadError}`.length))}│`,
				),
			);
			lines.push(this.theme.fg("accent", "│" + " ".repeat(bodyWidth) + "│"));
		} else if (this.messages.length === 0) {
			lines.push(this.theme.fg("accent", "│" + " ".repeat(bodyWidth) + "│"));
			lines.push(
				this.theme.fg(
					"accent",
					`│${this.theme.fg("dim", truncateToWidth(" (no messages yet)", bodyWidth))}${" ".repeat(Math.max(0, bodyWidth - " (no messages yet)".length))}│`,
				),
			);
			lines.push(this.theme.fg("accent", "│" + " ".repeat(bodyWidth) + "│"));
		} else {
			// Render messages with scroll
			const contentLines = this.renderMessages(bodyWidth);
			const viewportHeight = this.height - 4; // Reserve for header + footer
			const visibleLines = contentLines.slice(this.scrollOffset, this.scrollOffset + viewportHeight);

			for (const line of visibleLines) {
				const paddedLine = line + " ".repeat(Math.max(0, bodyWidth - line.length));
				lines.push(this.theme.fg("accent", `│${paddedLine}│`));
			}

			// Fill remaining space
			const remainingLines = viewportHeight - visibleLines.length;
			for (let i = 0; i < remainingLines; i++) {
				lines.push(this.theme.fg("accent", "│" + " ".repeat(bodyWidth) + "│"));
			}
		}

		// Footer with scroll info and keybindings
		const contentHeight = this.getContentHeight();
		const viewportHeight = this.height - 4;
		const scrollInfo =
			contentHeight > viewportHeight
				? ` Line ${this.scrollOffset + 1}/${contentHeight} `
				: this.autoFollow
					? " [Auto-follow] "
					: " ";
		const keys = "↑↓/PgUp/PgDn/Home/End/Esc";
		const footerText = scrollInfo + keys;
		const footerPadding = Math.max(0, bodyWidth - footerText.length);
		lines.push(this.theme.fg("accent", `╰${footerText}${"─".repeat(footerPadding)}╯`));

		return lines;
	}

	private renderMessages(width: number): string[] {
		const lines: string[] = [];

		for (const msg of this.messages) {
			// Role header
			const roleLabel = msg.role === "user" ? "User" : "Assistant";
			const roleColor = msg.role === "user" ? "accent" : "success";
			lines.push(this.theme.fg(roleColor, this.theme.bold(`${roleLabel}:`)));

			// Thinking block
			if (msg.thinking) {
				lines.push(this.theme.fg("dim", "  <thinking>"));
				const thinkingLines = this.wrapText(msg.thinking, width - 4);
				for (const line of thinkingLines) {
					lines.push(this.theme.fg("dim", `    ${line}`));
				}
				lines.push(this.theme.fg("dim", "  </thinking>"));
			}

			// Content
			if (msg.content) {
				const contentLines = this.wrapText(msg.content, width - 2);
				for (const line of contentLines) {
					lines.push(`  ${line}`);
				}
			}

			// Tool calls
			if (msg.toolCalls) {
				for (const tool of msg.toolCalls) {
					lines.push(this.theme.fg("warning", `  Tool: ${tool.name}`));
					const argsLines = this.wrapText(tool.args, width - 4);
					for (const line of argsLines) {
						lines.push(this.theme.fg("dim", `    ${line}`));
					}
					if (tool.result) {
						lines.push(this.theme.fg("success", "    Result:"));
						const resultLines = this.wrapText(tool.result.slice(0, 500), width - 6); // Truncate long results
						for (const line of resultLines) {
							lines.push(this.theme.fg("dim", `      ${line}`));
						}
						if (tool.result.length > 500) {
							lines.push(this.theme.fg("dim", "      ..."));
						}
					}
				}
			}

			lines.push(""); // Spacer
		}

		return lines;
	}

	private wrapText(text: string, width: number): string[] {
		const lines: string[] = [];
		const paragraphs = text.split("\n");
		for (const para of paragraphs) {
			if (para.length === 0) {
				lines.push("");
				continue;
			}
			for (let i = 0; i < para.length; i += width) {
				lines.push(para.slice(i, i + width));
			}
		}
		return lines;
	}
}
