# OpenClaw sessions_yield 后子 agent 结果回收卡住修复设计文档

## 1. 概述

### 1.1 问题

用户反馈主 agent 启动子 agent 后调用 `sessions_yield` 等待，子 agent 虽然完成，但主 agent 没有继续输出最终结果。

已确认三类复现场景：

1. 普通会话并行启动 A/B 两个子 agent，A 先完成并唤醒主 agent，主 agent 在等待 B 时再次 `sessions_yield`；B 的完成事件被写入 transcript，但没有后续模型回合消费，因此没有 `BOTH_DONE`。
2. 定时任务并行启动 A/B 两个子 agent，主 cron run 在 `sessions_yield` 后结束；A/B 完成后只能得到子 agent fallback summary，主 agent 没有重新合成最终结果。
3. 定时任务串行启动子 agent，主 cron run 在等待 A 时结束；A 完成后无法恢复主 agent，因此 B 根本没有被启动，界面表现为没有回复。

### 1.2 根因

`sessions_yield` 本身不是阻塞等待工具，它会结束当前模型回合，并依赖 runtime 后续 completion event 重新驱动父会话。

故障点有两个：

1. active requester steering 将“completion 事件写入 transcript”视为送达成功。但如果事件是在父会话已经调用 `sessions_yield` 的尾部写入，后面可能没有模型回合消费它。
2. isolated cron 的 finalization 可以等待 descendant 并读取 fallback，但这发生在执行结束阶段，只能汇总子 agent 文本，不能让主 agent 继续执行原任务。串行场景因此无法启动第二个子 agent。

### 1.3 修复目标

1. 普通会话中，父 run 已进入 `sessions_yield` 后，不再把新的子 agent completion 塞进当前 active run 并标记成功。
2. isolated cron 中，`meta.yielded=true` 后等待 descendant 结果，并把结果作为 runtime event 继续驱动同一个 cron session。
3. 支持多轮 yield continuation，覆盖串行子 agent 场景。
4. 保留 no-delivery cron 的子 agent fallback finalization，避免在无法继续合成时静默丢结果。
5. 不回移 OpenClaw PR #97090，不引入 deferred cron 状态，不改 LobsterAI UI/IPC/数据库结构。

## 2. 用户场景

### 场景 1：普通会话并行子 agent

**Given** 主 agent 并行启动 A/B 两个子 agent。  
**When** A 完成后唤醒主 agent，主 agent 再次调用 `sessions_yield`，B 在该 yield 尾部完成。  
**Then** B completion 不应被当前已 yield 的 active run 吞掉，应进入现有重试/挂起路径，等待后续父会话回合消费。

### 场景 2：cron 并行子 agent

**Given** isolated cron 并行启动 A/B，并调用 `sessions_yield`。  
**When** A/B 都完成。  
**Then** cron runner 将 A/B 结果注入后续父 agent 回合，父 agent 可输出 `BOTH_DONE`。

### 场景 3：cron 串行子 agent

**Given** isolated cron 要求依次启动 A 和 B。  
**When** 主 agent 等待 A 时 `sessions_yield`。  
**Then** A 完成后 cron runner 继续驱动主 agent，使其有机会启动 B；B 完成后再次继续，最终输出 `BOTH_DONE`。

## 3. 功能需求

### FR-1：active run 已 yield 后拒绝继续 steering

`runEmbeddedAttempt()` 的 active queue handle 在 `yieldDetected=true` 后拒绝新的 `queueMessage()`。这样 completion announce 不会把事件写入一个即将结束且不会继续消费的 run。

### FR-2：cron yield continuation

`executeCronRun()` 在 run result 标记 `meta.yielded=true` 且没有 fatal error 时：

1. 等待 active descendant drain。
2. 读取 descendant summary 或 fallback reply。
3. 构造 internal runtime event prompt。
4. 在同一 cron session 中再次调用 `runPrompt()`。
5. 最多继续 6 轮，防止异常循环。

### FR-3：no-delivery fallback 保底

`dispatchCronDelivery()` 仍接收 `yielded` 元数据。若 continuation 没有产生最终主 agent 文本，no-delivery cron 仍会等待/读取 descendant fallback，避免执行记录为空或只停在中间状态。

## 4. 实现方案

### 4.1 active steering guard

修改 `src/agents/embedded-agent-runner/run/attempt.ts`：

```ts
if (yieldDetected) {
  throw new Error("active session is yielding; queued steering requires a follow-up turn");
}
```

该错误会让 active steering 返回失败，后续沿用现有 announce retry / pending steering 机制。

### 4.2 cron continuation loop

修改 `src/cron/isolated-agent/run-executor.ts`：

- 引入 `waitForDescendantSubagentSummary()` 与 `readDescendantSubagentFallbackReply()`。
- 在普通 interim ack retry 后、返回 execution result 前增加 yield continuation loop。
- continuation prompt 明确说明 descendant result 是 runtime evidence，不是用户指令。

### 4.3 delivery finalization 保底

保留并扩展 `src/cron/isolated-agent/delivery-dispatch.ts`：

- `DispatchCronDeliveryParams` 增加 `yielded?: boolean`。
- `run.ts` 将 `finalRunResult.meta?.yielded === true` 传给 dispatcher。
- `delivery.mode=none` 且 yielded 时也执行 descendant finalization，但不发送 outbound message。

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| completion 到达时父 active run 已调用 `sessions_yield` | 拒绝 active queue，交给现有 announce retry / pending steering |
| cron 串行启动子 agent | 每次 descendant 完成后继续驱动 cron run，直到最终非 yielded 结果 |
| cron descendant 已在等待前完成 | 使用 frozen fallback reply |
| continuation 仍然 `sessions_yield` | 最多继续 6 轮 |
| continuation 没有可用 descendant 文本 | 跳出 loop，交给 delivery finalization 保底 |
| no-delivery cron | 不发送 outbound message |

## 6. 涉及文件

OpenClaw patch：

- `src/agents/embedded-agent-runner/run/attempt.ts`
- `src/cron/isolated-agent/run-executor.ts`
- `src/cron/isolated-agent/run.ts`
- `src/cron/isolated-agent/delivery-dispatch.ts`
- `src/cron/isolated-agent/run.test-harness.ts`
- `src/cron/isolated-agent/run.message-tool-policy.test.ts`
- `src/cron/isolated-agent/delivery-dispatch.double-announce.test.ts`

LobsterAI：

- `scripts/patches/v2026.6.1/openclaw-cron-yield-descendant-finalization.patch`
- `specs/bugfixes/openclaw-cron-yield-descendant-finalization/2026-06-30-openclaw-cron-yield-descendant-finalization-design.md`

## 7. 验收标准

1. 普通会话中，completion 不再被已 yield 的 active run 尾部吞掉。
2. cron 并行 A/B 用例最终进入主 agent continuation，可输出 `BOTH_DONE`。
3. cron 串行 A 后再 B 的用例可启动 B，并最终输出 `BOTH_DONE`。
4. no-delivery cron 不发送外部消息。
5. patch 可从干净 OpenClaw `v2026.6.1` 重复应用。
6. 目标 Vitest、格式检查和 lint 通过；全量 typecheck 若因既有无关问题失败需明确记录。
