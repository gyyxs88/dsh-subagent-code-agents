# dsh-subagent-code-agents

DeepSeek Harness（DSH）`0.1.0-rc.6` 至 `0.1.1-rc.2` 的多渠道编码代理子代理插件：内置 OpenAI Codex、Anthropic Claude Code、Grok Build，并可配置任意数量的 Agent Client Protocol（ACP）实例。它同时提供严格角色、插件自有后台运行登记、持久终态自动回报和诚实的重启后续跑语义；旧 `dsh-subagent-codex` 可原样共存。

## 远程项目与运行时部署

本插件是渠道适配器，不负责把 Codex、Claude Code、Grok Build 安装或认证到远端主机；远程安装由 `dsh-remote-control` 的受信 Runtime Manager 按项目 Desired State 完成。每个 channel package 的 `package.json` 暴露稳定的 `dsh.remote.channelRuntime` 渠道需求声明；管理员受信 catalog 再解析为固定供应商版本、来源、大小、SHA-256、packageName 和 executablePath，形成独立的 RuntimeRequirement。启动时从正式注入的 Runtime Manager（生产使用 `runtimeManagerSocket` + 0600 Host capability token 文件）获取已校验的绝对 executable，缺失、未认证、漂移、receipt 未绑定或不兼容均结构化拒绝，不回退到 PATH。第三方登录态只留远端，不读取或复制 `~/.codex`、`~/.claude`、`~/.grok`、Cookie、OAuth token 或 API key。完整组件边界、权限继承、安装流程和验收标准见 [`dsh-session-control` 的远程项目架构文档](https://github.com/gyyxs88/dsh-session-control/blob/main/docs/remote-project-architecture.md)。

`dsh.remote.channelRuntime` 只声明稳定 runtime id、driver、placement、协议、能力和 DSH/API 兼容范围，不冒充供应商版本。管理员 catalog 的 `dsh.runtime` 才是可安装包身份；Desired State builder 从已选 channelRuntime 自动推导 exact RuntimeRequirement，不要求调用方重复拼写。Remote Host 的 runtime socket 通过 Host-scoped capability token 文件认证，token 文件必须是 owner-only 的普通文件；channel 请求另带真实 target Session，daemon 用已完成安装 receipt 和项目归属核验后返回同一个绝对 executable。socket 断开、daemon 重启、receipt 漂移或认证 lease 过期均 fail closed。

```
packages/
  core/                    渠道适配器接口 + 注册表 + 统一结果 + Runtime 注入（无 DSH 依赖）
  channel-codex/           Codex 渠道（exec/resume + app-server，会按 policy 映射权限）
  channel-claude-code/     Claude Agent SDK 渠道（会话读取/托管/取消，按 policy 映射 SDK 权限）
  channel-grok-build/      Grok Build 渠道（headless + ACP 托管，会按 capability 映射权限）
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
| listSessions / readSession | ✅ | ✅ | ✅ | ⚠️¹ |
| managedSession（托管会话） | ✅ | ✅ | ✅ | ✅ |
| steerActive（真 steer） | ✅ | ❌ | ❌ | ❌ |
| cancel API | ✅ | ✅ | ✅ | ✅² |
| streaming 到 DSH | ❌ | ❌ | ❌ | ❌ |
| 显式进度查询 | ✅ | ✅ | ✅ | ✅¹ |
| modelOverride / effortOverride | ✅ | ✅ | ✅ | ⚠️³ |
| **executionPolicies** | 三档 | 三档 | Read Only/Full Access | driver 声明 |
| **sandboxBypassGuaranteed** | 仅 Full Access | 仅 Full Access | 仅 Full Access | ❌ |

¹ ACP 的 list 需要 agent 声明 `sessionCapabilities.list`；read 需要 `loadSession=true` 的历史回放。resume 优先使用 `session/load`，也支持稳定的 `sessionCapabilities.resume`；未声明时均显式返回 `unsupported`。² ACP cancel 仅作用于本插件创建并仍持有的 managed 活跃回合，不会尝试取消外部或空闲 session。³ model/effort 通过 session `configOptions` 的 `model` / `thought_level` 类别协商；agent 未提供对应选项或所请求值时显式 `unsupported`。

`streaming 到 DSH` 一行仍是 ❌，指已验收的 DSH rc.6–`0.1.1-rc.2` 尚未消费第三方 provider 的增量。渠道层已经通过 `RunEnv.onUpdate` 产生 `text-delta`，DSH provider 返回值也附带一个向后兼容、可选且有界的 `updates: AsyncIterable`；宿主会忽略这个未知字段，最终 `result` 仍是唯一权威终态，中间增量不会写入父模型上下文。待 DSH 上游把可选 `SubagentRun.updates` 纳入 Service Definition 并增加 UI/远端 Consumer 后，才会把矩阵改为 ✅。

`显式进度查询` 不等于把隐藏思维或完整流自动注入父模型上下文。插件把渠道公开的 assistant 文本增量合并成有界进度快照，并通过 `coding_run_read` 幂等读取；后台 Job 同时使用 DSH 正式 `readOutput()` 接口，让显式 `job_output` 读取自上次调用以来的新文本。若运行尚未产生增量但已绑定可读取的渠道 Session，`coding_run_read` 会临时读取有界 assistant 快照；该快照不写入运行注册表。没有可展示文本时返回 `not-yet`，不会把空输出误报成“无法查看进度”。

> `sandboxBypassGuaranteed` 只描述 Full Access 路径的真实保证，不是默认策略或安全边界：
> - **codex**：Full Access 才使用 CLI bypass 或 app-server `never`/`dangerFullAccess`；Read Only/Workspace Write 映射到官方审批与 sandbox profile。
> - **claude-code**：Full Access 才使用 `bypassPermissions`、`allowDangerouslySkipPermissions` 和 sandbox off；受限模式使用 SDK 正式权限与审批回调，模式漂移 fail closed。
> - **grok-build**：Full Access 才使用 `--permission-mode bypassPermissions`、`--sandbox off` 和 managed `--always-approve`；Read Only 使用官方 `read-only` profile、只读工具 allowlist 并显式移除写入/网络/越界能力，Workspace Write 当前显式 unsupported。
> - **ACP**：权限与沙箱由 ACP agent 在初始化中声明并由 channel config 允许；未声明的组合返回 `unsupported-permission-policy`，不伪造统一能力。

`ChannelExecutionPolicy` 必须由目标 Session 继承，至少包含 permission、匹配的 approval owner/mode、workspaceRoot 和可选 target/source session identity。只有 Full Access 的 `full-access-controller` 可使用 bypass/always-approve/sandbox-off；Workspace Write 的人工审批保留在 `target-session`。能力提示不是安全边界，受限模式仍由 DSH 外层 sandbox 兜底。

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

- **`subagent_code`** — 必填 `description` / `prompt`，并提供 `channel` 或已配置的 `role`；可选 `model` / `reasoning_effort` / `resume_session_id` / `run_in_background` / `completion_delivery`。默认后台执行并立即返回，默认 `completion_delivery=followup`：终态消息持久写入并自动唤醒拥有者会话，不再要求 `job_output` 轮询；只有当前一轮必须同步依赖结果时才显式设 `run_in_background=false`，显式轮询流程可选 `manual`。显式模型与强度覆盖角色默认值；模型必须使用渠道接受的完整 ID（Codex 例如 `gpt-5.6-sol`，不要写成 `sol`）；角色/通道冲突、未知角色和能力缺口都显式拒绝。
- **`coding_sessions_list`** — 必填 `channel`；默认按调用者 cwd 过滤，`include_all:true` 显式跨项目；`limit` 1..100。
- **`coding_session_read`** — 必填 `channel` + `session_id`；`max_turns` 1..20。
- **`coding_session_start`** — 必填 `channel` + `prompt`；可选 `model` / `reasoning_effort` / `cwd`，模型同样必须使用完整渠道 ID。
- **`coding_session_send`** — 必填 `channel` + `session_id` + `prompt`；托管会话 active 时 steer，否则显式拒绝。
- **`coding_session_cancel`** — 必填 `channel` + `session_id`；可选 `run_id` / `reason`。只取消当前插件进程拥有的 active turn，外部/空闲会话显式拒绝。
- **`coding_runs_list` / `coding_run_read`** — 查看本插件创建的后台运行；`coding_run_read` 是用户询问顾问/子 Agent 进度时的首选入口，返回有界进度、更新时间和中断原因，必要时使用只读 Session 快照兜底；不会保存原始 prompt。
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
        model: gpt-5.6-sol
        reasoningEffort: xhigh
        instructions: '先审查证据，再提出最小修改。'
        allowDelegation: false
      - id: action-advisor
        channel: codex
        model: gpt-5.6-sol
        reasoningEffort: xhigh
        executionPermission: read-only
        backgroundOnly: true
        instructions: '只研究、审计并输出可执行 PLAN/REPORT，不改文件、不调用其他代理。'
        allowDelegation: false
```

默认 bundle 使用 `coding-agent-tools-auto` 把同一份工具配置挂到所有非 `minimal` Agent，因此全局角色应配置在该行；它会随新建 Agent 和 preset 切换生效，不绑定某个历史会话。

`executionPermission` 只能把当前目标 Session 权限降为 `read-only` / `workspace-write` 或保持不变，不能通过角色提权；`backgroundOnly: true` 会拒绝前台调用。`allowDelegation: false` 会加入明确的角色指令，但它是行为约束，不是假装存在的进程级安全边界。

### 插件自有运行与重启

插件创建的后台和显式前台运行都会先登记到 `<DSH_HOME>/dsh-subagent-code-agents/owned-runs.json`；也可用 `runRegistryPath` 指定位置。若两者都没有，则只在内存中登记。最多保留 100 条记录；只保存拥有者 ID、通道、角色、模型、强度、cwd、sessionId/turnId、状态、最多 16000 字符终态输出摘要、最多 4096 字符公开 assistant 进度尾部、终态未知标记，以及终态通知的稳定消息 ID/摘要/投递状态；**不保存 prompt、工具参数、隐藏思维、密钥或登录态**。高频进度在内存中合并并至多每秒持久化一次，绑定、终态和关闭时强制落盘。插件重启把未结算运行标为 `interrupted`，保留最后进度和诚实的 `process-restart-or-crash` / `plugin-disposed` 原因；拥有者会话重新挂载后收到一次可去重回报，绝不冒充旧进程仍存活。

bundle 还注册 `dsh-code-agents` Skill，要求 Agent 对长期任务默认后台派发后结束当前轮，并在插件自动回报后再验收；前台等待和 `completion_delivery=manual` 只用于真正的同轮依赖或显式审计。

`completion_delivery=followup` 由插件自己的持久终态回报独占完成通知；它会在 DSH jobs registry 中预先认领该次终态，抑制通用的“请用 job_output 读取”重复通知。`manual` 保留 DSH 原生 jobs 通知与显式读取语义。

进程重启时，磁盘上所有 `running` 记录都会转换为 `interrupted`，绝不伪装为仍在运行。仅当记录含 sessionId 且当前通道支持 resume 时，`continuation` 才为 `resume_available`；否则为 `unavailable`。

> 工具名统一为：`subagent_code`、`coding_sessions_list`（复数，列表）、`coding_session_read/start/send`（单数，单会话操作）。不暴露旧工具名 `subagent_codex`（旧插件保留它，新插件不用），也不提供旧的 plural 别名。

## 安装

### 平台状态

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| Windows | **支持，已实机验证** | 当前开发、部署和真实渠道验收均在 Windows 上完成。 |
| macOS | **兼容性预览，未实机验证** | 已支持 POSIX 可执行文件、符号链接及 `/usr/local/bin`、`/opt/homebrew/bin` 等常见 Codex 启动路径，但维护者目前没有 Mac；请用户自行测试并反馈，暂不作为正式支持保证。 |

macOS 用户反馈请提交到 [GitHub Issues](https://github.com/gyyxs88/dsh-subagent-code-agents/issues)，并附上：Mac 芯片与系统版本、Node/DSH/渠道 CLI 版本、脱敏后的渠道配置和完整错误信息。请勿提交登录凭据、API Key 或本地会话内容。

根包 `dsh-subagent-code-agents` 就是公开发行包（**不是** private workspace 根）。`bundleDependencies` 把六个内部 `@dsh-subagent-code-agents/*` 包打进根 tarball，因此安装根 tgz 时不要求内部 scoped 包先发布。

当前内部 scoped 包尚未分别发布到 registry，**不要把 GitHub source archive 直接交给 pnpm 安装**：pnpm 的 Git 依赖封装不会保留 npm `bundleDependencies`。请从仓库生成根 tgz，或使用 Release 中同样由 `npm pack` 生成的 tgz：

```powershell
git clone https://github.com/gyyxs88/dsh-subagent-code-agents.git
cd dsh-subagent-code-agents
npm ci --ignore-scripts
npm pack
```

```jsonc
// <profile>/package.json
{
  "dependencies": {
    "dsh-subagent-code-agents": "file:D:/path/to/dsh-subagent-code-agents-0.1.4.tgz"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-subagent-code-agents"]
    }
  }
}
```

> 内部包（`core`、四个 channel 包、`plugin`）位于 `packages/*`，未来也可独立发布、独立维护；但从消费者视角它们被 bundle 进根包，无需单独安装。

`cordis.patch.yml` 自动挂一行工具策略和三行 provider（每行独立 executable/config）：

```yaml
- id: coding-agent-tools-auto
  name: 'dsh-subagent-code-agents/auto-tool'
  config: { excludedPresets: [minimal] }
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

渠道“出现在工具参数里”不等于渠道已注册。插件会在真实 Cordis 生命周期中逐行挂载 provider，并把构造失败保存在渠道注册表；工具遇到未注册渠道时会同时返回该渠道的有界 mount failure，而不是只显示含糊的 `registered: (none)`。发布验收必须至少覆盖一次经过 Config 校验的真实 Cordis fiber，不能只直接调用 `apply()`。

每行可配置 `runtimeRequirement`、`runtimeManagerSocket`、`runtimeManagerHostId`、`runtimeManagerSourceHostId`、`runtimeManagerSourceSessionId`、`runtimeManagerCapabilityTokenFile`、`runtimeManagerTimeoutMs` 和 `appServerTurnTimeoutMs`，以及受信的 Session Control policy service；这些是公开配置字段，不传函数或任意 manager 对象。Runtime Manager 的 socket、Host/source 身份和 0600 capability token 必须成组配置；channel 另从目标 Session policy 获取真实 `targetSessionId`，不能把来源身份冒充 target。正式远程部署优先只传 Runtime Manager 返回的绝对 executable。`codexExecutable`、`claudeExecutable`、`grokExecutable` 仅作为受控的绝对路径注入/测试边界，不触发 PATH 搜索，不能是 `.cmd/.ps1/.bat` shim；`codexExecutable` 与 `codexJs` 不可同时设置。Claude Agent SDK 继续使用远端用户已经完成的官方认证；Grok 的 `grokHome` 只用于远端 session metadata 读取，不得用来把登录目录复制到本机。

macOS 上若 DSH 的 PATH 没有包含渠道 CLI，可显式填写绝对路径，例如：

```yaml
- id: coding-agent-codex
  name: 'dsh-subagent-code-agents'
  config:
    channel: codex
    providerName: coding-agent/codex
    codexExecutable: '/opt/homebrew/bin/codex' # Intel Mac 常见路径为 /usr/local/bin/codex
```

此配置只指定受控启动文件，不代替 runtime 安装或登录；阶段 C 远程目标是 Linux x86_64，登录状态留在远端用户边界。

Windows 的 npm shim 通常是 `.cmd` / `.ps1`，不能交给无 shell 启动器。应把 Codex 配成绝对 Node + `codex.js`，并为带原生可执行文件的渠道配置真实 `.exe`：

```yaml
- id: coding-agent-codex
  config:
    channel: codex
    providerName: coding-agent/codex
    nodeExecutable: 'D:\\path\\to\\node.exe'
    codexJs: 'C:\\Users\\<user>\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'
- id: coding-agent-claude-code
  config:
    channel: claude-code
    providerName: coding-agent/claude-code
    claudeExecutable: 'C:\\Users\\<user>\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
- id: coding-agent-grok-build
  config:
    channel: grok-build
    providerName: coding-agent/grok-build
    grokExecutable: 'C:\\Users\\<user>\\.grok\\bin\\grok.exe'
```

这些路径只解决本机进程启动，不复制登录态，也不读取凭据。未配置绝对入口且没有正式 Runtime Manager 时，渠道会保持注册，但首次运行会 fail closed。

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
    runtimeRequirement: { id: 'acp/opencode', version: '1.0.0' }
    executionPolicies: { 'read-only': true, 'danger-full-access': true }
```

通用实现依据 ACP stable v1 动态协商：基础生命周期为 `initialize → session/new|load|resume → session/prompt`；可选接入 `session/list`、`session/close`、load 历史回放和 `session/set_config_option`。客户端声明不提供文件系统和终端能力，`mcpServers` 为空；需要这些桥接能力时应由 DSH 侧另行明确设计，而不是隐式开放。协议参考：[ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)、[ACP v1 schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json)。

> **模式策略**：bundle 默认把 `subagent_code`、`coding_sessions_*` 与 `coding_run*` 自动挂到所有已组合的 Agent preset，唯独排除 `minimal`。策略监听 Agent 创建与空白会话的 preset 切换：进入 `minimal` 会卸载，切回其他模式会重新挂载。它使用 Agent 自身作用域，不修改 DSH 内置 preset 文件，因此 DSH 更新后仍可重复部署，自定义 preset 也自动生效。
>
> 如果某个 preset 已经手工加入下列工具行（例如需要专属 `roles` 配置），自动策略会识别完整工具集并跳过重复注册，原配置继续生效：

```yaml
- id: tool-subagent-code-agents
  name: 'dsh-subagent-code-agents/tool'
```

## 从旧 dsh-subagent-codex 迁移

| 旧 | 新 |
| --- | --- |
| `subagent_codex`（provider `codex`） | `subagent_code`（`channel: "codex"`，provider `coding-agent/codex`） |
| `subagent_codex.resume_session_id` | `subagent_code.resume_session_id`（语义一致：`codex exec resume`） |
| `codex_sessions_list` / `read` / `start` / `send` / `cancel` | `coding_sessions_list` / `coding_session_read` / `coding_session_start` / `coding_session_send` / `coding_session_cancel`（需显式 `channel: "codex"`） |
| `tool-subagent-codex` 工具行 | bundle 自动策略（除 `minimal`）；有专属配置时仍可手工使用 `tool-subagent-code-agents` |

权限策略不再固定 bypass：只有目标 Session 为 Full Access 时 Codex 才使用 `--dangerously-bypass-approvals-and-sandbox` 或 app-server `dangerFullAccess`；Read Only 使用官方受限 CLI，Workspace Write 必须走按 target Session 隔离的 Codex app-server approval bridge，不能用没有 server-request bridge 的 `codex exec` 冒充支持；无法兑现时显式拒绝。角色可以请求相对目标 Session 的权限降级，但不能提权。前台 app-server turn 使用独立的 `appServerTurnTimeoutMs`；后台 turn 没有固定十分钟上限，由拥有者取消、插件卸载或 Codex 终态结束。取消最多等待 `appServerCancelTimeoutMs`，仍无法证明终态时返回 `outcomeUnknown` 并退役该精确 app-server。插件不会重试外部 writer 冲突，也不会删除 Codex `thread-writer-locks`。

Codex 0.147.0 的 `exec resume` 不接受父命令的 `--sandbox` 参数；受限续接使用该子命令正式支持的 `-c sandbox_mode=...` 与 `-c approval_policy=...`，并把所有选项放在 sessionId/prompt 之前。Read Only 顾问因此可安全续接而不会退回 Full Access。

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
- **ACP 能力按 agent 协商**：支持稳定的 list/load replay/resume/close/configOptions 时启用对应路径；缺失就显式 `unsupported`。managed/cancel 只覆盖本插件持有的进程，进程跨重启仍不存活；真 steer 仍仅限 Codex app-server。
- **按请求继承权限策略**：codex、Claude Code 支持三档映射；Grok 当前只声明 Read Only/Full Access；ACP 需要 driver/config 与远端 agent 同时声明对应能力。缺少 policy、Runtime Manager、认证或 capability 时均 fail closed。

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

默认 clone 不依赖 sibling 仓库：Runtime Manager 与 Session Control 的跨仓消费测试会 skip，单仓 fake/fixture 测试仍完整运行。需要做 opt-in 契约验收时，显式传入绝对路径：

```powershell
$env:DSH_SESSION_CONTROL_ROOT = 'D:\Project\deepseek-harness-lab\dsh-session-control'
$env:DSH_REMOTE_CONTROL_ROOT = 'D:\Project\deepseek-harness-lab\dsh-remote-control'
npm test
```

remote-control 的 channel manifest 消费测试也可使用 `DSH_SUBAGENT_CODE_AGENTS_ROOT` 指向已 checkout 的本仓库；未设置时使用仓库内 machine-readable fixture。环境变量只用于测试，不是生产运行时配置。

## License

MIT
