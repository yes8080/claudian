import { QueryBackedInstructionRefineService } from '../../../core/auxiliary/QueryBackedInstructionRefineService';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { KimiAuxQueryRunner } from '../runtime/KimiAuxQueryRunner';
import type { KimiAuxiliaryLifecycleOptions } from './KimiAuxiliaryLifecycleCoordinator';

export class KimiInstructionRefineService extends QueryBackedInstructionRefineService {
  constructor(plugin: ProviderHost, lifecycleOptions: KimiAuxiliaryLifecycleOptions = {}) {
    super(new KimiAuxQueryRunner(plugin, lifecycleOptions));
  }
}
