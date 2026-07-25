const mockGetHostnameKey = jest.fn(() => 'device:current');
const mockGetLegacyHostnameKey = jest.fn(() => 'legacy-host');

jest.mock('../../../../src/utils/env', () => ({
  ...jest.requireActual('../../../../src/utils/env'),
  getHostnameKey: () => mockGetHostnameKey(),
  getLegacyHostnameKey: () => mockGetLegacyHostnameKey(),
}));

import {
  clearCurrentKimiCatalog,
  DEFAULT_KIMI_PROVIDER_SETTINGS,
  getCurrentKimiCatalog,
  getKimiProviderSettings,
  normalizeKimiCatalogSnapshot,
  updateCurrentKimiCatalog,
  updateKimiProviderSettings,
  updateKimiVisibleModels,
} from '@/providers/kimi/settings';
import {
  buildKimiProviderState,
  buildPersistedKimiProviderState,
  parseKimiProviderState,
} from '@/providers/kimi/types';

describe('Kimi settings', () => {
  const currentCatalog = {
    defaultModelId: 'kimi-coding',
    fingerprint: 'fingerprint-current',
    models: [{
      displayName: 'Kimi Coding',
      rawId: 'kimi-coding',
      reasoningEfforts: [{ label: 'High', value: 'high' }],
      supportsReasoning: true,
    }],
    refreshedAt: 100,
  };
  const otherCatalog = {
    defaultModelId: 'glm-coding',
    fingerprint: 'fingerprint-other',
    models: [{
      displayName: 'GLM Coding',
      rawId: 'glm-coding',
      reasoningEfforts: [],
      supportsReasoning: false,
    }],
    refreshedAt: 50,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetHostnameKey.mockReturnValue('device:current');
    mockGetLegacyHostnameKey.mockReturnValue('legacy-host');
  });

  it('defaults to disabled with empty environment and host state', () => {
    expect(DEFAULT_KIMI_PROVIDER_SETTINGS).toEqual({
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
  });

  it('migrates legacy CLI and catalog keys to the opaque current host key', () => {
    const settings = getKimiProviderSettings({
      providerConfigs: {
        kimi: {
          catalogsByHost: {
            'legacy-host': currentCatalog,
            'other-host': otherCatalog,
          },
          cliPathsByHost: {
            'legacy-host': '/legacy/kimi',
            'other-host': '/other/kimi',
          },
        },
      },
    });

    expect(settings.cliPathsByHost).toEqual({
      'device:current': '/legacy/kimi',
      'other-host': '/other/kimi',
    });
    expect(settings.catalogsByHost).toEqual({
      'device:current': currentCatalog,
      'other-host': otherCatalog,
    });
    expect(settings.currentCatalog).toEqual(currentCatalog);
  });

  it('round-trips only the current host catalog without changing other hosts', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        kimi: {
          catalogsByHost: {
            'device:current': currentCatalog,
            'other-host': otherCatalog,
          },
        },
      },
    };
    const replacement = {
      ...currentCatalog,
      fingerprint: 'replacement',
      refreshedAt: 200,
    };

    expect(updateCurrentKimiCatalog(settings, replacement)).toEqual(replacement);
    expect(getCurrentKimiCatalog(settings)).toEqual(replacement);
    expect(getKimiProviderSettings(settings).catalogsByHost['other-host']).toEqual(otherCatalog);
    expect(clearCurrentKimiCatalog(settings)).toBe(true);
    expect(getCurrentKimiCatalog(settings)).toBeNull();
    expect(getKimiProviderSettings(settings).catalogsByHost['other-host']).toEqual(otherCatalog);
    expect(clearCurrentKimiCatalog(settings)).toBe(false);
  });

  it('whitelists catalog metadata and never persists opaque or secret fields', () => {
    const snapshot = normalizeKimiCatalogSnapshot({
      apiKey: 'catalog-secret',
      defaultModelId: 'kimi-coding',
      fingerprint: 'names-only-fingerprint',
      models: [{
        accessToken: 'model-secret',
        displayName: 'Kimi Coding',
        rawId: 'kimi-coding',
      }],
      refreshedAt: 123,
    });

    expect(snapshot).toEqual({
      defaultModelId: 'kimi-coding',
      fingerprint: 'names-only-fingerprint',
      models: [{
        displayName: 'Kimi Coding',
        rawId: 'kimi-coding',
        reasoningEfforts: [],
        supportsReasoning: false,
      }],
      refreshedAt: 123,
    });
    expect(JSON.stringify(snapshot)).not.toContain('secret');
  });

  it('normalizes catalog-scoped preferences while retaining a selected stale model', () => {
    const settings = getKimiProviderSettings({
      model: 'kimi/legacy-model',
      providerConfigs: {
        kimi: {
          catalogsByHost: { 'device:current': currentCatalog },
          modelAliases: {
            ' kimi-coding ': ' Kimi ',
            'legacy-model': ' Legacy ',
            unknown: 'Drop me',
          },
          preferredReasoningByModel: {
            'kimi-coding': 'medium',
            'legacy-model': 'low',
            unknown: 'xhigh',
          },
          visibleModels: [
            'kimi-coding',
            'kimi-coding',
            'legacy-model',
            'unknown',
          ],
        },
      },
    });

    expect(settings.visibleModels).toEqual(['kimi-coding', 'legacy-model']);
    expect(settings.modelAliases).toEqual({
      'kimi-coding': 'Kimi',
      'legacy-model': 'Legacy',
    });
    expect(settings.preferredReasoningByModel).toEqual({
      'kimi-coding': 'medium',
      'legacy-model': 'low',
    });
  });

  it('persists normalized settings without clobbering unrelated providers', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        codex: { enabled: true },
        kimi: { catalogsByHost: { 'device:current': currentCatalog } },
      },
    };

    const next = updateKimiProviderSettings(settings, {
      cliPath: ' /opt/bin/kimi ',
      enabled: true,
      modelAliases: { 'kimi-coding': ' Kimi ' },
      visibleModels: ['kimi-coding'],
    });

    expect(next).toMatchObject({
      cliPath: '',
      cliPathsByHost: { 'device:current': '/opt/bin/kimi' },
      enabled: true,
      modelAliases: { 'kimi-coding': 'Kimi' },
      visibleModels: ['kimi-coding'],
    });
    expect((settings.providerConfigs as Record<string, unknown>).codex).toEqual({ enabled: true });
  });

  it('prunes disabled reasoning state from every host catalog', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        kimi: {
          catalogsByHost: {
            'device:current': {
              ...currentCatalog,
              models: currentCatalog.models.map(model => ({
                ...model,
                reasoningMetadataResolved: true,
              })),
            },
            'device:other': {
              ...otherCatalog,
              models: otherCatalog.models.map(model => ({
                ...model,
                reasoningEfforts: [{ label: 'High', value: 'high' }],
                reasoningMetadataResolved: true,
                supportsReasoning: true,
              })),
            },
          },
          preferredReasoningByModel: { 'kimi-coding': 'high' },
          visibleModels: ['kimi-coding'],
        },
      },
    };

    updateKimiVisibleModels(settings, []);

    const kimi = getKimiProviderSettings(settings);
    expect(kimi.preferredReasoningByModel).toEqual({});
    for (const catalogSnapshot of Object.values(kimi.catalogsByHost)) {
      for (const model of catalogSnapshot.models) {
        expect(model.reasoningEfforts).toEqual([]);
        expect(model.supportsReasoning).toBe(false);
        expect(model).not.toHaveProperty('reasoningMetadataResolved');
      }
    }
  });
});

describe('Kimi provider state', () => {
  it('parses and builds only an absolute native session directory hint', () => {
    expect(parseKimiProviderState({
      sessionDirectory: ' /tmp/.kimi/sessions/vault/session-id ',
      token: 'do-not-preserve',
    })).toEqual({
      sessionDirectory: '/tmp/.kimi/sessions/vault/session-id',
    });
    expect(parseKimiProviderState({ sessionDirectory: '../outside' })).toEqual({});
    expect(buildKimiProviderState('/tmp/.kimi/sessions/vault/session-id')).toEqual({
      sessionDirectory: '/tmp/.kimi/sessions/vault/session-id',
    });
    expect(buildKimiProviderState('../outside')).toBeUndefined();
  });

  it('drops unsupported fork state and persists only absolute session directories', () => {
    expect(parseKimiProviderState({
      forkSource: { resumeAt: ' assistant-1 ', sessionId: ' source-session ' },
      forkSourceSessionDirectory: ' /tmp/.kimi/sessions/vault/source-session ',
      token: 'do-not-preserve',
    })).toEqual({});
    expect(buildPersistedKimiProviderState({
      sessionDirectory: '/tmp/.kimi/sessions/vault/source-session',
    })).toEqual({
      sessionDirectory: '/tmp/.kimi/sessions/vault/source-session',
    });
  });
});
