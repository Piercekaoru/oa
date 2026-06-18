# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read AGENTS.md first

`AGENTS.md` at the repo root holds the binding development rules (code quality, TypeScript constraints, git/commit policy, test commands, changelog, releasing). It takes precedence over anything here. This file covers the architecture and commands that `AGENTS.md` does not. A few constraints are worth repeating because they break the build if missed:

- **Erasable TypeScript only** in `packages/*/src`, `packages/*/test`, and `packages/coding-agent/examples` (Node strip-only mode): no `enum`, `namespace`/`module`, parameter properties, `import =`/`export =`. Use explicit fields with constructor assignments.
- **No inline imports** (`await import()`, `import("pkg").Type`). Top-level imports only.
- **Never edit `packages/ai/src/models.generated.ts` directly** — change `packages/ai/scripts/generate-models.ts` and regenerate. Same pattern for `image-models.generated.ts`.
- Treat dependency/lockfile changes as reviewed code; direct external deps stay pinned to exact versions. Hydrate with `npm install --ignore-scripts`.

## Commands

Run from the repo root unless noted:

- `npm install --ignore-scripts` — install all workspace deps (never run lifecycle scripts).
- `npm run build` — build every package in dependency order (tui → ai → agent → coding-agent).
- `npm run check` — biome (format/lint, `--error-on-warnings`) + pinned-deps + ts-relative-imports + shrinkwrap + `tsgo --noEmit` + browser-smoke. **Run after any code change; fix all errors/warnings/infos before committing. Does not run tests.**
- `./test.sh` — run the full test suite with auth and all provider API keys stripped (skips LLM-dependent e2e tests). This is the default way to run tests.
- Single test (from the package root, e.g. `packages/coding-agent`): `node ../../node_modules/vitest/dist/cli.js --run test/path/to.test.ts`.
- `./oa-test.sh` — run the `oa` CLI from source against any directory (build first if `dist` is stale).
- Never run `npm run build` or `npm test` (the raw vitest suite) unless asked — the raw suite activates e2e tests when endpoint/auth env vars are present.

Formatting is Biome with **tabs at indent width 3, line width 120**. `tsgo` is the TypeScript native-preview compiler used for builds and type checks; `tsx`/`jiti` run TS directly.

## Architecture

A four-package npm-workspaces monorepo (`packages/*`) implementing an extensible coding-agent CLI published as `oa`. Packages are layered; the build order reflects the dependency direction:

### `@openachieve/tui` (`packages/tui`) — standalone
Terminal UI library with differential rendering. Owns the editor component, keybindings (`keybindings.ts`, `keys.ts`), autocomplete/fuzzy matching, kill-ring, undo stack, and terminal/image plumbing. No dependency on the other packages; consumed by coding-agent's interactive mode.

### `@openachieve/ai` (`packages/ai`) — unified LLM layer
Provider-agnostic LLM API. `stream.ts` (`streamSimple`) is the call boundary; `api-registry.ts` registers providers; `providers/` has per-provider adapters (anthropic, openai-responses/completions, openai-codex-responses, google/google-vertex, amazon-bedrock, mistral, cloudflare, and `faux.ts` for tests). Models are **generated** into `models.generated.ts`/`image-models.generated.ts`. OAuth/subscription login lives in `oauth.ts` + `utils/oauth/`.

### `@openachieve/agent-core` (`packages/agent`) — provider-agnostic agent runtime
- `agent-loop.ts` — the core loop. Works with `AgentMessage` throughout and only transforms to the AI layer's `Message[]` at the LLM call boundary (`convertToLlm`). Exposes `agentLoop` (new prompt) and `agentLoopContinue` (resume from existing context, e.g. retries).
- `harness/` — higher-level orchestration over the loop: `agent-harness.ts`, `compaction/` (context-window compaction + branch summarization), `session/` (pluggable session repos: `jsonl-repo.ts` for disk, `memory-repo.ts` for tests), `skills.ts`, `system-prompt.ts`, `prompt-templates.ts`.
- Depends only on `@openachieve/ai`. Has no coding-specific tools — those live in coding-agent.

### `@openachieve/agent` (`packages/coding-agent`) — the `oa` CLI
The product. Depends on all of the above.
- `core/agent-session.ts` — **the central abstraction shared by all run modes.** Owns agent state, event subscription with automatic session persistence, model/thinking-level management, compaction, bash execution, and session switching/branching. Run modes layer their own I/O on top.
- `core/tools/` — the built-in tools: `read`, `write`, `edit`, `bash`, plus `grep`/`find`/`ls`. Default tool set the agent gets is read/write/edit/bash.
- `core/` also holds: `permission-system.ts`, `subagents/` (scout/planner/worker/reviewer/etc. delegated agents with live-view, parallel runs, intercom), `extensions/` (loader/runner for TypeScript extensions), `mcp/` (Model Context Protocol clients), `skills.ts`, `slash-commands.ts`, `prompt-templates.ts`, `model-registry.ts`/`model-resolver.ts`, `session-manager.ts`, `settings-manager.ts`, `goal-mode/`, `plan-mode/`, `compaction/`.
- `modes/` — three run modes built on `AgentSession`: `interactive/` (the TUI), `print-mode.ts` (one-shot `oa -p "..."`), `rpc/` (JSON-RPC for embedding/SDK use).
- `cli/` — argument parsing, model listing, config/session pickers, initial-message handling.
- `examples/extensions/` are workspace packages (with-deps, custom providers, sandbox, gondolin) and are type-checked by the root config.

### Data flow
`oa` (cli.ts → main.ts) selects a run mode → mode constructs an `AgentSession` (coding-agent) → session drives the `agent-core` harness/loop → loop calls `@openachieve/ai` `streamSimple` at the provider boundary → tool calls execute via `core/tools` under the permission system → events stream back to the mode's I/O (TUI render, print stdout, or RPC frames) and persist to the session repo.

## Testing notes

- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the **faux provider** — no real provider APIs, keys, or paid tokens.
- Put issue-specific regression tests under `packages/coding-agent/test/suite/regressions/` named `<issue-number>-<short-slug>.test.ts`.
- Drive the interactive TUI under tmux for manual testing (see the tmux recipe in `AGENTS.md`).

## Docs

Per-topic docs live in `packages/coding-agent/docs/` (e.g. `usage.md`, `providers.md`, `settings.md`, `extensions.md`, `mcp.md`, `subagents` topics, `rpc.md`, `containerization.md`, `compaction.md`). Each package keeps its own `CHANGELOG.md`; all packages share one lockstep version.
