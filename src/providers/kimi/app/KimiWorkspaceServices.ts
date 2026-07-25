import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderTabWarmupPolicy,
  ProviderTransitionOwnerContext,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { KimiAuxiliaryLifecycleCoordinator } from '../auxiliary/KimiAuxiliaryLifecycleCoordinator';
import { KimiCommandCatalog } from '../commands/KimiCommandCatalog';
import { KimiCliResolver } from '../runtime/KimiCliResolver';
import { KimiModelCatalogCoordinator } from '../runtime/KimiModelCatalogCoordinator';
import { KimiModelCatalogService } from '../runtime/KimiModelCatalogService';
import { kimiSettingsTabRenderer } from '../ui/KimiSettingsTab';
import { KimiRuntimeCommandLoader } from './KimiRuntimeCommandLoader';

export interface KimiWorkspaceServices extends ProviderWorkspaceServices {
  auxiliaryLifecycle: KimiAuxiliaryLifecycleCoordinator;
  cliResolver: KimiCliResolver;
  commandCatalog: ProviderCommandCatalog;
  modelCatalogCoordinator: KimiModelCatalogCoordinator;
  refreshModelCatalog(
    context?: ProviderTransitionOwnerContext,
  ): ReturnType<KimiModelCatalogCoordinator['refreshModelCatalog']>;
  prepareSettings(): Promise<void>;
  dispose(): Promise<void>;
}

const kimiTabWarmupPolicy: ProviderTabWarmupPolicy = {
  resolveMode() {
    return 'none';
  },
};

export async function createKimiWorkspaceServices(
  plugin: ProviderHost,
): Promise<KimiWorkspaceServices> {
  const modelCatalogService = new KimiModelCatalogService(plugin);
  const auxiliaryLifecycle = new KimiAuxiliaryLifecycleCoordinator();
  const modelCatalogCoordinator = new KimiModelCatalogCoordinator(
    plugin,
    modelCatalogService,
  );

  return {
    auxiliaryLifecycle,
    cliResolver: new KimiCliResolver(),
    commandCatalog: new KimiCommandCatalog(),
    modelCatalogCoordinator,
    runtimeCommandLoader: new KimiRuntimeCommandLoader(),
    settingsTabRenderer: kimiSettingsTabRenderer,
    tabWarmupPolicy: kimiTabWarmupPolicy,
    refreshModelCatalog: context => modelCatalogCoordinator.refreshModelCatalog(context),
    beginAuxiliaryServicesEnvironmentChange: () => (
      auxiliaryLifecycle.beginEnvironmentChange()
    ),
    async prepareSettings() {
      await modelCatalogCoordinator.ensureFresh('settings');
    },
    async dispose() {
      await auxiliaryLifecycle.dispose();
      modelCatalogCoordinator.dispose();
    },
  };
}

export const kimiWorkspaceRegistration: ProviderWorkspaceRegistration<KimiWorkspaceServices> = {
  initialize: async ({ plugin }) => createKimiWorkspaceServices(plugin),
};

export function getKimiWorkspaceServices(): KimiWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('kimi') as KimiWorkspaceServices;
}

export async function resolveKimiAuxiliaryLifecycle(
  plugin: ProviderHost,
): Promise<KimiAuxiliaryLifecycleCoordinator> {
  await ProviderWorkspaceRegistry.ensureInitialized(plugin, 'kimi', 'auxiliary-query');
  return getKimiWorkspaceServices().auxiliaryLifecycle;
}
