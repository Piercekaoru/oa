# Openachieve Agent

Openachieve Agent is a terminal-first coding agent CLI.

It is built as a TypeScript monorepo around four packages: the CLI, the agent runtime, the unified AI provider layer, and the terminal UI package.

The CLI is published on npm as `@openachieve/agent` and exposes the `oa` command.

---

## Install

```bash
npm install -g --ignore-scripts @openachieve/agent
```

Start the CLI:

```bash
oa
```

`--ignore-scripts` is recommended for safer npm installs.

---

## Requirements

```bash
node >= 22.19.0
```

Check your local version:

```bash
node -v
```

---

## Quick Start

Open a project and run OA:

```bash
cd your-project
oa
```

Then ask it to help with your codebase:

```text
Explain this repository.
```

```text
Find the bug in this feature and suggest a fix.
```

```text
Refactor this module without changing the public API.
```

```text
Run the tests and help me understand the failures.
```

---

## Packages

| Package | Purpose |
| --- | --- |
| [`@openachieve/agent`](packages/coding-agent) | Interactive coding agent CLI. This package exposes the `oa` command. |
| [`@openachieve/agent-core`](packages/agent) | Agent runtime with tool calling and state management. |
| [`@openachieve/ai`](packages/ai) | Unified multi-provider LLM API. |
| [`@openachieve/tui`](packages/tui) | Terminal UI library with differential rendering. |

Install the CLI globally:

```bash
npm install -g --ignore-scripts @openachieve/agent
```

Install the libraries directly:

```bash
npm install @openachieve/ai
npm install @openachieve/agent-core
npm install @openachieve/tui
```

---

## Development

Clone the repository:

```bash
git clone https://github.com/Piercekaoru/oa.git
cd oa
```

Install dependencies:

```bash
npm install --ignore-scripts
```

Build all packages:

```bash
npm run build
```

Run checks:

```bash
npm run check
```

Run tests:

```bash
./test.sh
```

Run OA from source:

```bash
./oa-test.sh
```

---

## Contributing

PRs are welcome.

Good contributions include:

- fixing bugs
- improving docs
- adding examples
- improving provider support
- improving error messages
- testing OA on more platforms
- simplifying confusing code

Before submitting a PR, read [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`AGENTS.md`](AGENTS.md).

Then run:

```bash
npm run check
./test.sh
```

Both should pass.

Keep PRs focused. A small clean PR is easier to review and easier to merge.

If your change is useful, thoughtful, and aligned with the project, send the PR. I will review it and merge it.

---

## Safety

OA runs with the permissions of the process that starts it.

For stronger isolation, run OA inside a container or sandbox.

See [`packages/coding-agent/docs/containerization.md`](packages/coding-agent/docs/containerization.md) for containerization patterns.

---

## Supply Chain

This repository treats dependency changes as code changes.

Important details:

- npm installs use `--ignore-scripts` where possible.
- Direct external dependencies are pinned.
- `package-lock.json` is the dependency source of truth.
- The published CLI includes a shrinkwrap file for transitive dependency pinning.

---

## Philosophy

A coding agent should not feel like a locked room.

It should feel like a door.

Open it. Inspect it. Improve it. Send a PR.

---

## License

MIT
