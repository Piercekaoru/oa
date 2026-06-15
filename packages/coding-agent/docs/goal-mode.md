# Goal Mode

Goal mode is a built-in autonomous loop. You give Openachieve Agent a goal; it locks a contract, then works turn-by-turn on its own until the goal is **verifiably done** — confirmed by running a verify command and approved by an independent judge. No extension installation is required.

It is the native equivalent of the "Ralph loop with a judge": instead of you prompting after every step, the agent keeps going until done, blocked, or out of budget.

## Starting a goal

- `/goal <intent>` — describe what you want done
- `oa --goal "<intent>"` — start a session already pursuing a goal
- `Ctrl+Alt+G` — show the current goal status

When you start a goal, the agent either asks clarifying questions (if the goal is vague) or proposes a **contract** and asks you to approve it:

- **goal** — the outcome
- **doneCriteria** — concrete, checkable conditions
- **verifyCommand** — a shell command (run via bash) whose success proves the goal is done (e.g. your test, lint, or build command)
- **askBefore** — bash command substrings that require your confirmation
- **budget** — max auto-continue turns (default 20)
- **judge** — the completion judge (see below)

After you approve, the agent works automatically. The footer shows `◎ goal n/budget` while active.

## The loop and its safeguards

Each turn the agent makes real progress and records a one-line note. After every turn it auto-continues, subject to:

- **Budget** — after `budget` auto-continue turns the loop pauses and tells you to `/goal resume` (which resets the budget).
- **Spin guard** — a turn that produces no tool actions blocks the goal, so the agent can't burn turns "thinking" without doing.
- **Ask-before gate** — bash commands matching the contract's `askBefore` list require your confirmation.
- **You always preempt** — anything you type takes priority over the next auto-continuation. Use `/goal ask <question>` for a side question that does not preempt.

## Completion is judged

The agent declares done by calling its `goal_complete` tool, which runs the `verifyCommand` and submits the result plus cited evidence to an independent **judge** model. The goal only transitions to `done` if the judge approves; otherwise the loop continues and the agent must supply stronger evidence.

A single model judging its own work tends to declare success prematurely, so a judge is **required**:

- `/goal judge <provider>/<modelId>` — set a cross-model judge default (recommended; e.g. `anthropic/claude-opus-4-7`)
- `/goal judge same` — same-model self-judge (weaker; use only when no second model is available)
- `/goal judge clear` — unset the default; future goals must then specify a judge

A per-goal judge always overrides the session default. If neither is set, the agent's `goal_set` is refused with `judge_unspecified`. If the judge model is unavailable or returns an unparseable response, completion **fails open** (approves with a warning) so infrastructure glitches don't block legitimate completion.

## Commands

| Command | Purpose |
| --- | --- |
| `/goal <intent>` | Start setup for a new goal |
| `/goal status` | One-line current state |
| `/goal pause` | Halt the auto-continue loop, keep state |
| `/goal resume` | Resume and reset the turn budget |
| `/goal cancel` | Clear the current goal |
| `/goal budget <n>` | Change the turn budget (1..20000; large values prompt to confirm) |
| `/goal judge <p>/<m>` | Set a cross-model judge default |
| `/goal judge same` | Use same-model self-judge by default |
| `/goal judge clear` | Unset the judge default |
| `/goal autopilot` | Toggle skipping the contract confirmation dialog |
| `/goal ask <question>` | Ask a side question without preempting the loop |
| `/goal help` | Show the command list |

## Tools the agent uses

| Tool | Purpose |
| --- | --- |
| `goal_set` | Lock the contract after you approve |
| `goal_progress` | Record a one-line progress note |
| `goal_complete` | Run the verifyCommand and submit evidence to the judge |
| `goal_block` | Pause with a question only you can answer |

## Notes

- Goal state (contract, progress, evidence, judge default) is persisted with the session and restored on resume.
- Goal mode composes with the permission system, which still applies to every tool the agent runs.
- The verifyCommand runs through bash; there is no extra tooling to install.
