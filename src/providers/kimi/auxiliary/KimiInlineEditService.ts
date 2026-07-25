import { QueryBackedInlineEditService } from '../../../core/auxiliary/QueryBackedInlineEditService';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { KimiAuxQueryRunner } from '../runtime/KimiAuxQueryRunner';
import type { KimiAuxiliaryLifecycleOptions } from './KimiAuxiliaryLifecycleCoordinator';

export class KimiInlineEditService extends QueryBackedInlineEditService {
  constructor(plugin: ProviderHost, lifecycleOptions: KimiAuxiliaryLifecycleOptions = {}) {
    super(new KimiAuxQueryRunner(plugin, lifecycleOptions));
  }
}
