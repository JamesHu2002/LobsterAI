import { describe, test } from 'vitest';

import { expectPatchContains } from './patchTestUtils';

describe('final OpenClaw 6.1 patch decisions', () => {
  test('carries aborted tool loop breaker because upstream generic loop detection is not enough', () => {
    expectPatchContains('openclaw-aborted-tool-loop-breaker.patch', [
      'ABORTED_TOOL_LOOP_CRITICAL_THRESHOLD',
      'detector: "aborted_tool_loop"',
      'sanitizeAbortedToolLoopHistory',
      'MAX_PRESERVED_ABORTED_TOOL_HISTORY_PAIRS',
    ]);
  });

  test('carries prompt segment fallback skip because derivePromptSegments is diagnostic-only', () => {
    expectPatchContains('openclaw-skip-derive-prompt-segments-deadloop.patch', [
      'skip derivePromptSegments fallback',
      'const promptSegments = runResult.meta?.promptSegments',
    ]);
  });

  test('carries subagent cleanup finalize best-effort handling for bundle runtime', () => {
    expectPatchContains('openclaw-subagent-cleanup-finalize-best-effort.patch', [
      'emitCompletionEndedHookBestEffort',
      'failed to emit subagent ended hook during cleanup',
      'GATEWAY_BUNDLE_BASENAME',
      './dist/${joined.slice(2)}',
    ]);
  });

  test('carries Kimi K3 length-limited continuation because OpenClaw 6.1 lacks 7.1 terminal handling', () => {
    expectPatchContains('openclaw-kimi-k3-length-continuation.patch', [
      'DEFAULT_LENGTH_LIMITED_RETRY_LIMIT',
      'resolveLengthLimitedRetryInstruction',
      'length-limited assistant turn detected',
      'retries length-limited turns only when replay remains safe',
      'thinkingLevelMap: ThinkingLevelMapSchema.optional()',
      'accepts the official Kimi K3 model entry carrying thinkingLevelMap',
    ]);
  });
});
