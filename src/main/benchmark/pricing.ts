import { BenchmarkDefaults } from '../../benchmark/constants';

export interface ModelPrice {
  /** USD per 1M input tokens */
  in: number;
  /** USD per 1M output tokens */
  out: number;
  /** USD per 1M cache-read tokens */
  read: number;
  /** USD per 1M cache-write tokens */
  write: number;
}

/**
 * Built-in price table (USD per 1M tokens), matched against the OpenClaw model
 * ref ("openclawProviderId/modelId"). First matching row wins; a configurable
 * override lives under app_config.benchmark.pricing (see getModelPrice).
 */
const DEFAULT_PRICE_TABLE: Array<{ match: RegExp; price: ModelPrice }> = [
  // Anthropic Claude
  { match: /claude-3-7-sonnet/, price: { in: 3, out: 15, read: 0.3, write: 3.75 } },
  { match: /claude-opus/i, price: { in: 15, out: 75, read: 1.5, write: 18.75 } },
  { match: /claude-sonnet/i, price: { in: 3, out: 15, read: 0.3, write: 3.75 } },
  { match: /claude-haiku/i, price: { in: 0.8, out: 4, read: 0.08, write: 1 } },
  { match: /claude/i, price: { in: 3, out: 15, read: 0.3, write: 3.75 } },
  // DeepSeek
  { match: /deepseek-(v|r|reasoner)/i, price: { in: 0.27, out: 1.1, read: 0.07, write: 0.27 } },
  { match: /deepseek/i, price: { in: 0.27, out: 1.1, read: 0.07, write: 0.27 } },
  // Moonshot Kimi
  { match: /kimi/i, price: { in: 4, out: 16, read: 4, write: 4 } },
  // Qwen
  { match: /qwen/i, price: { in: 0.5, out: 2, read: 0.5, write: 0.5 } },
  // GPT / OpenAI
  { match: /gpt-4o/i, price: { in: 2.5, out: 10, read: 1.25, write: 2.5 } },
  { match: /gpt-4/i, price: { in: 30, out: 60, read: 15, write: 30 } },
  { match: /gpt-3\.5|gpt-4o-mini/i, price: { in: 0.5, out: 1.5, read: 0.5, write: 0.5 } },
  { match: /gpt/i, price: { in: 2.5, out: 10, read: 1.25, write: 2.5 } },
  // Gemini
  { match: /gemini/i, price: { in: 1.25, out: 5, read: 0.31, write: 1.25 } },
  // Llama / open-source defaults
  { match: /llama/i, price: { in: 0.3, out: 0.6, read: 0.3, write: 0.3 } },
];

const FALLBACK_PRICE: ModelPrice = BenchmarkDefaults.fallbackPrice;

/**
 * Resolve the price for a model ref. Checks a user override under
 * app_config.benchmark.pricing (keyed by model ref prefix), then the built-in
 * table, then the fallback.
 */
export function getModelPrice(modelRef: string): ModelPrice {
  const override = readUserPriceOverride(modelRef);
  if (override) return override;
  for (const row of DEFAULT_PRICE_TABLE) {
    if (row.match.test(modelRef)) return row.price;
  }
  return { ...FALLBACK_PRICE };
}

function readUserPriceOverride(modelRef: string): ModelPrice | null {
  try {
    const { app } = require('electron');
    // userData/electron-store is read lazily and may not be ready pre-ready.
    if (!app.isReady()) return null;
    const configPath = require('path').join(app.getPath('userData'), 'app_config.json');
    const fs = require('fs') as typeof import('fs');
    if (!fs.existsSync(configPath)) return null;
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as {
      benchmark?: { pricing?: Record<string, ModelPrice> };
    };
    const pricing = config?.benchmark?.pricing;
    if (!pricing) return null;
    const keys = Object.keys(pricing).sort((a, b) => b.length - a.length);
    for (const key of keys) {
      if (modelRef.startsWith(key)) return pricing[key];
    }
  } catch {
    // ignore
  }
  return null;
}

export function estimateCostUsd(
  modelRef: string,
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
): number {
  const p = getModelPrice(modelRef);
  return (
    tokens.input * p.in
    + tokens.output * p.out
    + tokens.cacheRead * p.read
    + tokens.cacheWrite * p.write
  ) / 1_000_000;
}
