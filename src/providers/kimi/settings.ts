import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import { STANDARD_REASONING_VALUES } from '../../core/providers/reasoning';
import type { HostnameCliPaths } from '../../core/types/settings';
import {
  getHostnameKey,
  getLegacyHostnameKey,
  migrateLegacyHostnameKeyedMap,
} from '../../utils/env';
import {
  clearKimiReasoningMetadata,
  decodeKimiModelId,
  getKimiAvailableReasoningEfforts,
  type KimiDiscoveredModel,
  normalizeKimiDiscoveredModels,
} from './models';

export interface KimiCatalogSnapshot {
  models: KimiDiscoveredModel[];
  defaultModelId: string | null;
  fingerprint: string;
  refreshedAt: number;
}

export interface PersistedKimiProviderSettings {
  enabled: boolean;
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
  catalogsByHost: Record<string, KimiCatalogSnapshot>;
  environmentVariables: string;
  environmentHash: string;
  visibleModels: string[] | null;
  modelAliases: Record<string, string>;
  planBasePermissionMode: 'normal' | 'yolo';
  preferredReasoningByModel: Record<string, string>;
}

export interface KimiProviderSettings extends PersistedKimiProviderSettings {
  currentCatalog: KimiCatalogSnapshot | null;
}

export const DEFAULT_KIMI_PROVIDER_SETTINGS: Readonly<PersistedKimiProviderSettings> = Object.freeze({
  catalogsByHost: {},
  cliPath: '',
  cliPathsByHost: {},
  enabled: false,
  environmentHash: '',
  environmentVariables: '',
  modelAliases: {},
  planBasePermissionMode: 'normal',
  preferredReasoningByModel: {},
  visibleModels: null,
});

export function normalizeKimiCatalogSnapshot(value: unknown): KimiCatalogSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const defaultModelId = normalizeRawModelId(value.defaultModelId);
  const fingerprint = readTrimmedString(value.fingerprint);
  const refreshedAt = typeof value.refreshedAt === 'number'
    && Number.isFinite(value.refreshedAt)
    && value.refreshedAt >= 0
    ? Math.floor(value.refreshedAt)
    : 0;

  return {
    defaultModelId,
    fingerprint,
    models: normalizeKimiDiscoveredModels(value.models),
    refreshedAt,
  };
}

export function getKimiProviderSettings(
  settings: Record<string, unknown>,
): KimiProviderSettings {
  const config = getProviderConfig(settings, 'kimi');
  const currentHostKey = getHostnameKey();
  const legacyHostKey = getLegacyHostnameKey();
  const cliPathsByHost = migrateLegacyHostnameKeyedMap(
    normalizeHostnameCliPaths(config.cliPathsByHost),
    currentHostKey,
    legacyHostKey,
  );
  const catalogsByHost = migrateLegacyKimiCatalogs(
    normalizeKimiCatalogsByHost(config.catalogsByHost),
    currentHostKey,
    legacyHostKey,
  );
  const currentCatalog = catalogsByHost[currentHostKey] ?? null;
  const selectedModelIds = collectSelectedKimiRawModelIds(settings);
  const catalogModels = currentCatalog?.models ?? [];
  const allowedModelIds = new Set(catalogModels.map(model => model.rawId));
  for (const modelId of selectedModelIds) {
    allowedModelIds.add(modelId);
  }

  const visibleModels = normalizeKimiVisibleModels(
    config.visibleModels,
    allowedModelIds,
    catalogModels.length > 0,
  );
  const enabledModelIds = new Set(
    visibleModels ?? catalogModels.map(model => model.rawId),
  );

  return {
    catalogsByHost,
    cliPath: readTrimmedString(config.cliPath)
      || DEFAULT_KIMI_PROVIDER_SETTINGS.cliPath,
    cliPathsByHost,
    currentCatalog,
    enabled: typeof config.enabled === 'boolean'
      ? config.enabled
      : DEFAULT_KIMI_PROVIDER_SETTINGS.enabled,
    environmentHash: readTrimmedString(config.environmentHash),
    environmentVariables: typeof config.environmentVariables === 'string'
      ? config.environmentVariables
      : getProviderEnvironmentVariables(settings, 'kimi')
        ?? DEFAULT_KIMI_PROVIDER_SETTINGS.environmentVariables,
    modelAliases: normalizeKimiModelAliases(
      config.modelAliases,
      allowedModelIds,
      catalogModels.length > 0,
    ),
    planBasePermissionMode: normalizeKimiBasePermissionMode(config.planBasePermissionMode),
    preferredReasoningByModel: normalizeKimiPreferredReasoningByModel(
      config.preferredReasoningByModel,
      enabledModelIds,
      catalogModels,
      true,
    ),
    visibleModels,
  };
}

export function updateKimiProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<PersistedKimiProviderSettings>,
): KimiProviderSettings {
  const current = getKimiProviderSettings(settings);
  const currentHostKey = getHostnameKey();
  const cliPathsByHost = updates.cliPathsByHost !== undefined
    ? normalizeHostnameCliPaths(updates.cliPathsByHost)
    : { ...current.cliPathsByHost };
  let cliPath = updates.cliPathsByHost !== undefined
    ? readTrimmedString(updates.cliPath)
    : current.cliPath;

  if ('cliPath' in updates && updates.cliPathsByHost === undefined) {
    const hostCliPath = readTrimmedString(updates.cliPath);
    if (hostCliPath) {
      cliPathsByHost[currentHostKey] = hostCliPath;
    } else {
      delete cliPathsByHost[currentHostKey];
    }
    cliPath = DEFAULT_KIMI_PROVIDER_SETTINGS.cliPath;
  }

  const catalogsByHost = updates.catalogsByHost !== undefined
    ? normalizeKimiCatalogsByHost(updates.catalogsByHost)
    : { ...current.catalogsByHost };
  const currentCatalog = catalogsByHost[currentHostKey] ?? null;
  const catalogModels = currentCatalog?.models ?? [];
  const allowedModelIds = new Set(catalogModels.map(model => model.rawId));
  for (const modelId of collectSelectedKimiRawModelIds(settings)) {
    allowedModelIds.add(modelId);
  }
  const hasCatalog = catalogModels.length > 0;
  const visibleModels = normalizeKimiVisibleModels(
    updates.visibleModels === undefined ? current.visibleModels : updates.visibleModels,
    allowedModelIds,
    hasCatalog,
  );
  const enabledModelIds = new Set(
    visibleModels ?? catalogModels.map(model => model.rawId),
  );

  const next: PersistedKimiProviderSettings = {
    catalogsByHost,
    cliPath,
    cliPathsByHost,
    enabled: updates.enabled ?? current.enabled,
    environmentHash: updates.environmentHash !== undefined
      ? readTrimmedString(updates.environmentHash)
      : current.environmentHash,
    environmentVariables: updates.environmentVariables ?? current.environmentVariables,
    modelAliases: normalizeKimiModelAliases(
      updates.modelAliases ?? current.modelAliases,
      allowedModelIds,
      hasCatalog,
    ),
    planBasePermissionMode: updates.planBasePermissionMode !== undefined
      ? normalizeKimiBasePermissionMode(updates.planBasePermissionMode)
      : current.planBasePermissionMode,
    preferredReasoningByModel: normalizeKimiPreferredReasoningByModel(
      updates.preferredReasoningByModel ?? current.preferredReasoningByModel,
      enabledModelIds,
      catalogModels,
      true,
    ),
    visibleModels,
  };

  setProviderConfig(settings, 'kimi', next as unknown as Record<string, unknown>);
  return { ...next, currentCatalog };
}

export function updateKimiVisibleModels(
  settings: Record<string, unknown>,
  visibleModels: string[] | null,
): KimiProviderSettings {
  const current = getKimiProviderSettings(settings);
  const normalizedVisibleModels = normalizeKimiVisibleModels(
    visibleModels,
    new Set(current.currentCatalog?.models.map(model => model.rawId) ?? []),
    Boolean(current.currentCatalog?.models.length),
  );
  const enabledModelIds = new Set(
    normalizedVisibleModels
      ?? current.currentCatalog?.models.map(model => model.rawId)
      ?? [],
  );
  const catalogsByHost = Object.fromEntries(
    Object.entries(current.catalogsByHost).map(([hostKey, catalog]) => [
      hostKey,
      {
        ...catalog,
        models: catalog.models.map(model => (
          normalizedVisibleModels === null || enabledModelIds.has(model.rawId)
            ? model
            : clearKimiReasoningMetadata(model)
        )),
      },
    ]),
  );
  return updateKimiProviderSettings(settings, {
    catalogsByHost,
    preferredReasoningByModel: current.preferredReasoningByModel,
    visibleModels: normalizedVisibleModels,
  });
}

export function getCurrentKimiCatalog(
  settings: Record<string, unknown>,
): KimiCatalogSnapshot | null {
  return getKimiProviderSettings(settings).currentCatalog;
}

export function updateCurrentKimiCatalog(
  settings: Record<string, unknown>,
  snapshot: KimiCatalogSnapshot,
): KimiCatalogSnapshot | null {
  const normalized = normalizeKimiCatalogSnapshot(snapshot);
  if (!normalized) {
    return null;
  }
  const current = getKimiProviderSettings(settings);
  updateKimiProviderSettings(settings, {
    catalogsByHost: {
      ...current.catalogsByHost,
      [getHostnameKey()]: normalized,
    },
  });
  return normalized;
}

export function clearCurrentKimiCatalog(settings: Record<string, unknown>): boolean {
  const current = getKimiProviderSettings(settings);
  const currentHostKey = getHostnameKey();
  if (!current.catalogsByHost[currentHostKey]) {
    return false;
  }

  const catalogsByHost = { ...current.catalogsByHost };
  delete catalogsByHost[currentHostKey];
  updateKimiProviderSettings(settings, { catalogsByHost });
  return true;
}

export function normalizeKimiVisibleModels(
  value: unknown,
  allowedModelIds: ReadonlySet<string> = new Set(),
  restrictToAllowed = allowedModelIds.size > 0,
): string[] | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Array.isArray(value)) {
    return null;
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const rawModelId = normalizeRawModelId(entry);
    if (
      !rawModelId
      || seen.has(rawModelId)
      || (restrictToAllowed && !allowedModelIds.has(rawModelId))
    ) {
      continue;
    }
    seen.add(rawModelId);
    normalized.push(rawModelId);
  }
  return normalized;
}

export function normalizeKimiModelAliases(
  value: unknown,
  allowedModelIds: ReadonlySet<string> = new Set(),
  restrictToAllowed = allowedModelIds.size > 0,
): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [modelId, aliasValue] of Object.entries(value)) {
    const rawModelId = normalizeRawModelId(modelId);
    const alias = readTrimmedString(aliasValue);
    if (
      !rawModelId
      || !alias
      || (restrictToAllowed && !allowedModelIds.has(rawModelId))
    ) {
      continue;
    }
    normalized[rawModelId] = alias;
  }
  return normalized;
}

export function normalizeKimiPreferredReasoningByModel(
  value: unknown,
  allowedModelIds: ReadonlySet<string> = new Set(),
  catalogModels: KimiDiscoveredModel[] = [],
  restrictToAllowed = catalogModels.length > 0,
): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const catalogById = new Map(catalogModels.map(model => [model.rawId, model] as const));
  const normalized: Record<string, string> = {};
  for (const [modelId, effortValue] of Object.entries(value)) {
    const rawModelId = normalizeRawModelId(modelId);
    const effort = readTrimmedString(effortValue);
    if (
      !rawModelId
      || !effort
      || (restrictToAllowed && !allowedModelIds.has(rawModelId))
    ) {
      continue;
    }

    const catalogModel = catalogById.get(rawModelId);
    const supportedEfforts = new Set(catalogModel
      ? getKimiAvailableReasoningEfforts(catalogModel).map(option => option.value)
      : STANDARD_REASONING_VALUES);
    if (!supportedEfforts.has(effort)) {
      continue;
    }
    normalized[rawModelId] = effort;
  }
  return normalized;
}

function normalizeKimiCatalogsByHost(
  value: unknown,
): Record<string, KimiCatalogSnapshot> {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: Record<string, KimiCatalogSnapshot> = {};
  for (const [hostKey, snapshot] of Object.entries(value)) {
    const normalizedHostKey = hostKey.trim();
    const normalizedSnapshot = normalizeKimiCatalogSnapshot(snapshot);
    if (normalizedHostKey && normalizedSnapshot) {
      normalized[normalizedHostKey] = normalizedSnapshot;
    }
  }
  return normalized;
}

function normalizeHostnameCliPaths(value: unknown): HostnameCliPaths {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: HostnameCliPaths = {};
  for (const [hostKey, cliPath] of Object.entries(value)) {
    const normalizedHostKey = hostKey.trim();
    const normalizedCliPath = readTrimmedString(cliPath);
    if (normalizedHostKey && normalizedCliPath) {
      normalized[normalizedHostKey] = normalizedCliPath;
    }
  }
  return normalized;
}

function migrateLegacyKimiCatalogs(
  catalogsByHost: Record<string, KimiCatalogSnapshot>,
  currentHostKey: string,
  legacyHostKey: string,
): Record<string, KimiCatalogSnapshot> {
  if (
    !currentHostKey
    || !legacyHostKey
    || currentHostKey === legacyHostKey
    || !Object.prototype.hasOwnProperty.call(catalogsByHost, legacyHostKey)
  ) {
    return catalogsByHost;
  }

  const migrated = { ...catalogsByHost };
  if (!Object.prototype.hasOwnProperty.call(migrated, currentHostKey)) {
    migrated[currentHostKey] = migrated[legacyHostKey];
  }
  delete migrated[legacyHostKey];
  return migrated;
}

function collectSelectedKimiRawModelIds(settings: Record<string, unknown>): Set<string> {
  const selected = new Set<string>();
  addSelectedKimiRawModelId(selected, settings.model);
  addSelectedKimiRawModelId(selected, settings.titleGenerationModel);

  if (isRecord(settings.savedProviderModel)) {
    addSelectedKimiRawModelId(selected, settings.savedProviderModel.kimi);
  }
  return selected;
}

function addSelectedKimiRawModelId(target: Set<string>, value: unknown): void {
  if (typeof value !== 'string') {
    return;
  }
  const rawModelId = decodeKimiModelId(value.trim());
  if (rawModelId) {
    target.add(rawModelId);
  }
}

function normalizeRawModelId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  return decodeKimiModelId(normalized) ?? normalized;
}

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeKimiBasePermissionMode(value: unknown): 'normal' | 'yolo' {
  return value === 'yolo' ? 'yolo' : 'normal';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
