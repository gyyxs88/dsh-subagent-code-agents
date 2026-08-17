# @dsh-subagent-code-agents/plugin

多渠道编码代理子代理插件的内部实现包（Codex / Claude Code / Grok Build / 可配置 ACP）。本包由根公开发行包 `dsh-subagent-code-agents` 通过 `bundleDependencies` 打包引用；一般情况下无需单独安装。

完整文档见仓库根 [README.md](../README.md)。

- **Providers**：`coding-agent/codex`、`coding-agent/claude-code`、`coding-agent/grok-build`、按配置生成的 `coding-agent/acp/<name>`
- **工具**：`subagent_code`、`coding_sessions_list`、`coding_session_read/start/send`、`coding_runs_list`、`coding_run_read/resume/cancel`
- **渠道配置名**：codex → `codexExecutable`（原生二进制或 POSIX 启动器，跨平台优先）或 `nodeExecutable` + `codexJs`（不可同时配置）；claude-code → `claudeExecutable`（真实二进制，不接受 `.cmd/.ps1`）；grok-build → `grokExecutable`（同上）
- **平台状态**：Windows 已实机验证；macOS 仅提供兼容性实现，需用户自行测试并通过仓库 Issues 反馈
- **工具配置**：`roles` / `rolesFile` 提供严格角色；`runRegistryPath` 可覆盖插件自有后台运行登记位置
- 与旧 `dsh-subagent-codex` 插件可共存（provider 命名不同）
