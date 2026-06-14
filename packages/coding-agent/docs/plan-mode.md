# Plan Mode

Plan mode is a built-in read-only exploration mode. When enabled, Openachieve Agent can read and analyze your codebase but cannot modify files — it produces a numbered plan you review before any changes are made. No extension installation is required.

## Enabling plan mode

- `/plan` — toggle plan mode on/off
- `Ctrl+Alt+P` — toggle plan mode
- `oa --plan` — start a session already in plan mode

While plan mode is active the footer shows `⏸ plan`.

## How it works

1. **Explore (read-only)**: only read-only tools are available — `read`, `bash` (allowlisted commands only), `grep`, `find`, `ls`. `edit` and `write` are disabled.
2. **Plan**: the agent writes a detailed, numbered plan under a `Plan:` header.
3. **Review**: when the agent finishes, you choose what happens next:
   - **Execute the plan** — restores full tool access and runs the steps. As the agent marks steps with `[DONE:n]`, progress is tracked in a todo widget.
   - **Stay in plan mode** — keep exploring or refining.
   - **Refine the plan** — open an editor to add guidance that is sent back to the agent.

## Read-only command allowlist

In plan mode, `bash` only runs read-only commands (for example `cat`, `head`, `grep`, `ls`, `find`, `rg`, `git status`, `git log`, `git diff`, `git show`). Mutating commands are blocked, including `rm`, `mv`, `cp`, `mkdir`, `chmod`, output redirects (`>`, `>>`), `git commit`/`push`/`merge`, package installs (`npm install`, `pip install`, `brew install`, …), `sudo`, and process control (`kill`, `systemctl`, …). Toggle plan mode off with `/plan` to run such commands.

## Commands

- `/plan` — toggle plan mode
- `/todos` — show the current plan's steps and completion progress

## Notes

- Plan mode state and the extracted plan steps are persisted with the session and restored on resume.
- Plan mode protects against accidental edits during analysis; it does not replace the permission system, which still applies once you execute.
