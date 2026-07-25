import { QueryBackedTitleGenerationService } from '../../../core/auxiliary/QueryBackedTitleGenerationService';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { isKimiModelSelectionId } from '../models';
import { KimiAuxQueryRunner } from '../runtime/KimiAuxQueryRunner';
import type { KimiAuxiliaryLifecycleOptions } from './KimiAuxiliaryLifecycleCoordinator';

export class KimiTitleGenerationService extends QueryBackedTitleGenerationService {
  constructor(plugin: ProviderHost, lifecycleOptions: KimiAuxiliaryLifecycleOptions = {}) {
    super({
      createRunner: () => new KimiAuxQueryRunner(plugin, lifecycleOptions),
      resolveModel: () => {
        const settings = plugin.settings as unknown as Record<string, unknown>;
        const model = typeof settings.titleGenerationModel === 'string'
          ? settings.titleGenerationModel.trim()
          : '';
        return model && isKimiModelSelectionId(model) ? model : undefined;
      },
    });
  }
}
