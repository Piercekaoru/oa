import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import registerSubagentExtension from "./extension/index.ts";

const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

export const BUILTIN_SUBAGENT_AGENTS_DIR = resolve(SUBAGENTS_DIR, "assets", "agents");
export const BUILTIN_SUBAGENT_PROMPTS_DIR = resolve(SUBAGENTS_DIR, "assets", "prompts");
export const BUILTIN_SUBAGENT_SKILLS_DIR = resolve(SUBAGENTS_DIR, "assets", "skills");
export const BUILTIN_SUBAGENT_SKILL_FILE = join(BUILTIN_SUBAGENT_SKILLS_DIR, "oa-subagents", "SKILL.md");

export { registerSubagentExtension };
