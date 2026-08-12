import type { LocalizedText } from '../../shared/kit/constants';

/** Built-in kit that groups the software development & testing skill set. */
export const SoftwareDevTestKitId = 'software-dev-test';

/** Skills this kit manages (bundled with the app, disabled until installed). */
export const SoftwareDevTestKitSkillIds = [
  'writing-plans',
  'test-driven-development',
  'systematic-debugging',
  'code-review',
  'refactoring',
  'unit-testing',
  'integration-testing',
  'e2e-testing',
  'coverage-gap-analysis',
  'flaky-test-repair',
  'qa-strategy',
];

const LOCALIZED = (en: string, zh: string): LocalizedText => ({ en, zh });

const SKILL_METADATA: Array<{ id: string; name: LocalizedText; description: LocalizedText }> = [
  { id: 'writing-plans', name: LOCALIZED('Writing Plans', '编写实施计划'), description: LOCALIZED('Turn a task into a precise, reviewable implementation plan.', '把任务转化为精确、可评审的实施计划。') },
  { id: 'test-driven-development', name: LOCALIZED('Test-Driven Development', '测试驱动开发'), description: LOCALIZED('Red–green–refactor workflow for features and bug fixes.', '用红-绿-重构循环驱动功能与缺陷修复。') },
  { id: 'systematic-debugging', name: LOCALIZED('Systematic Debugging', '系统化调试'), description: LOCALIZED('Find root causes with evidence, not guessing.', '用证据而非猜测定位问题根因。') },
  { id: 'code-review', name: LOCALIZED('Code Review', '代码审查'), description: LOCALIZED('Prioritised, actionable findings on any change.', '对变更给出按优先级排序、可执行的审查意见。') },
  { id: 'refactoring', name: LOCALIZED('Refactoring', '安全重构'), description: LOCALIZED('Improve structure without changing behaviour.', '在不改变行为的前提下改进代码结构。') },
  { id: 'unit-testing', name: LOCALIZED('Unit Testing', '单元测试'), description: LOCALIZED('Fast, focused tests for isolated logic.', '为独立逻辑编写快速、聚焦的单元测试。') },
  { id: 'integration-testing', name: LOCALIZED('Integration Testing', '集成测试'), description: LOCALIZED('Verify contracts and data flow across modules.', '验证模块间的契约与数据流。') },
  { id: 'e2e-testing', name: LOCALIZED('End-to-End Testing', '端到端测试'), description: LOCALIZED('Drive real user flows through the browser.', '通过浏览器驱动真实用户流程。') },
  { id: 'coverage-gap-analysis', name: LOCALIZED('Coverage Gap Analysis', '覆盖率缺口分析'), description: LOCALIZED('Find untested, high-risk code worth covering.', '找出值得覆盖的未测试高风险代码。') },
  { id: 'flaky-test-repair', name: LOCALIZED('Flaky Test Repair', '不稳定测试修复'), description: LOCALIZED('Make intermittent tests deterministic.', '让间歇性失败的测试变得确定可复现。') },
  { id: 'qa-strategy', name: LOCALIZED('QA Strategy', '测试策略'), description: LOCALIZED('Design a test pyramid, scope, and quality gates.', '设计测试金字塔、范围与质量门禁。') },
];

/** MarketplaceKit object surfaced in the Expert Kits area. */
export function buildSoftwareDevTestMarketplaceKit(): Record<string, unknown> {
  return {
    id: SoftwareDevTestKitId,
    name: LOCALIZED('Software Dev & Test', '软件研发与测试'),
    description: LOCALIZED(
      'A bundled skill set for software development and testing: planning, TDD, debugging, code review, refactoring, unit/integration/E2E testing, coverage, flaky-test repair and QA strategy.',
      '面向软件研发与测试的技能集：计划、TDD、调试、代码审查、重构、单元/集成/端到端测试、覆盖率分析、不稳定测试修复与测试策略。',
    ),
    author: 'LobsterAI',
    version: '1.0.0',
    tryAsking: [
      LOCALIZED('Write a plan for adding user authentication', '为新增用户认证写一份实施计划'),
      LOCALIZED('Generate unit tests for the billing module and run them', '为计费模块生成单元测试并运行'),
      LOCALIZED('Review this PR and fix the flaky test', '审查这个 PR 并修复不稳定测试'),
    ],
    skills: {
      bundle: 'builtin://software-dev-test',
      list: SKILL_METADATA,
    },
    mcpServers: [],
    connectors: [],
  };
}

/** Per-skill metadata for the InstalledKitRecord. */
export function softwareDevTestKitMetadata(): Record<string, { id: string; name: LocalizedText; description: LocalizedText }> {
  return Object.fromEntries(SKILL_METADATA.map((m) => [m.id, m]));
}
