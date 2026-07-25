import * as fs from 'node:fs';
import * as path from 'node:path';

import { Notice, Setting } from 'obsidian';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderSettingsTabRenderer,
  ProviderSettingsTabRendererContext,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import type { ClaudianSettings } from '../../../core/types';
import { t } from '../../../i18n/i18n';
import { renderEnvironmentSettingsSection } from '../../../shared/settings/EnvironmentSettingsSection';
import {
  type ProviderModelPickerModel,
  type ProviderModelPickerState,
  renderProviderModelPicker,
} from '../../../shared/settings/ProviderModelPicker';
import { getHostnameKey } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import type { KimiDiscoveredModel } from '../models';
import {
  clearCurrentKimiCatalog,
  getKimiProviderSettings,
  normalizeKimiVisibleModels,
  updateKimiProviderSettings,
  updateKimiVisibleModels,
} from '../settings';

const KIMI_PROVIDER_ID = 'kimi' as const;

export const kimiSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const initialSettings = getKimiProviderSettings(settingsBag);
    const hostnameKey = getHostnameKey();
    const workspace = getKimiWorkspaceServices();

    const refreshModelCatalog = async (): Promise<'empty' | 'failed' | 'loaded'> => {
      if (!workspace?.refreshModelCatalog) {
        return 'failed';
      }
      const result = await workspace.refreshModelCatalog();
      if (result.diagnostics) {
        new Notice(`Kimi model discovery failed: ${result.diagnostics}`);
        return 'failed';
      }
      context.notifyProviderModelOptionsChanged(KIMI_PROVIDER_ID);
      return (getKimiProviderSettings(settingsBag).currentCatalog?.models.length ?? 0) > 0
        ? 'loaded'
        : 'empty';
    };

    new Setting(container).setName('Setup').setHeading();

    new Setting(container)
      .setName(t('settings.providerEnablement.name', { provider: 'Kimi' }))
      .setDesc(t('settings.providerEnablement.desc', { provider: 'Kimi' }))
      .addToggle(toggle => toggle
        .setValue(initialSettings.enabled)
        .onChange(async (enabled) => {
          await context.plugin.mutateSettings((settings) => {
            ProviderSettingsCoordinator.applyProviderEnablement(
              settings,
              KIMI_PROVIDER_ID,
              enabled,
            );
          });
          if (enabled) {
            await refreshModelCatalog();
          }
          context.notifyProviderModelOptionsChanged(KIMI_PROVIDER_ID);
        }));

    const cliPathSetting = new Setting(container)
      .setName('CLI path')
      .setDesc('Optional absolute path to the Kimi CLI for this computer. Leave empty to prefer known installs, then `kimi` from PATH.');
    const validationEl = container.createDiv({
      cls: 'claudian-cli-path-validation claudian-setting-validation claudian-setting-validation-error claudian-hidden',
    });
    const cliPathsByHost = { ...initialSettings.cliPathsByHost };
    const initialCliPath = initialSettings.cliPathsByHost[hostnameKey]
      ?? initialSettings.cliPath
      ?? '';
    let currentCliPath = initialCliPath;
    let cliPathInputEl: HTMLInputElement | null = null;

    const updateCliPathValidation = (value: string, input?: HTMLInputElement): boolean => {
      const error = validateCliPath(value);
      if (error) {
        validationEl.setText(error);
        validationEl.toggleClass('claudian-hidden', false);
        input?.toggleClass('claudian-input-error', true);
        return false;
      }
      validationEl.toggleClass('claudian-hidden', true);
      input?.toggleClass('claudian-input-error', false);
      return true;
    };

    const resynchronizeCliPathState = (): void => {
      const persistedSettings = getKimiProviderSettings(settingsBag);
      for (const hostKey of Object.keys(cliPathsByHost)) {
        delete cliPathsByHost[hostKey];
      }
      Object.assign(cliPathsByHost, persistedSettings.cliPathsByHost);
      currentCliPath = persistedSettings.cliPathsByHost[hostnameKey]
        ?? persistedSettings.cliPath
        ?? '';
      if (cliPathInputEl) {
        cliPathInputEl.value = currentCliPath;
        updateCliPathValidation(currentCliPath, cliPathInputEl);
      }
    };

    const persistCliPath = async (value: string): Promise<void> => {
      if (!updateCliPathValidation(value, cliPathInputEl ?? undefined)) {
        return;
      }
      const trimmed = value.trim();
      if (trimmed === currentCliPath.trim()) {
        return;
      }
      if (trimmed) {
        cliPathsByHost[hostnameKey] = trimmed;
      } else {
        delete cliPathsByHost[hostnameKey];
      }

      const mutation = (settings: ClaudianSettings): void => {
        updateKimiProviderSettings(settings, {
          cliPath: '',
          cliPathsByHost: { ...cliPathsByHost },
        });
        clearCurrentKimiCatalog(settings);
      };
      try {
        if (context.plugin.mutateProviderSettingsAndRecycleRuntimes) {
          await context.plugin.mutateProviderSettingsAndRecycleRuntimes(
            KIMI_PROVIDER_ID,
            mutation,
          );
        } else {
          await context.plugin.mutateSettings(mutation);
          workspace?.cliResolver?.reset();
          await context.plugin.recycleProviderRuntimes?.(KIMI_PROVIDER_ID);
        }
      } catch (error) {
        resynchronizeCliPathState();
        throw error;
      }
      currentCliPath = trimmed;
      context.notifyProviderModelOptionsChanged(KIMI_PROVIDER_ID);
    };

    cliPathSetting.addText(text => {
      text
        .setPlaceholder(process.platform === 'win32'
          ? 'C:\\Users\\you\\AppData\\Roaming\\npm\\kimi.cmd'
          : '/usr/local/bin/kimi')
        .setValue(initialCliPath)
        .onChange(persistCliPath);
      text.inputEl.addClass('claudian-settings-cli-path-input');
      cliPathInputEl = text.inputEl;
      updateCliPathValidation(initialCliPath, text.inputEl);
    });

    new Setting(container).setName('Models').setHeading();
    renderKimiModelPicker(container, context, settingsBag, refreshModelCatalog);

    new Setting(container).setName(t('settings.agentSkills.sectionTitle')).setHeading();
    context.renderAgentSkillSettings(container, KIMI_PROVIDER_ID);

    new Setting(container).setName('Commands').setHeading();
    context.renderHiddenProviderCommandSetting(container, KIMI_PROVIDER_ID, {
      name: 'Hidden Kimi commands',
      desc: 'Hide runtime commands advertised by Kimi from the command dropdown. Enter names without the leading slash, one per line.',
      placeholder: 'compact\nreview',
    });

    renderEnvironmentSettingsSection({
      container,
      desc: 'Environment variables passed only to Kimi. Custom-model secrets stay in this provider scope and are referenced from native config by env_key.',
      heading: 'Environment',
      name: 'Kimi environment variables',
      placeholder: 'KIMI_HOME=/path/to/kimi-home\nKIMI_DEFAULT_MODEL=kimi-code-fast-1',
      plugin: context.plugin,
      renderCustomContextLimits: target => context.renderCustomContextLimits(target, KIMI_PROVIDER_ID),
      scope: 'provider:kimi',
    });
  },
};

function renderKimiModelPicker(
  container: HTMLElement,
  context: ProviderSettingsTabRendererContext,
  settingsBag: Record<string, unknown>,
  loadCatalog: () => Promise<'empty' | 'failed' | 'loaded'>,
): void {
  const getState = (): ProviderModelPickerState => {
    const settings = getKimiProviderSettings(settingsBag);
    const catalogModels = settings.currentCatalog?.models ?? [];
    const selectedIds = settings.visibleModels ?? catalogModels.map(model => model.rawId);
    return {
      aliases: settings.modelAliases,
      discoveredCount: catalogModels.length,
      models: buildKimiPickerModels(catalogModels, selectedIds),
      selectedIds,
    };
  };

  renderProviderModelPicker({
    checkCatalogFreshnessWhenCached: true,
    container,
    emptyCatalogText: 'No Kimi models discovered yet. Run `kimi login` if needed, then click Discover.',
    failedCatalogText: 'Could not load the Kimi model catalog. Check the CLI path, account login, and custom-model environment, then try again.',
    getState,
    initiallyOpen: (getKimiProviderSettings(settingsBag).currentCatalog?.models.length ?? 0) === 0,
    loadCatalog: async () => loadCatalog(),
    loadingCatalogText: 'Loading the Kimi model catalog...',
    modifier: 'kimi',
    async onAliasesChange(modelAliases) {
      await context.plugin.mutateSettings((settings) => {
        updateKimiProviderSettings(settings, { modelAliases });
      });
      context.notifyProviderModelOptionsChanged(KIMI_PROVIDER_ID);
    },
    async onSelectedIdsChange(selectedIds) {
      const current = getKimiProviderSettings(settingsBag);
      const models = current.currentCatalog?.models ?? [];
      const allowedIds = new Set(models.map(model => model.rawId));
      const normalized = normalizeKimiVisibleModels(selectedIds, allowedIds, models.length > 0);
      const nextVisibleModels = representsWholeCatalog(normalized, models) ? null : normalized;
      if (sameOptionalList(current.visibleModels, nextVisibleModels)) {
        return;
      }
      await context.plugin.mutateSettings((settings) => {
        updateKimiVisibleModels(settings, nextVisibleModels);
      });
      context.notifyProviderModelOptionsChanged(KIMI_PROVIDER_ID);
    },
    providerName: 'Kimi',
    searchPlaceholder: 'Filter by model name, description, or alias ID...',
    settingDescription: 'Choose which discovered Kimi models are available in Claudian. Kimi is unavailable when no models are selected.',
  });
}

function buildKimiPickerModels(
  catalogModels: KimiDiscoveredModel[],
  selectedIds: string[],
): ProviderModelPickerModel[] {
  const models: ProviderModelPickerModel[] = catalogModels.map(model => ({
    description: model.description,
    id: model.rawId,
    isAvailable: true,
    name: model.displayName,
  }));
  const catalogIds = new Set(catalogModels.map(model => model.rawId));
  for (const rawId of selectedIds) {
    if (catalogIds.has(rawId)) {
      continue;
    }
    models.push({
      description: 'Selected model',
      id: rawId,
      isAvailable: false,
      name: rawId,
      unavailableMessage: 'Not currently reported by Kimi',
    });
  }
  return models;
}

function representsWholeCatalog(
  selectedIds: string[] | null,
  catalogModels: KimiDiscoveredModel[],
): boolean {
  if (!selectedIds || selectedIds.length !== catalogModels.length) {
    return false;
  }
  const selected = new Set(selectedIds);
  return catalogModels.every(model => selected.has(model.rawId));
}

function sameOptionalList(left: string[] | null, right: string[] | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateCliPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const expandedPath = expandHomePath(trimmed);
  if (!path.posix.isAbsolute(expandedPath) && !path.win32.isAbsolute(expandedPath)) {
    return 'Path must be absolute';
  }
  try {
    if (!fs.existsSync(expandedPath)) {
      return 'Path does not exist';
    }
    if (!fs.statSync(expandedPath).isFile()) {
      return 'Path must point to a file';
    }
    if (process.platform !== 'win32') {
      fs.accessSync(expandedPath, fs.constants.X_OK);
    }
  } catch {
    return process.platform === 'win32'
      ? 'Path is not accessible'
      : 'Path must be executable';
  }
  return null;
}

function getKimiWorkspaceServices(): ProviderWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices(KIMI_PROVIDER_ID);
}
