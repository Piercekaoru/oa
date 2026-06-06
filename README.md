# Openachieve Agent

Openachieve Agent is a self-extensible coding agent CLI and supporting runtime packages. Install the CLI to run `oa` in a project, then extend it with TypeScript extensions, skills, prompt templates, themes, and Openachieve packages.

## Packages

| Package | Description |
|---------|-------------|
| **[@openachieve/ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@openachieve/agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@openachieve/agent](packages/coding-agent)** | Interactive coding agent CLI, exposed as `oa` |
| **[@openachieve/tui](packages/tui)** | Terminal UI library with differential rendering |

## Install

Requires Node.js 22.19.0 or newer.

```bash
npm install -g --ignore-scripts @openachieve/agent
```

`--ignore-scripts` disables dependency lifecycle scripts during install. Openachieve Agent does not require install scripts for normal npm installs.

## First run

Start `oa` in the project directory you want it to work on:

```bash
cd /path/to/project
oa
```

Then type a request and press Enter. By default, Openachieve Agent gives the model four tools: `read`, `write`, `edit`, and `bash`.

For one-shot prompts:

```bash
oa -p "Summarize this codebase"
cat README.md | oa -p "Summarize this text"
```

## Authentication

Use `/login` for subscription providers:

```text
/login
```

Built-in subscription logins include Claude Pro/Max, ChatGPT Plus/Pro (Codex), and GitHub Copilot.

Or set an API key before launching `oa`:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
oa
```

See [packages/coding-agent/docs/providers.md](packages/coding-agent/docs/providers.md) for all supported providers.

## Documentation

- [Quickstart](packages/coding-agent/docs/quickstart.md) - install, authenticate, and run a first session.
- [Using Openachieve Agent](packages/coding-agent/docs/usage.md) - interactive mode, slash commands, sessions, context files, and CLI reference.
- [Settings](packages/coding-agent/docs/settings.md) - global and project configuration.
- [Openachieve packages](packages/coding-agent/docs/packages.md) - install shared extensions, skills, prompts, and themes.
- [CONTRIBUTING.md](CONTRIBUTING.md) - contribution guidelines.
- [AGENTS.md](AGENTS.md) - project-specific rules for humans and agents.

## Permissions & Containerization

Openachieve Agent does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox Openachieve Agent. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **OpenShell**: run the whole `oa` process in a policy-controlled sandbox.
- **Gondolin extension**: keep `oa` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `oa` process in a local container for simple isolation.

## Development from source

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build        # Build all packages
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./oa-test.sh         # Run oa from sources (can be run from any directory)
```

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `OPENACHIEVE_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Local release installs, documented npm installs, and `oa update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## License

MIT
