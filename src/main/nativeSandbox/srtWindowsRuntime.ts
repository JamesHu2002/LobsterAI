interface SrtWinSpawn {
  exe: string;
  prependArgs: readonly string[];
}

interface WindowsSandboxRuntimeUserStatus {
  provisioned: boolean;
  sid?: string;
  groupExists: boolean;
  inBuiltinUsers: boolean;
  inSandboxGroup: boolean;
  hiddenFromLogon: boolean;
  credPresent: boolean;
}

interface WindowsSandboxRuntimeWfpStatus {
  state: 'absent' | 'installed' | 'cannot-read';
  filters: number;
  portRange?: [number, number];
}

export interface SrtWindowsRuntime {
  resolveSrtWin: (config?: { path?: string }) => SrtWinSpawn;
  getWindowsSandboxUserStatus: (options?: {
    srtWin?: SrtWinSpawn;
  }) => WindowsSandboxRuntimeUserStatus;
  getWindowsWfpStatus: (options?: {
    srtWin?: SrtWinSpawn;
  }) => WindowsSandboxRuntimeWfpStatus;
  verifyWindowsWfpEgress: (options?: {
    proxyPortRange?: readonly [number, number];
    srtWin?: SrtWinSpawn;
  }) => Promise<unknown>;
  installWindowsSandbox: (options?: {
    force?: boolean;
    srtWin?: SrtWinSpawn;
  }) => {
    cancelled?: true;
  };
}

const indirectImport = new Function(
  'specifier',
  'return import(specifier)',
) as (specifier: string) => Promise<unknown>;

const isSrtWindowsRuntime = (value: unknown): value is SrtWindowsRuntime => {
  if (!value || typeof value !== 'object') return false;
  const module = value as Partial<Record<keyof SrtWindowsRuntime, unknown>>;
  return typeof module.resolveSrtWin === 'function'
    && typeof module.getWindowsSandboxUserStatus === 'function'
    && typeof module.getWindowsWfpStatus === 'function'
    && typeof module.verifyWindowsWfpEgress === 'function'
    && typeof module.installWindowsSandbox === 'function';
};

/** Loads SRT only after an explicit status/setup request reaches the service. */
export const loadSrtWindowsRuntime = async (): Promise<SrtWindowsRuntime> => {
  const loaded = await indirectImport('@anthropic-ai/sandbox-runtime');
  if (!isSrtWindowsRuntime(loaded)) {
    throw new Error('The installed sandbox runtime does not expose the required Windows APIs.');
  }
  return loaded;
};
