import type { InstalledKitRecord, KitSkillMetadata } from '../../shared/kit/constants';
import type { SqliteStore } from '../sqliteStore';

const SKILLS_STATE_KEY = 'skills_state';

function readSkillsState(store: SqliteStore): Record<string, { enabled: boolean }> {
  return store.get<Record<string, { enabled: boolean }>>(SKILLS_STATE_KEY) ?? {};
}

export interface BundledSkillKitDefinition {
  id: string;
  version: string;
  skillIds: string[];
  metadata?: Record<string, KitSkillMetadata>;
}

/**
 * Built-in kits whose skills ship bundled with the app (disabled by default).
 * "Installing" such a kit just enables its skills and records the install —
 * no remote bundle download is involved.
 */
export function installBundledSkillKit(store: SqliteStore, def: BundledSkillKitDefinition): InstalledKitRecord {
  const stateMap = readSkillsState(store);
  for (const skillId of def.skillIds) {
    stateMap[skillId] = { enabled: true };
  }
  store.set(SKILLS_STATE_KEY, stateMap);
  return {
    id: def.id,
    version: def.version,
    installedAt: Date.now(),
    skills: def.skillIds.length > 0
      ? {
        skillIds: [...def.skillIds],
        ...(def.metadata && Object.keys(def.metadata).length > 0 ? { metadata: def.metadata } : {}),
      }
      : null,
    mcpServers: [],
    connectors: [],
  };
}

export function uninstallBundledSkillKit(store: SqliteStore, skillIds: string[]): void {
  const stateMap = readSkillsState(store);
  for (const skillId of skillIds) {
    stateMap[skillId] = { enabled: false };
  }
  store.set(SKILLS_STATE_KEY, stateMap);
}
