import type { LocalizedText } from '../../shared/kit/constants';

/** Built-in kit for fetching and summarizing academic papers. */
export const PaperResearchKitId = 'paper-research';

/** Skills this kit manages (bundled with the app, disabled until installed). */
export const PaperResearchKitSkillIds = [
  'arxiv-search',
  'paper-fetch',
  'paper-analyze',
  'paper-summarize',
];

const LOCALIZED = (en: string, zh: string): LocalizedText => ({ en, zh });

const SKILL_METADATA: Array<{ id: string; name: LocalizedText; description: LocalizedText }> = [
  { id: 'arxiv-search', name: LOCALIZED('Arxiv & Scholar Search', '论文检索'), description: LOCALIZED('Search arXiv and Semantic Scholar for papers.', '检索 arXiv 与 Semantic Scholar 上的论文。') },
  { id: 'paper-fetch', name: LOCALIZED('Paper Fetch', '论文抓取'), description: LOCALIZED('Fetch and extract the full text of a paper.', '抓取并提取论文全文。') },
  { id: 'paper-analyze', name: LOCALIZED('Paper Analyze', '论文解析'), description: LOCALIZED('Extract background, algorithm, model structure and results.', '结构化提取背景、算法、模型结构与实验结果。') },
  { id: 'paper-summarize', name: LOCALIZED('Paper Summarize', '论文总结'), description: LOCALIZED('Write a structured article from paper analysis.', '把解析结果写成结构化的论文文章。') },
];

/** MarketplaceKit object surfaced in the Expert Kits area. */
export function buildPaperResearchMarketplaceKit(): Record<string, unknown> {
  return {
    id: PaperResearchKitId,
    name: LOCALIZED('Paper Research', '论文抓取与总结'),
    description: LOCALIZED(
      'A bundled skill set for fetching academic papers (arXiv / Semantic Scholar / Google Scholar / GitHub) and summarizing their background, algorithms, and model structure into articles.',
      '面向论文抓取与总结的技能集：从 arXiv / Semantic Scholar / Google Scholar / GitHub 检索论文，并将其背景、算法与模型结构总结成文章。',
    ),
    author: 'LobsterAI',
    version: '1.0.0',
    tryAsking: [
      LOCALIZED('Find recent papers on diffusion models for image generation', '检索近期关于扩散模型做图像生成的论文'),
      LOCALIZED('Summarize the Transformer architecture paper', '总结 Transformer 架构这篇论文'),
      LOCALIZED('Research and summarize 3 papers on RAG and compare them', '研究并总结 3 篇 RAG 相关论文并对比'),
    ],
    skills: {
      bundle: 'builtin://paper-research',
      list: SKILL_METADATA,
    },
    mcpServers: [],
    connectors: [],
  };
}

/** Per-skill metadata for the InstalledKitRecord. */
export function paperResearchKitMetadata(): Record<string, { id: string; name: LocalizedText; description: LocalizedText }> {
  return Object.fromEntries(SKILL_METADATA.map((m) => [m.id, m]));
}
