import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  decodeKimiSessionCwd,
  encodeKimiSessionCwd,
  resolveKimiSessionCwd,
  resolveKimiSessionDirectory,
} from '@/providers/kimi/history/KimiHistoryPathResolver';

describe('KimiHistoryPathResolver', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = path.join(
      process.cwd(),
      'tests',
      '.scratch',
      `kimi-history-path-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    fs.mkdirSync(tempRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  });

  it('resolves default and custom homes using the percent-encoded cwd', () => {
    const vaultPath = path.join(tempRoot, 'vault');
    const sessionId = 'session-default';
    const defaultDirectory = path.join(
      tempRoot,
      '.kimi',
      'sessions',
      encodeKimiSessionCwd(vaultPath),
      sessionId,
    );
    fs.mkdirSync(defaultDirectory, { recursive: true });

    expect(resolveKimiSessionDirectory(undefined, sessionId, vaultPath, {
      environment: { HOME: tempRoot },
    })).toBe(defaultDirectory);

    const customHome = path.join(tempRoot, 'custom-kimi');
    const customDirectory = path.join(
      customHome,
      'sessions',
      encodeKimiSessionCwd(vaultPath),
      'session-custom',
    );
    fs.mkdirSync(customDirectory, { recursive: true });
    expect(resolveKimiSessionDirectory(undefined, 'session-custom', vaultPath, {
      environment: { KIMI_HOME: customHome, HOME: tempRoot },
    })).toBe(customDirectory);
  });

  it('round-trips an encoded source cwd and rejects non-canonical directory names', () => {
    const sourceCwd = path.join(tempRoot, 'previous vault');
    const encoded = encodeKimiSessionCwd(sourceCwd);

    expect(decodeKimiSessionCwd(encoded)).toBe(path.resolve(sourceCwd));
    expect(decodeKimiSessionCwd('not-an-absolute-path')).toBeNull();
    expect(decodeKimiSessionCwd('%E0%A4%A')).toBeNull();
  });

  it('resolves a hash-based Kimi session cwd from its metadata file', () => {
    const sourceCwd = path.join(tempRoot, 'a'.repeat(260), 'vault');
    const cwdDirectory = path.join(tempRoot, '.kimi', 'sessions', 'vault-0123456789abcdef');
    const sessionDirectory = path.join(cwdDirectory, 'session-hashed-cwd');
    fs.mkdirSync(sessionDirectory, { recursive: true });
    fs.writeFileSync(path.join(cwdDirectory, '.cwd'), sourceCwd);

    expect(resolveKimiSessionCwd(sessionDirectory)).toBe(path.resolve(sourceCwd));
  });

  it('never crosses from a configured home into the default home', () => {
    const vaultPath = path.join(tempRoot, 'vault');
    const sessionId = 'session-collision';
    const customHome = path.join(tempRoot, 'custom-kimi');
    const customDirectory = path.join(
      customHome,
      'sessions',
      encodeKimiSessionCwd(vaultPath),
      sessionId,
    );
    const defaultDirectory = path.join(
      tempRoot,
      '.kimi',
      'sessions',
      '%2Fprevious%2Fvault',
      sessionId,
    );
    fs.mkdirSync(customDirectory, { recursive: true });
    fs.mkdirSync(defaultDirectory, { recursive: true });
    const context = { environment: { KIMI_HOME: customHome, HOME: tempRoot } };

    expect(resolveKimiSessionDirectory(
      defaultDirectory,
      sessionId,
      vaultPath,
      context,
    )).toBe(customDirectory);

    fs.rmSync(customDirectory, { recursive: true });
    expect(resolveKimiSessionDirectory(
      defaultDirectory,
      sessionId,
      vaultPath,
      context,
    )).toBeNull();
  });

  it('uses the default home only when KIMI_HOME is absent or blank', () => {
    const vaultPath = path.join(tempRoot, 'vault');
    const sessionId = 'session-default-fallback';
    const defaultDirectory = path.join(
      tempRoot,
      '.kimi',
      'sessions',
      encodeKimiSessionCwd(vaultPath),
      sessionId,
    );
    fs.mkdirSync(defaultDirectory, { recursive: true });

    expect(resolveKimiSessionDirectory(undefined, sessionId, vaultPath, {
      environment: { HOME: tempRoot },
    })).toBe(defaultDirectory);
    expect(resolveKimiSessionDirectory(undefined, sessionId, vaultPath, {
      environment: { KIMI_HOME: '   ', HOME: tempRoot },
    })).toBe(defaultDirectory);
    expect(resolveKimiSessionDirectory(undefined, sessionId, vaultPath, {
      environment: { KIMI_HOME: 'relative-kimi-home', HOME: tempRoot },
    })).toBeNull();
  });

  it('repairs moved-vault paths through a bounded exact-id fallback', () => {
    const sessionId = 'session-moved';
    const movedDirectory = path.join(
      tempRoot,
      '.kimi',
      'sessions',
      '%2Fold%2Fvault',
      sessionId,
    );
    fs.mkdirSync(movedDirectory, { recursive: true });

    expect(resolveKimiSessionDirectory(
      path.join(tempRoot, 'outside', sessionId),
      sessionId,
      path.join(tempRoot, 'new-vault'),
      { environment: { HOME: tempRoot } },
    )).toBe(movedDirectory);
  });

  it('rejects traversal, outside-root hints, and mismatched ids', () => {
    const sessionsRoot = path.join(tempRoot, '.kimi', 'sessions');
    const valid = path.join(sessionsRoot, '%2Fvault', 'session-valid');
    fs.mkdirSync(valid, { recursive: true });

    expect(resolveKimiSessionDirectory(
      path.join(tempRoot, 'outside', 'session-valid'),
      '../session-valid',
      '/vault',
      { environment: { HOME: tempRoot } },
    )).toBeNull();
    expect(resolveKimiSessionDirectory(
      path.join(sessionsRoot, '%2Fvault', 'other-session'),
      'session-valid',
      '/missing-vault',
      { environment: { HOME: tempRoot } },
    )).toBe(valid);
  });

  it('rejects a session directory symlink that escapes the effective home', () => {
    if (process.platform === 'win32') return;

    const vaultPath = path.join(tempRoot, 'vault');
    const sessionId = 'session-symlink';
    const customHome = path.join(tempRoot, 'custom-kimi');
    const cwdDirectory = path.join(
      customHome,
      'sessions',
      encodeKimiSessionCwd(vaultPath),
    );
    const outsideDirectory = path.join(tempRoot, 'outside', sessionId);
    fs.mkdirSync(cwdDirectory, { recursive: true });
    fs.mkdirSync(outsideDirectory, { recursive: true });
    fs.symlinkSync(outsideDirectory, path.join(cwdDirectory, sessionId), 'dir');

    expect(resolveKimiSessionDirectory(undefined, sessionId, vaultPath, {
      environment: { KIMI_HOME: customHome, HOME: tempRoot },
    })).toBeNull();
  });
});
