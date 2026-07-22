# Windows 原生 Sandbox M3：安装态与系统安全加固

## 1. 状态

- 实施状态：代码已完成，等待端侧安装、断网和异常恢复验收。
- Runtime：`0.4.0`。
- Protocol：`4`。
- Policy：`workspace-write-v4`。
- 平台：Windows x64。
- 发布状态：仍为测试功能；M4/M5 与专项安全评审完成前不声明正式生产就绪。

## 2. 目标

M2.x 已经证明现有工程、Agent workspace、固定兼容目录和 Skills 只读根可以进入同一写入策略，但任务仍从登录用户 token 派生，且没有系统网络隔离、受保护安装和供应链校验。

M3 把该原型改造成安装态 runtime：

1. 模型命令不再使用登录用户身份，而是使用安装时创建的专用本地低权限身份；
2. 专用身份之上继续叠加 `WRITE_RESTRICTED` token、路径 Capability SID 和 Job Object；
3. 专用身份默认不能访问网络，规则覆盖非 loopback、loopback TCP 和 loopback UDP；
4. runner、setup、manifest 和安装状态进入 `%ProgramData%` 下的受保护目录；
5. 首次安装或修复时才申请 UAC，正常启动、状态检查和任务执行不申请提权；
6. manifest、SHA-256、协议、版本、路径和安装 ACL 任一异常时失败关闭。

M3 不改变 M2.x 的基础目录策略，也不实现 M4 的多 workspace 授权并集与企业审计查询。为先验证专用身份、workspace 边界、命令执行和网络隔离主链路，产品配置在当前 M3 验收阶段默认传入空的 `filesystemCapabilities`，不再默认授权真实 `%LOCALAPPDATA%/npm-cache`。`npm-cache-write` 注册能力仍保留，待大型共享目录 ACL 准备的进度、超时、取消和失败清理机制完善后再评估默认启用。

## 3. 组件与职责

```text
LobsterAI 设置页 / 启用事务
        |
        +-- 非提权 verify -------------------------------+
        |                                                |
        +-- install / repair（仅需要时弹 UAC）            |
                                                         v
资源目录/lobster-sandbox-setup.exe  --->  %ProgramData%/LobsterAI-SandboxRuntime
                                               |
                                               +-- current/
                                               |     +-- lobster-command-runner.exe
                                               |     +-- lobster-sandbox-setup.exe
                                               |     +-- lobster-sandbox-manifest.json
                                               |     +-- install-state.json
                                               |
                                               +-- previous/（单版本回滚）
                                               +-- state/credentials.json（受保护 + DPAPI）

OpenClaw backend
        |
        v
受保护 command-runner（真实用户 broker）
        |
        +-- 校验安装、hash、签名策略、身份与网络规则
        +-- 为声明根准备 Capability ACL + 专用身份 ACL
        +-- CreateProcessWithLogonW
        v
专用本地身份下的 runner worker
        |
        +-- 再次校验自身路径、身份、hash、ACL 和网络规则
        +-- 创建 WRITE_RESTRICTED token
        +-- 绑定 Capability SID + Job Object/UI 限制
        v
PowerShell / cmd / node / npm / Python 及其子进程
```

### 3.1 `lobster-sandbox-setup.exe`

只接受固定操作：

- `install`
- `verify`
- `repair`
- `upgrade`
- `rollback`
- `uninstall`

它不接受 shell、脚本、任意 ACL 或任意安装目标。安装源固定为 setup 自身所在的发布资源目录，安装目标固定为产品定义的 ProgramData 目录。为兼容标准用户输入管理员凭据的 UAC 场景，非提权父进程会把自身 SID 作为隐藏参数传给提权子进程；setup 必须确认该 SID 可解析为真实 Windows 用户、且不是受管 sandbox 身份，才可将其用于产品读取 ACL。每次提权调用还携带唯一请求标识，父进程不会接受上一次遗留的结果文件。

### 3.2 `lobster-command-runner.exe`

公开入口仍为 `verify`、`run` 和 `cleanup`。公开入口是非提权 broker；内部 worker 入口必须同时满足：

- 当前可执行文件就是受保护安装目录中的 runner；
- 当前 Windows 用户 SID 等于安装状态记录的专用身份；
- runtime hash、签名策略、安装 DACL 和离线网络规则仍健康。

即使模型发现内部参数，也不能借此获得登录用户或管理员身份，也不能为新目录准备 ACL。

## 4. 安装事务

首次启用顺序：

1. LobsterAI 非提权执行 `setup verify`；
2. 未安装或不健康时执行固定 `install` / `repair`；
3. setup 使用 Windows `runas` 请求 UAC；
4. LobsterAI 主进程先校验资源目录 manifest、精确文件集合和文件 hash，并在安装包模式校验 Authenticode；提权后的 setup 再独立复验；
5. 创建或修复 `LobsterSandboxUser` 本地普通账户；setup 在创建或修复后通过固定 SID `S-1-5-32-545` 解析本地化的 Windows 内置 Users 组，并显式、幂等地写入账户成员关系，同时使用 `NetUserSetInfo` level 1008 规范化密码不过期等本地 SAM 可稳定持久化的安全标志；健康检查回读真实 Users 组成员关系和 flags，不依赖在部分本地 SAM 环境中可能仍报告 Guest、且通过 level 1005 更新会返回 `ERROR_INVALID_PARAMETER` 的旧式 privilege 字段；账户仍明确拒绝 trusted-for-delegation 标志，并通过 Windows 账户可见性策略从登录页隐藏；账户名必须满足 Windows 本地 SAM 的 20 个 UTF-16 单元上限，且只有 `NetUserAdd` 明确返回“用户已存在”时才进入更新分支，其他创建错误保留原始错误码；`UF_NOT_DELEGATED` 主要对应 AD/Kerberos 的敏感账户语义，不作为本地账户健康检查的硬条件；
6. 生成随机密码，以 machine-scope DPAPI 加密保存；
7. 在 ProgramData 下使用独立的安全根目录，设置固定 owner，并为 runtime 和 credentials 设置受保护 DACL；runtime 树的目录与文件使用权限主体和访问掩码相同、但继承标志不同的精确模板：目录保留 `OICI` 以约束后代，普通文件不携带 Windows 会自动剥离的目录继承标志；credentials 等普通文件的拒绝 ACE 使用文件专用 `FA` 而非会被 Windows 映射后改变二进制表示的通用 `GA`；写入与健康检查均按对象类型选择模板；该目录不放在普通用户可能拥有删除子项权限的 LobsterAI 数据父目录内；
8. 安装并回读验证按账户 SID 绑定的默认拒绝网络规则；
9. 将资源复制到 staging，复验后原子切换 `current`，旧版本保留为 `previous`；
10. 再次执行完整 verify；
11. 只有 verify、OpenClaw 配置和 backend 探测全部成功后，产品开关才持久化为启用。

用户取消 UAC 时不会写入启用配置。安装或切换失败时，setup 恢复上一 runtime；LobsterAI 保持或回滚为实机模式，不自动降级绕过沙箱。

## 5. 身份与文件边界

M3 的文件写入检查包含两层：

1. 普通访问检查必须由专用低权限本地身份通过；
2. restricted-token 检查还必须由当前请求的路径 Capability SID 通过。

因此，真实用户对其他私有文件的写权限不会自然继承到任务进程。workspace、Agent workspace、scratch 和显式启用的兼容根只有在 LobsterAI 策略声明后，才会同时获得专用身份 ACE 和 Capability ACE；当前默认策略不包含真实 npm cache。

为兼容 Windows PowerShell/.NET 初始化，restricted token 仍保留 logon SID 与 `Everyone` 兼容 SID。专用账户显著收窄了真实用户文件的默认权限，但对本机原本就显式授予 `Everyone` 写入的对象，不应额外宣称提供绝对保护；专项安全评审需要把这类 world-writable 对象纳入验证和文档。

## 6. 网络边界

当前只支持 `networkMode=disabled`。网络策略 v3 使用两层互补机制：

1. Windows Firewall 继续创建三条 SID 范围的出站阻断规则，作为企业策略可见的纵深防线：

- 非 loopback 的任意协议；
- loopback TCP；
- loopback UDP。

2. LobsterAI 自有的持久 WFP provider/sublayer 在 `ALE_AUTH_CONNECT_V4/V6` 层通过 `ALE_USER_ID` 安全描述符匹配 `LobsterSandboxUser` SID，并阻断该身份的全部 IPv4/IPv6 connect；另在 `ALE_RESOURCE_ASSIGNMENT_V4/V6` 层补充 ICMP 阻断。

不能把 Firewall 规则“写入且回读成功”等同于网络边界生效：`LocalUserAuthorizedList` 的公开语义偏向 AppContainer，普通专用账户在部分端点上可能不命中该条件。WFP ALE 用户条件才是当前专用本地账户的强制主边界，Firewall 规则保留为纵深防护和企业可观测配置。

WFP 对象使用固定 LobsterAI GUID。repair 在一个事务中删除并重建 LobsterAI 自有 filter、sublayer 和 provider，避免旧 SID 或旧 ACL 遗留；SYSTEM/Administrators 拥有管理权限，产品 owner 与 sandbox SID 仅有读取权限，因此提升后的 setup、非管理员产品健康检查和专用账户 worker 都能验证同一策略，但不能修改它。verify 会检查持久 provider、sublayer、阻断动作、目标层、SID 条件和协议条件，任一不符均失败关闭。

规则绑定账户而非某个命令，因此 PowerShell、Node、Python、自带网络客户端和全部子进程使用同一边界。代理变量、证书覆盖变量和 OpenClaw 凭据不会注入任务环境；即使任务清空代理变量或自行创建 socket，也仍由 Windows 内核按身份拒绝。

Windows Firewall 会把等价地址表示归一化，例如把 IPv4 CIDR 改写为子网掩码、把单个 IPv6 地址改写为范围。setup/runtime 使用 Windows COM 自身对预期值和回读值做相同的规范化后再比较，而非直接比较字符串；账户 SID、启用状态、阻断动作、出站方向、全部 profile、协议和地址集合任一不符合策略时仍报告不健康并拒绝启用或执行。如果企业策略使本地防火墙规则无效、Firewall/WFP 对象缺失或字段被修改，同样失败关闭。

## 7. 供应链与防篡改

构建脚本同时产出：

- `lobster-command-runner.exe`
- `lobster-sandbox-setup.exe`
- `lobster-sandbox-manifest.json`
- `THIRD_PARTY_NOTICES.txt`

manifest 记录 runtime/protocol/policy 版本、架构、Git commit、构建时间、最低 LobsterAI 版本和每个文件的 SHA-256。

- 开发态：允许未签名，但仍强制 manifest、hash、版本和协议校验；
- 安装包态：先完成 runner/setup 签名，再生成最终 hash；LobsterAI 启动 setup 之前和 setup 提权之后均强制 Authenticode；
- manifest 只能声明 runner、setup 和第三方声明三个固定文件，缺失、重复、额外文件或签名标记不符都会失败关闭；
- runtime 目录：SYSTEM/Administrators 可修改，产品用户和 sandbox 身份仅可读/执行；健康检查会比较完整预期 DACL，而不只检查“已关闭继承”标志；
- credentials：sandbox 身份显式拒绝访问，产品用户只读，密码仍由 machine-scope DPAPI 加密；
- 每次 broker/worker 初始化都会重新验证受保护安装，不能只依赖首次安装结果。

## 8. 进程与环境加固

- runner 与 setup 调用 `SetDefaultDllDirectories` 并清空进程 DLL current-directory 搜索；
- worker 使用专用账户启动，模型命令不持有管理员 token；
- broker 在每次跨账户启动前，按专用账户 SID 幂等授予当前 Window Station 与 Desktop 的连接权限；授权失败则拒绝启动，避免 `CreateProcessWithLogonW` 在不同 Windows 端点上静默失败；
- broker 仅向专用账户开放自身进程对象的等待与身份查询权限并把 PID 交给 worker；worker 先确认 Windows 记录的真实父进程 PID 和父进程用户 SID 与安装态产品 owner 一致，再监视 broker；watchdog 线程取得完整 RAII 进程句柄的所有权，避免只捕获整数 handle 后由外层 guard 提前关闭；broker 被取消或终止时立即退出，从而关闭 kill-on-close Job 并终止命令进程树；
- 跨账户 worker 不依赖 `CreateProcessWithLogonW` 继承 broker 的标准句柄；broker 在请求目录创建一次性 stdout/stderr 桥接文件，worker 重定向控制面与命令数据面输出，退出后 broker 原样转发并删除，错误报告因此保留稳定的 code/stage，而非只剩 exit code 70；
- 命令在挂起状态创建，先加入 kill-on-close Job Object 再恢复；
- Job Object 不开放 breakaway，并限制活动进程数、剪贴板、外部窗口句柄、系统参数和关机类 UI；
- `HOME`、`USERPROFILE`、`APPDATA` 等 profile 字段只决定子进程环境，不产生授权，因此仅校验为无相对分量的本地绝对非根路径，不要求专用账户读取真实用户目录；writable/readable/protected roots 仍由 owner broker 完整 canonicalize 并检查 reparse，worker 对最终目标复验且必须与 broker 的规范路径一致；
- `TEMP/TMP` 指向任务 scratch；
- 代理、证书注入、密钥/token 和 OpenClaw 启动信息不进入任务环境。

M3 选择“专用身份 + restricted token + Job UI restrictions”，不在当前版本创建 private desktop。专用账户对交互桌面对象的 ACE 会保留到对应 Windows 对象或登录会话结束，避免并发任务之间因提前撤销而互相干扰；该 ACE 只解决进程连接要求，模型命令仍受 Job 的外部窗口句柄、剪贴板、系统参数与关机限制。若安全评审发现共享交互桌面仍构成实际逃逸面，再将 private desktop 作为独立加固项引入，避免在没有兼容性数据时破坏 PowerShell、Node 和 Python。

### 8.1 真实安装态自动验收

开发验收提供 `npm run sandbox-native:test:installed`。该入口必须从与 LobsterAI 相同的
非管理员用户上下文启动，仅为安装生命周期子进程请求一次 UAC；提升后的子进程连续执行
repair、verify 和幂等复验，随后由原始非管理员父进程验证受保护安装，并通过真实的
broker/专用账户 worker 验证 workspace 内 PowerShell 写入成功、stdout/stderr 可回传、同级宽权限
目录写入被拒绝，并在真实 LobsterAI SKILLs 根存在时验证任一 `SKILL.md` 可读且不输出内容；
同时验证 Node/npm 与测试脚本显式声明的共享 npm cache 能力可用，并通过宿主实时 loopback listener 证明专用账户连接失败且宿主未接受连接。该原生能力测试不代表 LobsterAI 产品配置默认启用 `npm-cache-write`。

测试输出结构化 JSON 到原生 target 目录，失败时保留具体 setup 报告。安装成功后默认保留
runtime，便于继续进行设置页和 OpenClaw 端侧验收；自动化不通过时，不再依赖设置页逐层
暴露安装错误。

## 9. 错误、审计与恢复

关键错误使用稳定代码，例如：

- `setup-uac-cancelled`
- `setup-partial-failure`
- `runtime-manifest-invalid`
- `runtime-hash-invalid`
- `runtime-signature-invalid`
- `runtime-protection-invalid`
- `sandbox-identity-mismatch`
- `network-policy-ineffective`
- `network-rule-invalid`
- `network-wfp-filter-invalid`

setup 生命周期事件写入 ProgramData 下的 JSONL 日志，并尝试写入 Windows Application Event Log；LobsterAI 主进程同时记录不含凭据、命令内容和用户路径的结构化生命周期审计。命令/文件级可查询审计、保留期和导出仍属于 M4。

## 10. 验收重点

端侧 M3 验收至少覆盖：

1. 首次启用弹一次 UAC，取消后仍为未启用；
2. 安装成功后刷新状态和重启应用不再弹 UAC；
3. 设置页显示身份、完整性、安装 ACL、签名策略和网络规则均健康，专用账户不出现在登录页；
4. workspace、Agent workspace 与 scratch 可写，默认未授权的 npm cache 和普通用户目录越界写入失败；
5. PowerShell、cmd、Node、npm、Python 和子进程均可运行；
6. 域名、直接 IP、DNS、loopback、局域网和子进程网络均失败；
7. 修改或替换安装目录中的 runtime 文件后，verify/任务执行失败关闭；
8. repair 能恢复文件、身份、ACL 和网络规则；
9. 应用退出、超时或取消后无明显逃逸子进程；
10. 原实机模式在 Sandbox 关闭时无回归。

## 11. 后续 TBD

- M4：多 workspace 权限并集、授权引用计数、崩溃回收和可查询审计；
- M5：正式代码签名流水线、SBOM、干净机/覆盖升级/降级矩阵、企业安全软件兼容和发布门禁；
- 对显式 world-writable 对象、企业 GPO 防火墙策略和多用户切换做专项安全评审；
- 是否需要 private desktop；
- 是否把当前部分读取隔离提升为独立的强读取模式；
- 大型共享目录 ACL 准备的阶段日志、独立长时限、取消传播和失败补偿清理；完成前 `npm-cache-write` 保持默认关闭；
- macOS 后端继续复用 provisioner/executor/policy 公共接口，不复用 Windows 账户、防火墙或 ACL 实现。
