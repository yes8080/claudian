import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import { getRuntimeEnvironmentVariables } from '../../../core/providers/providerEnvironment';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { ProviderTransitionOwnerContext } from '../../../core/providers/types';
import { getVaultPath } from '../../../utils/path';
import {
  resolveWindowsCmdShimSpawnSpec,
  terminateSpawnedProcess,
} from '../../../utils/windowsCmdShim';
import {
  type KimiDiscoveredModel,
  normalizeKimiDiscoveredModels,
} from '../models';
import { getKimiProviderSettings } from '../settings';
import { buildKimiRuntimeEnv } from './KimiRuntimeEnvironment';

const FINGERPRINT_VERSION = '1';
const MODEL_COMMAND_TIMEOUT_MS = 20_000;
const VERSION_COMMAND_TIMEOUT_MS = 5_000;
const MAX_STDOUT_BYTES = 512 * 1024;
const ANSI_ESCAPE_SEQUENCE = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  'g',
);

export interface KimiCatalogCommandRequest {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface KimiCatalogCommandResult {
  exitCode: number | null;
  stdout: string;
  termination?: 'abort' | 'error' | 'output-limit' | 'timeout';
}

export interface KimiCatalogCommandRunner {
  run(request: KimiCatalogCommandRequest): Promise<KimiCatalogCommandResult>;
}

export type KimiModelCatalogDiscoveryResult =
  | {
    defaultModelId: string | null;
    diagnostics?: string;
    fingerprint: string;
    kind: 'completed';
    models: KimiDiscoveredModel[];
  }
  | {
    kind: 'skipped';
    reason: 'provider-disabled';
  };

export interface KimiModelCatalogServiceLike {
  discoverCatalog(
    signal?: AbortSignal,
    context?: ProviderTransitionOwnerContext,
  ): Promise<KimiModelCatalogDiscoveryResult>;
  getCatalogFingerprint(
    signal?: AbortSignal,
    context?: ProviderTransitionOwnerContext,
  ): Promise<string>;
}

export interface KimiModelCatalogServiceOptions {
  modelCommandTimeoutMs?: number;
  runner?: KimiCatalogCommandRunner;
  versionCommandTimeoutMs?: number;
}

export interface KimiCatalogFingerprintInputs {
  command: string;
  environmentKeys: string[];
  version: string;
}

interface KimiResolvedCatalogCommandContext {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  environmentKeys: string[];
}

export function buildKimiCatalogFingerprint(inputs: KimiCatalogFingerprintInputs): string {
  const payload = [
    FINGERPRINT_VERSION,
    inputs.command.trim(),
    inputs.version.trim(),
    Array.from(new Set(inputs.environmentKeys.map(key => key.trim()).filter(Boolean))).sort(),
  ];
  return `${FINGERPRINT_VERSION}:${createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')}`;
}

export function parseKimiModelsOutput(output: string): {
  defaultModelId: string | null;
  models: KimiDiscoveredModel[];
} {
  const lines = stripAnsi(output).split(/\r?\n/);
  let defaultModelId: string | null = null;
  let inAvailableModels = false;
  const rawModels: Array<{ displayName: string; rawId: string }> = [];

  for (const line of lines) {
    const defaultMatch = line.match(/^\s*Default model:\s*(\S+)/i);
    if (defaultMatch) {
      defaultModelId = normalizeModelToken(defaultMatch[1]);
      continue;
    }

    if (/^\s*Available models:\s*$/i.test(line)) {
      inAvailableModels = true;
      continue;
    }
    if (!inAvailableModels || !line.trim()) {
      continue;
    }
    if (!/^\s/u.test(line)) {
      inAvailableModels = false;
      continue;
    }

    const modelLine = line.trim().replace(/^[-*]\s+/, '');
    const rawId = normalizeModelToken(modelLine.split(/\s+/)[0] ?? '');
    if (rawId) {
      rawModels.push({ displayName: rawId, rawId });
    }
  }

  return {
    defaultModelId,
    models: normalizeKimiDiscoveredModels(rawModels),
  };
}

export class KimiModelCatalogService implements KimiModelCatalogServiceLike {
  private readonly runner: KimiCatalogCommandRunner;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly options: KimiModelCatalogServiceOptions = {},
  ) {
    this.runner = options.runner ?? new SpawnKimiCatalogCommandRunner();
  }

  async getCatalogFingerprint(
    signal?: AbortSignal,
    ownerContext?: ProviderTransitionOwnerContext,
  ): Promise<string> {
    const context = await this.resolveCommandContext(ownerContext);
    return this.resolveFingerprint(context, signal);
  }

  async discoverCatalog(
    signal?: AbortSignal,
    ownerContext?: ProviderTransitionOwnerContext,
  ): Promise<KimiModelCatalogDiscoveryResult> {
    if (!getKimiProviderSettings(this.plugin.settings).enabled) {
      return { kind: 'skipped', reason: 'provider-disabled' };
    }

    try {
      const context = await this.resolveCommandContext(ownerContext);
      const fingerprint = await this.resolveFingerprint(context, signal);
      const commandResult = await this.runner.run({
        args: ['models'],
        command: context.command,
        cwd: context.cwd,
        env: context.env,
        signal,
        timeoutMs: this.options.modelCommandTimeoutMs ?? MODEL_COMMAND_TIMEOUT_MS,
      });
      const diagnostics = describeModelsCommandFailure(commandResult);
      if (diagnostics) {
        return {
          defaultModelId: null,
          diagnostics,
          fingerprint,
          kind: 'completed',
          models: [],
        };
      }

      const parsed = parseKimiModelsOutput(commandResult.stdout);
      if (parsed.models.length === 0) {
        return {
          ...parsed,
          diagnostics: 'Kimi models returned no available models',
          fingerprint,
          kind: 'completed',
        };
      }
      return { ...parsed, fingerprint, kind: 'completed' };
    } catch {
      return {
        defaultModelId: null,
        diagnostics: 'Kimi models could not be started',
        fingerprint: buildKimiCatalogFingerprint({
          command: '',
          environmentKeys: [],
          version: 'unavailable',
        }),
        kind: 'completed',
        models: [],
      };
    }
  }

  private async resolveCommandContext(
    ownerContext?: ProviderTransitionOwnerContext,
  ): Promise<KimiResolvedCatalogCommandContext> {
    const command = await this.plugin.getResolvedProviderCliPath(
      'kimi',
      ownerContext,
    ) ?? 'kimi';
    const configuredEnvironment = getRuntimeEnvironmentVariables(this.plugin.settings, 'kimi');
    return {
      command,
      cwd: getVaultPath(this.plugin.app) ?? process.cwd(),
      env: buildKimiRuntimeEnv(this.plugin.settings, command),
      environmentKeys: Object.keys(configuredEnvironment),
    };
  }

  private async resolveFingerprint(
    context: KimiResolvedCatalogCommandContext,
    signal?: AbortSignal,
  ): Promise<string> {
    let version = 'unavailable';
    try {
      const versionResult = await this.runner.run({
        args: ['--version'],
        command: context.command,
        cwd: context.cwd,
        env: context.env,
        signal,
        timeoutMs: this.options.versionCommandTimeoutMs ?? VERSION_COMMAND_TIMEOUT_MS,
      });
      if (versionResult.exitCode === 0 && !versionResult.termination) {
        version = versionResult.stdout.trim() || version;
      } else {
        version = `unavailable:${versionResult.termination ?? versionResult.exitCode ?? 'unknown'}`;
      }
    } catch {
      version = 'unavailable:error';
    }

    return buildKimiCatalogFingerprint({
      command: context.command,
      environmentKeys: context.environmentKeys,
      version,
    });
  }
}

export class SpawnKimiCatalogCommandRunner implements KimiCatalogCommandRunner {
  run(request: KimiCatalogCommandRequest): Promise<KimiCatalogCommandResult> {
    if (request.signal?.aborted) {
      return Promise.resolve({ exitCode: null, stdout: '', termination: 'abort' });
    }

    return new Promise((resolve) => {
      const spawnSpec = resolveWindowsCmdShimSpawnSpec(request);
      const proc = spawn(spawnSpec.command, spawnSpec.args, {
        cwd: request.cwd,
        env: request.env,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        ...(spawnSpec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
      const chunks: Buffer[] = [];
      let byteLength = 0;
      let settled = false;

      const finish = (result: KimiCatalogCommandResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timeout);
        request.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const terminate = (): void => {
        terminateSpawnedProcess(proc, 'SIGKILL', spawn, spawnSpec);
      };
      const onAbort = (): void => {
        terminate();
        finish({ exitCode: null, stdout: '', termination: 'abort' });
      };
      const timeout = window.setTimeout(() => {
        terminate();
        finish({ exitCode: null, stdout: '', termination: 'timeout' });
      }, request.timeoutMs);

      request.signal?.addEventListener('abort', onAbort, { once: true });
      proc.stdout.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteLength += buffer.byteLength;
        if (byteLength > MAX_STDOUT_BYTES) {
          terminate();
          finish({ exitCode: null, stdout: '', termination: 'output-limit' });
          return;
        }
        chunks.push(buffer);
      });
      proc.once('error', () => {
        finish({ exitCode: null, stdout: '', termination: 'error' });
      });
      proc.once('close', (exitCode) => {
        finish({ exitCode, stdout: Buffer.concat(chunks).toString('utf8') });
      });
    });
  }
}

function describeModelsCommandFailure(result: KimiCatalogCommandResult): string | null {
  switch (result.termination) {
    case 'abort':
      return 'Kimi models was cancelled';
    case 'error':
      return 'Kimi models could not be started';
    case 'output-limit':
      return 'Kimi models returned too much output';
    case 'timeout':
      return 'Kimi models timed out';
    default:
      return result.exitCode === 0
        ? null
        : `Kimi models exited with code ${result.exitCode ?? 'unknown'}`;
  }
}

function normalizeModelToken(value: string): string | null {
  const normalized = value.trim().replace(/,+$/u, '');
  return normalized
    && !normalized.endsWith(':')
    && /^[A-Za-z0-9@][A-Za-z0-9@._/+:-]*$/u.test(normalized)
    ? normalized
    : null;
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_SEQUENCE, '');
}
