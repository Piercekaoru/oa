# Openachieve Agent Mono Repo

This is the home of Openachieve Agent, a self-extensible coding agent CLI and supporting runtime packages.

* **[@openachieve/agent](packages/coding-agent)**: Interactive coding agent CLI
* **[@openachieve/agent-core](packages/agent)**: Agent runtime with tool calling and state management
* **[@openachieve/ai](packages/ai)**: Unified multi-provider LLM API (OpenAI, Anthropic, Google, ...)

## All Packages

| Package | Description |
|---------|-------------|
| **[@openachieve/ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@openachieve/agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@openachieve/agent](packages/coding-agent)** | Interactive coding agent CLI, exposed as `oa` |
| **[@openachieve/tui](packages/tui)** | Terminal UI library with differential rendering |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## Development

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
