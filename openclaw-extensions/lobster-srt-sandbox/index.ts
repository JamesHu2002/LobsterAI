import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

/**
 * M1 only reserves a packaged OpenClaw extension entry point. It deliberately
 * registers no sandbox backend or tools, so merely shipping the extension
 * cannot change command or file execution. A later milestone will register
 * the backend only when LobsterAI writes an explicit opt-in configuration.
 */
const plugin = {
  id: 'lobster-srt-sandbox',
  name: 'Lobster SRT Sandbox',
  description: 'Reserved OpenClaw integration point for the LobsterAI native sandbox.',
  register(_api: OpenClawPluginApi) {
    // Intentionally inert during M1.
  },
};

export default plugin;
