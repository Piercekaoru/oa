# Subagents 功能实施总结

**实施日期**: 2026-06-08  
**提交**: 2aacaad2

## ✅ 今日已完成（Phase 1）

### 1. `/agents` 命令（列表模式）✓
**文件**: `packages/coding-agent/src/core/subagents/slash/agents-command.ts`

功能：
- 列出所有可用 agent（builtin/user/project）
- 显示名称、作用域、模型、描述
- 可视化指示器：● builtin / ◦ user / • project / ✕ disabled
- 支持 `--scope=<builtin|user|project>` 过滤
- 支持 `--chains` 显示可用链
- Tab 自动完成（agent 名称和标志）

输出格式：
```
Name        Scope      Model      Description
────────────────────────────────────────────────
scout       ● builtin  inherit    Fast codebase recon
planner     ● builtin  inherit    Creates implementation plans
...
```

### 2. `/agents <name>` 命令（检查模式）✓
**文件**: 同上

功能：
- 显示单个 agent 的完整配置
- 文件路径、系统提示预览、工具、模型、thinking 等
- 显示 settings.json 的有效覆盖
- 显示 override 信息（如果有）

输出示例：
```
scout [builtin]
────────────────────────────────────────────────
Description:
Fast codebase recon

Configuration:
  Model: inherit
  Thinking: low
  System prompt mode: replace
  ...

System prompt preview:
You are a scout agent...
...
```

### 3. 文档更新 ✓
**文件**: 
- `packages/coding-agent/src/core/slash-commands.ts`
- `packages/coding-agent/docs/usage.md`

更新内容：
- 在 `BUILTIN_SLASH_COMMANDS` 添加 6 个 subagent 命令
- 在 `usage.md` 添加完整的 "Subagent Commands" 章节
- 说明 `/agents`、`/run`、`/chain`、`/parallel`、`/run-chain`、`/subagents-doctor`
- 包含 `--bg` 和 `--fork` 标志说明
- 列出 8 个内置 agent 及其用途

### 4. 集成与测试 ✓
- 注册命令到 `registerSlashCommands()`
- TypeScript 编译通过
- 构建成功（`npm run build`）
- 与现有 `discoverAgentsAll()` API 集成

## ⏳ 待完成（Phase 2）

### 4. Widget 可点击打开实时对话查看器（推迟）
**原因**: 技术复杂度高，需要：
- Widget 组件支持键盘交互（当前为只读）
- 解析 session.jsonl 文件实时读取
- 创建覆盖层对话查看器组件
- 实现自动跟随和手动滚动
- 处理消息格式化、工具调用高亮

**建议**: 作为独立任务在后续迭代中实施（预计 1-2 天）

**替代方案（当前）**:
- 用户可用 `subagent({action:"status", id})` 查看文本状态报告
- Widget 显示压缩状态（当前工具、最近 3 工具、最后 5 行输出）
- 会话文件路径显示在 widget 和通知中
- 用户可手动 `tail -f` 日志文件

## 📊 代码统计

**新增文件**: 1
- `packages/coding-agent/src/core/subagents/slash/agents-command.ts` (268 行)

**修改文件**: 3
- `packages/coding-agent/src/core/slash-commands.ts` (+6 行)
- `packages/coding-agent/src/core/subagents/slash/slash-commands.ts` (+7 行)
- `packages/coding-agent/docs/usage.md` (+21 行)

**文档文件**: 1
- `pi-subagents-comparison.md` (完整对比分析)

**总计**: +408 行（包括新文件）

## 🎯 达成目标

根据调研工作流的建议，成功实施：

✅ **发现性缺口修复**: 用户现在可以通过 `/agents` 浏览所有可用 agent  
✅ **文档可见性**: subagents 现在出现在 `/help` 和 `usage.md` 中  
✅ **检查能力**: `/agents <name>` 显示完整配置和有效覆盖  
✅ **行业标准对齐**: 提供专门的管理命令（参考 Claude Code `/agents`）  
✅ **零破坏性**: 纯增量功能，不影响现有 API

## 🔄 下一步建议

### 优先级 1（发布后第一周）
1. **实时对话查看器**（任务 #4）
   - 基于 TUI `SelectList` 和 overlay API
   - 读取 session.jsonl 并流式显示
   - 键盘导航：↑↓/PgUp/PgDn/Esc
   - 自动跟随模式（可暂停）

### 优先级 2（按需）
2. **`/runs` 命令**（如果后台 agent 使用量大）
   - 列出活动/完成的后台运行
   - 显示状态、runId、日志路径、时长、tokens
   - 快速访问 `subagent({action:"status", id})`

### 优先级 3（用户反馈后）
3. **Agent 创建/编辑 UI**（如果用户要求）
   - 交互式 agent 创建向导
   - TUI 编辑器（而非手动文件编辑）
   - 验证和模板

## 📝 用户体验改进

**改进前**:
- 用户不知道有 subagents 功能
- 必须让模型调 `subagent({action:"list"})` 并转述
- `/help` 不显示相关命令
- 文档零提及

**改进后**:
- `/agents` 列出所有可用 agent（带描述）
- `/agents scout` 查看详细配置
- `/help` 显示 6 个 subagent 命令
- `usage.md` 有完整的 Subagents 章节
- Tab 自动完成 agent 名称

## 🐛 已知限制

1. **对话查看器缺失**（Phase 2）: 实时观察运行中 agent 的完整对话需手动查看日志文件
2. **Widget 只读**: 当前 widget 显示状态但不可交互（点击/选择）
3. **无管理 UI**: 创建/编辑 agent 仍需手动文件编辑或 `subagent({action:"create"})`

这些都是已知的待办事项，可在后续迭代中根据用户反馈优先级决定。

## ✨ 亮点

- **快速实施**: Phase 1 核心功能 2-3 天完成（如计划）
- **零破坏性**: 纯增量，不改现有 API
- **文档齐全**: 代码 + 用户文档同步更新
- **行业对齐**: 参考 Claude Code 模式，符合用户期待
- **可扩展**: 为 Phase 2 功能（对话查看器、`/runs`）打好基础
