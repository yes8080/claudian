import {
  decodeKimiModelId,
  encodeKimiModelId,
  findKimiModel,
  isKimiModelSelectionId,
  KIMI_CONTEXT_WINDOW_FALLBACK,
  mergeKimiDiscoveredModels,
  normalizeKimiDiscoveredModels,
  resolveKimiContextWindow,
  resolveKimiDefaultReasoningEffort,
} from '@/providers/kimi/models';

describe('Kimi model identity', () => {
  it('uses only provider-qualified explicit model ids', () => {
    expect(encodeKimiModelId('kimi-coding')).toBe('kimi/kimi-coding');
    expect(encodeKimiModelId('kimi/kimi-coding')).toBe('kimi/kimi-coding');
    expect(encodeKimiModelId('')).toBe('');
    expect(encodeKimiModelId('kimi/')).toBe('');
    expect(decodeKimiModelId('kimi/kimi-coding')).toBe('kimi-coding');
    expect(decodeKimiModelId('kimi')).toBeNull();
    expect(decodeKimiModelId(' kimi/kimi-coding ')).toBe('kimi-coding');
    expect(isKimiModelSelectionId('kimi')).toBe(false);
    expect(isKimiModelSelectionId('kimi/kimi-coding')).toBe(true);
    expect(isKimiModelSelectionId('kimi/')).toBe(false);
    expect(isKimiModelSelectionId('kimi-coding')).toBe(false);
  });
});

describe('Kimi model metadata', () => {
  it('normalizes only non-secret persisted metadata', () => {
    expect(normalizeKimiDiscoveredModels([{
      agentType: ' coding ',
      apiKey: 'must-not-persist',
      contextWindow: 262_144,
      defaultReasoningEffort: ' high ',
      description: ' Fast custom model ',
      displayName: ' Kimi Coding ',
      rawId: ' kimi-coding ',
      reasoningMetadataResolved: true,
      reasoningEfforts: [
        { description: 'Quick', label: ' Low ', value: ' low ' },
        { value: 'high' },
        { value: 'high' },
      ],
      supportsReasoning: true,
    }])).toEqual([{
      agentType: 'coding',
      contextWindow: 262_144,
      defaultReasoningEffort: 'high',
      description: 'Fast custom model',
      displayName: 'Kimi Coding',
      rawId: 'kimi-coding',
      reasoningMetadataResolved: true,
      reasoningEfforts: [
        { description: 'Quick', label: 'Low', value: 'low' },
        { label: 'High', value: 'high' },
      ],
      supportsReasoning: true,
    }]);
  });

  it('normalizes Kimi wire reasoning metadata and orders returned fallback modes', () => {
    expect(normalizeKimiDiscoveredModels([{
      modelId: 'kimi-wire',
      name: 'Kimi Wire',
      reasoningEffort: 'xhigh',
      supportsReasoningEffort: true,
      'kimi/sessionConfig': {
        options: [
          { category: 'mode', id: 'xhigh', label: 'Extra high', selected: true },
          { category: 'mode', id: 'minimal', label: 'Minimal', selected: false },
          { category: 'mode', id: 'high', label: 'High', selected: false },
        ],
      },
    }])).toEqual([expect.objectContaining({
      defaultReasoningEffort: 'xhigh',
      rawId: 'kimi-wire',
      reasoningEfforts: [
        { label: 'Minimal', value: 'minimal' },
        { label: 'High', value: 'high' },
        { label: 'Extra high', value: 'xhigh' },
      ],
      supportsReasoning: true,
    })]);
  });

  it('merges live metadata by raw id while retaining prior catalog-only fields', () => {
    const merged = mergeKimiDiscoveredModels(
      [{
        displayName: 'Kimi',
        rawId: 'kimi-coding',
        reasoningEfforts: [],
        supportsReasoning: false,
      }, {
        displayName: 'GLM',
        rawId: 'glm-coding',
        reasoningEfforts: [],
        supportsReasoning: false,
      }],
      [{
        agentType: 'coding',
        contextWindow: 200_000,
        displayName: 'Kimi Coding',
        rawId: 'kimi-coding',
        reasoningEfforts: [
          { label: 'Low', value: 'low' },
          { label: 'High', value: 'high' },
        ],
        supportsReasoning: true,
      }],
    );

    expect(merged).toEqual([
      expect.objectContaining({
        agentType: 'coding',
        contextWindow: 200_000,
        displayName: 'Kimi Coding',
        rawId: 'kimi-coding',
        supportsReasoning: true,
      }),
      expect.objectContaining({ rawId: 'glm-coding' }),
    ]);
    expect(findKimiModel(merged, 'kimi/kimi-coding')?.contextWindow).toBe(200_000);
  });

  it('treats resolved ACP reasoning metadata as authoritative', () => {
    const [merged] = mergeKimiDiscoveredModels([{
      defaultReasoningEffort: 'high',
      displayName: 'Reasoner',
      rawId: 'reasoner',
      reasoningEfforts: [{ label: 'High', value: 'high' }],
      reasoningMetadataResolved: true,
      supportsReasoning: true,
    }], [{
      displayName: 'Reasoner',
      rawId: 'reasoner',
      reasoningEfforts: [],
      reasoningMetadataResolved: true,
      supportsReasoning: false,
    }]);

    expect(merged).toEqual({
      displayName: 'Reasoner',
      rawId: 'reasoner',
      reasoningEfforts: [],
      reasoningMetadataResolved: true,
      supportsReasoning: false,
    });
  });

  it('resolves preferred, declared, high, and first reasoning defaults in order', () => {
    const model = normalizeKimiDiscoveredModels([{
      defaultReasoningEffort: 'medium',
      displayName: 'Reasoner',
      rawId: 'reasoner',
      reasoningEfforts: ['low', 'medium', 'high'],
      supportsReasoning: true,
    }])[0];

    expect(resolveKimiDefaultReasoningEffort(model, 'low')).toBe('low');
    expect(resolveKimiDefaultReasoningEffort(model)).toBe('medium');
    expect(resolveKimiDefaultReasoningEffort({
      ...model,
      defaultReasoningEffort: undefined,
    })).toBe('high');
    expect(resolveKimiDefaultReasoningEffort({
      ...model,
      defaultReasoningEffort: undefined,
      reasoningEfforts: [{ label: 'Low', value: 'low' }],
    })).toBe('low');
  });

  it('resolves context from metadata, custom limits, then the shared fallback', () => {
    const models = normalizeKimiDiscoveredModels([{
      contextWindow: 300_000,
      displayName: 'Known',
      rawId: 'known',
    }]);

    expect(resolveKimiContextWindow('kimi/known', models, {
      'kimi/known': 150_000,
    })).toBe(300_000);
    expect(resolveKimiContextWindow('kimi/custom', models, {
      'kimi/custom': 123_000,
    })).toBe(123_000);
    expect(resolveKimiContextWindow('kimi/other', models)).toBe(
      KIMI_CONTEXT_WINDOW_FALLBACK,
    );
  });
});
