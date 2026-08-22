import { isInstallPhaseError } from '../errors';

const CAPABILITY_HTTP_STATUS = /(?:^|\b)HTTP\s+(401|403)(?:\b|:)/i;

function readHttpStatus(error: unknown, depth = 0): number | undefined {
  if (depth > 5 || !error) return undefined;
  if (typeof error === 'string') {
    const match = CAPABILITY_HTTP_STATUS.exec(error);
    return match ? Number(match[1]) : undefined;
  }
  if (typeof error !== 'object') return undefined;

  const value = error as Record<string, unknown>;
  for (const candidate of [value.status, value.statusCode, value.httpStatus]) {
    if (candidate === 401 || candidate === 403) return candidate;
  }
  const messageStatus = readHttpStatus(value.message, depth + 1);
  if (messageStatus) return messageStatus;

  const nested = isInstallPhaseError(error)
    ? error.originalCause
    : value.cause ?? value.error ?? value.userInfo;
  return readHttpStatus(nested, depth + 1);
}

export function isArtifactCapabilityRejected(error: unknown): boolean {
  return isInstallPhaseError(error) &&
    error.phase === 'download' &&
    Boolean(readHttpStatus(error.originalCause));
}
