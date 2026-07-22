# Windows 原生 Sandbox 宿主 Profile 与语义化权限设计

> 文档日期：2026-07-21
>
> 当前状态：代码已实施，待端侧验收
>
> 适用范围：Windows x64 内部测试版

## 1. 概述

### 1.1 背景

上一版 M2.x 为每个 Agent 创建持久 `sandboxHomeDir`，并把 `HOME`、`USERPROFILE`、`APPDATA` 和 `LOCALAPPDATA` 全部映射到该目录。该方案能隔离真实用户配置，但也改变了命令行工具熟悉的宿主环境，并引入缓存复制、生命周期清理、跨 Agent 重复占用和后续迁移成本。

本次迭代改为继承真实 Windows 用户 Profile，同时继续由操作系统强制限制写入根。继承一个目录的环境路径不等于授予该目录写权限；真正允许写入的位置仍由显式 `writableRoots` 决定。

为了补偿 workspace-only 对常用开发工具的兼容性损失，产品增加语义化文件权限注册表。首个可选能力为 `npm-cache-write`，仅将真实 `%LOCALAPPDATA%/npm-cache` 叶子目录加入可写根，不开放整个 Home、AppData 或 npm 全局可执行目录。

### 1.2 目标

1. 不再创建、映射或依赖持久 Sandbox Home。
2. `HOME`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA` 继承可信宿主值，但不自动获得写权限。
3. 保持任务 workspace、Agent workspace 和每任务 scratch 可写。
4. 保持 LobsterAI Skills 只读。
5. 通过语义能力 ID 增减常用兼容目录，避免在业务代码散落路径字符串。
6. 默认启用真实 npm cache 写能力，支持 npm/npx 的常见工作流。
7. 不修改 OpenClaw 核心，继续通过 LobsterAI extension 和原生 runner 接入。
8. 权限、协议和 runtime 版本失败关闭，不兼容时不回退实机执行。

### 1.3 非目标

- 本阶段不实现一般读取隔离。
- 本阶段不实现网络隔离或域名白名单。
- 本阶段不增加设置页中的严格/平衡/兼容模式选择。
- 本阶段不实现单次命令动态审批或临时扩权。
- 本阶段不开放整个真实 `%APPDATA%/LobsterAI`、`%LOCALAPPDATA%` 或 `%USERPROFILE%`。
- 本阶段不开放 `%APPDATA%/npm` 全局 npm 命令目录。
- 本阶段不增加 pip、pnpm、Yarn、Gradle 等缓存能力；后续按真实失败案例逐项增加。

## 2. 用户场景

### 场景 1：直接使用已有工程

**Given** 用户选择已有工程并开启 Sandbox

**When** Agent 修改源码、安装项目依赖并执行 `npm test`

**Then** 工程、项目内 `node_modules` 和 npm cache 可以写入，其他用户目录不能因 Profile 继承而获得写权限。

### 场景 2：复用真实 npm cache

**Given** 用户真实 `%LOCALAPPDATA%/npm-cache` 已有缓存

**When** npm/npx 在 Sandbox 命令树中访问默认缓存

**Then** 缓存可读写并可跨任务复用；产品明确记录该共享目录可能被 Sandbox 任务修改。

### 场景 3：读取但不能修改用户配置

**Given** 用户 Home 中存在 `.npmrc` 或 `.gitconfig`

**When** 对应工具按默认规则读取配置

**Then** 读取行为与宿主环境一致，但该配置所在 Home 没有写 Capability，修改应被操作系统拒绝。

### 场景 4：收回兼容能力

**Given** 后续策略或用户选择关闭 `npm-cache-write`

**When** 结束当前任务并使用新策略启动任务

**Then** npm cache 不再出现在新 token 的可写根中；基础 workspace、Agent workspace 和 scratch 权限不受影响。

### 场景 5：宿主侧产品功能

**Given** 用户通过 LobsterAI UI 安装 Skill、创建 Skin 或修改插件配置

**When** 现有 Electron main/IPC 管理流程执行落盘

**Then** 继续使用宿主侧产品权限，不要求将整个 LobsterAI userData 开放给模型命令。

## 3. 功能需求

### FR-1：Profile 与写权限解耦

runner 必须从版本化请求读取宿主 Profile 路径，并据此构造子进程环境；Profile 路径不得被自动加入 `writableRoots`。

### FR-2：语义化兼容能力

OpenClaw plugin 配置使用稳定能力 ID，而不是由调用方直接传入任意兼容路径。extension 内部注册表负责把能力 ID 解析为平台路径和访问级别。

### FR-3：首批 npm cache 能力

`npm-cache-write` 只解析到真实 `LOCALAPPDATA` 下的 `npm-cache` 叶子目录。注册表需要创建缺失目录、解析 canonical path，并拒绝逃出 `LOCALAPPDATA` 的 junction、符号链接或异常路径。

### FR-4：环境变量保护

tool call 不能覆盖 `HOME`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`TEMP`、`TMP`、`PATH`、代理和系统根等宿主控制变量。名称包含 `KEY`、`SECRET` 或 `TOKEN` 的命令环境变量在进入 runner 前过滤。LobsterAI 自带 Node/npm shim 和 Skill 脚本所需变量只能由 extension 从 Gateway 的可信宿主环境按语义白名单注入，同名 tool env 不得覆盖。

### FR-5：版本与失败关闭

本版使用：

```text
protocolVersion = 3
policyVersion = workspace-write-v3
runtimeVersion = 0.3.1
profile.mode = inherit-host
```

任一版本或 profile 结构不匹配时，runner/extension 必须拒绝初始化。

## 4. 实现方案

### 4.1 权限矩阵

| 语义根 | 权限 | 生命周期 | 来源 |
| --- | --- | --- | --- |
| `taskWorkspaceDir` | 读写 | 当前活动工程 | OpenClaw task |
| `agentWorkspaceDir` | 读写 | Agent 持久 | OpenClaw Agent |
| `scratchDir` | 读写 | runtime 临时 | executor |
| LobsterAI `SKILLs` | 只读 | 产品持久 | LobsterAI config |
| `%LOCALAPPDATA%/npm-cache` | 读写 | 用户共享 | `npm-cache-write` |
| 真实 Home/AppData 其他位置 | 不授予写 Capability | 用户持久 | 宿主 Profile |

不开放：

- `%APPDATA%/npm`；
- 整个 `%APPDATA%/LobsterAI`；
- SQLite、OpenClaw 配置和认证数据；
- `.ssh`、`.aws`、`.kube`、`.docker` 等凭据/配置目录；
- 插件、扩展、runtime 和更新目录。

### 4.2 策略组合

当前策略等价于：

```text
EffectivePolicy
  = BaseRoots(task workspace + Agent workspace + scratch + Skills RO)
  + EnabledCapabilities(npm-cache-write)
  - ProtectedPaths
```

后续可以在不改变 runner 基础协议的情况下增加：

```text
  + UserSelectedRoots
  + TaskScopedApprovals
  + MoreCompatibilityCapabilities
```

硬性敏感目录不应通过普通兼容预置覆盖。需要修改 Skill、Skin、插件或应用配置时，优先使用宿主侧受控 API，而不是开放父目录。

### 4.3 宿主 Profile

`NativeSandboxPolicyContext` 和 runner request 使用：

```ts
interface NativeSandboxHostProfile {
  mode: 'inherit-host';
  homeDir: string;
  userProfileDir: string;
  appDataDir: string;
  localAppDataDir: string;
}
```

这些值由 OpenClaw extension 从自身可信 `process.env` 捕获，不接受 tool call 的同名覆盖。TypeScript policy registry 和 Rust runner 都会验证其为存在的本地 Windows 目录。

runner 最终环境：

| 变量 | 值 |
| --- | --- |
| `HOME` | `profile.homeDir` |
| `USERPROFILE` | `profile.userProfileDir` |
| `HOMEDRIVE`/`HOMEPATH` | 从 `userProfileDir` 派生 |
| `APPDATA` | `profile.appDataDir` |
| `LOCALAPPDATA` | `profile.localAppDataDir` |
| `TEMP`/`TMP` | 每任务 `scratchDir` |

`TEMP`/`TMP` 继续使用 scratch 是为了避免污染共享系统临时目录，不属于持久 Home 映射。

OpenClaw 的 Sandbox 命令环境不会完整继承 Gateway `process.env`。此前虽然 `PATH` 中仍有 LobsterAI 的 Node/npm shim，但 shim 依赖的 Electron、npm bin 等定位变量缺失，表现为命令可以被找到、启动后却立即失败。为此 extension 在生成 `command.env` 时增加可信语义环境注册表：

| 语义组 | 注入变量 |
| --- | --- |
| Node/npm runtime | `LOBSTERAI_ELECTRON_PATH`、`LOBSTERAI_NPM_BIN_DIR` |
| Skill 定位 | `SKILLS_ROOT`、`LOBSTERAI_SKILLS_ROOT` |
| Python runtime | `LOBSTERAI_PYTHON_ROOT`（宿主存在时） |
| 时区 | `TZ`（宿主存在时） |

路径值必须是已存在的绝对路径；来源只允许 Gateway 自身环境，tool call 的同名变量按 Windows 大小写不敏感规则过滤。当前有意不注入 `LOBSTERAI_OPENCLAW_ENTRY`、代理、CA、Gateway token 或其他密钥，避免把 OpenClaw 管理面与凭据带入受限命令树。开发态和安装包使用同一注册表，差别仅在 Electron main 预先计算的可信路径值。

### 4.4 语义化权限注册表

首版注册表定义：

```text
id       = npm-cache-write
access   = write
rootId   = npm-cache
scope    = user-shared
risk     = shared-cache-mutation
resolver = LOCALAPPDATA/npm-cache
```

OpenClaw config 只传入 `filesystemCapabilities: ['npm-cache-write']`。extension 解析已知 ID、去重并忽略未知配置值；具体路径只由受信任 resolver 计算，不读取项目 `.npmrc`，避免项目配置把 cache 指向任意目录后获得隐式授权。

### 4.5 原生执行与文件桥

解析后的 npm cache 进入 `writableRoots`，与 task/Agent workspace 一起获得 Capability SID 和读写 ACL。Skills 继续进入 `readableRoots` 并获得只读 Capability。

结构化文件桥和 shell runner 消费同一个 `NativeSandboxPolicyContext`，因此二者对 npm cache、Skills 和 workspace 的访问级别一致。`scratchDir` 仍由 runner 隐式加入可写根。

### 4.6 收权生命周期

注册表配置变化不能夺回已运行进程持有的 token。正确流程为：

1. 阻止启动新的命令；
2. 结束当前 Sandbox 任务/进程树；
3. 使用 cleanup ledger 撤销该 runtime 周期添加的 Capability ACE；
4. 根据新配置生成有效根；
5. 新任务使用新 token。

当前设置页已经要求切换模式或工程前结束活动任务。后续增加权限档位时沿用同一门禁。

### 4.7 OpenClaw 集成

不 patch OpenClaw 核心。LobsterAI config sync 向 `lobster-native-sandbox` 传入：

- runner 路径、runtime/protocol 版本和启用状态；
- 真实 `skillsRoot`；
- `filesystemCapabilities`。

上一版的 `sandboxDataRoot` 不再传入。旧 `<userData>/sandbox-data` 不会被本版继续使用，也不在本阶段自动删除，避免升级时无提示清理用户数据。

### 4.8 ACL 准备与命令执行生命周期

Capability ACE 是 runtime 周期级状态，不是单条命令状态。`verify` 在首次准备 workspace 或运行期新增权限根时写入 ACL；`cleanup` 在 reset 时统一撤销。普通 `run` 仍会重新解析并校验全部路径、根据当前请求创建 restricted token，但不得重复写入相同 ACL。

这一约束对共享缓存尤其重要。Windows 会把根目录上的继承 ACE 传播到已有子项；若每条命令都重新设置 `%LOCALAPPDATA%/npm-cache` ACL，真实缓存规模下会产生十几到数十秒的固定延迟，并被 OpenClaw 的命令超时误判为 `SIGKILL`。将 ACL 写入收敛到准备阶段不扩大授权范围：未完成 `verify` 的新根没有对应 ACE，restricted token 的访问检查会失败关闭。

同一 runtime 周期若出现新的 Agent workspace 或语义化根，extension 必须先完成一次新策略准备并登记到 cleanup union，之后才能生成该上下文的命令请求；相同策略的重复命令直接复用已准备的 Capability ACE。

## 5. 安全边界与风险

| 风险 | 当前处理 |
| --- | --- |
| npm 共享缓存被当前任务修改 | 明确接受的兼容性风险；仅开放叶子目录并在 UI/spec 标注 |
| npm cache junction 指向其他目录 | 注册表 canonicalize 并验证仍位于 `LOCALAPPDATA`，异常失败关闭 |
| 整个 Home/AppData 获得写权限 | 不加入可写根；profile 仅用于环境继承 |
| `.npmrc`/`.gitconfig` 等真实配置被自动读取 | 当前 `readIsolated=false`，作为已知剩余风险记录 |
| 环境变量携带密钥 | tool env 中 KEY/SECRET/TOKEN 名称过滤；后续仍需完整凭据策略 |
| LobsterAI shim 可执行但定位变量缺失 | 仅从 Gateway 可信环境注入 Node/npm、Skill、Python 与时区语义变量；绝对路径缺失或无效时失败关闭 |
| OpenClaw CLI 或 Gateway 凭据进入命令树 | 不注入 OpenClaw entry、代理/CA、Gateway token 和其他密钥 |
| 读取到配置后通过网络外传 | 当前 `networkIsolated=false`；内部测试版不得宣称生产安全 |
| 在活动任务中直接收权 | 不支持；要求结束任务并重建 token |
| 通过 npm 全局目录持久化命令 | `%APPDATA%/npm` 不开放写权限 |
| LobsterAI 应用状态被篡改 | 不开放 userData 父目录；产品写入走宿主 API |

### TBD

1. 真正的网络隔离与域名级策略。
2. 一般读取隔离、敏感配置读取策略和凭据暴露治理。
3. 严格/平衡/兼容三档 UI，以及企业策略覆盖关系。
4. 单次任务临时授权和用户显式额外根。
5. pip、pnpm、Yarn、Cargo、Gradle 等缓存是否按能力逐项支持。
6. npm cache 的共享污染提示、审计、配额和清理策略。
7. `.git`、`.agents` 等 workspace 内 protected path 默认清单。
8. macOS resolver 与 Seatbelt 写根实现。

## 6. 涉及文件

```text
src/shared/nativeSandbox/
src/main/libs/openclawConfigSync.ts
src/renderer/components/settings/nativeSandbox/
openclaw-extensions/lobster-native-sandbox/
native/sandbox-windows/
scripts/native-sandbox/verify-package.cjs
```

不涉及 OpenClaw 核心 patch。

## 7. 验收标准

### 7.1 自动化

1. 协议、policy 和 runner 版本一致升级至 v3 / `workspace-write-v3` / `0.3.1`。
2. request 不再包含 `sandboxHomeDir`，改为 `profile.mode=inherit-host` 及四个真实 Profile 路径。
3. tool call 不能覆盖 Profile、TEMP/TMP、PATH、代理、可信语义环境和敏感 KEY/SECRET/TOKEN 环境变量。
4. Node/npm、Skill、Python 与时区变量只从 Gateway 可信环境注入；OpenClaw entry、代理/CA 和 token 不注入。
5. 有 `npm-cache-write` 时 npm cache 进入可写根；去掉能力后只保留基础可写根。
6. npm cache 缺失时可安全创建；异常 junction/越界解析失败关闭。
7. runner 能读取真实 Profile 文件但不能写入未授权 Profile 位置。
8. runner 能写入显式 npm cache，但不能写入 `LOCALAPPDATA` 其他子目录。
9. task workspace、Agent workspace、Skills 只读、protected path、进程树和 ACL cleanup 原有测试继续通过。
10. 相关 Vitest、Rust test、Rust Clippy、Electron compile、变更文件 lint、扩展预编译和打包核验通过。

### 7.2 用户侧

1. 已有工程开启 Sandbox 后，可以修改源码并执行 `npm test`。
2. `$env:USERPROFILE`、`$env:APPDATA` 和 `$env:LOCALAPPDATA` 显示真实用户路径。
3. 向真实 Home 普通文件写入失败。
4. 向 `%LOCALAPPDATA%/npm-cache` 写入成功。
5. 向 `%LOCALAPPDATA%` 其他目录或另一个工程写入失败。
6. 已安装 Skill 可读取但不可修改。
7. 关闭 Sandbox 后的新任务恢复原有实机行为。
8. 设置页明确说明共享 npm cache、真实配置可读、网络/一般读取未隔离和内部测试边界。
