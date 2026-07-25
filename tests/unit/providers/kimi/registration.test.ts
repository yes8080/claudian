import '@/providers';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import {
  kimiWorkspaceRegistration,
} from '@/providers/kimi/app/KimiWorkspaceServices';
import { KimiAuxiliaryLifecycleCoordinator } from '@/providers/kimi/auxiliary/KimiAuxiliaryLifecycleCoordinator';
import { KimiCommandCatalog } from '@/providers/kimi/commands/KimiCommandCatalog';
import { kimiProviderRegistration } from '@/providers/kimi/registration';
import { KimiAuxQueryRunner } from '@/providers/kimi/runtime/KimiAuxQueryRunner';
import { KimiCliResolver } from '@/providers/kimi/runtime/KimiCliResolver';
import type { KimiModelCatalogCoordinator } from '@/providers/kimi/runtime/KimiModelCatalogCoordinator';
import { getKimiProviderSettings } from '@/providers/kimi/settings';

jest.mock('@/providers/kimi/runtime/KimiAuxQueryRunner');

const MockKimiAuxQueryRunner = KimiAuxQueryRunner as jest.MockedClass<typeof KimiAuxQueryRunner>;

jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => 'device:current',
  getLegacyHostnameKey: () => 'legacy-host',
}));

function createPlugin(): any {
  return {
    app: { vault: { adapter: { basePath: '/workspace/kimi-registration' } } },
    manifest: { version: 'test' },
    settings: {
      model: 'sonnet',
      providerConfigs: { kimi: { enabled: true } },
    },
    storage: { getAdapter: jest.fn(() => ({})) },
  };
}

describe('Kimi provider registration', () => {
  beforeEach(() => {
    MockKimiAuxQueryRunner.mockImplementation((_plugin, options) => ({
      query: jest.fn(async (config: any, prompt: string) => {
        await options?.resolveLifecycle?.();
        if (prompt.includes('<editor_')) return '<replacement>edited</replacement>';
        if (config.systemPrompt.includes('title')) return 'Cold Kimi title';
        if (config.systemPrompt.includes('instruction')) {
          return '<instruction>Cold refined instruction</instruction>';
        }
        return '<replacement>edited</replacement>';
      }),
      reset: jest.fn(),
    } as unknown as KimiAuxQueryRunner));
  });

  afterEach(() => {
    ProviderWorkspaceRegistry.setServices('kimi', undefined);
    ProviderWorkspaceRegistry.register('kimi', kimiWorkspaceRegistration);
  });

  it('registers the complete provider surface with the locked environment boundary', () => {
    expect(kimiProviderRegistration).toMatchObject({
      id: 'kimi',
      displayName: 'Kimi',
      blankTabOrder: 13,
    });
    expect(kimiProviderRegistration.environmentKeyPatterns?.map(pattern => ({
      flags: pattern.flags,
      source: pattern.source,
    }))).toEqual([
      { flags: 'i', source: '^KIMI_' },
      { flags: 'i', source: '^MOONSHOT_' },
    ]);
    expect(kimiProviderRegistration.environmentKeyPatterns?.some(pattern => pattern.test('KIMI_HOME'))).toBe(true);
    expect(kimiProviderRegistration.environmentKeyPatterns?.some(pattern => pattern.test('MOONSHOT_API_KEY'))).toBe(true);
    expect(kimiProviderRegistration.environmentKeyPatterns?.some(pattern => pattern.test('OPENAI_API_KEY'))).toBe(false);
    expect(kimiProviderRegistration.subagentAdapter).toBeUndefined();
    expect(kimiProviderRegistration.settingsReconciler.environmentSessionPolicy).toBe('reload');
    expect(kimiProviderRegistration.historyService).toHaveProperty('hydrateConversationHistory');
    expect(kimiProviderRegistration.taskResultInterpreter).toHaveProperty('resolveTerminalStatus');
  });

  it('requires initialized workspace services before constructing a chat runtime', () => {
    ProviderWorkspaceRegistry.setServices('kimi', undefined);

    expect(() => kimiProviderRegistration.createRuntime({
      plugin: createPlugin(),
    })).toThrow('Provider workspace "kimi" is not initialized.');
  });

  it('is disabled by default, mutates enablement through Kimi settings, and routes model ids', () => {
    const settings: Record<string, unknown> = {};
    expect(kimiProviderRegistration.isEnabled(settings)).toBe(false);
    kimiProviderRegistration.setEnabled?.(settings, true);
    expect(getKimiProviderSettings(settings).enabled).toBe(true);
    expect(ProviderRegistry.resolveProviderForModel('kimi/kimi-4.5', settings)).toBe('kimi');
    expect(ProviderRegistry.resolveProviderForModel('kimi', settings)).toBe('claude');
  });

  it('constructs runtime and auxiliary factories against initialized workspace services', () => {
    const plugin = createPlugin();
    const cliResolver = new KimiCliResolver();
    const modelCatalogCoordinator = {
      mergeLiveModels: jest.fn(),
    } as unknown as KimiModelCatalogCoordinator;
    ProviderWorkspaceRegistry.setServices('kimi', {
      cliResolver,
      commandCatalog: new KimiCommandCatalog(),
      modelCatalogCoordinator,
    } as any);

    const runtime = kimiProviderRegistration.createRuntime({ plugin });
    expect(runtime.providerId).toBe('kimi');
    expect(runtime.getCapabilities()).toBe(kimiProviderRegistration.capabilities);
    expect(runtime).toMatchObject({
      cliResolver,
      modelCatalogCoordinator,
    });
    expect(runtime).not.toHaveProperty('commandCatalog');
    expect(kimiProviderRegistration.createTitleGenerationService(plugin)).toBeDefined();
    expect(kimiProviderRegistration.createInstructionRefineService(plugin)).toBeDefined();
    expect(kimiProviderRegistration.createInlineEditService(plugin)).toBeDefined();
    runtime.cleanup();
  });

  it('constructs saved blank-tab and inline services before Kimi workspace initialization', () => {
    const plugin = createPlugin();
    ProviderWorkspaceRegistry.setServices('kimi', undefined);

    expect(() => kimiProviderRegistration.createInstructionRefineService(plugin)).not.toThrow();
    expect(() => kimiProviderRegistration.createInlineEditService(plugin)).not.toThrow();
    expect(ProviderWorkspaceRegistry.getIfInitialized('kimi')).toBeNull();
  });

  it('shares one pending cold initialization across a blank-tab switch and routed Kimi title use', async () => {
    const plugin = createPlugin();
    plugin.settings.titleGenerationModel = 'kimi/kimi-4.5';
    const lifecycle = new KimiAuxiliaryLifecycleCoordinator();
    let finishInitialization!: () => void;
    const initialization = new Promise<void>(resolve => { finishInitialization = resolve; });
    const initialize = jest.fn(async () => {
      await initialization;
      return { auxiliaryLifecycle: lifecycle } as any;
    });
    ProviderWorkspaceRegistry.register('kimi', { initialize });

    const blankTabService = kimiProviderRegistration.createInstructionRefineService(plugin);
    const routedTitleService = ProviderRegistry.createTitleGenerationService(plugin);
    const callback = jest.fn();
    const refine = blankTabService.refineInstruction('cold refine', 'Existing');
    const title = routedTitleService.generateTitle('conversation-1', 'Cold route', callback);
    await new Promise(resolve => setImmediate(resolve));
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(() => blankTabService.resetConversation()).not.toThrow();

    finishInitialization();
    await Promise.all([title, expect(refine).resolves.toEqual({
      refinedInstruction: 'Cold refined instruction',
      success: true,
    })]);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith('conversation-1', {
      success: true,
      title: 'Cold Kimi title',
    });
  });

  it('does not launch a pending cold query with the old environment during a transition', async () => {
    const plugin = createPlugin();
    plugin.settings.providerConfigs.kimi.environmentVariables = 'KIMI_PROFILE=old';
    const lifecycle = new KimiAuxiliaryLifecycleCoordinator();
    let finishInitialization!: () => void;
    const initialization = new Promise<void>(resolve => { finishInitialization = resolve; });
    ProviderWorkspaceRegistry.register('kimi', {
      initialize: jest.fn(async () => {
        await initialization;
        return { auxiliaryLifecycle: lifecycle } as any;
      }),
    });
    const launchedEnvironments: string[] = [];
    MockKimiAuxQueryRunner.mockImplementation((queryPlugin, options) => ({
      query: jest.fn(async () => {
        await options?.resolveLifecycle?.();
        launchedEnvironments.push(
          getKimiProviderSettings(queryPlugin.settings).environmentVariables,
        );
        return '<instruction>Cold refined instruction</instruction>';
      }),
      reset: jest.fn(),
    } as unknown as KimiAuxQueryRunner));
    const service = kimiProviderRegistration.createInstructionRefineService(plugin);
    const query = service.refineInstruction('cold refine', 'Existing');
    await new Promise(resolve => setImmediate(resolve));

    const transitionPromise = ProviderWorkspaceRegistry
      .beginAuxiliaryServicesEnvironmentChange(['kimi']);
    let transitionAcquired = false;
    void transitionPromise.then(() => { transitionAcquired = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(transitionAcquired).toBe(false);

    finishInitialization();
    const transition = await transitionPromise;
    expect(launchedEnvironments).toEqual([]);
    plugin.settings.providerConfigs.kimi.environmentVariables = 'KIMI_PROFILE=new';
    await transition.release();

    await expect(query).resolves.toEqual({
      refinedInstruction: 'Cold refined instruction',
      success: true,
    });
    expect(launchedEnvironments).toEqual(['KIMI_PROFILE=new']);
  });

  it('initializes once on first use of a cold inline factory and returns the edit', async () => {
    const plugin = createPlugin();
    const lifecycle = new KimiAuxiliaryLifecycleCoordinator();
    const initialize = jest.fn(async () => ({ auxiliaryLifecycle: lifecycle }) as any);
    ProviderWorkspaceRegistry.register('kimi', { initialize });

    const service = kimiProviderRegistration.createInlineEditService(plugin);
    expect(initialize).not.toHaveBeenCalled();
    await expect(service.editText({
      instruction: 'Improve this',
      mode: 'selection',
      notePath: 'note.md',
      selectedText: 'draft',
    })).resolves.toEqual({ editedText: 'edited', success: true });
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('surfaces cold workspace initialization failures through the title service', async () => {
    const plugin = createPlugin();
    plugin.settings.titleGenerationModel = 'kimi/kimi-4.5';
    const initialize = jest.fn(async () => {
      throw new Error('Kimi workspace initialization failed');
    });
    ProviderWorkspaceRegistry.register('kimi', { initialize });

    const service = ProviderRegistry.createTitleGenerationService(plugin);
    const callback = jest.fn();
    await service.generateTitle('conversation-1', 'Cold route', callback);

    expect(callback).toHaveBeenCalledWith('conversation-1', {
      error: 'Kimi workspace initialization failed',
      success: false,
    });
  });

  it('host-scopes CLI paths and model catalogs during storage normalization', () => {
    expect(kimiProviderRegistration.settingsStorage.hostScopedFields).toEqual([
      'cliPathsByHost',
      'catalogsByHost',
    ]);
    const target: Record<string, unknown> = {};
    const stored = {
      providerConfigs: {
        kimi: {
          catalogsByHost: {
            'device:current': {
              defaultModelId: 'kimi-4.5',
              fingerprint: 'fingerprint',
              models: [{ displayName: 'Kimi 4.5', rawId: 'kimi-4.5' }],
              refreshedAt: 1,
            },
            'device:other': {
              defaultModelId: null,
              fingerprint: 'other',
              models: [],
              refreshedAt: 2,
            },
          },
          cliPathsByHost: {
            'device:current': '/opt/kimi/bin/kimi',
            'device:other': '/other/kimi',
          },
          enabled: true,
          runtimeAuthToken: 'must-not-persist',
          sessionMetadata: { secret: 'must-not-persist' },
        },
      },
    };

    kimiProviderRegistration.settingsStorage.normalizeStored(target, stored);

    expect(getKimiProviderSettings(target).cliPathsByHost).toEqual({
      'device:current': '/opt/kimi/bin/kimi',
      'device:other': '/other/kimi',
    });
    expect(getKimiProviderSettings(target).catalogsByHost).toEqual(
      expect.objectContaining({
        'device:current': expect.objectContaining({ fingerprint: 'fingerprint' }),
        'device:other': expect.objectContaining({ fingerprint: 'other' }),
      }),
    );
    expect((target.providerConfigs as Record<string, Record<string, unknown>>).kimi)
      .not.toHaveProperty('runtimeAuthToken');
    expect((target.providerConfigs as Record<string, Record<string, unknown>>).kimi)
      .not.toHaveProperty('sessionMetadata');
  });
});
