export interface NativeSandboxM0MigrationDependencies {
  getEnabled: () => boolean;
  persistEnabled: (enabled: boolean) => void;
  applyConfiguration: (enabled: boolean) => Promise<void>;
  logger?: Pick<Console, 'error'>;
}

export interface NativeSandboxM0MigrationResult {
  migrated: boolean;
  configurationApplied: boolean;
}

/**
 * M0 deliberately has no activatable native executor. Persisted test-build
 * state must therefore fail closed instead of silently selecting the legacy
 * backend after an upgrade.
 */
export const migrateNativeSandboxM0Configuration = async (
  dependencies: NativeSandboxM0MigrationDependencies,
): Promise<NativeSandboxM0MigrationResult> => {
  if (!dependencies.getEnabled()) {
    return {
      migrated: false,
      configurationApplied: false,
    };
  }

  dependencies.persistEnabled(false);
  try {
    await dependencies.applyConfiguration(false);
    return {
      migrated: true,
      configurationApplied: true,
    };
  } catch (error) {
    (dependencies.logger ?? console).error(
      '[NativeSandbox] Failed to apply the M0 fail-closed configuration migration.',
      error,
    );
    return {
      migrated: true,
      configurationApplied: false,
    };
  }
};
