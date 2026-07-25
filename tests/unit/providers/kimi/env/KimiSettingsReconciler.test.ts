import type { Conversation } from '@/core/types';
import {
  computeKimiEnvironmentHash,
  kimiSettingsReconciler,
} from '@/providers/kimi/env/KimiSettingsReconciler';
import { getKimiProviderSettings } from '@/providers/kimi/settings';

jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => 'current-host',
  getLegacyHostnameKey: () => 'legacy-host',
}));

describe('KimiSettingsReconciler', () => {
  const catalog = (rawId: string) => ({
    defaultModelId: rawId,
    fingerprint: `${rawId}-fingerprint`,
    models: [{
      displayName: rawId,
      rawId,
      reasoningEfforts: [],
      supportsReasoning: false,
    }],
    refreshedAt: 1,
  });

  it('computes a stable SHA-256 digest without exposing raw secret values', () => {
    const first = computeKimiEnvironmentHash({
      providerConfigs: {
        kimi: {
          cliPathsByHost: { 'current-host': '/bin/kimi' },
          environmentVariables: 'MOONSHOT_API_KEY=super-secret\nKIMI_HOME=/tmp/kimi',
        },
      },
      sharedEnvironmentVariables: 'HTTPS_PROXY=https://proxy.example.com',
    });
    const reordered = computeKimiEnvironmentHash({
      providerConfigs: {
        kimi: {
          cliPathsByHost: { 'current-host': '/bin/kimi' },
          environmentVariables: 'KIMI_HOME=/tmp/kimi\nMOONSHOT_API_KEY=super-secret',
        },
      },
      sharedEnvironmentVariables: 'HTTPS_PROXY=https://proxy.example.com',
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toBe(reordered);
    expect(first).not.toContain('super-secret');
    expect(first).not.toContain('/tmp/kimi');
  });

  it('declares reload and preserves all conversation bindings', () => {
    const kimiConversation = {
      messages: [],
      providerId: 'kimi',
      providerState: { sessionDirectory: '/tmp/kimi/session-1' },
      sessionId: 'session-1',
    } as unknown as Conversation;

    expect(kimiSettingsReconciler.environmentSessionPolicy).toBe('reload');
    expect(kimiSettingsReconciler.invalidateConversationSessions([kimiConversation]))
      .toEqual([]);
    expect(kimiConversation).toEqual(expect.objectContaining({
      providerState: { sessionDirectory: '/tmp/kimi/session-1' },
      sessionId: 'session-1',
    }));
  });

  it('leaves pristine disabled defaults untouched during startup reconciliation', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        kimi: {
          catalogsByHost: {},
          enabled: false,
          environmentHash: '',
          environmentVariables: '',
        },
      },
    };

    expect(kimiSettingsReconciler.reconcileModelWithEnvironment(settings, []))
      .toEqual({ changed: false, invalidatedConversations: [] });
    expect(getKimiProviderSettings(settings).environmentHash).toBe('');
  });

  it('clears only the current host catalog when construction inputs become stale', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        codex: { enabled: true, marker: 'untouched' },
        kimi: {
          catalogsByHost: {
            'current-host': catalog('current-model'),
            'other-host': catalog('other-model'),
          },
          enabled: true,
          environmentHash: 'stale-hash',
          environmentVariables: 'MOONSHOT_API_KEY=new-secret',
        },
      },
    };
    const kimiConversation = {
      messages: [],
      providerId: 'kimi',
      providerState: { sessionDirectory: '/tmp/kimi/session-1' },
      sessionId: 'session-1',
    } as unknown as Conversation;
    const otherConversation = {
      messages: [],
      providerId: 'claude',
      providerState: { providerSessionId: 'claude-session' },
      sessionId: 'claude-session',
    } as unknown as Conversation;

    const result = kimiSettingsReconciler.reconcileModelWithEnvironment(
      settings,
      [kimiConversation, otherConversation],
    );

    expect(result).toEqual({ changed: true, invalidatedConversations: [] });
    expect(getKimiProviderSettings(settings).catalogsByHost).toEqual({
      'other-host': catalog('other-model'),
    });
    expect(getKimiProviderSettings(settings).environmentHash)
      .toBe(computeKimiEnvironmentHash(settings));
    expect(kimiConversation.sessionId).toBe('session-1');
    expect(otherConversation.sessionId).toBe('claude-session');
    expect((settings.providerConfigs as Record<string, unknown>).codex).toEqual({
      enabled: true,
      marker: 'untouched',
    });
  });

  it('retains the current catalog when the construction digest is current', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        kimi: {
          catalogsByHost: { 'current-host': catalog('current-model') },
          enabled: true,
          environmentVariables: 'KIMI_HOME=/tmp/kimi',
        },
      },
    };
    (settings.providerConfigs as Record<string, any>).kimi.environmentHash =
      computeKimiEnvironmentHash(settings);

    expect(kimiSettingsReconciler.reconcileModelWithEnvironment(settings, []))
      .toEqual({ changed: false, invalidatedConversations: [] });
    expect(getKimiProviderSettings(settings).currentCatalog).toEqual(catalog('current-model'));
  });

  it('normalizes qualified Kimi selections in every shared model slot', () => {
    const settings: Record<string, unknown> = {
      model: '  kimi/kimi-4.5  ',
      titleGenerationModel: ' kimi/kimi-3 ',
      savedProviderModel: {
        claude: 'claude-sonnet-4-5',
        kimi: ' kimi/kimi-code-fast-1 ',
      },
    };

    expect(kimiSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(true);
    expect(settings).toEqual({
      model: 'kimi/kimi-4.5',
      titleGenerationModel: 'kimi/kimi-3',
      savedProviderModel: {
        claude: 'claude-sonnet-4-5',
        kimi: 'kimi/kimi-code-fast-1',
      },
    });
  });

  it('leaves normalized, unqualified, and unrelated provider selections unchanged', () => {
    const settings: Record<string, unknown> = {
      model: 'kimi/kimi-4.5',
      titleGenerationModel: 'claude-sonnet-4-5',
      savedProviderModel: {
        codex: 'gpt-5.4',
        kimi: 'kimi-3',
      },
    };

    expect(kimiSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(false);
    expect(settings).toEqual({
      model: 'kimi/kimi-4.5',
      titleGenerationModel: 'claude-sonnet-4-5',
      savedProviderModel: {
        codex: 'gpt-5.4',
        kimi: 'kimi-3',
      },
    });
  });
});
