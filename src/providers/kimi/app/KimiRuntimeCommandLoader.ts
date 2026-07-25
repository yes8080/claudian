import {
  normalizeProviderCommandDiscoveryItems,
  type ProviderCommandDiscoveryResult,
} from '../../../core/providers/commands/ProviderCommandDiscoveryResult';
import type {
  ProviderRuntimeCommandLoader,
  ProviderRuntimeCommandLoaderContext,
} from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type { SlashCommand } from '../../../core/types';
import { KimiChatRuntime } from '../runtime/KimiChatRuntime';
import { getKimiProviderSettings } from '../settings';

interface KimiRuntimeCommandSource {
  discoverSupportedCommands(timeoutMs?: number, signal?: AbortSignal): Promise<SlashCommand[]>;
  getReadySupportedCommandsSnapshot(): SlashCommand[] | null;
  providerId: 'kimi';
}

type KimiRuntimeFactory = (
  plugin: ProviderRuntimeCommandLoaderContext['plugin'],
) => ChatRuntime & KimiRuntimeCommandSource;

function resolveCommandSource(
  runtime: ProviderRuntimeCommandLoaderContext['runtime'],
): (ChatRuntime & KimiRuntimeCommandSource) | null {
  if (
    runtime?.providerId !== 'kimi'
    || typeof (runtime as Partial<KimiRuntimeCommandSource>)
      .discoverSupportedCommands !== 'function'
    || typeof (runtime as Partial<KimiRuntimeCommandSource>)
      .getReadySupportedCommandsSnapshot !== 'function'
  ) {
    return null;
  }
  return runtime as ChatRuntime & KimiRuntimeCommandSource;
}

export class KimiRuntimeCommandLoader implements ProviderRuntimeCommandLoader {
  constructor(
    private readonly createRuntime: KimiRuntimeFactory = plugin => new KimiChatRuntime(plugin),
  ) {}

  getCacheFingerprint(settings: Record<string, unknown>): string {
    const providerSettings = getKimiProviderSettings(settings);
    const hasConfiguredCli = providerSettings.cliPath.length > 0
      || Object.values(providerSettings.cliPathsByHost).some(path => path.trim().length > 0);
    return [
      'kimi:commands:v2',
      providerSettings.enabled ? 'enabled' : 'disabled',
      hasConfiguredCli ? 'configured-cli' : 'auto-cli',
    ].join(':');
  }

  isAvailable(settings: Record<string, unknown>): boolean {
    return getKimiProviderSettings(settings).enabled;
  }

  async loadCommands(
    context: ProviderRuntimeCommandLoaderContext,
  ): Promise<ProviderCommandDiscoveryResult<SlashCommand>> {
    context.signal?.throwIfAborted();
    const activeSource = resolveCommandSource(context.runtime);
    try {
      const commands = activeSource?.getReadySupportedCommandsSnapshot();
      if (commands) {
        return normalizeProviderCommandDiscoveryItems(commands);
      }
    } catch {
      return {
        message: 'Could not read Kimi skills and commands from the active conversation.',
        retryable: true,
        status: 'error',
      };
    }

    const runtime = activeSource ?? this.createRuntime(context.plugin);
    let cleanedUp = false;
    const cleanup = (): void => {
      if (activeSource || cleanedUp) {
        return;
      }
      cleanedUp = true;
      runtime.cleanup();
    };
    const onAbort = (): void => cleanup();
    context.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return normalizeProviderCommandDiscoveryItems(
        await runtime.discoverSupportedCommands(5_000, context.signal),
      );
    } catch {
      return {
        message: 'Could not load Kimi skills and commands.',
        retryable: true,
        status: 'error',
      };
    } finally {
      context.signal?.removeEventListener('abort', onAbort);
      cleanup();
    }
  }
}
