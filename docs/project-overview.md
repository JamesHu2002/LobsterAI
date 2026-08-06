# LobsterAI 项目概览

> 本文档基于仓库 `README.md` / `README_zh.md` 及源码结构整理，用于快速了解项目的大致内容。
> 最后更新：2026-08-06（对应 tag `2026.8.5`）

---

## 1. 项目简介

**LobsterAI** 是网易有道出品的全场景办公助手 Agent，国内大厂中首个开源桌面级 Agent，采用 MIT 协议开源。

它可以真正进入用户的日常工作环境：操作**本地文件**、执行**终端命令**、驱动**浏览器流程**、处理**文档/表格/幻灯片**、对接 **IM 渠道**、运行**定时任务**并维护**项目工作区**。

核心分层：

- **Cowork**：LobsterAI 的产品与会话层，负责桌面端的本地持久化、权限、UI 状态、Artifacts、Agents、记忆和 IM 绑定。
- **OpenClaw**：底层运行时和网关，负责实际执行 Agent 任务（锁定的版本为 `v2026.6.1`）。

---

## 2. 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面框架 | Electron `40.2.1` |
| 前端框架 | React `18` + Vite `5` + TypeScript `5.7` |
| 状态管理 | Redux Toolkit `2.x` + react-redux `9` |
| 样式 | Tailwind CSS `3.4` + PostCSS + Autoprefixer |
| 本地存储 | SQLite（`better-sqlite3`，配合 `sql.js`） |
| 协议 | Model Context Protocol SDK（`@modelcontextprotocol/sdk`） |
| 文档渲染 | docx-preview、pptx-preview、pdfjs-dist、mermaid、katex、react-markdown、xlsx |
| 代码编辑 | CodeMirror（`@uiw/react-codemirror`） |
| 测试 / 质量 | Vitest、ESLint 9、Prettier、Commitlint、Husky |
| 打包 | electron-builder、patch-package |
| 运行时 | 内嵌 OpenClaw runtime + 便携 Python（Windows） |

环境要求：**Node.js `>=24.15.0 <25`**，npm。

---

## 3. 架构分层

整体架构分为三部分（详见 `docs/architecture-openclaw-gui-cowork.md`）：

### 3.1 Renderer（渲染进程）
React + Redux Toolkit + Tailwind。包含 Artifact 渲染器、设置、Agent/会话 UI、技能、MCP、定时任务和 IM 配置。

### 3.2 Main process（主进程）
Electron 生命周期、IPC、SQLite 持久化、登录鉴权、日志、OpenClaw 启动、运行时修复、技能同步、IM 网关和 Artifact 服务。

### 3.3 OpenClaw 集成
以下模块负责把 LobsterAI 状态翻译成 OpenClaw 运行时行为：

- `openclawEngineManager`：OpenClaw 网关进程、运行时状态、端口、日志、重启和修复
- `openclawConfigSync`：将 provider、model、agent、IM 绑定、skills、MCP 和工作区指令渲染为 OpenClaw 配置
- `openclawRuntimeAdapter`：将 OpenClaw 网关事件翻译为 Cowork 流式事件
- `coworkEngineRouter`：Cowork 引擎路由

---

## 4. 核心功能

| 功能 | 说明 |
| --- | --- |
| **桌面级 Cowork 会话** | 针对本地项目/文件执行长任务；实时流式展示进度、保存会话历史、渲染工具输出，并在文件操作、终端命令、网络访问等敏感动作前请求用户审批 |
| **多 Agent 工作流** | 创建拥有独立身份、模型、技能、工作目录、启用状态和 IM 绑定的自定义 Agent；主 Agent 处理通用工作，专用 Agent 负责重复性角色 |
| **专家套件** | 按场景打包能力选择与参考信息，形成可复用工作流；与直接选择技能相互独立，可组合使用 |
| **技能（Skills）** | 内置 28 个技能（配置于 `SKILLs/skills.config.json`），涵盖 Web 搜索、Word/Excel/PPT、PDF、Remotion 视频生成、浏览器自动化、图片/视频生成、股票研究、内容写作、邮件、天气、技能创建等 |
| **MCP 服务** | 通过 Model Context Protocol 接入外部工具和数据源；本地保存配置，并将启用服务同步到 OpenClaw |
| **定时任务** | 通过自然语言或 UI 创建周期任务，适合每日新闻、邮箱摘要、网站监控、周报等 |
| **IM 远程控制** | 支持微信、企业微信、钉钉、飞书/Lark、QQ、Telegram、Discord、网易云信 IM、网易小蜜蜂、POPO 和邮件等渠道；多实例平台可将不同账号/渠道绑定到不同 Agent |
| **丰富 Artifacts** | 桌面端预览和管理生成的 HTML、SVG、图片、视频、Mermaid 图表、代码、Markdown、文本、文档和本地服务类 Artifacts |
| **本地记忆与数据** | 会话与应用数据保存在本地 SQLite；OpenClaw 工作区记忆使用 `MEMORY.md`、`USER.md`、`SOUL.md` 和每日笔记等文件，让偏好和上下文跨会话延续 |
| **模型评测** | 侧边栏「模型评测」入口：加载开源评测集（GAIA 2023 验证集、AgentBench 横向思维谜题），通过 OpenClaw Agent 跑题，输出性能报告（成功率、工具选择准确率、参数准确率、无效调用率、平均调用次数、成本、耗时、中间步骤可恢复性等） |

**典型使用场景**：搭建本地系统（如进销存）、分析本地数据（可视化看板）、生成汇报 PPT、自动检查网页后台、批量筛选简历、定时收集新闻摘要等。

---

## 5. 目录结构

```
├── src/
│   ├── main/                 # Electron 主进程
│   │   ├── main.ts           # 生命周期、IPC、鉴权、日志、runtime 启动与服务装配
│   │   ├── coworkStore.ts    # Cowork 会话/消息/Agents/记忆 + SQLite CRUD
│   │   ├── libs/             # openclawEngineManager、openclawConfigSync 等
│   │   ├── ipcHandlers/      # IPC 处理器
│   │   ├── im/               # IM 网关（微信/企微/钉钉/飞书/QQ 等）
│   │   ├── mcp/              # MCP 服务管理
│   │   ├── skills/           # 技能同步
│   │   ├── permissions/      # 权限门控
│   │   └── computerUse/      # 电脑使用（浏览器/桌面自动化）
│   ├── renderer/             # React 前端
│   │   ├── App.tsx / main.tsx
│   │   ├── components/       # cowork/ agent/ skills/ mcp/ scheduledTasks/ 等 UI
│   │   ├── store/            # Redux store
│   │   └── services/         # i18n.ts 等
│   ├── common/ shared/       # 共享类型与工具
│   └── scheduledTask/        # 定时任务逻辑
├── src/
│   └── benchmark/            # 模型评测共享类型与常量
├── src/main/benchmark/       # 评测主进程：数据集加载、网关客户端、评测 runner、指标计算、定价
├── src/main/benchmarkStore.ts# 评测 run/结果 SQLite 存储
├── src/main/ipcHandlers/benchmark/  # 评测 IPC handlers
├── src/renderer/components/benchmark/  # 评测 UI（列表/新建/进度/报告）
├── SKILLs/                   # 内置技能（skills.config.json + 各技能实现）
├── build/                    # 构建配置
├── resources/                # 打包资源（含 Windows 便携 Python）
├── scripts/                  # 构建/打包/OpenClaw runtime 脚本
├── docs/                     # 文档（本文件所在目录）
├── specs/                    # 规格说明
├── tests/                    # 测试
├── openclaw-extensions/      # 本地 OpenClaw 扩展
├── patches/                  # patch-package 补丁
└── package.json              # 含 openclaw 锁定版本与插件列表
```

---

## 6. 开发与构建

### 本地开发

```bash
npm install                              # 安装依赖（postinstall 会自动 patch 并装 Electron 依赖）

# 首次开发启动（会先构建 OpenClaw runtime）
npm run electron:dev:openclaw

# 日常开发（OpenClaw runtime 已构建后）
npm run electron:dev
```

Renderer 开发服务器默认运行在 `http://localhost:5175`。

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 生产 renderer bundle（tsc + vite build） |
| `npm run compile:electron` | 编译 Electron main/preload TypeScript |
| `npm test` | Vitest 测试（CI 入口） |
| `npm run lint` | 全量 ESLint（可能暴露既有历史 lint debt） |
| `npm run openclaw:runtime:host` | 手动构建当前平台 OpenClaw runtime |
| `npm run dist:win` / `dist:mac` / `dist:linux` | 打包对应平台安装包 |
| `npm run build:skills` | 构建技能（web-search / tech-news / email） |

### OpenClaw Runtime

- 锁定版本与第三方插件列表位于 `package.json` 的 `openclaw` 字段
- 支持 `OPENCLAW_SRC`（指定源码路径）、`OPENCLAW_FORCE_BUILD=1`（强制重建）、`OPENCLAW_SKIP_ENSURE=1`（保持本地 checkout 版本）
- Windows 打包内置便携 Python（`resources/python-win`），终端用户无需手动安装 Python

---

## 7. 安全与数据

- Renderer 窗口启用 **context isolation**、禁用 **Node integration**、启用 **sandbox**
- Renderer 到 Main 的访问全部通过 **preload IPC API**
- 敏感工具动作有**权限门控**并记录日志
- 应用数据：Electron `userData` 下的本地 `lobsterai.sqlite`
- OpenClaw 状态、工作区记忆、生成配置和网关日志位于 `userData/openclaw`

---

## 8. 参考资料

- 官方站点：https://lobsterai.youdao.com/
- 源码仓库：https://github.com/netease-youdao/LobsterAI
- 架构文档：`docs/architecture-openclaw-gui-cowork.md`
- 许可证：MIT（网易有道开发维护）
