import type {
  ProviderConversationHistoryService,
  ProviderHistoryPathContext,
} from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import {
  buildPersistedKimiProviderState,
  parseKimiProviderState,
} from '../types';
import { resolveKimiSessionDirectory } from './KimiHistoryPathResolver';
import { loadKimiHistory } from './KimiHistoryStore';

export class KimiConversationHistoryService implements ProviderConversationHistoryService {
  private readonly hydratedKeys = new Map<string, string>();

  async hydrateConversationHistory(
    conversation: Conversation,
    vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<void> {
    const state = parseKimiProviderState(conversation.providerState);
    const sessionId = conversation.sessionId;
    if (!sessionId || !pathContext) {
      this.hydratedKeys.delete(conversation.id);
      return;
    }
    const sessionDirectory = resolveKimiSessionDirectory(
      state.sessionDirectory,
      sessionId,
      vaultPath,
      pathContext,
    );
    if (sessionDirectory !== state.sessionDirectory) {
      conversation.providerState = buildPersistedKimiProviderState({
        sessionDirectory: sessionDirectory ?? undefined,
      }) as Record<string, unknown> | undefined;
    }
    if (!sessionDirectory) {
      this.hydratedKeys.delete(conversation.id);
      return;
    }

    const hydrationKey = `${sessionId}::${sessionDirectory}`;
    if (
      conversation.messages.length > 0
      && this.hydratedKeys.get(conversation.id) === hydrationKey
    ) {
      return;
    }
    const parsed = await loadKimiHistory(sessionDirectory, sessionId);
    if (parsed.messages.length === 0) {
      this.hydratedKeys.delete(conversation.id);
      return;
    }
    conversation.messages = parsed.messages;
    this.hydratedKeys.set(conversation.id, hydrationKey);
  }

  async deleteConversationSession(
    _conversation: Conversation,
    _vaultPath: string | null,
    _pathContext?: ProviderHistoryPathContext,
  ): Promise<void> {
    // Kimi-native history is read-only from Claudian.
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    return conversation?.sessionId ?? null;
  }

  isPendingForkConversation(_conversation: Conversation): boolean {
    return false;
  }

  buildForkProviderState(
    _sourceSessionId: string,
    _resumeAt: string,
    sourceProviderState?: Record<string, unknown>,
  ): Record<string, unknown> {
    return (buildPersistedKimiProviderState(
      parseKimiProviderState(sourceProviderState),
    ) as Record<string, unknown> | undefined) ?? {};
  }

  buildPersistedProviderState(
    conversation: Conversation,
  ): Record<string, unknown> | undefined {
    return buildPersistedKimiProviderState(
      parseKimiProviderState(conversation.providerState),
    ) as Record<string, unknown> | undefined;
  }
}
