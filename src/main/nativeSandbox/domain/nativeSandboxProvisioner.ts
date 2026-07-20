import type {
  NativeSandboxOperationResult,
} from '../../../shared/nativeSandbox/types';

/**
 * Main-process control-plane contract.
 *
 * Provisioners may inspect, install, or repair platform runtime components,
 * but they never execute model-generated commands. Command execution belongs
 * to the OpenClaw-side NativeSandboxExecutor contract.
 */
export interface NativeSandboxProvisioner {
  getStatus: () => Promise<NativeSandboxOperationResult>;
  install: () => Promise<NativeSandboxOperationResult>;
  repair: () => Promise<NativeSandboxOperationResult>;
}
