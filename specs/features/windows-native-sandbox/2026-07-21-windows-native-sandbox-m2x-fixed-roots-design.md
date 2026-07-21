# Windows 原生 Sandbox M2.x 固定权限根设计

> 文档日期：2026-07-21
>
> 当前状态：历史方案；持久 Sandbox Home 已由同日的“宿主 Profile 与语义化权限设计”取代
>
> 适用范围：Windows x64 内部测试版

> 本文保留用于记录 M2.x 第一版设计。当前实现请以
> `2026-07-21-windows-native-sandbox-host-profile-capabilities-design.md` 为准。

## 1. 概述

### 1.1 问题

M2 只允许当前 `taskWorkspaceDir` 写入。该边界能验证用户工程的写隔离，但不足以支撑 LobsterAI 的真实工作流：OpenClaw 还需要 Agent 指令、身份、记忆和已安装 Skill，部分命令行工具也需要可持久化的用户级 Home、AppData 或缓存目录。

直接把真实 `%APPDATA%/LobsterAI` 整体设为可写虽然兼容性高，但模型命令会同时获得应用配置、插件、Skill、其他 Agent 数据等大范围写权限，难以解释和维护。

### 1.2 目标

M2.x 使用少量由产品声明的固定权限根，在不修改 OpenClaw 核心的前提下达到：

1. 用户继续直接使用已有工程。
2. Agent 指令和记忆可以正常读写。
3. 已安装 Skill 可以读取，但模型命令不能修改全局 Skill。
4. npm、Python 等工具拥有与真实用户目录分离的持久 Home。
5. shell、结构化文件工具及子进程使用同一组根目录策略。
6. 未声明的 LobsterAI AppData、其他工程和系统目录不获得写 Capability。
7. Sandbox 关闭时不改变原有实机行为。

### 1.3 非目标

M2.x 不实现：

- 网络隔离；
- 对所有未声明目录的强读取隔离；
- 多个用户工程同时活动；
- 对话创建或修改全局 Skill；
- 动态扩权审批；
- 安装态专用身份、签名和生产发布；
- Sandbox Home 配额、清理 UI、迁移或导出；
- macOS 执行后端。

## 2. 用户场景

### 场景 1：已有工程与 Agent 记忆同时工作

**Given** 用户选择已有工程 `D:\projects\demo` 并开启 Sandbox

**When** Agent 修改源码、运行测试并更新自己的 `MEMORY.md`

**Then** 工程和当前 Agent workspace 都可读写，其他未授权工程不可写。

### 场景 2：读取已安装 Skill

**Given** LobsterAI 已在 `%APPDATA%/LobsterAI/SKILLs` 安装 Skill

**When** OpenClaw 或命令读取 `SKILL.md`

**Then** 读取成功；创建、修改、删除 Skill 文件均被拒绝。

### 场景 3：工具使用用户级缓存

**Given** 同一 Agent 连续执行两个任务

**When** 工具向 `HOME`、`USERPROFILE` 或 AppData 写入缓存

**Then** 数据写入该 Agent 的持久 Sandbox Home，第二个任务可复用；真实用户 Home 不被污染。

### 场景 4：产品宿主侧功能

**Given** 用户通过 LobsterAI UI 安装 Skill、修改插件或生成 AI Skin

**When** 操作由既有 Electron IPC 和主进程管理流程执行

**Then** 继续按宿主侧产品权限落盘，不要求把整个真实 AppData 授权给沙箱命令。

### 场景 5：只读根与可写根冲突

**Given** 用户选择的任务目录覆盖了 LobsterAI `SKILLs`，或配置使只读根与可写根互为父子

**When** Sandbox 初始化

**Then** 初始化失败关闭，并报告根目录权限冲突，不把只读声明静默提升为可写。

## 3. 权限模型

### 3.1 固定根矩阵

| 根目录 | 权限 | 生命周期 | 用途 |
| --- | --- | --- | --- |
| `taskWorkspaceDir` | 读写 | 当前活动工程 | 源码、项目依赖、测试和构建产物 |
| `agentWorkspaceDir` | 读写 | Agent 持久 | 指令、身份、记忆和 OpenClaw 内部文件 |
| `sandboxHomeDir` | 读写 | 每 Agent 持久 | 用户级配置、缓存和 AppData 映射 |
| `scratchDir` | 读写 | runtime 临时 | 请求、报告、stdin 暂存和临时文件 |
| LobsterAI `SKILLs` | 只读 | 产品持久 | 已安装 Skill |
| 其他真实 LobsterAI `userData` | 未声明写权限 | 产品持久 | 由宿主侧产品功能管理 |

### 3.2 Agent workspace 的取舍

整体允许 `agentWorkspaceDir` 写入可以保持记忆、日记忆、身份和指令文件的现有行为，但也意味着沙箱任务能够修改该 Agent 的持久状态。M2.x 接受该风险，不在本阶段维护易失真的文件级白名单。

后续若需要更高安全级别，可把 Agent workspace 拆成明确子路径，或把敏感变更改为宿主侧受控 API。

### 3.3 Skills 的取舍

`SKILLs` 只读意味着：

- 读取和执行已安装 Skill 正常；
- 市场、GitHub、ZIP 等由 `SkillManager` 执行的宿主侧安装正常；
- 模型通过 shell 或结构化文件工具直接创建全局 Skill 失败；
- M2.x 不做 shadow copy、自动回写或审批合并。

### 3.4 读取与网络声明

只读 Skills 是一个明确的原生只读 Capability，不代表一般读取已隔离。产品状态继续报告：

```text
networkIsolated = false
readIsolated = false
productionReady = false
```

## 4. 实现方案

### 4.1 数据流

```text
LobsterAI config sync
  -> runtime path/version + sandboxDataRoot + skillsRoot
  -> lobster-native-sandbox extension
  -> NativeSandboxPolicyContext
       task workspace       RW
       agent workspace      RW
       per-agent home       RW
       Skills               RO
  -> WindowsNativeSandboxExecutor
       protocol v2 request
       restricted token + Capability SID + ACL
       Job Object process tree
  -> PowerShell / Node.js / Python / npm / file helper
```

OpenClaw 核心不需要 patch。extension 从 `CreateSandboxBackendParams` 读取 Agent workspace、任务 workspace 和 session key，在 LobsterAI 集成边界构造策略。

### 4.2 Policy Context

平台中性上下文：

```ts
interface NativeSandboxPolicyContext {
  agentWorkspaceDir: string;
  sandboxHomeDir: string;
  writableRoots: Array<{ id: string; path: string }>;
  readableRoots: Array<{ id: string; path: string }>;
  protectedPaths: string[];
}
```

同一访问级别的重复路径按 canonical path 去重。读写级别不同的根若相同或互为父子，则拒绝策略。

### 4.3 每 Agent Sandbox Home

Sandbox Home 位于：

```text
<userData>/sandbox-data/agents/<safe-agent-slug>-<agent-id-hash>/home
```

设计约束：

- session key 不直接进入文件路径；
- Agent ID 先按大小写无关语义规范化；
- 同一 Agent 的 session 复用 Home；
- 不同 Agent 使用不同 Home；
- Home 不加入 `PATH`。

Windows runner 强制映射：

| 环境变量 | 目标 |
| --- | --- |
| `HOME`、`USERPROFILE` | `sandboxHomeDir` |
| `HOMEDRIVE`、`HOMEPATH` | `sandboxHomeDir` 对应分量 |
| `APPDATA` | `sandboxHomeDir/AppData/Roaming` |
| `LOCALAPPDATA` | `sandboxHomeDir/AppData/Local` |
| `TEMP`、`TMP` | `scratchDir` |

tool call 传入的同名环境变量会被过滤，不能覆盖产品映射。

### 4.4 Windows 原生授权

runner 协议升级为：

```text
protocolVersion = 2
policyVersion = workspace-write-v2
runtimeVersion = 0.2.0
```

`SandboxPolicySnapshot` 新增必填 `sandboxHomeDir`。runner 对每个可写根生成读写 Capability，对每个只读根生成只读 Capability，并把全部 Capability 加入 restricted token：

- 可写 ACL：read/write/execute/delete；
- 只读 ACL：read/execute；
- 子进程继承同一 token 与 Job Object；
- cleanup 同时撤销读写和只读 Capability ACE；
- 根 Capability identity 在兼容协议升级间保持稳定，使新 runtime 可以替换或撤销旧 ACE；
- 不改变目录 owner，不删除用户已有 ACL。

### 4.5 结构化文件工具

`WindowsWorkspacePathPolicy` 新增显式 `writeRoots`，并保留 `readRoots`。每次操作继续验证：

- 绝对/相对路径锚定；
- canonical path；
- 根目录 identity；
- reparse point、junction、hardlink；
- 缺失路径出现竞态；
- mutation 对只读根的拒绝；
- rename 不跨根。

最终 I/O 仍由受限 runner 内的文件 helper 执行，不由 OpenClaw 宿主进程直接写入。

### 4.6 生命周期与清理

M2.x 保留一个活动 `taskWorkspaceDir` 的限制。切换工程前需要结束任务并 reset/restart runtime。

executor 会登记当前 runtime 周期见过的读写根、只读根和 protected path。普通命令使用当前 backend 的策略上下文；reset 使用登记并集生成 cleanup 请求，从而避免后加入的 Agent workspace 或 Sandbox Home 留下 Capability ACE。

## 5. 安全边界与已知风险

| 风险 | 当前处理 |
| --- | --- |
| 只读根被父级写根覆盖 | 初始化失败关闭 |
| PowerShell/Node/Python 绕过文件桥 | restricted token + Capability ACL |
| 子进程逃逸 | Job Object 与继承 token |
| 修改真实用户 Home | 环境强制重定向，未声明真实 Home 写根 |
| 修改 Agent 持久状态 | M2.x 明确接受；后续可细分 |
| 对话创建 Skill 失败 | 明确功能限制；宿主侧安装仍可用 |
| 一般读取和网络仍开放 | UI/状态如实标记未隔离 |
| 显式授予 `Everyone` 写权限的极端 ACL | 仍是当前登录用户派生 token 的生产级缺口，归 M3 |
| runner/config 版本错配 | 协议和 runtime 版本失败关闭 |

## 6. 涉及文件

主要模块：

```text
src/main/libs/openclawConfigSync.ts
src/shared/nativeSandbox/
src/renderer/components/settings/nativeSandbox/
openclaw-extensions/lobster-native-sandbox/
native/sandbox-windows/
scripts/native-sandbox/verify-package.cjs
```

## 7. 验收标准

### 7.1 自动化

1. 固定根能从 Lobster config 传到 backend、executor 和文件桥。
2. 同一 Agent 的 Home 稳定，不同 Agent 的 Home 不同。
3. task、Agent、Home 可写，Skills 可读不可写。
4. 只读/可写根重叠时 TS 路径层和 Rust runner 都失败关闭。
5. PowerShell、cmd、Node.js、Python、npm 与子进程不能写出声明根。
6. HOME 数据跨命令保留，scratch 可清理。
7. reset cleanup 包含运行期登记的完整根并集。
8. 协议、runtime、打包核验版本一致。
9. 相关 Vitest、Rust test、Clippy、Electron compile 和变更文件 lint 通过。

### 7.2 端侧

1. 用已有工程开启 Sandbox，新会话可修改源码并运行测试。
2. Agent 能读取和更新自身记忆。
3. 使用已安装 Skill 的任务不再出现“路径位于 task workspace 外”的读取错误。
4. 尝试改写全局 Skill 时得到明确拒绝。
5. npm/Python 的用户级缓存写入 Sandbox Home，而不写真实用户 Home。
6. 尝试写另一个未授权工程、Desktop 或 LobsterAI 未声明 AppData 目录失败。
7. 设置页明确展示 M2.x 固定根、Skills 只读、网络未隔离、一般读取未隔离。
8. 关闭 Sandbox 后新任务恢复原实机行为，Skill、Skin、MCP、插件和 Agent 功能无回归。

## 8. TBD

1. 是否把 `agentWorkspaceDir` 拆为更细的可写子目录。
2. 对话创建 Skill 采用宿主受控 API、shadow copy + 审批回写，还是继续不支持。
3. Sandbox Home 的配额、清理周期、重置、迁移、备份和导出。
4. 多 workspace 权限并集的最大数量、展示和回收宽限期。
5. AI Skin、插件、MCP 等宿主侧写入是否统一接入可审计产品 API。
6. 是否按 Skill 建立独立只读根，减少不同 Skill 间的可见性。
7. `protectedPaths` 首批清单及其对 Git、记忆和工具缓存的兼容性。
8. M3 专用低权限身份、网络规则、setup、签名和卸载恢复设计。
9. 强读取隔离是否作为独立模式。
10. macOS 如何复用固定根、Home 和平台中性协议，同时用 Seatbelt 实现原生约束。
