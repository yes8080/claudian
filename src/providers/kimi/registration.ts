import type { ProviderModule } from '../../core/providers/types';
import {
  getKimiWorkspaceServices,
  kimiWorkspaceRegistration,
  resolveKimiAuxiliaryLifecycle,
} from './app/KimiWorkspaceServices';
import { KimiInlineEditService } from './auxiliary/KimiInlineEditService';
import { KimiInstructionRefineService } from './auxiliary/KimiInstructionRefineService';
import { KimiTaskResultInterpreter } from './auxiliary/KimiTaskResultInterpreter';
import { KimiTitleGenerationService } from './auxiliary/KimiTitleGenerationService';
import { KIMI_PROVIDER_CAPABILITIES } from './capabilities';
import { kimiSettingsReconciler } from './env/KimiSettingsReconciler';
import { KimiConversationHistoryService } from './history/KimiConversationHistoryService';
import { KimiChatRuntime } from './runtime/KimiChatRuntime';
import { getKimiProviderSettings, updateKimiProviderSettings } from './settings';
import { kimiChatUIConfig } from './ui/KimiChatUIConfig';

export const kimiProviderRegistration: ProviderModule = {
  id: 'kimi',
  blankTabOrder: 13,
  capabilities: KIMI_PROVIDER_CAPABILITIES,
  chatUIConfig: kimiChatUIConfig,
  createInlineEditService: plugin => new KimiInlineEditService(
    plugin,
    { resolveLifecycle: () => resolveKimiAuxiliaryLifecycle(plugin) },
  ),
  createInstructionRefineService: plugin => new KimiInstructionRefineService(
    plugin,
    { resolveLifecycle: () => resolveKimiAuxiliaryLifecycle(plugin) },
  ),
  createRuntime: ({ plugin }) => {
    const workspace = getKimiWorkspaceServices();
    return new KimiChatRuntime(plugin, {
      capabilities: KIMI_PROVIDER_CAPABILITIES,
      cliResolver: workspace.cliResolver,
      lifecycle: workspace.auxiliaryLifecycle,
      modelCatalogCoordinator: workspace.modelCatalogCoordinator,
    });
  },
  createTitleGenerationService: plugin => new KimiTitleGenerationService(
    plugin,
    { resolveLifecycle: () => resolveKimiAuxiliaryLifecycle(plugin) },
  ),
  displayName: 'Kimi',
  environmentKeyPatterns: [/^KIMI_/i, /^MOONSHOT_/i],
  historyService: new KimiConversationHistoryService(),
  isEnabled: settings => getKimiProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updateKimiProviderSettings(settings, { enabled }),
  settingsReconciler: kimiSettingsReconciler,
  settingsStorage: {
    hostScopedFields: ['cliPathsByHost', 'catalogsByHost'],
    normalizeStored(target, stored) {
      updateKimiProviderSettings(target, getKimiProviderSettings(stored));
      return false;
    },
  },
  taskResultInterpreter: new KimiTaskResultInterpreter(),
  workspace: kimiWorkspaceRegistration,
};
