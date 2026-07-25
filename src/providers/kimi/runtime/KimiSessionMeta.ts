import { decodeKimiModelId } from '../models';
import {
  buildKimiSystemPrompt,
  type KimiSystemPromptSettings,
} from '../prompt/KimiSystemPrompt';

export interface KimiSessionMeta {
  modelId?: string;
  systemPromptOverride: string;
  yoloMode: boolean;
}

export interface KimiSessionMetaBuildOptions {
  model: string;
  permissionMode: unknown;
  promptSettings: KimiSystemPromptSettings;
}

export function buildKimiSessionMeta(
  options: KimiSessionMetaBuildOptions,
): KimiSessionMeta {
  const modelId = decodeKimiModelId(options.model);
  return {
    ...(modelId ? { modelId } : {}),
    systemPromptOverride: buildKimiSystemPrompt(options.promptSettings),
    yoloMode: options.permissionMode === 'yolo',
  };
}
