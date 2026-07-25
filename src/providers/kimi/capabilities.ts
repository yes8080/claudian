import type { ProviderCapabilities } from '../../core/providers/types';

export const KIMI_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'kimi',
  reasoningControl: 'effort',
  supportsFork: false,
  supportsImageAttachments: true,
  supportsInstructionMode: true,
  supportsMcpTools: false,
  supportsNativeHistory: true,
  supportsPersistentRuntime: true,
  supportsPlanMode: true,
  supportsProviderCommands: true,
  supportsRewind: false,
  supportsTurnSteer: false,
});
