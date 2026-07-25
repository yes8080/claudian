import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { findCliBinaryPath, resolveConfiguredCliPath } from '../../../utils/cliBinaryLocator';
import { getHostnameKey, parseEnvironmentVariables } from '../../../utils/env';
import { getKimiProviderSettings } from '../settings';

export class KimiCliResolver {
  private readonly cachedHostname = getHostnameKey();
  private hasCachedResolution = false;
  private lastCliPath = '';
  private lastEnvironmentText = '';
  private lastHostnamePath = '';
  private resolvedPath: string | null = null;

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    const kimiSettings = getKimiProviderSettings(settings);
    const cliPath = kimiSettings.cliPath.trim();
    const hostnamePath = (kimiSettings.cliPathsByHost[this.cachedHostname] ?? '').trim();
    const environmentText = getRuntimeEnvironmentText(settings, 'kimi');

    if (
      this.hasCachedResolution
      && cliPath === this.lastCliPath
      && hostnamePath === this.lastHostnamePath
      && environmentText === this.lastEnvironmentText
    ) {
      return this.resolvedPath;
    }

    this.lastCliPath = cliPath;
    this.lastHostnamePath = hostnamePath;
    this.lastEnvironmentText = environmentText;
    this.resolvedPath = this.resolve(
      kimiSettings.cliPathsByHost,
      cliPath,
      environmentText,
    );
    this.hasCachedResolution = true;
    return this.resolvedPath;
  }

  resolve(
    hostnamePaths: Record<string, string> | undefined,
    legacyPath: string,
    environmentText: string,
  ): string | null {
    const hostnamePath = (hostnamePaths?.[this.cachedHostname] ?? '').trim();
    const customEnvironment = parseEnvironmentVariables(environmentText || '');
    return resolveConfiguredCliPath(hostnamePath)
      ?? resolveConfiguredCliPath(legacyPath.trim())
      ?? findCliBinaryPath('kimi', customEnvironment.PATH);
  }

  reset(): void {
    this.hasCachedResolution = false;
    this.lastCliPath = '';
    this.lastEnvironmentText = '';
    this.lastHostnamePath = '';
    this.resolvedPath = null;
  }
}
