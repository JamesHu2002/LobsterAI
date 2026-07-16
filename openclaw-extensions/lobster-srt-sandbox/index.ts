import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

import { registerLobsterSrtSandboxBackend } from './src/backend/index.js';

export default definePluginEntry({
  id: 'lobster-srt-sandbox',
  name: 'Lobster SRT Sandbox',
  description: 'Windows native sandbox backend for LobsterAI task workspaces.',
  register(api) {
    // Discovery/setup loads must not mutate the process-global backend registry.
    if (api.registrationMode !== 'full') {
      return;
    }

    registerLobsterSrtSandboxBackend();
    api.logger.info('[lobster-srt-sandbox] registered lobster-srt sandbox backend.');
  },
});
