import type { ProviderConfig } from '../../shared/providers/types';
import type { SqliteStore } from '../sqliteStore';

export interface ModelEndpointAccess {
  apiKey: string | null;
  /** Full lm-eval base_url ending in /chat/completions. */
  lmEvalBaseUrl: string;
}

/**
 * Resolve an OpenAI-compatible provider endpoint (from app_config.providers)
 * into the full base_url lm-eval expects (ending in /chat/completions).
 * Works for cloud providers (deepseek, …) and local OpenAI-compatible servers
 * (Ollama / llama.cpp / vLLM) alike.
 */
export function readModelEndpoint(
  getStore: () => SqliteStore,
  providerKey: string,
): ModelEndpointAccess | null {
  const appConfig = getStore().get<{ providers?: Record<string, ProviderConfig> }>('app_config');
  const provider = appConfig?.providers?.[providerKey];
  const baseUrl = (provider?.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!baseUrl) return null;

  const lmEvalBaseUrl = baseUrl.endsWith('/chat/completions')
    ? baseUrl
    : baseUrl.endsWith('/v1')
      ? `${baseUrl}/chat/completions`
      : `${baseUrl}/v1/chat/completions`;

  return { apiKey: provider?.apiKey?.trim() || null, lmEvalBaseUrl };
}
