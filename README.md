# dsh-subagent-code-agents

DeepSeek Harness（DSH）的多渠道编码代理子代理插件：内置 OpenAI Codex、Anthropic Claude Code、Grok Build，并可配置任意数量的 Agent Client Protocol（ACP）实例。它同时提供严格角色、插件自有后台运行登记和诚实的重启后续跑语义；旧 `dsh-subagent-codex` 可原样共存。

```
packages/
  core/                    渠道适配器接口 + 注册表 + 统一结果 + Runtime 注入（无 DSH 依赖）
  channel-codex/           Codex 渠道（exec/resume + app-server 会话，固定绕过审批与沙箱）
  channel-claude-code/     Claude Code 渠道（headless -p，固定 bypassPermissions）
  channel-grok-build/      Grok Build 渠道（headless -p，固定权限，诚实报告非沙箱关闭）
  channel-acp/             通用 ACP v1 客户端（可配置多个 acp/<name> 实例）
  plugin/                  公开包 dsh-subagent-code-agents：cordis.patch.yml + 宿主组合 + 工具
```

## 架构

- **core** 定义 `CodingAgentChannel` 小接口（run / resume / listSessions / readSession / startManagedSession / steerActive / cancel / dispose）与能力标记（capabilities）。渠道之间**没有巨型基类、没有按渠道 switch**——每个渠道是独立包里的一个小 adapter，通过共享 `ChannelRegistry` 注册。
- **渠道包**是纯 adapter：只依赖 core 与注入的 `RuntimeEnv`（subprocess / fs / path / logger / signal / cwd）。它们**不得包含 DSH 注册或 Cordis patch**，因此可独立测试、独立版本化、独立发布。
- **ACP** 是独立的通用渠道包。每一行 `channel: acp` 配置都会创建独立的 `acp/<name>` 注册表项与 `coding-agent/acp/<name>` provider，不需要为 OpenCode、Gemini 等每个 ACP agent 修改 core。
- **plugin** 是唯一接触 DSH 的包：持有 `cordis.patch.yml`，用 `RuntimeEnv` 把 DSH 的 `ctx.subprocess` 注入渠道，把渠道桥接为 `SubagentProvider`（命名 `coding-agent/<channel>`），并注册工具。**旧插件注册的 `codex` 与这里的 `coding-agent/codex` 名称不同，可并存。**
- **故障隔离**：单渠道注册失败只记录错误，不阻断兄弟渠道；能力缺口一律显式结构化拒绝（`unsupported`），**禁止静默忽略或 fallback**。

## 能力矩阵

| 能力 | codex | claude-code | grok-build | `acp/<name>` |
| --- | :-: | :-: | :-: | :-: |
| run（一次性） | ✅ | ✅ | ✅ | ✅ |
| resume（续跑会话） | ✅ | ✅ | ✅ | ✅¹ |
| listSessions / readSession | ✅ | ❌ | ❌ | ❌ |
| managedSession（`thread/start` 托管会话） | ✅ | ❌ | ❌ | ❌ |
| steerActive（真 steer） | ✅ | ❌ | ❌ | ❌ |
| cancel API | ✅ | ❌ | ❌ | ❌² |
| streaming 到 DSH | ❌ | ❌ | ❌ | ❌ |
| modelOverride / effortOverride | ✅ | ✅ | ✅ | ❌ |
| **sandboxBypassGuaranteed** | ✅ | ❌ | ❌ | ❌ |

¹ ACP agent 必须在初始化响应中声明 `agentCapabilities.loadSession=true`，否则续跑显式返回 `unsupported`。² 调用中的 ACP 进程可通过 `session/cancel` 中止，但本插件没有宣称可按外部 session 任意取消，因此 channel capability 保持 `false`。

> `sandboxBypassGuaranteed` 是"真实保证"，不是口号：
> - **codex**：CLI 每次 `--dangerously-bypass-approvals-and-sandbox`；app-server `thread/start`/`turn/start` 固定 `approvalPolicy:"never"` + `sandbox:"danger-full-access"`/`sandboxPolicy:{type:"dangerFullAccess"}` → **true**。
> - **claude-code**：固定 `--permission-mode bypassPermissions`，但 Claude Code 没有独立的"关闭沙箱"开关暴露给 CLI → **false**。README 明示：绕过权限审批 ≠ 沙箱关闭。
> - **grok-build**：固定 `--permission-mode bypassPermissions` + `--no-auto-update`；本机 1.0.3 `--help` 无任何可验证的 off/unrestricted 沙箱模式 → **false**。权限绕过不等于沙箱关闭。
> - **ACP**：权限与沙箱由所配置的 ACP agent 决定；通用客户端不虚构保证 → **false**。

## 统一结果

每个渠道操作返回同一个 `ChannelResult`：

```ts
{
  channel: 'codex' | 'claude-code' | 'grok-build' | `acp/${string}`,
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

- **`subagent_code`** — 必填 `description` / `prompt`，并提供 `channel` 或已配置的 `role`；可选 `model` / `reasoning_effort` / `resume_session_id` / `run_in_background`。显式模型与强度覆盖角色默认值；角色/通道冲突、未知角色和能力缺口都显式拒绝。
- **`coding_sessions_list`** — 必填 `channel`；默认按调用者 cwd 过滤，`include_all:true` 显式跨项目；`limit` 1..100。
- **`coding_session_read`** — 必填 `channel` + `session_id`；`max_turns` 1..20。
- **`coding_session_start`** — 必填 `channel` + `prompt`；可选 `model` / `reasoning_effort` / `cwd`。
- **`coding_session_send`** — 必填 `channel` + `session_id` + `prompt`；托管会话 active 时 steer，否则显式拒绝。
- **`coding_runs_list` / `coding_run_read`** — 查看本插件创建的后台运行；不会保存原始 prompt。
- **`coding_run_resume`** — 从有 sessionId 且当前通道仍支持 resume 的旧记录启动一个**新的**后台运行，并以 `resumedFrom` 关联。
- **`coding_run_cancel`** — 只取消当前插件进程真实持有的 active run；重启前的记录会明确拒绝取消。

### 严格角色

工具行可直接配置角色，也可用 `rolesFile` 指向不超过 256 KiB 的 JSON 文件。每个角色必须有唯一 `id` 和固定 `channel`：

```yaml
- id: tool-subagent-code-agents
  name: 'dsh-subagent-code-agents/tool'
  config:
    roles:
      - id: reviewer
        channel: codex
        model: gpt-5.6-codex
        reasoningEffort: xhigh
        instructions: '先审查证据，再提出最小修改。'
        allowDelegation: false
```

`allowDelegation: false` 会加入明确的角色指令，但它是行为约束，不是假装存在的进程级安全边界。

### 插件自有运行与重启

后台运行登记默认写到 `<DSH_HOME>/dsh-subagent-code-agents/owned-runs.json`；也可用 `runRegistryPath` 指定位置。若两者都没有，则只在内存中登记。只保存通道、角色、模型、强度、cwd、sessionId、状态和最多 1000 字符输出摘要；**不保存 prompt、密钥或登录态**。

进程重启时，磁盘上所有 `running` 记录都会转换为 `interrupted`，绝不伪装为仍在运行。仅当记录含 sessionId 且当前通道支持 resume 时，`continuation` 才为 `resume_available`；否则为 `unavailable`。

> 工具名统一为：`subagent_code`、`coding_sessions_list`（复数，列表）、`coding_session_read/start/send`（单数，单会话操作）。不暴露旧工具名 `subagent_codex`（旧插件保留它，新插件不用），也不提供旧的 plural 别名。

## 安装

根包 `dsh-subagent-code-agents` 就是公开发行包（**不是** private workspace 根）。`bundleDependencies` 把六个内部 `@dsh-subagent-code-agents/*` 包打进根 tarball；Git 安装的 `prepare` 仅在 workspace 包缺失时物化同一组内部包。因此**直接 GitHub/tarball 安装均可，不要求内部 scoped 包先发布**。GitHub 安装必须允许该仓库自身的 `prepare` 脚本运行；若宿主统一使用 `--ignore-scripts`，请改装 `npm pack` 产生的根 tgz。

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

> 内部包（`core`、四个 channel 包、`plugin`）位于 `packages/*`，未来也可独立发布、独立维护；但从消费者视角它们被 bundle 进根包，无需单独安装。

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

ACP 实例按需追加；`id`/`name` 只写实例名，注册后是 `acp/<name>`。命令用无 shell 的 argv 启动，不接受 `.cmd/.ps1/.bat` shim：

```yaml
- id: coding-agent-opencode
  name: 'dsh-subagent-code-agents'
  config:
    channel: acp
    id: opencode
    command: 'C:/tools/opencode-acp.exe'
    args: ['--stdio']
    requestTimeoutMs: 30000
```

通用实现依据 ACP stable v1 的 `initialize → session/new|session/load → session/prompt` 生命周期，并从 `session/update` 的 `agent_message_chunk` 收集文本。客户端声明不提供文件系统和终端能力，`mcpServers` 为空；需要这些桥接能力时应由 DSH 侧另行明确设计，而不是隐式开放。协议参考：[ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)、[ACP v1 schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json)。

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

## 扩展渠道

若目标已经提供 ACP server，只需新增一行 `channel: acp` 配置，可并存多个实例，不修改代码。只有需要原生专属能力（例如 Codex app-server 的会话列表和真 steer）时才新增渠道包：

1. 新建 `packages/channel-<name>/`，实现 `CodingAgentChannel`（小 adapter，见 core 类型）。
2. 包内写 argv 构造 + 输出解析 + fake runtime 测试；**不含任何 DSH/Cordis 代码**。
3. 在 `plugin/lib/index.js` 的 `CHANNEL_FACTORIES` 加一行工厂。
4. 在 `cordis.patch.yml` 加一行 provider（channel + providerName）。
5. 工具层无需改动：工具自动按注册表路由，能力缺口显式拒绝（`unsupported`）。core 在注册时校验“能力为 true 必须有对应方法”，防止渠道虚报能力。

> 注意：新增渠道需要修改 plugin 的静态工厂表与 patch（core 本身不用改）。"渠道自行导入即注册"不成立——渠道包是纯 adapter，由 plugin 显式装配。

### 当前边界

- **Claude Code / Grok Build 的会话能力（list/read/start/send）为 false**：这两个渠道的 `coding_sessions_*` 工具会显式返回 `unsupported`。渠道包中保留的 `parseClaudeSessionsJson` / `parseGrokSessions` 是**未启用的纯函数占位**——Claude 的官方 JSONL transcript 与会话列表格式、Grok 的 SQLite 会话存储都**未**在本轮实现为可用能力，capability 保持 `false` 是权威状态，不以存在 parser 函数为"已实现"。
- **ACP 只实现稳定的一次调用/载入续跑路径**：不宣称 session list/read、managed steer、模型/强度覆盖或进程跨重启存活；codex 的真 steer 仍仅限 app-server 托管会话。
- **固定 full-access 策略**：codex `sandboxBypassGuaranteed=true`；claude/grok 仅权限审批绕过（`bypassPermissions`），沙箱关闭无保证（`false`）。

## 相关项目与定位

本项目不宣称是首个 Codex/Claude 子代理或多 CLI harness。相邻项目包括：

- [OpenClaw ACP agents](https://github.com/openclaw/openclaw/blob/main/docs/tools/acp-agents.md)：面向 OpenClaw 的会话绑定 ACP runtime，层次更完整；本项目面向 DSH/Cordis provider 与工具注册。
- [twaldin/harness](https://github.com/twaldin/harness)：统一调用大量 headless coding CLI 的通用库；本项目重点是 DSH 插件生命周期、能力门控和会话工具。
- [OpenAI codex-plugin-cc](https://github.com/openai/codex-plugin-cc)：在 Claude Code 中把 Codex 作为 companion/subagent；本项目以 DSH 为主控，并同时维护多个原生/ACP 通道。

差异化不在“能启动 Codex/Claude”，而在：DSH 原生注册、每次调用选择模型/强度（通道支持时）、严格角色、原有 Codex app-server 真会话能力、多个可配置 ACP 实例，以及不会把重启后的旧进程或沙箱能力说成仍然存在。

## 开发与测试

```bash
npm install                 # 链接 workspaces
npm run check               # 全部包语法检查
npm test                    # 全部测试（fake runtime/fs/ACP，不启动真实 provider）
npm run test:codex          # 定向：codex 渠道
npm run test:claude         # 定向：claude-code 渠道
npm run test:grok           # 定向：grok-build 渠道
npm run test:acp            # 定向：通用 ACP 渠道
npm run test:plugin         # 定向：plugin 挂载/工具
npm run pack:check          # 打包验证：6 个 workspace tgz 清单 + 根 tgz 单包安装 smoke
```

测试使用 fake subprocess/fs/ACP，**不调用真实模型、不启动真实 provider、不读写密钥/登录态**。`pack:check` 会把根包真实 `npm pack` 到系统临时目录、在一次性 consumer 中 `npm install` 根 tgz（`--ignore-scripts --legacy-peer-deps`，peer 从 workspace 的 node_modules 显式提供以模拟真实 DSH 宿主），验证 `dsh-subagent-code-agents` 与 `/tool` 可 import、6 个 bundled 内部依赖真实存在，随后清理所有临时文件/tgz。

## License

MIT
