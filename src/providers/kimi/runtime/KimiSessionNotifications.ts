import type { AcpSessionNotification } from '../../acp';

export const KIMI_SESSION_UPDATE_NOTIFICATION_METHODS = [
  'kimi/session/update',
  '_kimi/session/update',
] as const;

export const KIMI_WRAPPED_SESSION_NOTIFICATION_METHOD = '_kimi/session_notification';

const KIMI_WRAPPED_SESSION_NOTIFICATION_NAME = 'kimi/session_notification';

export function parseKimiSessionNotification(
  method: string,
  params: unknown,
): AcpSessionNotification | null {
  if (KIMI_SESSION_UPDATE_NOTIFICATION_METHODS.some(candidate => candidate === method)) {
    return parseSessionNotification(params);
  }
  if (method !== KIMI_WRAPPED_SESSION_NOTIFICATION_METHOD || !isRecord(params)) {
    return null;
  }
  if (params.method !== KIMI_WRAPPED_SESSION_NOTIFICATION_NAME) {
    return null;
  }
  return parseSessionNotification(params.params);
}

function parseSessionNotification(value: unknown): AcpSessionNotification | null {
  if (!isRecord(value) || !isRecord(value.update)) {
    return null;
  }
  if (typeof value.sessionId !== 'string' || !value.sessionId.trim()) {
    return null;
  }
  return value as unknown as AcpSessionNotification;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
