import type { AgentToolResult as BaseAgentToolResult } from "@openachieve/agent-core";

export interface AgentToolResult<T> extends BaseAgentToolResult<T> {
	isError?: boolean;
}
