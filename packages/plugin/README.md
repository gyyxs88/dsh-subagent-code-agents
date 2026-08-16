# @dsh-subagent-code-agents/plugin

多渠道编码代理子代理插件的内部实现包（Codex / Claude Code / Grok Build）。本包由根公开发行包 `dsh-subagent-code-agents` 通过 `bundleDependencies` 打包引用；一般情况下无需单独安装。

完整文档见仓库根 [README.md](../README.md)。

- **Providers**：`coding-agent/codex`、`coding-agent/claude-code`、`coding-agent/grok-build`
- **工具**：`subagent_code`、`coding_sessions_list`、`coding_session_read`、`coding_session_start`、`coding_session_send`
- **渠道配置名**：codex → `nodeExecutable` / `codexJs`；claude-code → `claudeExecutable`（真实二进制，不接受 `.cmd/.ps1`）；grok-build → `grokExecutable`（同上）
- 与旧 `dsh-subagent-codex` 插件可共存（provider 命名不同）
