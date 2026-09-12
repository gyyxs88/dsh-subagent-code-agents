# @dsh-subagent-code-agents/plugin

多渠道编码代理子代理插件的内部实现包（Codex / Claude Code / Grok Build / 可配置 ACP）。本包由根公开发行包 `dsh-subagent-code-agents` 通过 `bundleDependencies` 打包引用；一般情况下无需单独安装。

完整文档见仓库根 [README.md](../README.md)。

- **Providers**：`coding-agent/codex`、`coding-agent/claude-code`、`coding-agent/grok-build`、按配置生成的 `coding-agent/acp/<name>`
- **工具**：`subagent_code`、`coding_sessions_list`、`coding_session_read/start/send/cancel`、`coding_runs_list`、`coding_run_read/resume/cancel`；后台 run 默认在终态持久回报并自动唤醒拥有者，运行中可通过 `coding_run_read` 或显式 `job_output` 读取有界公开进度
- **渠道配置名**：codex → `codexExecutable`（原生二进制或 POSIX 启动器，跨平台优先）或 `nodeExecutable` + `codexJs`（不可同时配置）；claude-code → `claudeExecutable`（真实二进制，不接受 `.cmd/.ps1`，Agent SDK 复用其登录/配置）；grok-build → `grokExecutable`（同上）以及可选 `grokHome`（自定义会话存储目录）
- **平台状态**：Windows 已实机验证；macOS 仅提供兼容性实现，需用户自行测试并通过仓库 Issues 反馈
- **工具配置**：`roles` / `rolesFile` 提供严格角色；角色可声明只降不升的 `executionPermission` 和 `backgroundOnly`；`runRegistryPath` 可覆盖插件自有运行登记位置
- **模式挂载**：bundle 默认把工具自动挂到所有 Agent preset，唯独排除 `minimal`；已有手工工具行会被识别并保留
- **Skill**：bundle 注册 `dsh-code-agents`；`subagent_code` 默认后台，行动顾问固定使用只读、仅后台 `action-advisor` 角色，完成时由插件自动回报；询问进度时先用 `coding_run_read`，不根据一次空 `job_output` 误判无进度，也不持续轮询
- 与旧 `dsh-subagent-codex` 插件可共存（provider 命名不同）

## 官方优先策略

本插件只补充官方当前缺失的渠道、外部会话续接、持久运行回报和严格角色能力。普通 DSH 子代理及已安装官方后端可满足的一次性任务优先走官方工具；不替换官方工具名、权限或 Job 生命周期，也不在结果不确定时自动换入口重发。使用边界随包内 dsh-code-agents Skill 一起交付。
