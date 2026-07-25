import {
  buildSystemPrompt,
  computeSystemPromptKey,
  type SystemPromptSettings,
} from '../../../core/prompt/mainAgent';

const KIMI_PROMPT_OPTIONS = Object.freeze({
  toolGuidanceProfile: 'provider-native' as const,
});

export type KimiSystemPromptSettings = SystemPromptSettings;

export function buildKimiSystemPrompt(settings: KimiSystemPromptSettings): string {
  return buildSystemPrompt(settings, KIMI_PROMPT_OPTIONS);
}

export function computeKimiSystemPromptKey(settings: KimiSystemPromptSettings): string {
  return computeSystemPromptKey(settings, KIMI_PROMPT_OPTIONS);
}
