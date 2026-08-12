import type { LocalizedText } from '../../shared/kit/constants';

/**
 * Built-in kit for the skill-factory pipeline. The two skills it manages
 * (skill-creator for authoring, skill-vetter for security vetting) are already
 * bundled and enabled by default; the kit definition records the dependency for
 * marketplace visibility and keeps provisioning consistent with paper-research.
 */
export const SkillFactoryKitId = 'skill-factory';

/** Skills the skill-factory pipeline relies on. */
export const SkillFactoryKitSkillIds = ['skill-creator', 'skill-vetter'];

const LOCALIZED = (en: string, zh: string): LocalizedText => ({ en, zh });

const SKILL_METADATA: Array<{ id: string; name: LocalizedText; description: LocalizedText }> = [
  {
    id: 'skill-creator',
    name: LOCALIZED('Skill Creator', '技能制作'),
    description: LOCALIZED('Create, modify, evaluate and package skills.', '创建、修改、评估并打包技能。'),
  },
  {
    id: 'skill-vetter',
    name: LOCALIZED('Skill Vetter', '技能安全审查'),
    description: LOCALIZED('Security vetting protocol for skills before install.', '安装前对技能进行安全审查。'),
  },
];

/** MarketplaceKit object surfaced in the Expert Kits area. */
export function buildSkillFactoryMarketplaceKit(): Record<string, unknown> {
  return {
    id: SkillFactoryKitId,
    name: LOCALIZED('Skill Factory', '技能制作流水线'),
    description: LOCALIZED(
      'A bundled skill set used by the skill-factory pipeline to author, evaluate and package new skills.',
      '技能制作流水线使用的技能集：用于制作、评估并打包新技能。',
    ),
    author: 'LobsterAI',
    version: '1.0.0',
    tryAsking: [
      LOCALIZED('Make a skill that summarizes meeting minutes into action items', '制作一个把会议纪要总结成待办事项的技能'),
      LOCALIZED('Create a skill that searches and summarizes the latest AI news', '创建一个搜索并总结最新 AI 动态的技能'),
      LOCALIZED('Build a skill for checking code style before commits', '制作一个提交前检查代码风格的技能'),
    ],
    skills: {
      bundle: 'builtin://skill-factory',
      list: SKILL_METADATA,
    },
    mcpServers: [],
    connectors: [],
  };
}

/** Per-skill metadata for the InstalledKitRecord. */
export function skillFactoryKitMetadata(): Record<string, { id: string; name: LocalizedText; description: LocalizedText }> {
  return Object.fromEntries(SKILL_METADATA.map((m) => [m.id, m]));
}
