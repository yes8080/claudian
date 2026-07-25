import {
  DEFAULT_REASONING_VALUE,
  formatReasoningValueLabel,
  resolvePreferredReasoningDefault,
} from '../../../core/providers/reasoning';
import type {
  ProviderChatUIConfig,
  ProviderPermissionModeToggleConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import { KIMI_PROVIDER_ICON } from '../../../shared/icons';
import {
  decodeKimiModelId,
  encodeKimiModelId,
  findKimiModel,
  getKimiAvailableReasoningEfforts,
  isKimiModelSelectionId,
  resolveKimiContextWindow,
} from '../models';
import { getKimiProviderSettings, updateKimiProviderSettings } from '../settings';

const KIMI_PERMISSION_MODE_TOGGLE: ProviderPermissionModeToggleConfig = {
  inactiveValue: 'normal',
  inactiveLabel: 'Safe',
  activeValue: 'yolo',
  activeLabel: 'YOLO',
  planValue: 'plan',
  planLabel: 'PLAN',
};

export const kimiChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings): ProviderUIOption[] {
    const kimiSettings = getKimiProviderSettings(settings);
    const catalogModels = kimiSettings.currentCatalog?.models ?? [];
    const catalogById = new Map(catalogModels.map(model => [model.rawId, model] as const));
    const visibleModelIds = kimiSettings.visibleModels
      ?? catalogModels.map(model => model.rawId);
    const options: ProviderUIOption[] = [];
    const seen = new Set<string>();

    for (const rawId of visibleModelIds) {
      pushModelOption(options, seen, rawId, catalogById, kimiSettings.modelAliases);
    }

    return options;
  },

  getDefaultModel(settings): string | null {
    const defaultModelId = getKimiProviderSettings(settings).currentCatalog?.defaultModelId?.trim();
    const options = this.getModelOptions(settings);
    const preferred = defaultModelId ? encodeKimiModelId(defaultModelId) : null;
    return (preferred && options.some(option => option.value === preferred)
      ? preferred
      : options[0]?.value) ?? null;
  },

  ownsModel(model, settings): boolean {
    return isKimiModelSelectionId(model)
      && this.getModelOptions(settings)
        .some(option => option.value === model.trim());
  },

  isAdaptiveReasoningModel(model, settings): boolean {
    return getKimiAvailableReasoningEfforts(
      getExplicitlySelectedKimiModel(model, settings),
    ).length > 0;
  },

  getReasoningOptions(model, settings): ProviderReasoningOption[] {
    return getKimiAvailableReasoningEfforts(
      getExplicitlySelectedKimiModel(model, settings),
    ).map(option => ({
      ...(option.description ? { description: option.description } : {}),
      label: formatReasoningValueLabel(option.value),
      value: option.value,
    }));
  },

  getDefaultReasoningValue(model, settings): string {
    const kimiSettings = getKimiProviderSettings(settings);
    const rawId = decodeKimiModelId(model);
    if (!rawId) {
      return '';
    }
    const efforts = getKimiAvailableReasoningEfforts(
      getExplicitlySelectedKimiModel(model, settings),
    );
    if (efforts.length === 0) {
      return '';
    }
    const availableValues = efforts.map(effort => effort.value);
    const preferred = kimiSettings.preferredReasoningByModel[rawId];
    if (preferred && availableValues.includes(preferred)) {
      return preferred;
    }
    return resolvePreferredReasoningDefault(availableValues, DEFAULT_REASONING_VALUE);
  },

  getContextWindowSize(model, customLimits = {}, settings = {}): number {
    const rawId = resolveSelectedKimiRawModelId(model, settings);
    return resolveKimiContextWindow(
      rawId ? encodeKimiModelId(rawId) : model,
      getKimiProviderSettings(settings).currentCatalog?.models ?? [],
      customLimits,
    );
  },

  isDefaultModel(): boolean {
    return false;
  },

  applyModelDefaults(model, settings): void {
    if (!isRecord(settings)) {
      return;
    }
    const normalizedModel = normalizeSelection(model);
    if (!isKimiModelSelectionId(normalizedModel)) {
      return;
    }
    clearSavedKimiEffortProjection(settings);
    settings.model = normalizedModel;
    settings.effortLevel = this.getDefaultReasoningValue(normalizedModel, settings);
  },

  applyModelProjectionDefaults(model, settings): void {
    if (!isRecord(settings)) {
      return;
    }
    clearSavedKimiEffortProjection(settings);
    const rawId = decodeKimiModelId(model);
    if (!rawId) {
      delete settings.effortLevel;
      return;
    }
    settings.effortLevel = this.getDefaultReasoningValue(model, settings);
  },

  applyReasoningSelection(model, value, settings): void {
    if (!isRecord(settings)) {
      return;
    }
    const rawId = decodeKimiModelId(model);
    if (!rawId) {
      clearSavedKimiEffortProjection(settings);
      delete settings.effortLevel;
      return;
    }
    const kimiSettings = getKimiProviderSettings(settings);
    const supportedValues = new Set(getKimiAvailableReasoningEfforts(
      getExplicitlySelectedKimiModel(model, settings),
    ).map(option => option.value));
    const preferredReasoningByModel = { ...kimiSettings.preferredReasoningByModel };
    if (supportedValues.has(value)) {
      preferredReasoningByModel[rawId] = value;
    } else {
      delete preferredReasoningByModel[rawId];
    }
    updateKimiProviderSettings(settings, { preferredReasoningByModel });
  },

  normalizeModelVariant(model): string {
    return normalizeSelection(model);
  },

  getCustomModelIds(): Set<string> {
    return new Set();
  },

  getPermissionModeToggle(): ProviderPermissionModeToggleConfig {
    return KIMI_PERMISSION_MODE_TOGGLE;
  },

  resolvePermissionMode(settings): string {
    if (settings.permissionMode === 'plan') return 'plan';
    return settings.permissionMode === 'yolo' ? 'yolo' : 'normal';
  },

  applyPermissionMode(value, settings): void {
    if (isRecord(settings)) {
      const currentMode = settings.permissionMode;
      if (value === 'plan') {
        if (currentMode === 'normal' || currentMode === 'yolo') {
          updateKimiProviderSettings(settings, { planBasePermissionMode: currentMode });
        }
        settings.permissionMode = 'plan';
        return;
      }
      const baseMode = value === 'yolo' ? 'yolo' : 'normal';
      updateKimiProviderSettings(settings, { planBasePermissionMode: baseMode });
      settings.permissionMode = baseMode;
    }
  },

  getModeSelector(): null {
    return null;
  },

  getProviderIcon() {
    return KIMI_PROVIDER_ICON;
  },
};

function pushModelOption(
  options: ProviderUIOption[],
  seen: Set<string>,
  rawId: string,
  catalogById: ReadonlyMap<string, { description?: string; displayName: string }>,
  aliases: Record<string, string>,
): void {
  const value = encodeKimiModelId(rawId);
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  const model = catalogById.get(rawId);
  options.push({
    value,
    label: aliases[rawId] ?? model?.displayName ?? rawId,
    description: model?.description ?? 'Selected in an existing session',
  });
}

function normalizeSelection(model: string): string {
  const normalized = model.trim();
  const rawId = decodeKimiModelId(normalized);
  return rawId ? encodeKimiModelId(rawId) : model;
}

function resolveSelectedKimiRawModelId(
  model: string,
  settings: Record<string, unknown>,
): string | null {
  return decodeKimiModelId(model);
}

function getExplicitlySelectedKimiModel(
  model: string,
  settings: Record<string, unknown>,
) {
  const rawId = decodeKimiModelId(model);
  if (!rawId) {
    return null;
  }
  const kimiSettings = getKimiProviderSettings(settings);
  const catalogModels = kimiSettings.currentCatalog?.models ?? [];
  const visibleModels = kimiSettings.visibleModels
    ?? catalogModels.map(entry => entry.rawId);
  if (!visibleModels.includes(rawId)) {
    return null;
  }
  return findKimiModel(catalogModels, rawId) ?? {
    displayName: rawId,
    rawId,
    reasoningEfforts: [],
    supportsReasoning: false,
  };
}

function clearSavedKimiEffortProjection(settings: Record<string, unknown>): void {
  if (isRecord(settings.savedProviderEffort)) {
    delete settings.savedProviderEffort.kimi;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
