# pi-subagents 对照本地 oa-subagents：对比与遗漏分析

## Context（为什么做这件事）
用户想用 GitHub `gotgenes/pi-packages` 里的 `@gotgenes/pi-subagents` 包作为参照，
核对本地 Openachieve Agent（`oa`，仓库根 `/Users/kayano/Documents/pi`）是否已经对照实现了同样的
subagents 能力，以及是否存在"影响使用的遗漏"。

## 结论先行
本地 `oa-subagents`（`packages/coding-agent/src/core/subagents/`，约 3 万行）**不是** pi-subagents 的直接搬运，
而是**同源**（带 `compat/` 兼容层映射到 `@openachieve/*` 核心）、**独立演进**、整体**功能更强**的原生实现。
pi-subagents 的能力本地**基本都有对应**，很多更强；但有几处确实缺失或字段不兼容，按"是否影响使用"分级如下。

## 架构对应关系
- pi：3 个工具 `subagent` / `get_subagent_result` / `steer_subagent` + `/agents` 交互菜单。
- 本地：单一多态 `subagent` 工具（`action`: list/get/create/update/delete/status/interrupt/resume/doctor）
  + `intercom`/`contact_supervisor` + slash：`/run` `/chain` `/parallel` `/run-chain` `/subagents-doctor`。
- 工具能力映射：
  - `get_subagent_result` → `subagent({action:"status", id})` ✓
  - `steer_subagent` → `subagent({action:"resume", id, message})`（注入到运行中子 agent）+ `intercom`，外加 `action:"interrupt"` 软中断 ✓
- 默认 agent：pi = general-purpose / Explore / Plan；本地 = scout / planner / worker / reviewer / context-builder / researcher / delegate / oracle（命名不同、是超集）。

## 本地额外有、pi 没有的（更强部分）
chain 链式管道、动态 fanout（expand/collect/outputSchema）、acceptance 验收契约、`structured_output`、
intercom 父子协作、worktree、打包的 prompt 工作流配方（/parallel-review、/review-loop、/parallel-research…）、doctor 诊断。

## 真正的"遗漏 / 不一致"（按影响排序）

### A. 影响较大：可观测性 / 交互体验
1. **没有 `/agents` 交互式管理菜单 + 实时会话查看器**。
   - pi：`/agents` 打开交互菜单（运行中 agent、agent 类型、新建、设置），并能实时滚动查看子 agent 对话。
   - 本地：只有顶部只读 widget（`tui/render.ts`，spinner/token/状态，无按键/滚动）、完成通知、
     `subagent({action:"status"})` 文本报告、会话文件。`agents/agent-management.ts` 只是 list/get/create/update/delete 的程序化逻辑，**不是 TUI 菜单**。
   - 影响：后台/长跑 agent 的实时可见性与交互管理缺一块。

### B. 影响中等：agent `.md` frontmatter 字段不兼容（移植 footgun）
本地解析器是朴素 key:value（`agents/frontmatter.ts`），honored 字段见 `agents/agents.ts`（AgentConfig）：
description/name/package/tools/model/thinking/skill(s)/defaultReads/fallbackModels/systemPromptMode/
inheritProjectContext/inheritSkills/defaultContext/extensions/maxSubagentDepth/completionGuard/output/
defaultProgress/interactive/disabled。未知字段落入 `extraFields` 但**无行为**。

pi 的以下字段会被**静默忽略**：
- `prompt_mode` → 本地用 `systemPromptMode`（append/replace 均支持 ✓，仅字段名不同）
- `inherit_context` → 本地用 `defaultContext`(fresh/fork) + `inheritProjectContext`
- `enabled: false` → 本地用 `disabled: true`（**语义相反**，最易踩坑）
- `max_turns` / `memory` / `isolation` / `permission` → 见 C

直接把 pi 写的 agent `.md` 拷过来，多个字段会被悄悄忽略。

### C. 真正缺失的功能
1. **per-agent 持久 `memory`**（pi 的 `memory: project|local|user`）：本地完全没有；oa 仅有父编排器级全局 MEMORY，不是 per-subagent-type 的跨运行记忆。

2. **`max_turns` 硬轮次上限 + 优雅收尾**（wrap-up 警告 → grace turns → 硬 abort）：本地**零**实现（`grep max_turns/maxTurns/graceTurn` 全 0）。
   取而代之是活动/时间型 attention 模型（`needsAttentionAfterMs`/`activeNoticeAfter*`/`failedToolAttemptsBeforeAttention`）+ 软中断 + acceptance。属"设计差异+替代方案"，但硬轮次预算确实不可用。

3. **per-agent `permission` frontmatter**：本地子 agent 以 `permissionMode:"allow"` 运行（deny 仍生效），不支持 pi 的 per-agent 精细授权 / `ask` 状态转发父 UI。设计差异。

4. **per-agent `isolation` frontmatter**（pi 有，规范每个 agent 定义的隔离策略）：本地 `worktree: true` 只是 per-run 的并行隔离开关，不是 agent 默认属性。

## 不算遗漏（已对应或更强）
并行+后台+并发队列(默认4) ✓；自定义 agent markdown ✓；中途 steer/resume/interrupt ✓；会话 resume ✓；
worktree 隔离 ✓；skill 预加载 ✓；完成通知 ✓；`pi.events` 事件总线 ✓（事件名不同：
`SUBAGENT_ASYNC_STARTED/COMPLETE` `SUBAGENT_CONTROL_EVENT`）；`systemPromptMode` append/replace ✓。

## 关键文件（如需补齐）
- frontmatter 解析与字段：`agents/frontmatter.ts`、`agents/agents.ts`（parseFrontmatter / AgentConfig / 各 `frontmatter.*` 读取）
- 工具与命令注册、事件：`extension/index.ts`、`extension/schemas.ts`、`slash/slash-commands.ts`
- 管理逻辑（无菜单）：`agents/agent-management.ts`
- widget 渲染：`tui/render.ts`
- 控制/attention 模型（替代 max_turns）：`runs/shared/long-running-guard.ts`、`runs/shared/completion-guard.ts`、`extension/control-notices.ts`

## 对照表：pi-subagents 功能 → 本地对应

| pi-subagents 特性 | 本地 oa-subagents | 状态 |
|------------------|------------------|------|
| 3 个工具(subagent/get_subagent_result/steer_subagent) | 单一多态 `subagent` 工具 + action | ✓ 已对应（设计更简洁） |
| 并行 background agents + 并发队列 | async: true + concurrency | ✓ 已对应 |
| 自定义 agent 类型 (.md + YAML frontmatter) | .md + frontmatter | ✓ 已对应 |
| 默认 agent: general-purpose/Explore/Plan | scout/planner/worker/reviewer/context-builder/researcher/delegate/oracle | ✓ 超集（8 个 vs 3 个）|
| 中途 steering | action:"resume" + intercom | ✓ 已对应 |
| Session resume | action:"resume" + 会话文件 | ✓ 已对应 |
| Context inheritance (fresh/fork) | context: fresh\|fork + inheritProjectContext | ✓ 已对应 |
| Skill preloading | skill: 参数 + assets/skills/ | ✓ 已对应 |
| Live widget UI (spinner/tokens/status) | tui/render.ts widget | ✓ 已对应 |
| `/agents` 交互菜单 + 实时会话查看器 | **无** | ✗ 缺失（仅程序化 management + status 文本报告）|
| Git worktree isolation | worktree: true | ✓ 已对应 |
| `max_turns` + grace turns + wrap-up warning | **无** | ✗ 缺失（替代方案：attention 模型 + 软中断）|
| per-agent `memory` (project/local/user) | **无** | ✗ 缺失 |
| per-agent `permission` frontmatter | **无** (permissionMode: allow 全局) | ✗ 缺失 |
| per-agent `isolation` frontmatter | **无** (worktree 是 per-run) | ✗ 缺失 |
| Lifecycle events (pi.events) | pi.events.on / emit | ✓ 已对应（事件名稍异）|
| Completion notifications | notify.ts | ✓ 已对应 |
| `systemPromptMode: append\|replace` | systemPromptMode: append\|replace | ✓ 已对应 |
| Chain execution | chain: [...] | ✓ 超集（+ 动态 fanout）|
| Structured output | outputSchema + structured_output | ✓ 超集 |
| Acceptance contracts | acceptance: {...} | ✓ 超集（pi 无） |
| Intercom parent-child coordination | intercom/contact_supervisor | ✓ 超集（pi 基础版）|
| Prompt templates (/parallel-review etc) | /parallel-review + 9 个配方 | ✓ 超集（pi 无）|
| Doctor diagnostics | action:"doctor" | ✓ 超集（pi 无）|

## 推荐行动
1. **高优先级**：评估是否需要 `/agents` 交互菜单 + 实时会话查看器（影响 UX）。
2. **中优先级**：决定是否兼容 pi frontmatter 字段（`prompt_mode`/`enabled`/`inherit_context`）以便复用社区 agent 定义。
3. **低优先级**：per-agent `memory` / `max_turns` / `permission` 是否为刚需（当前 workaround：全局 MEMORY、attention 模型、permissionMode: allow）。
