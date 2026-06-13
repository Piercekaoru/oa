import { Text } from "@openachieve/tui";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import type { ToolDefinition } from "../extensions/types.ts";
import { registerMcpToolPermissionTarget } from "../permission-system.ts";
import { mapCallToolResult, mapReadResourceResult } from "./content.ts";
import type { McpManager } from "./manager.ts";
import { buildDirectToolsFilter, collectExposedEntries, type ExposedToolEntry } from "./selection.ts";

export interface McpDirectToolDetails {
	server: string;
	mcpTool: string;
}

/** Tools/resources promoted to first-class registration per directTools config. */
export function selectDirectTools(manager: McpManager): ExposedToolEntry[] {
	return collectExposedEntries(manager.config, manager.getCache(), buildDirectToolsFilter(manager.config));
}

export function buildDirectToolDefinition(
	manager: McpManager,
	entry: ExposedToolEntry,
): ToolDefinition<TSchema, McpDirectToolDetails> {
	const details: McpDirectToolDetails = { server: entry.server, mcpTool: entry.baseName };
	registerMcpToolPermissionTarget(entry.exposedName, entry.server, entry.baseName);

	if (entry.kind === "resource") {
		const uri = entry.resource?.uri ?? "";
		return {
			name: entry.exposedName,
			label: entry.exposedName,
			description: entry.resource?.description
				? `${entry.resource.description} (MCP resource ${uri} from server "${entry.server}")`
				: `Read the MCP resource ${uri} from server "${entry.server}".`,
			promptSnippet: `Read MCP resource ${entry.resource?.name ?? uri} (server: ${entry.server})`,
			parameters: emptyObjectSchema(),
			async execute(_toolCallId, _params, signal) {
				const result = await manager.readResource(entry.server, uri, signal);
				return { content: mapReadResourceResult(result), details };
			},
			renderCall: (_args, theme) =>
				new Text(`${theme.fg("toolTitle", theme.bold("mcp "))}${theme.fg("accent", entry.exposedName)}`, 0, 0),
		};
	}

	return {
		name: entry.exposedName,
		label: entry.exposedName,
		description: entry.tool?.description || `MCP tool "${entry.baseName}" from server "${entry.server}".`,
		promptSnippet: oneLine(entry.tool?.description) || `MCP tool ${entry.baseName} (server: ${entry.server})`,
		parameters: normalizeJsonSchema(entry.tool?.inputSchema),
		async execute(_toolCallId, params, signal) {
			const result = await manager.callTool(entry.server, entry.baseName, params as Record<string, unknown>, signal);
			return { content: mapCallToolResult(result, `${entry.server}/${entry.baseName}`), details };
		},
		renderCall: (_args, theme) =>
			new Text(`${theme.fg("toolTitle", theme.bold("mcp "))}${theme.fg("accent", entry.exposedName)}`, 0, 0),
	};
}

const MAX_REF_DEPTH = 16;

/**
 * Prepare a raw MCP JSON Schema for use as ToolDefinition.parameters:
 * - guarantee an object root (providers require it)
 * - inline $ref/$defs (the Anthropic serializer only forwards properties/required,
 *   so refs would dangle on the model side)
 * - verify the result compiles; fall back to a permissive schema otherwise
 */
export function normalizeJsonSchema(schema: Record<string, unknown> | undefined): TSchema {
	let normalized: Record<string, unknown>;
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		normalized = permissiveObjectSchema();
	} else {
		const defs = collectDefs(schema);
		const inlined = inlineRefs(schema, defs, 0) as Record<string, unknown>;
		delete inlined.$schema;
		delete inlined.$id;
		delete inlined.$defs;
		delete inlined.definitions;
		if (inlined.type !== "object") {
			inlined.type = "object";
			if (!("properties" in inlined)) inlined.additionalProperties = true;
		}
		normalized = inlined;
	}

	try {
		Compile(normalized as TSchema);
		return normalized as TSchema;
	} catch {
		return permissiveObjectSchema() as TSchema;
	}
}

function collectDefs(schema: Record<string, unknown>): Record<string, unknown> {
	const defs: Record<string, unknown> = {};
	for (const key of ["$defs", "definitions"]) {
		const block = schema[key];
		if (block && typeof block === "object" && !Array.isArray(block)) {
			Object.assign(defs, block as Record<string, unknown>);
		}
	}
	return defs;
}

function inlineRefs(node: unknown, defs: Record<string, unknown>, refDepth: number): unknown {
	if (refDepth > MAX_REF_DEPTH) return {};
	if (Array.isArray(node)) return node.map((item) => inlineRefs(item, defs, refDepth));
	if (!node || typeof node !== "object") return node;

	const obj = node as Record<string, unknown>;
	const ref = obj.$ref;
	if (typeof ref === "string") {
		const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
		const target = match ? defs[match[1]!] : undefined;
		// Unresolvable refs degrade to a permissive node; cycles are cut by refDepth.
		return target === undefined ? {} : inlineRefs(target, defs, refDepth + 1);
	}

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		result[key] = inlineRefs(value, defs, refDepth);
	}
	return result;
}

function permissiveObjectSchema(): Record<string, unknown> {
	return { type: "object", properties: {}, additionalProperties: true };
}

function emptyObjectSchema(): TSchema {
	return { type: "object", properties: {}, additionalProperties: false } as unknown as TSchema;
}

function oneLine(text: string | undefined): string {
	if (!text) return "";
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 100 ? `${flat.slice(0, 97)}...` : flat;
}
