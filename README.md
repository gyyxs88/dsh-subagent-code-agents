# dsh-subagent-code-agents

多渠道编码代理（coding-agent）子代理插件：一个 **npm workspaces monorepo**，把 OpenAI Codex、Anthropic Claude Code、Grok Build 三个 CLI 后端统一挂到 DeepSeek Harness（DSH）的 `subagents` 注册表上，同时**保留旧 `dsh-subagent-codex` 插件原样不动**、可共存。

```
packages/
  core/                    渠道适配器接口 + 注册表 + 统一结果 + Runtime 注入（无 DSH 依赖）
  channel-codex/           Codex 渠道（exec/resume + app-server 会话，固定绕过审批与沙箱）
  channel-claude-code/     Claude Code 渠道（headless -p，固定 bypassPermissions）
  channel-grok-build/      Grok Build 渠道（headless -p，固定权限，诚实报告非沙箱关闭）
  plugin/                  公开包 dsh-subagent-code-agents：cordis.patch.yml + 宿主组合 + 工具
```

## 架构

- **core** 定义 `CodingAgentChannel` 小接口（run / resume / listSessions / readSession / startManagedSession / steerActive / cancel / dispose）与能力标记（capabilities）。渠道之间**没有巨型基类、没有按渠道 switch**——每个渠道是独立包里的一个小 adapter，通过共享 `ChannelRegistry` 注册。
- **渠道包**是纯 adapter：只依赖 core 与注入的 `RuntimeEnv`（subprocess / fs / path / logger / signal / cwd）。它们**不得包含 DSH 注册或 Cordis patch**，因此可独立测试、独立版本化、独立发布。
- **plugin** 是唯一接触 DSH 的包：持有 `cordis.patch.yml`，用 `RuntimeEnv` 把 DSH 的 `ctx.subprocess` 注入渠道，把渠道桥接为 `SubagentProvider`（命名 `coding-agent/<channel>`），并注册工具。**旧插件注册的 `codex` 与这里的 `coding-agent/codex` 名称不同，可并存。**
- **故障隔离**：单渠道注册失败只记录错误，不阻断兄弟渠道；能力缺口一律显式结构化拒绝（`unsupported`），**禁止静默忽略或 fallback**。

## 能力矩阵

| 能力 | codex | claude-code | grok-build |
| --- | :-: | :-: | :-: |
| run（一次性） | ✅ | ✅ | ✅ |
| resume（续跑会话） | ✅ | ✅ | ✅ |
| listSessions / readSession | ✅ | ❌ | ❌ |
| managedSession（`thread/start` 托管会话） | ✅ | ❌ | ❌ |
| steerActive（真 steer） | ✅ | ❌ | ❌ |
| cancel | ✅ | ❌ | ❌ |
| streaming | ❌ | ❌ | ❌ |
| modelOverride / effortOverride | ✅ | ✅ | ✅ |
| **sandboxBypassGuaranteed** | ✅ | ❌ | ❌ |

> `sandboxBypassGuaranteed` 是"真实保证"，不是口号：
> - **codex**：CLI 每次 `--dangerously-bypass-approvals-and-sandbox`；app-server `thread/start`/`turn/start` 固定 `approvalPolicy:"never"` + `sandbox:"danger-full-access"`/`sandboxPolicy:{type:"dangerFullAccess"}` → **true**。
> - **claude-code**：固定 `--permission-mode bypassPermissions`，但 Claude Code 没有独立的"关闭沙箱"开关暴露给 CLI → **false**。README 明示：绕过权限审批 ≠ 沙箱关闭。
> - **grok-build**：固定 `--permission-mode bypassPermissions` + `--no-auto-update`；本机 1.0.3 `--help` 无任何可验证的 off/unrestricted 沙箱模式 → **false**。权限绕过不等于沙箱关闭。

## 统一结果

每个渠道操作返回同一个 `ChannelResult`：

```ts
{
  channel: 'codex' | 'claude-code' | 'grok-build',
  runId: string,
  sessionId?: string,
  stopReason: 'completed' | 'aborted' | 'error' | 'refused' | 'unsupported',
  output: string,
  delivery?: 'managed_turn_started' | 'steered' | 'resume_unmanaged' | 'external_or_idle' | 'refused' | 'failed',
  mayBeConcurrent?: boolean,
  capabilities: ChannelCapabilities,
}
```

诚实投递语义（继承旧插件的边界，全部保留）：
- `notLoaded`（可能空闲，也可能正被其他 Codex/Claude/Grok 进程使用）**绝不**凭 mtime 断言 active；只报 `external_or_idle`。
- 真 steer 仅限**本插件 app-server 托管且已知 owned activeTurnId** 的 codex 会话；steer 失败**绝不**降级 resume。
- 显式 `resume_session_id` → `resume_unmanaged` + `mayBeConcurrent:true`（可能与其他进程并发）。
- `systemError` 硬失败，不自动续跑。
- 会话历史/预览有数量与字符上限（全局预算），不读取密钥/登录态。

## 工具接口

- **`subagent_code`** — 必填 `channel` / `description` / `prompt`；可选 `model` / `reasoning_effort` / `resume_session_id` / `run_in_background`。渠道不支持某能力时显式 `unsupported` 拒绝。
- **`coding_sessions_list`** — 必填 `channel`；默认按调用者 cwd 过滤，`include_all:true` 显式跨项目；`limit` 1..100。
- **`coding_session_read`** — 必填 `channel` + `session_id`；`max_turns` 1..20。
- **`coding_session_start`** — 必填 `channel` + `prompt`；可选 `model` / `reasoning_effort` / `cwd`。
- **`coding_session_send`** — 必填 `channel` + `session_id` + `prompt`；托管会话 active 时 steer，否则显式拒绝。

> 工具名统一为：`subagent_code`、`coding_sessions_list`（复数，列表）、`coding_session_read/start/send`（单数，单会话操作）。不暴露旧工具名 `subagent_codex`（旧插件保留它，新插件不用），也不提供旧的 plural 别名。

## 安装

根包 `dsh-subagent-code-agents` 就是公开发行包（**不是** private workspace 根）。`bundleDependencies` 把四个内部 `@dsh-subagent-code-agents/*` 包打进根 tarball，因此**直接 GitHub/tarball 安装即可，不要求内部 scoped 包先发布**。

```jsonc
// <profile>/package.json
{
  "dependencies": {
    "dsh-subagent-code-agents": "github:gyyxs88/dsh-subagent-code-agents#<tag>"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-subagent-code-agents"]
    }
  }
}
```

> 内部包（`@dsh-subagent-code-agents/core`、`channel-codex`、`channel-claude-code`、`channel-grok-build`、`plugin`）位于 `packages/*`，未来也可独立发布、独立维护；但从消费者视角它们被 bundle 进根包，无需单独安装。

`cordis.patch.yml` 自动挂三行 provider（每行独立 executable/config）：

```yaml
- id: coding-agent-codex
  name: 'dsh-subagent-code-agents'
  config: { channel: codex, providerName: coding-agent/codex }
- id: coding-agent-claude-code
  name: 'dsh-subagent-code-agents'
  config: { channel: claude-code, providerName: coding-agent/claude-code }
- id: coding-agent-grok-build
  name: 'dsh-subagent-code-agents'
  config: { channel: grok-build, providerName: coding-agent/grok-build }
```

每行可配置渠道专属 executable：`nodeExecutable` / `codexJs`（codex）、`claudeExecutable`（claude-code，须为真实二进制，不接受 `.cmd/.ps1`）、`grokExecutable`（grok-build，同上）。

> **工具行**：与旧插件一样，`subagent_code` 与 `coding_sessions_*` 工具由 preset 中的工具行暴露。在会话 preset 的 `agent.cordis.yml` 加入：

```yaml
- id: tool-subagent-code-agents
  name: 'dsh-subagent-code-agents/tool'
```

## 从旧 dsh-subagent-codex 迁移

| 旧 | 新 |
| --- | --- |
| `subagent_codex`（provider `codex`） | `subagent_code`（`channel: "codex"`，provider `coding-agent/codex`） |
| `subagent_codex.resume_session_id` | `subagent_code.resume_session_id`（语义一致：`codex exec resume`） |
| `codex_sessions_list` / `read` / `start` / `send` | `coding_sessions_list` / `coding_session_read` / `coding_session_start` / `coding_session_send`（需显式 `channel: "codex"`） |
| `tool-subagent-codex` 工具行 | `tool-subagent-code-agents` 工具行（需按上文在 preset 中加入；非自动启用） |

固定安全策略不变：codex 始终 `--dangerously-bypass-approvals-and-sandbox`；app-server 始终 `never` + `dangerFullAccess`；`sandboxMode` 配置不存在。

## 新增一个渠道

1. 新建 `packages/channel-<name>/`，实现 `CodingAgentChannel`（小 adapter，见 core 类型）。
2. 包内写 argv 构造 + 输出解析 + fake runtime 测试；**不含任何 DSH/Cordis 代码**。
3. 在 `plugin/lib/index.js` 的 `CHANNEL_FACTORIES` 加一行工厂。
4. 在 `cordis.patch.yml` 加一行 provider（channel + providerName）。
5. 工具层无需改动：`subagent_code` / `coding_sessions_*` 自动按 `channel` 字段路由到注册表，能力缺口自动显式拒绝（`unsupported`）。core 在注册时校验"能力为 true 必须有对应方法"，防止渠道虚报能力。

> 注意：新增渠道需要修改 plugin 的静态工厂表与 patch（core 本身不用改）。"渠道自行导入即注册"不成立——渠道包是纯 adapter，由 plugin 显式装配。

### R0 能力缺口（第二轮修复后仍保留）

- **Claude Code / Grok Build 的会话能力（list/read/start/send）为 false**：这两个渠道的 `coding_sessions_*` 工具会显式返回 `unsupported`。渠道包中保留的 `parseClaudeSessionsJson` / `parseGrokSessions` 是**未启用的纯函数占位**——Claude 的官方 JSONL transcript 与会话列表格式、Grok 的 SQLite 会话存储都**未**在本轮实现为可用能力，capability 保持 `false` 是权威状态，不以存在 parser 函数为"已实现"。
- **ACP managed transport 未实现**：`steerActive` 对 claude/grok 为 `false`；codex 的真 steer 仅限 app-server 托管会话。
- **固定 full-access 策略**：codex `sandboxBypassGuaranteed=true`；claude/grok 仅权限审批绕过（`bypassPermissions`），沙箱关闭无保证（`false`）。

## 开发与测试

```bash
npm install                 # 链接 workspaces
npm run check               # 全部包语法检查
npm test                    # 全部测试（fake runtime/fs/ACP，不启动真实 provider）
npm run test:codex          # 定向：codex 渠道
npm run test:claude         # 定向：claude-code 渠道
npm run test:grok           # 定向：grok-build 渠道
npm run test:plugin         # 定向：plugin 挂载/工具
npm run pack:check          # 打包验证：5 个 workspace tgz 清单 + 根 tgz 单包安装 smoke
```

测试使用 fake subprocess/fs/ACP，**不调用真实模型、不启动真实 provider、不读写密钥/登录态**。`pack:check` 会把根包真实 `npm pack` 到系统临时目录、在一次性 consumer 中 `npm install` 根 tgz（`--ignore-scripts --legacy-peer-deps`，peer 从 workspace 的 node_modules 显式提供以模拟真实 DSH 宿主），验证 `dsh-subagent-code-agents` 与 `/tool` 可 import、5 个 bundled 内部依赖真实存在，随后清理所有临时文件/tgz。

## License

MIT
