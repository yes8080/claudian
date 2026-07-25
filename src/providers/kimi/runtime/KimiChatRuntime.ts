import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { ProviderCapabilities } from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type {
  ApprovalCallback,
  AskUserQuestionCallback,
  AutoTurnCallback,
  ChatRewindMode,
  ChatRewindPreview,
  ChatRewindResult,
  ChatRuntimeConversationState,
  ChatRuntimeEnsureReadyOptions,
  ChatRuntimeQueryOptions,
  ChatTurnMetadata,
  ChatTurnRequest,
  PreparedChatTurn,
  SessionUpdateResult,
} from '../../../core/runtime/types';
import type {
  ChatMessage,
  Conversation,
  ExitPlanModeCallback,
  SlashCommand,
  StreamChunk,
  ToolCallInfo,
} from '../../../core/types';
import { getVaultPath } from '../../../utils/path';
import {
  type AcpAvailableCommand,
  AcpClientConnection,
  AcpJsonRpcTransport,
  type AcpLoadSessionResponse,
  type AcpMetadata,
  type AcpNewSessionResponse,
  type AcpSessionNotification,
  AcpSessionUpdateNormalizer,
  AcpSubprocess,
  type AcpSubprocessLaunchSpec,
  AcpToolStreamAdapter,
  type AcpUsage,
  type AcpUsageUpdate,
  buildAcpUsageInfo,
  extractAcpSessionModelState,
  normalizeAcpAvailableCommands,
} from '../../acp';
import type { KimiAuxiliaryLifecycleCoordinator } from '../auxiliary/KimiAuxiliaryLifecycleCoordinator';
import { KIMI_PROVIDER_CAPABILITIES } from '../capabilities';
import { computeKimiEnvironmentHash } from '../env/KimiSettingsReconciler';
import { resolveKimiSessionDirectory } from '../history/KimiHistoryPathResolver';
import { resolveKimiUpdateMessageId } from '../history/KimiHistoryStore';
import {
  decodeKimiModelId,
  encodeKimiModelId,
  type KimiDiscoveredModel,
  normalizeKimiDiscoveredModels,
  normalizeKimiReasoningMetadata,
  resolveKimiDefaultReasoningEffort,
} from '../models';
import {
  buildKimiToolProviderPayload,
  normalizeKimiToolCall,
  normalizeKimiToolName,
  resolveKimiRawToolName,
} from '../normalization/kimiToolNormalization';
import {
  computeKimiSystemPromptKey,
  type KimiSystemPromptSettings,
} from '../prompt/KimiSystemPrompt';
import { getKimiProviderSettings } from '../settings';
import { parseKimiProviderState } from '../types';
import { buildKimiPromptBlocks, buildKimiPromptText } from './buildKimiPrompt';
import { waitForKimiCancelDelivery } from './KimiCancelDelivery';
import { KimiCliResolver } from './KimiCliResolver';
import { buildKimiRuntimeEnv } from './KimiRuntimeEnvironment';
import {
  KIMI_EXTENSION_NOTIFICATION_METHODS,
  KIMI_EXTENSION_REQUEST_METHODS,
  KimiServerRequestRouter,
} from './KimiServerRequestRouter';
import { buildKimiSessionMeta } from './KimiSessionMeta';
import {
  KimiSessionNotificationMirrorDeduplicator,
  type KimiSessionNotificationSource,
} from './KimiSessionNotificationMirrorDeduplicator';
import {
  KIMI_SESSION_UPDATE_NOTIFICATION_METHODS,
  KIMI_WRAPPED_SESSION_NOTIFICATION_METHOD,
  parseKimiSessionNotification,
} from './KimiSessionNotifications';

function cloneSlashCommand(command: SlashCommand): SlashCommand {
  return {
    ...command,
    allowedTools: command.allowedTools ? [...command.allowedTools] : undefined,
    hooks: command.hooks
      ? cloneJsonRecord(command.hooks)
      : undefined,
  };
}

function cloneJsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, cloneJsonValue(entry)]),
  );
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (value && typeof value === 'object') {
    return cloneJsonRecord(value as Record<string, unknown>);
  }
  return value;
}

function freezeSlashCommand(command: SlashCommand): SlashCommand {
  const clone = cloneSlashCommand(command);
  if (clone.allowedTools) Object.freeze(clone.allowedTools);
  if (clone.hooks) deepFreezeJsonValue(clone.hooks);
  return Object.freeze(clone);
}

function deepFreezeJsonValue(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeJsonValue(child);
  }
  Object.freeze(value);
}

interface ActiveTurn {
  abortController: AbortController;
  cancelled: boolean;
  completionEmitted: boolean;
  execution: TurnExecution;
  observedTurnCompletions: number;
  promptSettled: boolean;
  queryOptions?: ChatRuntimeQueryOptions;
  queue: StreamChunkQueue;
  requiredTurnCompletions: number;
  sessionId: string;
}

interface TurnExecution {
  abortController: AbortController;
  cancelled: boolean;
}

interface PendingKimiSessionNotification {
  notification: AcpSessionNotification;
  source: KimiSessionNotificationSource;
}

type KimiTurnPreparation =
  | { error: string; sessionId: null }
  | { error: null; sessionId: string };

interface KimiCliResolverLike {
  resolveFromSettings(settings: Record<string, unknown>): string | null;
}

interface KimiLiveModelCoordinatorLike {
  mergeLiveModels(
    models: KimiDiscoveredModel[],
    defaultModelId?: string,
    sourceContextKey?: string,
  ): Promise<unknown>;
}

interface PreparedKimiSessionModels {
  currentModelId: string | null;
  currentSessionEffort: string | null;
  models: KimiDiscoveredModel[];
}

interface PreparedKimiSessionResponse extends PreparedKimiSessionModels {
  sessionId: string;
}

interface KimiListCommandsResponse {
  commands: AcpAvailableCommand[];
}

export interface KimiRuntimeProcess {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  getStderrSnapshot(): string;
  isAlive(): boolean;
  onClose(listener: (error?: Error) => void): () => void;
  shutdown(): Promise<void>;
  start(): void;
}

export interface KimiChatRuntimeOptions {
  capabilities?: Readonly<ProviderCapabilities>;
  cliResolver?: KimiCliResolverLike;
  modelCatalogCoordinator?: KimiLiveModelCoordinatorLike | null;
  lifecycle?: KimiAuxiliaryLifecycleCoordinator;
  processFactory?: (launchSpec: AcpSubprocessLaunchSpec) => KimiRuntimeProcess;
  resolveSessionDirectory?: typeof resolveKimiSessionDirectory;
}

class StreamChunkQueue {
  private closed = false;
  private readonly items: StreamChunk[] = [];
  private readonly waiters: Array<(chunk: StreamChunk | null) => void> = [];

  push(chunk: StreamChunk): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(chunk);
    else this.items.push(chunk);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()?.(null);
  }

  async next(): Promise<StreamChunk | null> {
    if (this.items.length > 0) return this.items.shift() ?? null;
    if (this.closed) return null;
    return new Promise(resolve => this.waiters.push(resolve));
  }
}

export class KimiChatRuntime implements ChatRuntime {
  readonly providerId = 'kimi' as const;

  private activeTurn: ActiveTurn | null = null;
  private cancelDeliveryFlight: Promise<void> | null = null;
  private cancelRecycleFlight: Promise<void> | null = null;
  private connection: AcpClientConnection | null = null;
  private connectionGeneration = 0;
  private conversationGeneration = 0;
  private conversationId: string | null = null;
  private currentContextUsage: AcpUsageUpdate | null = null;
  private currentConversationModel: string | null = null;
  private currentLaunchKey: string | null = null;
  private currentModelContextKey: string | null = null;
  private currentPromptUsage: AcpUsage | null = null;
  private currentSessionDirectoryHint: string | null = null;
  private currentSessionEffort: string | null = null;
  private currentSessionModeId: 'default' | 'plan' | null = null;
  private currentSessionModelId: string | null = null;
  private currentTurnMetadata: ChatTurnMetadata = {};
  private disposed = false;
  private lastError: Error | null = null;
  private lifecycleGeneration = 0;
  private loadedSessionId: string | null = null;
  private process: KimiRuntimeProcess | null = null;
  private ready = false;
  private readonly readyListeners = new Set<(ready: boolean) => void>();
  private permissionModeSyncCallback: ((sdkMode: string) => void) | null = null;
  private readinessFlight: { key: string; promise: Promise<boolean> } | null = null;
  private requestedSessionModeId: 'default' | 'plan' | null = null;
  private readonly requestRouter = new KimiServerRequestRouter();
  private readonly notificationMirrorDeduplicator = new KimiSessionNotificationMirrorDeduplicator();
  private readonly sessionModelContextWindows = new Map<string, number>();
  private pendingNewSessionNotifications: PendingKimiSessionNotification[] | null = null;
  private sessionId: string | null = null;
  private sessionInvalidated = false;
  private readonly sessionUpdateNormalizer = new AcpSessionUpdateNormalizer();
  private shutdownFlight: Promise<void> | null = null;
  private readonly supportedCommandListeners = new Set<(
    commands: readonly SlashCommand[],
  ) => void>();
  private supportedCommandsAdvertised = false;
  private supportedCommands: readonly SlashCommand[] = [];
  private startingTurn: TurnExecution | null = null;
  private readonly toolStreamAdapter = createKimiToolStreamAdapter();
  private transport: AcpJsonRpcTransport | null = null;
  private unregisterTransportClose: (() => void) | null = null;
  private readonly unregisterTransportHandlers: Array<() => void> = [];

  private readonly capabilities: Readonly<ProviderCapabilities>;
  private readonly cliResolver: KimiCliResolverLike;
  private readonly modelCatalogCoordinator: KimiLiveModelCoordinatorLike | null;
  private readonly lifecycle: KimiAuxiliaryLifecycleCoordinator | null;
  private readonly processFactory: (launchSpec: AcpSubprocessLaunchSpec) => KimiRuntimeProcess;
  private readonly resolveSessionDirectory: typeof resolveKimiSessionDirectory;

  constructor(
    private readonly plugin: ProviderHost,
    options: KimiChatRuntimeOptions = {},
  ) {
    this.capabilities = options.capabilities ?? KIMI_PROVIDER_CAPABILITIES;
    this.cliResolver = options.cliResolver ?? new KimiCliResolver();
    this.modelCatalogCoordinator = options.modelCatalogCoordinator ?? null;
    this.lifecycle = options.lifecycle ?? null;
    this.processFactory = options.processFactory ?? (spec => new AcpSubprocess(spec));
    this.resolveSessionDirectory = options.resolveSessionDirectory ?? resolveKimiSessionDirectory;
  }

  getCapabilities(): Readonly<ProviderCapabilities> {
    return this.capabilities;
  }

  prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
    return {
      isCompact: false,
      mcpMentions: request.enabledMcpServers ?? new Set(),
      persistedContent: '',
      prompt: buildKimiPromptText(request),
      request,
    };
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  }

  setResumeCheckpoint(_checkpointId: string | undefined): void {}

  syncConversationState(conversation: ChatRuntimeConversationState | null): void {
    const nextConversationId = conversation?.id ?? null;
    const state = parseKimiProviderState(conversation?.providerState);
    const nextSessionId = normalizeOpaqueString(conversation?.sessionId);
    const targetChanged = JSON.stringify({
      conversationId: this.conversationId,
      sessionId: this.sessionId,
    }) !== JSON.stringify({
      conversationId: nextConversationId,
      sessionId: nextSessionId,
    });
    this.setCurrentConversationModel(conversation?.selectedModel);

    if (targetChanged) {
      this.currentSessionEffort = null;
      this.currentSessionModeId = null;
      this.requestedSessionModeId = null;
      this.currentSessionModelId = null;
      this.sessionModelContextWindows.clear();
      this.loadedSessionId = null;
      this.sessionInvalidated = false;
      this.setSupportedCommands([], false);
      this.requestRouter.setActiveSessionId(nextSessionId);
    }
    this.conversationId = nextConversationId;
    this.currentSessionDirectoryHint = state.sessionDirectory ?? null;
    this.sessionId = nextSessionId;

    if (targetChanged) {
      this.conversationGeneration += 1;
      this.currentLaunchKey = null;
      if (this.activeTurn) this.cancel();
      else if (this.startingTurn) this.recycleStartingTurn(this.startingTurn, false);
    }
  }

  async reloadMcpServers(): Promise<void> {}

  async ensureReady(options?: ChatRuntimeEnsureReadyOptions): Promise<boolean> {
    if (this.disposed) return false;
    if (this.lifecycle) {
      if (options?.providerTransitionOwner === true) {
        try {
          this.lifecycle.acquireOwned(this);
        } catch {
          return false;
        }
      } else {
        const lifecycleGeneration = this.lifecycleGeneration;
        try {
          await this.lifecycle.acquire(this);
        } catch {
          return false;
        }
        if (lifecycleGeneration !== this.lifecycleGeneration || this.disposed) {
          this.lifecycle.untrack(this);
          return false;
        }
      }
    }
    const cancelRecycle = this.cancelRecycleFlight;
    if (cancelRecycle) await cancelRecycle.catch(() => undefined);
    if (this.disposed) return false;
    const key = JSON.stringify({
      conversationGeneration: this.conversationGeneration,
      options: options ?? {},
    });
    if (this.readinessFlight) {
      if (this.readinessFlight.key === key) return this.readinessFlight.promise;
      await this.readinessFlight.promise.catch(() => undefined);
      return this.ensureReady(options);
    }

    const lifecycleGeneration = this.lifecycleGeneration;
    const conversationGeneration = this.conversationGeneration;
    const promise = this.ensureReadyInternal(
      options,
      lifecycleGeneration,
      conversationGeneration,
    );
    this.readinessFlight = { key, promise };
    return promise.finally(() => {
      if (this.readinessFlight?.promise === promise) this.readinessFlight = null;
    });
  }

  query(
    turn: PreparedChatTurn,
    _conversationHistory?: ChatMessage[],
    queryOptions?: ChatRuntimeQueryOptions,
  ): AsyncGenerator<StreamChunk> {
    const execution: TurnExecution = { abortController: new AbortController(), cancelled: false };
    const iterator = this.runQuery(turn, queryOptions, execution);
    return wrapCancelableGenerator(iterator, () => this.cancelTurnExecution(execution));
  }

  private async *runQuery(
    turn: PreparedChatTurn,
    queryOptions: ChatRuntimeQueryOptions | undefined,
    execution: TurnExecution,
  ): AsyncGenerator<StreamChunk> {
    if (this.activeTurn || this.startingTurn) {
      yield { type: 'error', content: 'Kimi does not support overlapping turns.' };
      yield { type: 'done' };
      return;
    }
    const conversationGeneration = this.conversationGeneration;
    this.startingTurn = execution;
    let preparation: KimiTurnPreparation;
    try {
      await this.lifecycle?.acquire(this, execution.abortController.signal);
      if (execution.cancelled) {
        yield { type: 'done' };
        return;
      }
      if (!this.isConversationCurrent(conversationGeneration)) {
        yield { type: 'error', content: 'The Kimi conversation changed before the turn started.' };
        yield { type: 'done' };
        return;
      }
      preparation = await this.prepareTurnSession(queryOptions, execution, true);
    } catch (error) {
      if (execution.cancelled) {
        yield { type: 'done' };
        return;
      }
      yield { type: 'error', content: this.formatRuntimeError(error) };
      yield { type: 'done' };
      return;
    } finally {
      if (this.startingTurn === execution) this.startingTurn = null;
    }
    if (execution.cancelled) {
      yield { type: 'done' };
      return;
    }
    if (preparation.error !== null) {
      yield { type: 'error', content: preparation.error };
      yield { type: 'done' };
      return;
    }
    const connection = this.connection;
    if (!connection) {
      yield { type: 'error', content: 'The Kimi runtime is not ready.' };
      yield { type: 'done' };
      return;
    }

    const activeTurn: ActiveTurn = {
      abortController: new AbortController(),
      cancelled: false,
      completionEmitted: false,
      execution,
      observedTurnCompletions: 0,
      promptSettled: false,
      queryOptions,
      queue: new StreamChunkQueue(),
      requiredTurnCompletions: 0,
      sessionId: preparation.sessionId,
    };
    this.activeTurn = activeTurn;
    this.currentContextUsage = null;
    this.currentPromptUsage = null;
    this.currentTurnMetadata = {};
    this.notificationMirrorDeduplicator.reset();
    this.sessionUpdateNormalizer.reset();
    this.toolStreamAdapter.reset();

    if (execution.cancelled) {
      this.activeTurn = null;
      yield { type: 'done' };
      return;
    }
    this.currentTurnMetadata.wasSent = true;
    const promptPromise = connection.prompt({
      prompt: buildKimiPromptBlocks(turn.request),
      sessionId: activeTurn.sessionId,
    }).then((response) => {
      if (response.userMessageId) this.currentTurnMetadata.userMessageId = response.userMessageId;
      const promptUsage = parseKimiPromptResponseUsage(response);
      if (promptUsage) this.currentPromptUsage = promptUsage;
    }).catch((error) => {
      if (!activeTurn.cancelled) {
        activeTurn.queue.push({ type: 'error', content: this.formatRuntimeError(error) });
      }
    }).finally(() => {
      activeTurn.promptSettled = true;
      this.finishActiveTurnIfReady(activeTurn);
    });

    try {
      while (true) {
        const chunk = await activeTurn.queue.next();
        if (!chunk) break;
        yield chunk;
      }
      if (!activeTurn.cancelled) await promptPromise;
    } finally {
      if (!activeTurn.promptSettled && !activeTurn.cancelled) {
        this.cancelTurnExecution(execution);
      }
      if (this.activeTurn === activeTurn) this.activeTurn = null;
    }
  }

  private async prepareTurnSession(
    queryOptions?: ChatRuntimeQueryOptions,
    execution?: TurnExecution,
    transitionAdmitted = false,
  ): Promise<KimiTurnPreparation> {
    if (queryOptions?.model) this.setCurrentConversationModel(queryOptions.model);
    const conversationGeneration = this.conversationGeneration;

    const ready = await this.ensureReady(
      transitionAdmitted ? { providerTransitionOwner: true } : undefined,
    );
    if (execution?.cancelled) {
      return { error: 'The Kimi turn was cancelled before it started.', sessionId: null };
    }
    if (!this.isConversationCurrent(conversationGeneration)) {
      return { error: 'The Kimi conversation changed before the turn started.', sessionId: null };
    }
    if (!ready) {
      return { error: this.formatRuntimeError(this.lastError), sessionId: null };
    }
    if (!this.connection || !this.sessionId) {
      return { error: 'The Kimi runtime is not ready.', sessionId: null };
    }

    try {
      await this.applySelectedModel(this.sessionId, queryOptions);
    } catch (error) {
      if (execution?.cancelled) {
        return { error: 'The Kimi turn was cancelled before it started.', sessionId: null };
      }
      if (!this.isConversationCurrent(conversationGeneration)) {
        return { error: 'The Kimi conversation changed before the turn started.', sessionId: null };
      }
      return { error: this.formatModelSelectionError(error), sessionId: null };
    }
    try {
      const desiredMode = this.requestedSessionModeId
        ?? (this.getProviderSettings().permissionMode === 'plan' ? 'plan' : null);
      if (desiredMode) {
        await this.setSessionMode(desiredMode);
      }
    } catch (error) {
      return { error: this.formatRuntimeError(error), sessionId: null };
    }
    if (!this.isConversationCurrent(conversationGeneration)) {
      return { error: 'The Kimi conversation changed before the turn started.', sessionId: null };
    }
    if (execution?.cancelled) {
      return { error: 'The Kimi turn was cancelled before it started.', sessionId: null };
    }
    if (!this.connection || !this.sessionId) {
      return { error: 'The Kimi runtime is not ready.', sessionId: null };
    }
    return { error: null, sessionId: this.sessionId };
  }

  async steer(_turn: PreparedChatTurn): Promise<boolean> {
    return false;
  }

  private finishActiveTurnIfReady(activeTurn: ActiveTurn): void {
    if (
      activeTurn.cancelled
      || activeTurn.completionEmitted
      || !activeTurn.promptSettled
      || activeTurn.observedTurnCompletions < activeTurn.requiredTurnCompletions
    ) return;

    activeTurn.completionEmitted = true;
    const usage = this.buildCurrentUsage(activeTurn.queryOptions);
    if (usage) {
      activeTurn.queue.push({ sessionId: activeTurn.sessionId, type: 'usage', usage });
    }
    activeTurn.queue.push({ type: 'done' });
    activeTurn.queue.close();
    if (this.activeTurn === activeTurn) this.activeTurn = null;
  }

  cancel(): void {
    const activeTurn = this.activeTurn;
    if (activeTurn) {
      this.cancelActiveTurn(activeTurn);
      return;
    }
    const startingTurn = this.startingTurn;
    if (startingTurn) this.cancelStartingTurn(startingTurn);
  }

  private cancelActiveTurn(activeTurn: ActiveTurn): void {
    if (activeTurn.cancelled) return;
    activeTurn.cancelled = true;
    activeTurn.execution.cancelled = true;
    activeTurn.abortController.abort();
    this.requestRouter.abortPending();
    this.requestRouter.setActiveSessionId(null);
    this.connection?.cancel({ sessionId: activeTurn.sessionId });
    this.quarantineCancelledTurn(this.transport);
    activeTurn.queue.push({ type: 'done' });
    activeTurn.queue.close();
    if (this.activeTurn === activeTurn) this.activeTurn = null;
  }

  private cancelStartingTurn(execution: TurnExecution): void {
    if (execution.cancelled) return;
    execution.abortController.abort();
    this.recycleStartingTurn(execution, true);
  }

  private recycleStartingTurn(execution: TurnExecution, cancelled: boolean): void {
    if (cancelled) execution.cancelled = true;
    if (this.startingTurn === execution) this.startingTurn = null;
    this.lifecycleGeneration += 1;
    this.requestRouter.abortPending();
    this.requestRouter.setActiveSessionId(null);
    const readiness = this.readinessFlight?.promise;
    const recycle = (async () => {
      await this.shutdownProcess().catch(() => undefined);
      if (readiness) await readiness.catch(() => undefined);
    })();
    this.setCancelRecycleFlight(recycle);
  }

  private cancelTurnExecution(execution: TurnExecution): void {
    if (this.activeTurn?.execution === execution) {
      this.cancelActiveTurn(this.activeTurn);
      return;
    }
    if (this.startingTurn === execution) {
      this.cancelStartingTurn(execution);
      return;
    }
    execution.cancelled = true;
    execution.abortController.abort();
  }

  resetSession(): void {
    this.cancel();
    this.sessionId = null;
    this.loadedSessionId = null;
    this.currentSessionModelId = null;
    this.currentSessionEffort = null;
    this.currentSessionModeId = null;
    this.currentSessionDirectoryHint = null;
    this.requestedSessionModeId = null;
    this.sessionModelContextWindows.clear();
    this.currentLaunchKey = null;
    this.sessionInvalidated = false;
    this.requestRouter.setActiveSessionId(null);
    this.setSupportedCommands([], false);
    void this.shutdownProcess();
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  consumeSessionInvalidation(): boolean {
    const invalidated = this.sessionInvalidated;
    this.sessionInvalidated = false;
    return invalidated;
  }

  isReady(): boolean {
    return this.ready;
  }

  async getSupportedCommands(): Promise<SlashCommand[]> {
    if (!this.sessionId) return [];
    if (this.loadedSessionId !== this.sessionId) {
      const ready = await this.ensureReady({ allowSessionCreation: false });
      if (!ready) return [];
    }
    return this.supportedCommands.map(cloneSlashCommand);
  }

  async discoverSupportedCommands(
    timeoutMs = 5_000,
    signal?: AbortSignal,
  ): Promise<SlashCommand[]> {
    signal?.throwIfAborted();
    const ready = await this.ensureReady({ allowSessionCreation: false });
    signal?.throwIfAborted();
    const transport = this.transport;
    if (!ready || !transport || transport.isClosed) {
      throw new Error('Kimi command transport is unavailable.');
    }
    const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
    const response = await transport.request<KimiListCommandsResponse>(
      'kimi/commands/list',
      { cwd },
      { signal, timeoutMs },
    );
    if (!Array.isArray(response.commands)) {
      throw new Error('Kimi returned malformed command metadata.');
    }
    return normalizeAcpAvailableCommands(response.commands);
  }

  getReadySupportedCommandsSnapshot(): SlashCommand[] | null {
    if (
      this.disposed
      || !this.ready
      || !this.sessionId
      || this.loadedSessionId !== this.sessionId
      || !this.supportedCommandsAdvertised
    ) {
      return null;
    }
    return this.supportedCommands.map(cloneSlashCommand);
  }

  onSupportedCommandsChange(
    listener: (commands: readonly SlashCommand[]) => void,
  ): () => void {
    if (this.disposed) return () => undefined;
    this.supportedCommandListeners.add(listener);
    return () => this.supportedCommandListeners.delete(listener);
  }

  getAuxiliaryModel(): string | null {
    return this.currentConversationModel
      ?? (this.currentSessionModelId ? `kimi/${this.currentSessionModelId}` : null);
  }

  cleanup(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycleGeneration += 1;
    const activeTurn = this.activeTurn;
    if (activeTurn) {
      activeTurn.cancelled = true;
      activeTurn.abortController.abort();
      activeTurn.queue.close();
      this.activeTurn = null;
    }
    const startingTurn = this.startingTurn;
    if (startingTurn) {
      startingTurn.cancelled = true;
      startingTurn.abortController.abort();
      if (this.startingTurn === startingTurn) this.startingTurn = null;
    }
    this.requestRouter.dispose();
    this.sessionModelContextWindows.clear();
    this.supportedCommandListeners.clear();
    this.lifecycle?.untrack(this);
    void this.shutdownProcess();
  }

  async quiesceForEnvironmentChange(): Promise<void> {
    this.lifecycleGeneration += 1;
    this.cancel();
    const readiness = this.readinessFlight?.promise;
    const recycle = this.cancelRecycleFlight;
    if (recycle) await recycle.catch(() => undefined);
    if (readiness) await readiness.catch(() => undefined);
    await this.shutdownProcess();
  }

  async rewind(
    _userMessageId: string,
    _assistantMessageId: string | undefined,
    _mode: ChatRewindMode = 'code-and-conversation',
  ): Promise<ChatRewindResult> {
    return { canRewind: false, error: 'Kimi rewind is not supported.' };
  }

  async previewRewind(
    _userMessageId: string,
    _assistantMessageId: string | undefined,
    _mode: ChatRewindMode = 'code-and-conversation',
  ): Promise<ChatRewindPreview> {
    return { canRewind: false, error: 'Kimi rewind is not supported.' };
  }

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.requestRouter.setApprovalCallback(callback);
  }

  setApprovalDismisser(dismisser: (() => void) | null): void {
    this.requestRouter.setApprovalDismisser(dismisser);
  }

  setAskUserQuestionCallback(callback: AskUserQuestionCallback | null): void {
    this.requestRouter.setAskUserQuestionCallback(callback);
  }

  setExitPlanModeCallback(callback: ExitPlanModeCallback | null): void {
    this.requestRouter.setExitPlanModeCallback(callback);
  }

  async setSessionMode(mode: string): Promise<boolean> {
    const modeId = mode === 'plan' ? 'plan' : 'default';
    const connection = this.connection;
    const sessionId = this.sessionId;
    if (!connection || !sessionId || !this.ready) {
      this.requestedSessionModeId = modeId;
      return false;
    }
    if (this.currentSessionModeId === modeId) {
      this.requestedSessionModeId = modeId;
      return true;
    }
    const connectionGeneration = this.connectionGeneration;
    await connection.setMode({ modeId, sessionId });
    this.requestedSessionModeId = modeId;
    if (
      connection !== this.connection
      || connectionGeneration !== this.connectionGeneration
      || sessionId !== this.sessionId
    ) return false;
    this.currentSessionModeId = modeId;
    return true;
  }

  setPermissionModeSyncCallback(callback: ((sdkMode: string) => void) | null): void {
    this.permissionModeSyncCallback = callback;
    this.requestRouter.setPermissionModeSyncCallback((mode) => {
      if (
        this.currentSessionModeId !== 'plan'
        && this.getProviderSettings().permissionMode !== 'plan'
      ) callback?.(mode);
    });
  }

  setAutoTurnCallback(_callback: AutoTurnCallback | null): void {}

  consumeTurnMetadata(): ChatTurnMetadata {
    const metadata = this.currentTurnMetadata;
    this.currentTurnMetadata = {};
    return metadata;
  }

  buildSessionUpdates(params: {
    conversation: Conversation | null;
    sessionInvalidated: boolean;
  }): SessionUpdateResult {
    const providerState = isRecord(params.conversation?.providerState)
      ? { ...params.conversation.providerState }
      : {};
    delete providerState.sessionDirectory;

    if (this.sessionId) {
      const cwd = getVaultPath(this.plugin.app);
      const cliPath = this.cliResolver.resolveFromSettings(this.plugin.settings) ?? 'kimi';
      const environment = buildKimiRuntimeEnv(this.plugin.settings, cliPath);
      const currentHint = isRecord(params.conversation?.providerState)
        && typeof params.conversation.providerState.sessionDirectory === 'string'
        ? params.conversation.providerState.sessionDirectory
        : undefined;
      const sessionDirectory = this.resolveSessionDirectory(
        currentHint,
        this.sessionId,
        cwd,
        { environment, hostPlatform: process.platform },
      );
      if (sessionDirectory) {
        providerState.sessionDirectory = sessionDirectory;
        this.currentSessionDirectoryHint = sessionDirectory;
      }
    }

    return {
      updates: {
        providerState: Object.keys(providerState).length > 0 ? providerState : undefined,
        sessionId: this.sessionId,
      },
    };
  }

  resolveSessionIdForFork(conversation: Conversation | null): string | null {
    if (this.sessionId) return this.sessionId;
    return normalizeOpaqueString(conversation?.sessionId) ?? null;
  }

  async loadSubagentToolCalls(_agentId: string): Promise<ToolCallInfo[]> {
    return [];
  }

  async loadSubagentFinalResult(_agentId: string): Promise<string | null> {
    return null;
  }

  private async ensureReadyInternal(
    options: ChatRuntimeEnsureReadyOptions | undefined,
    lifecycleGeneration: number,
    conversationGeneration: number,
  ): Promise<boolean> {
    if (!getKimiProviderSettings(this.plugin.settings).enabled) {
      this.lastError = new Error('Kimi is disabled.');
      this.setReady(false);
      return false;
    }
    const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
    const cliPath = this.cliResolver.resolveFromSettings(this.plugin.settings);
    if (!cliPath) {
      this.lastError = new Error('Kimi CLI was not found. Configure its path or install `kimi`.');
      this.setReady(false);
      return false;
    }
    const environment = buildKimiRuntimeEnv(this.plugin.settings, cliPath);
    const environmentHash = computeKimiEnvironmentHash(this.plugin.settings);
    const promptSettings = this.getPromptSettings(cwd);
    const settings = this.getProviderSettings();
    const yoloMode = resolveKimiBasePermissionMode(settings) === 'yolo';
    const nextLaunchKey = JSON.stringify({
      cliPath,
      cwd,
      environmentHash,
      promptKey: computeKimiSystemPromptKey(promptSettings),
      sessionId: this.sessionId,
      yoloMode,
    });
    const shouldRestart = !this.process
      || !this.process.isAlive()
      || !this.transport
      || this.transport.isClosed
      || !this.connection
      || options?.force === true
      || this.currentLaunchKey !== nextLaunchKey;

    if (shouldRestart) {
      await this.shutdownProcess();
      if (!this.isReadinessCurrent(lifecycleGeneration, conversationGeneration)) return false;
      try {
        await this.startProcess(cliPath, cwd, environment);
        this.currentModelContextKey = environmentHash;
      } catch (error) {
        this.lastError = toError(error, 'Failed to start Kimi.');
        await this.shutdownProcess();
        return false;
      }
      if (!this.isReadinessCurrent(lifecycleGeneration, conversationGeneration)) {
        await this.shutdownProcess();
        return false;
      }
      this.currentLaunchKey = nextLaunchKey;
      this.loadedSessionId = null;
    }


    if (this.sessionId && this.loadedSessionId !== this.sessionId) {
      const targetSessionId = this.sessionId;
      if (!(await this.loadSession(targetSessionId, cwd, promptSettings, conversationGeneration))) {
        this.setReady(false);
        return false;
      }
    } else if (!this.sessionId && options?.allowSessionCreation !== false) {
      if (!(await this.createSession(cwd, promptSettings, conversationGeneration))) {
        this.setReady(false);
        return false;
      }
    }

    if (this.sessionId) {
      this.currentLaunchKey = JSON.stringify({
        cliPath,
        cwd,
        environmentHash,
        promptKey: computeKimiSystemPromptKey(promptSettings),
        sessionId: this.sessionId,
        yoloMode,
      });
    }
    this.lastError = null;
    this.setReady(true);
    return true;
  }

  private async startProcess(
    command: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    const ownedProcess = this.processFactory({
      args: ['acp'],
      command,
      cwd,
      env,
    });
    this.process = ownedProcess;
    ownedProcess.start();

    const transport = new AcpJsonRpcTransport({
      input: ownedProcess.stdout,
      onClose: listener => ownedProcess.onClose(listener),
      output: ownedProcess.stdin,
    });
    this.transport = transport;
    const connectionGeneration = ++this.connectionGeneration;
    this.notificationMirrorDeduplicator.reset();
    this.unregisterTransportClose = transport.onClose((error) => {
      if (this.transport !== transport) return;
      this.setReady(false);
      this.requestRouter.abortPending();
      this.settleActiveTurn(error ?? new Error('Kimi runtime closed.'));
    });

    this.connection = new AcpClientConnection({
      clientInfo: {
        name: 'claudian',
        version: this.plugin.manifest?.version ?? '0.0.0',
      },
      delegate: {
        onSessionNotification: notification => this.handleSessionNotification(
          notification,
          connectionGeneration,
          'standard',
        ),
        requestPermission: request => this.requestRouter.handlePermissionRequest(
          request,
          this.activeTurn?.abortController.signal,
        ),
      },
      methodOverrides: { cancel: 'session/cancel' },
      transport,
    });

    for (const method of [
      ...KIMI_SESSION_UPDATE_NOTIFICATION_METHODS,
      KIMI_WRAPPED_SESSION_NOTIFICATION_METHOD,
    ]) {
      this.unregisterTransportHandlers.push(transport.onNotification(
        method,
        (params) => {
          const notification = parseKimiSessionNotification(method, params);
          if (notification) {
            void this.handleSessionNotification(notification, connectionGeneration, 'extension');
          }
        },
      ));
    }
    for (const method of KIMI_EXTENSION_REQUEST_METHODS) {
      this.unregisterTransportHandlers.push(transport.onRequest(
        method,
        params => this.requestRouter.handleRequest(
          method,
          params,
          this.activeTurn?.abortController.signal,
        ),
      ));
    }
    for (const method of KIMI_EXTENSION_NOTIFICATION_METHODS) {
      this.unregisterTransportHandlers.push(transport.onNotification(
        method,
        params => { this.requestRouter.handleNotification(method, params); },
      ));
    }

    transport.start();
    await this.connection.initialize();
    this.setReady(true);
  }

  private async shutdownProcess(): Promise<void> {
    if (this.shutdownFlight) return this.shutdownFlight;
    const shutdown = this.shutdownProcessInternal();
    this.shutdownFlight = shutdown;
    try {
      await shutdown;
    } finally {
      if (this.shutdownFlight === shutdown) this.shutdownFlight = null;
    }
  }

  private async shutdownProcessInternal(): Promise<void> {
    const cancelDelivery = this.cancelDeliveryFlight;
    if (cancelDelivery) {
      await cancelDelivery.catch(() => undefined);
      if (this.cancelDeliveryFlight === cancelDelivery) this.cancelDeliveryFlight = null;
    }
    this.connectionGeneration += 1;
    this.notificationMirrorDeduplicator.reset();
    this.setReady(false);
    this.requestRouter.abortPending();
    this.settleActiveTurn();

    this.unregisterTransportClose?.();
    this.unregisterTransportClose = null;
    while (this.unregisterTransportHandlers.length > 0) {
      this.unregisterTransportHandlers.pop()?.();
    }

    this.connection?.dispose();
    this.connection = null;
    this.transport?.dispose();
    this.transport = null;
    const ownedProcess = this.process;
    this.process = null;
    this.currentModelContextKey = null;
    if (ownedProcess) await ownedProcess.shutdown().catch(() => undefined);
    this.loadedSessionId = null;
    this.pendingNewSessionNotifications = null;
  }

  private quarantineCancelledTurn(transport: AcpJsonRpcTransport | null): void {
    const delivery = waitForKimiCancelDelivery(transport);
    this.cancelDeliveryFlight = delivery;
    const recycle = (async () => {
      await delivery.catch(() => undefined);
      if (this.transport === transport) await this.shutdownProcess();
    })();
    this.setCancelRecycleFlight(recycle);
  }

  private setCancelRecycleFlight(recycle: Promise<void>): void {
    this.cancelRecycleFlight = recycle;
    const clear = () => {
      if (this.cancelRecycleFlight === recycle) this.cancelRecycleFlight = null;
    };
    void recycle.then(clear, clear);
  }

  private async createSession(
    cwd: string,
    promptSettings: KimiSystemPromptSettings,
    conversationGeneration: number,
  ): Promise<boolean> {
    if (!this.connection) return false;
    const pendingNotifications: PendingKimiSessionNotification[] = [];
    this.pendingNewSessionNotifications = pendingNotifications;
    try {
      this.setSupportedCommands([], false);
      const response = await this.connection.newSession({
        _meta: this.buildSessionMeta(promptSettings),
        cwd,
        mcpServers: [],
      });
      if (!this.isConversationCurrent(conversationGeneration)) return false;
      const prepared = this.prepareSessionResponse(response);
      await this.mergeSessionModels(prepared.models);
      if (!this.isConversationCurrent(conversationGeneration)) return false;
      this.commitSessionResponse(prepared);
      this.notificationMirrorDeduplicator.reset();
      for (const pending of pendingNotifications) {
        if (pending.notification.sessionId === prepared.sessionId) {
          await this.handleSessionNotification(
            pending.notification,
            this.connectionGeneration,
            pending.source,
          );
        }
      }
      return this.isConversationCurrent(conversationGeneration);
    } catch (error) {
      this.lastError = toError(error, 'Failed to create a Kimi session.');
      return false;
    } finally {
      if (this.pendingNewSessionNotifications === pendingNotifications) {
        this.pendingNewSessionNotifications = null;
      }
    }
  }

  private async loadSession(
    sessionId: string,
    cwd: string,
    promptSettings: KimiSystemPromptSettings,
    conversationGeneration: number,
  ): Promise<boolean> {
    if (!this.connection) return false;
    try {
      this.setSupportedCommands([], false);
      const response = await this.connection.loadSession({
        _meta: this.buildSessionMeta(promptSettings),
        cwd,
        mcpServers: [],
        sessionId,
      });
      if (!this.isConversationCurrent(conversationGeneration)) return false;
      const prepared = this.prepareSessionResponse(response, sessionId);
      await this.mergeSessionModels(prepared.models);
      if (!this.isConversationCurrent(conversationGeneration)) return false;
      this.commitSessionResponse(prepared);
      return this.isConversationCurrent(conversationGeneration);
    } catch (error) {
      this.lastError = toError(error, `Failed to load Kimi session ${sessionId}.`);
      return false;
    }
  }

  private buildSessionMeta(promptSettings: KimiSystemPromptSettings): AcpMetadata {
    const settings = this.getProviderSettings();
    return { ...buildKimiSessionMeta({
      model: this.resolveSelectedModel(),
      permissionMode: resolveKimiBasePermissionMode(settings),
      promptSettings,
    }) };
  }

  private async applySelectedModel(
    sessionId: string,
    queryOptions?: ChatRuntimeQueryOptions,
  ): Promise<string> {
    if (!this.connection) return sessionId;
    const rawModelId = decodeKimiModelId(this.resolveSelectedModel(queryOptions));
    if (!rawModelId) {
      return sessionId;
    }
    const effort = this.resolveSelectedEffort(rawModelId);
    if (
      rawModelId === this.currentSessionModelId
      && effort === this.currentSessionEffort
    ) {
      return sessionId;
    }

    const response = await this.connection.setModel({
      ...(effort ? { _meta: { reasoningEffort: effort } } : {}),
      modelId: rawModelId,
      sessionId,
    });
    this.currentSessionModelId = rawModelId;
    this.currentSessionEffort = effort;
    await this.mergeSetModelMetadata(response._meta);
    return sessionId;
  }

  private async handleSessionNotification(
    notification: AcpSessionNotification,
    connectionGeneration: number,
    source: KimiSessionNotificationSource,
  ): Promise<void> {
    if (connectionGeneration !== this.connectionGeneration) return;
    if (!isRecord(notification)) return;
    if (notification.sessionId !== this.sessionId) {
      if (
        this.pendingNewSessionNotifications
        && this.notificationMirrorDeduplicator.shouldProcess(notification, source)
      ) {
        this.pendingNewSessionNotifications.push({ notification, source });
      }
      return;
    }
    if (!this.notificationMirrorDeduplicator.shouldProcess(notification, source)) return;

    if (isKimiTurnCompleted(notification.update)) {
      const activeTurn = this.activeTurn;
      if (activeTurn?.sessionId === notification.sessionId) {
        activeTurn.observedTurnCompletions += 1;
        const completedUsage = parseKimiTurnCompletedUsage(notification.update);
        if (completedUsage) this.currentPromptUsage = completedUsage;
        this.finishActiveTurnIfReady(activeTurn);
      }
      return;
    }

    let normalized: ReturnType<AcpSessionUpdateNormalizer['normalize']>;
    try {
      normalized = this.sessionUpdateNormalizer.normalize(notification.update);
    } catch {
      return;
    }
    if (!normalized) return;

    if (normalized.type === 'commands') {
      this.setSupportedCommands(normalized.commands);
      return;
    }
    if (normalized.type === 'config_options') {
      await this.syncSessionModels({ configOptions: normalized.configOptions });
      return;
    }
    if (normalized.type === 'current_mode') {
      const mode = normalized.currentModeId === 'plan' ? 'plan' : 'default';
      this.currentSessionModeId = mode;
      this.requestedSessionModeId = mode;
      const uiMode = mode === 'plan'
        ? 'plan'
        : getKimiProviderSettings(this.getProviderSettings()).planBasePermissionMode;
      try {
        this.permissionModeSyncCallback?.(uiMode);
      } catch {
        // UI synchronization is best-effort and must not disrupt the ACP stream.
      }
      return;
    }
    if (!this.activeTurn || this.activeTurn.sessionId !== notification.sessionId) return;

    switch (normalized.type) {
      case 'message_chunk': {
        const messageId = normalized.messageId
          ?? (normalized.role === 'assistant' || normalized.role === 'user'
            ? resolveKimiUpdateMessageId(
              notification.update,
              normalized.role,
              notification._meta,
            )
            : undefined);
        if (normalized.role === 'assistant' && messageId) {
          this.currentTurnMetadata.assistantMessageId = messageId;
        }
        if (normalized.role === 'user' && messageId) {
          this.currentTurnMetadata.userMessageId = messageId;
        }
        for (const chunk of normalized.streamChunks) {
          if (
            messageId
            && (chunk.type === 'assistant_message_start' || chunk.type === 'user_message_start')
            && !chunk.itemId
          ) {
            this.activeTurn.queue.push({ ...chunk, itemId: messageId });
          } else {
            this.activeTurn.queue.push(chunk);
          }
        }
        return;
      }
      case 'tool_call':
        for (const chunk of this.toolStreamAdapter.normalizeToolCall(
          normalized.toolCall,
          normalized.streamChunks,
        )) this.activeTurn.queue.push(chunk);
        return;
      case 'tool_call_update':
        for (const chunk of this.toolStreamAdapter.normalizeToolCallUpdate(
          normalized.toolCallUpdate,
          normalized.streamChunks,
        )) this.activeTurn.queue.push(chunk);
        return;
      case 'usage': {
        this.currentContextUsage = normalized.usage;
        const usage = this.buildCurrentUsage();
        if (usage) {
          this.activeTurn.queue.push({
            sessionId: notification.sessionId,
            type: 'usage',
            usage,
          });
        }
        return;
      }
      default:
        return;
    }
  }

  private async syncSessionModels(
    response: Pick<AcpNewSessionResponse, '_meta' | 'configOptions' | 'models'>,
    conversationGeneration?: number,
  ): Promise<void> {
    if (
      conversationGeneration !== undefined
      && !this.isConversationCurrent(conversationGeneration)
    ) return;
    const prepared = this.prepareSessionModels(response);
    this.applySessionModels(prepared);
    await this.mergeSessionModels(prepared.models);
  }

  private prepareSessionResponse(
    response: AcpNewSessionResponse | AcpLoadSessionResponse,
    expectedSessionId?: string,
  ): PreparedKimiSessionResponse {
    if (!isRecord(response)) throw new Error('Kimi returned a malformed ACP session response.');
    const responseSessionId = normalizeOpaqueString(response.sessionId);
    const sessionId = response.sessionId === undefined || response.sessionId === null
      ? expectedSessionId ?? null
      : responseSessionId;
    if (!sessionId) throw new Error('Kimi ACP session response is missing a session id.');
    if (responseSessionId && expectedSessionId !== undefined && responseSessionId !== expectedSessionId) {
      throw new Error(`Kimi ACP session response returned an unexpected session id: ${responseSessionId}.`);
    }
    return { ...this.prepareSessionModels(response), sessionId };
  }

  private prepareSessionModels(
    response: Pick<AcpNewSessionResponse, '_meta' | 'configOptions' | 'models'>,
  ): PreparedKimiSessionModels {
    const state = extractAcpSessionModelState(response);
    const models = normalizeKimiDiscoveredModels(state.availableModels.map(model => ({
      ...readKimiModelMetadata({
        ...(model.id === state.currentModelId
          ? normalizeKimiReasoningMetadata(response._meta)
          : {}),
        ...(isRecord(model._meta) ? model._meta : {}),
      }),
      description: model.description ?? undefined,
      displayName: model.name,
      rawId: model.id,
      reasoningMetadataResolved: true,
    })));
    const current = models.find(model => model.rawId === state.currentModelId);
    return {
      currentModelId: state.currentModelId,
      currentSessionEffort: current ? resolveKimiDefaultReasoningEffort(current) : null,
      models,
    };
  }

  private applySessionModels(prepared: PreparedKimiSessionModels): void {
    this.updateSessionModelContextWindows(prepared.models, true);
    this.currentSessionModelId = prepared.currentModelId;
    this.currentSessionEffort = prepared.currentSessionEffort;
  }

  private updateSessionModelContextWindows(
    models: readonly KimiDiscoveredModel[],
    reconcileAvailableModels = false,
  ): void {
    if (reconcileAvailableModels) {
      const availableModelIds = new Set(models.map(model => model.rawId));
      for (const modelId of this.sessionModelContextWindows.keys()) {
        if (!availableModelIds.has(modelId)) this.sessionModelContextWindows.delete(modelId);
      }
    }
    for (const model of models) {
      if (model.contextWindow !== undefined) {
        this.sessionModelContextWindows.set(model.rawId, model.contextWindow);
      }
    }
  }

  private async mergeSessionModels(
    models: KimiDiscoveredModel[],
    defaultModelId?: string,
  ): Promise<void> {
    if (models.length > 0) {
      await (defaultModelId
        ? this.modelCatalogCoordinator?.mergeLiveModels(
          models,
          defaultModelId,
          this.currentModelContextKey ?? undefined,
        )
        : this.modelCatalogCoordinator?.mergeLiveModels(
          models,
          undefined,
          this.currentModelContextKey ?? undefined,
        ));
    }
  }

  private commitSessionResponse(prepared: PreparedKimiSessionResponse): void {
    this.sessionId = prepared.sessionId;
    this.loadedSessionId = prepared.sessionId;
    this.requestRouter.setActiveSessionId(prepared.sessionId);
    this.applySessionModels(prepared);
  }

  private async mergeSetModelMetadata(metadata: AcpMetadata | null | undefined): Promise<void> {
    if (!isRecord(metadata) || !isRecord(metadata.model)) return;
    const model = normalizeKimiDiscoveredModels([{
      ...metadata.model,
      reasoningMetadataResolved: true,
    }]);
    if (model.length > 0) {
      this.updateSessionModelContextWindows(model);
      await this.modelCatalogCoordinator?.mergeLiveModels(
        model,
        undefined,
        this.currentModelContextKey ?? undefined,
      );
    }
  }

  private setSupportedCommands(commands: SlashCommand[], advertised = true): void {
    const snapshot = Object.freeze(commands.map(command => freezeSlashCommand(command)));
    this.supportedCommandsAdvertised = advertised;
    this.supportedCommands = snapshot;
    for (const listener of this.supportedCommandListeners) {
      try {
        listener(snapshot);
      } catch {
        // A UI subscriber cannot interrupt the provider protocol stream.
      }
    }
  }

  private settleActiveTurn(error?: Error): void {
    const activeTurn = this.activeTurn;
    if (!activeTurn || activeTurn.cancelled) return;
    activeTurn.cancelled = true;
    activeTurn.abortController.abort();
    this.requestRouter.abortPending();
    if (error) activeTurn.queue.push({ type: 'error', content: this.formatRuntimeError(error) });
    activeTurn.queue.push({ type: 'done' });
    activeTurn.queue.close();
    if (this.activeTurn === activeTurn) this.activeTurn = null;
  }

  private getProviderSettings(): Record<string, unknown> {
    const settings: Record<string, unknown> = { ...this.plugin.settings };
    projectSavedProviderValue(settings, 'savedProviderModel', 'model');
    projectSavedProviderValue(settings, 'savedProviderEffort', 'effortLevel');
    projectSavedProviderValue(settings, 'savedProviderPermissionMode', 'permissionMode');
    if (this.currentConversationModel) settings.model = this.currentConversationModel;
    return settings;
  }

  private resolveSelectedModel(queryOptions?: ChatRuntimeQueryOptions): string {
    const settings = this.getProviderSettings();
    const model = queryOptions?.model ?? settings.model;
    const rawModelId = typeof model === 'string' ? decodeKimiModelId(model) : null;
    if (rawModelId) {
      return encodeKimiModelId(rawModelId);
    }
    throw new Error('No Kimi model is selected. Enable a discovered model in Claudian settings.');
  }

  private resolveSelectedEffort(rawModelId: string): string | null {
    const settings = this.getProviderSettings();
    const direct = typeof settings.effortLevel === 'string' ? settings.effortLevel.trim() : '';
    const preferred = getKimiProviderSettings(settings).preferredReasoningByModel[rawModelId];
    return direct || preferred || null;
  }

  private setCurrentConversationModel(model: unknown): void {
    const normalized = typeof model === 'string' ? model.trim() : '';
    this.currentConversationModel = normalized || null;
  }

  private getPromptSettings(cwd: string): KimiSystemPromptSettings {
    return {
      customPrompt: this.plugin.settings.systemPrompt,
      mediaFolder: this.plugin.settings.mediaFolder,
      userName: this.plugin.settings.userName,
      vaultPath: cwd,
    };
  }

  private buildCurrentUsage(queryOptions?: ChatRuntimeQueryOptions) {
    const usage = buildAcpUsageInfo({
      contextWindow: this.currentContextUsage,
      model: this.resolveSelectedModel(queryOptions),
      promptUsage: this.currentPromptUsage,
    });
    if (!usage) return null;
    const advertisedContextWindow = this.currentSessionModelId
      ? this.sessionModelContextWindows.get(this.currentSessionModelId)
      : undefined;
    const usageContextWindow = this.currentContextUsage && this.currentContextUsage.size > 0
      ? this.currentContextUsage.size
      : undefined;
    const contextWindow = usageContextWindow ?? advertisedContextWindow ?? usage.contextWindow;
    const contextTokens = this.currentPromptUsage?.totalTokens
      ?? this.currentContextUsage?.used
      ?? usage.contextTokens;
    return {
      ...usage,
      contextTokens,
      contextWindow,
      contextWindowIsAuthoritative: Boolean(usageContextWindow || advertisedContextWindow),
      percentage: contextWindow > 0
        ? Math.min(100, Math.max(0, Math.round((contextTokens / contextWindow) * 100)))
        : 0,
    };
  }

  private formatModelSelectionError(error: unknown): string {
    const message = toError(error, 'Kimi model selection failed.').message;
    if (/agent\s*type|agenttype|incompatible/i.test(message)) {
      return 'This model uses an agent type that is incompatible with the current Kimi session. Start a new conversation with that model.';
    }
    return this.formatRuntimeError(error);
  }

  private formatRuntimeError(error: unknown): string {
    const baseMessage = toError(error ?? this.lastError, 'Kimi request failed.').message;
    const redactedBaseMessage = redactDiagnostic(baseMessage);
    if (redactedBaseMessage !== baseMessage) {
      return redactedBaseMessage;
    }
    const diagnosticText = `${baseMessage}\n${this.process?.getStderrSnapshot() ?? ''}`;
    if (/api[ _-]?key|credential|env_key|custom model/i.test(diagnosticText)) {
      return 'Kimi custom-model credentials are missing or invalid. Configure the model env_key in Kimi and provide that variable through the Kimi environment settings.';
    }
    if (/auth|log[ -]?in|token.*(?:expired|missing|invalid)|unauthorized/i.test(diagnosticText)) {
      return 'Kimi authentication failed or expired. Run `kimi login` in a terminal, then retry.';
    }
    return redactedBaseMessage;
  }

  private setReady(ready: boolean): void {
    if (this.ready === ready) return;
    this.ready = ready;
    for (const listener of this.readyListeners) listener(ready);
  }

  private isConversationCurrent(generation: number): boolean {
    return generation === this.conversationGeneration;
  }

  private isReadinessCurrent(
    lifecycleGeneration: number,
    conversationGeneration: number,
  ): boolean {
    return !this.disposed
      && lifecycleGeneration === this.lifecycleGeneration
      && this.isConversationCurrent(conversationGeneration);
  }
}

function createKimiToolStreamAdapter(): AcpToolStreamAdapter {
  return new AcpToolStreamAdapter({
    normalizeToolInput(rawName, input) {
      return normalizeKimiToolCall({ rawInput: input, title: rawName }).input;
    },
    normalizeToolName(rawName) {
      return normalizeKimiToolName(rawName ?? 'tool');
    },
    normalizeToolUseResult(rawName, _input, rawOutput, rawInput) {
      return {
        providerPayload: buildKimiToolProviderPayload({
          rawInput,
          rawName: rawName ?? 'tool',
          rawOutput,
        }),
      };
    },
    resolveRawToolName(currentRawName, update) {
      return resolveKimiRawToolName(currentRawName, update);
    },
  });
}

function wrapCancelableGenerator(
  iterator: AsyncGenerator<StreamChunk>,
  cancel: () => void,
): AsyncGenerator<StreamChunk> {
  const wrapped: AsyncGenerator<StreamChunk> = {
    next: iterator.next.bind(iterator),
    return(value) {
      cancel();
      return iterator.return(value);
    },
    throw(error) {
      cancel();
      return iterator.throw(error);
    },
    [Symbol.asyncIterator]() {
      return wrapped;
    },
    async [Symbol.asyncDispose]() {
      cancel();
      await iterator[Symbol.asyncDispose]();
    },
  };
  return wrapped;
}

function readKimiModelMetadata(metadata: AcpMetadata | null | undefined): Record<string, unknown> {
  if (!isRecord(metadata)) return {};
  return {
    ...normalizeKimiReasoningMetadata(metadata),
    agentType: readString(metadata.agentType),
    contextWindow: readNumber(metadata.totalContextTokens) ?? readNumber(metadata.contextWindow),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function normalizeOpaqueString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function isKimiTurnCompleted(update: unknown): boolean {
  return isRecord(update)
    && (update.sessionUpdate === 'turn_completed' || update.type === 'turn_completed');
}

function parseKimiTurnCompletedUsage(update: unknown): AcpUsage | null {
  if (!isKimiTurnCompleted(update) || !isRecord(update) || !isRecord(update.usage)) {
    return null;
  }
  return parseKimiUsageRecord(update.usage);
}

function parseKimiPromptResponseUsage(response: unknown): AcpUsage | null {
  if (!isRecord(response)) return null;
  const direct = parseKimiUsageRecord(response.usage);
  if (direct) return direct;
  if (!isRecord(response._meta)) return null;
  return parseKimiUsageRecord(response._meta)
    ?? parseKimiUsageRecord(response._meta.usage);
}

function parseKimiUsageRecord(value: unknown): AcpUsage | null {
  if (!isRecord(value)) return null;
  const inputTokens = readTokenCount(value.inputTokens);
  const outputTokens = readTokenCount(value.outputTokens);
  const totalTokens = readTokenCount(value.totalTokens);
  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) {
    return null;
  }
  const cachedReadTokens = readTokenCount(value.cachedReadTokens);
  const cachedWriteTokens = readTokenCount(value.cachedWriteTokens);
  const thoughtTokens = readTokenCount(value.reasoningTokens);
  return {
    ...(cachedReadTokens !== undefined ? { cachedReadTokens } : {}),
    ...(cachedWriteTokens !== undefined ? { cachedWriteTokens } : {}),
    inputTokens,
    outputTokens,
    ...(thoughtTokens !== undefined ? { thoughtTokens } : {}),
    totalTokens,
  };
}

function readTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function projectSavedProviderValue(
  settings: Record<string, unknown>,
  mapKey: string,
  targetKey: string,
): void {
  const projection = settings[mapKey];
  if (!isRecord(projection) || typeof projection.kimi !== 'string') return;
  settings[targetKey] = projection.kimi;
}

function resolveKimiBasePermissionMode(settings: Record<string, unknown>): 'normal' | 'yolo' {
  if (settings.permissionMode === 'yolo') return 'yolo';
  if (settings.permissionMode === 'plan') {
    return getKimiProviderSettings(settings).planBasePermissionMode;
  }
  return 'normal';
}

function redactDiagnostic(message: string): string {
  return message
    .replace(/\b(?:sk|moonshot)-[A-Za-z0-9_-]{8,}\b/gi, '<redacted>')
    .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(
      /(["']?\b(?:[A-Za-z_][A-Za-z0-9_-]*)?(?:api[_-]?key|token|secret|password)\b["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;}\]]+)/gi,
      (_match: string, prefix: string, value: string) => `${prefix}${redactAssignedValue(value)}`,
    );
}

function redactAssignedValue(value: string): string {
  const quote = value[0];
  return (quote === '"' || quote === "'") && value.at(-1) === quote
    ? `${quote}<redacted>${quote}`
    : '<redacted>';
}

function toError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
