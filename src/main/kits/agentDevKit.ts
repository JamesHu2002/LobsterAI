import type { LocalizedText } from '../../shared/kit/constants';

/** Built-in kit for developing production-grade AI agents. */
export const AgentDevKitId = 'agent-dev';

/** Skills this kit manages (bundled with the app, disabled until installed). */
export const AgentDevKitSkillIds = [
  'agent-architecture',
  'agent-loop-design',
  'tool-calling',
  'prompt-engineering',
  'context-management',
  'memory-design',
  'mcp-integration',
  'multi-agent-orchestration',
  'agent-evaluation',
  'agent-guardrails',
  'agent-observability',
];

const LOCALIZED = (en: string, zh: string): LocalizedText => ({ en, zh });

const SKILL_METADATA: Array<{ id: string; name: LocalizedText; description: LocalizedText }> = [
  { id: 'agent-architecture', name: LOCALIZED('Agent Architecture', 'Agent 架构设计'), description: LOCALIZED('Choose workflow vs agent, ReAct / plan-execute / orchestrator patterns.', '决策工作流 vs Agent，选择 ReAct / plan-execute / orchestrator 模式。') },
  { id: 'agent-loop-design', name: LOCALIZED('Agent Loop Design', 'Agent 循环设计'), description: LOCALIZED('Design reason→tool→observe loops, stop conditions and step caps.', '设计 reason→tool→observe 循环、停止条件与步数上限。') },
  { id: 'tool-calling', name: LOCALIZED('Tool Calling', '工具调用设计'), description: LOCALIZED('Design tool schemas, contracts, validation and error handling.', '设计工具 schema、契约、参数校验与错误处理。') },
  { id: 'prompt-engineering', name: LOCALIZED('Agent Prompt Engineering', 'Agent 提示词工程'), description: LOCALIZED('Output contracts, structured outputs and injection-resistant prompts.', '输出契约、结构化输出与抗注入提示词。') },
  { id: 'context-management', name: LOCALIZED('Context Management', '上下文管理'), description: LOCALIZED('Compress, disclose progressively and time retrieval to reduce drift.', '压缩上下文、渐进披露、规划检索时机以减少幻觉。') },
  { id: 'memory-design', name: LOCALIZED('Memory Design', '记忆设计'), description: LOCALIZED('Layer short/episodic/long-term memory, auditable and safe.', '分层设计短期/情景/长期记忆，可审计且安全。') },
  { id: 'mcp-integration', name: LOCALIZED('MCP Integration', 'MCP 集成'), description: LOCALIZED('Build MCP servers, tools and resources instead of glue code.', '构建 MCP server / tool / resource，替代自定义胶水代码。') },
  { id: 'multi-agent-orchestration', name: LOCALIZED('Multi-Agent Orchestration', '多 Agent 编排'), description: LOCALIZED('Supervisor routing, handoffs, parallel and hierarchical patterns.', 'supervisor 路由、handoff、并行与层次化编排模式。') },
  { id: 'agent-evaluation', name: LOCALIZED('Agent Evaluation', 'Agent 评测'), description: LOCALIZED('Eval sets, LLM-as-judge, regression gates — not vibe checks.', 'eval 集、LLM-as-judge、回归质量门禁，而非"感觉不错"。') },
  { id: 'agent-guardrails', name: LOCALIZED('Agent Guardrails', 'Agent 安全护栏'), description: LOCALIZED('Prompt-injection defense, approval gates (HITL), retry backoff.', '提示注入防御、审批门（人机协同）、重试退避。') },
  { id: 'agent-observability', name: LOCALIZED('Agent Observability', 'Agent 可观测性'), description: LOCALIZED('OpenTelemetry tracing, span taxonomy, logs and cost attribution.', 'OpenTelemetry 追踪、span 分类、日志与成本归因。') },
];

/** MarketplaceKit object surfaced in the Expert Kits area. */
export function buildAgentDevMarketplaceKit(): Record<string, unknown> {
  return {
    id: AgentDevKitId,
    name: LOCALIZED('Agent Development', 'Agent 开发'),
    description: LOCALIZED(
      'A bundled skill set for building production-grade AI agents: architecture, agent loop, tool calling, prompt/context engineering, memory, MCP, multi-agent orchestration, evaluation, guardrails and observability.',
      '面向生产级 AI Agent 开发的技能集：架构、Agent 循环、工具调用、提示词/上下文工程、记忆、MCP、多 Agent 编排、评测、安全护栏与可观测性。',
    ),
    author: 'LobsterAI',
    version: '1.0.0',
    tryAsking: [
      LOCALIZED('Design an agent architecture for a support ticket triage system', '为工单分类系统设计 Agent 架构'),
      LOCALIZED('Build an MCP server exposing a weather tool', '构建一个暴露天气工具的 MCP server'),
      LOCALIZED('Write an eval set to measure my agent\'s tool-use accuracy', '为我的 Agent 写一套衡量工具调用准确率的评测集'),
    ],
    skills: {
      bundle: 'builtin://agent-dev',
      list: SKILL_METADATA,
    },
    mcpServers: [],
    connectors: [],
  };
}

/** Per-skill metadata for the InstalledKitRecord. */
export function agentDevKitMetadata(): Record<string, { id: string; name: LocalizedText; description: LocalizedText }> {
  return Object.fromEntries(SKILL_METADATA.map((m) => [m.id, m]));
}
