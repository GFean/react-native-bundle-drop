import { decodeBase64UrlUtf8 } from './encoding';
import {
  RuntimeDeliveryManifestError,
  verifyRuntimeDeliverySignedPayload,
} from './manifestVerifier';
import {
  RUNTIME_DELIVERY_AUTHORITY_LEASE_JWS_TYPE,
  type RuntimeDeliveryAuthorityLease,
  type RuntimeDeliveryAuthorityLeaseV1,
  type RuntimeDeliveryPublicKey,
} from './types';

export const MAX_RUNTIME_DELIVERY_AUTHORITY_LEASE_MS = 15_000;
const MAX_CLOCK_SKEW_MS = 5_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function normalizeDnsOrIpv4Host(value: string): string | undefined {
  const host = value.toLowerCase();
  if (host.length > 253 || !/^[a-z0-9.-]+$/.test(host)) return undefined;

  const labels = host.split('.');
  if (labels.some(label =>
    !label ||
    label.length > 63 ||
    label.startsWith('-') ||
    label.endsWith('-')
  )) {
    return undefined;
  }

  if (labels.every(label => /^\d+$/.test(label))) {
    if (labels.length !== 4 || labels.some(label => Number(label) > 255)) return undefined;
  }
  return host;
}

function normalizeManifestOrigin(value: string): string | undefined {
  const match = /^https:\/\/([^/?#@]+)\/?$/i.exec(value);
  if (!match) return undefined;

  const authority = match[1];
  const authorityMatch = /^([^:]+)(?::(\d{1,5}))?$/.exec(authority);
  if (!authorityMatch) return undefined;

  const host = normalizeDnsOrIpv4Host(authorityMatch[1]);
  const port = authorityMatch[2] ? Number(authorityMatch[2]) : 443;
  if (!host || port < 1 || port > 65_535) return undefined;

  return `https://${host}${port === 443 ? '' : `:${port}`}`;
}

function authorityError(
  error: unknown,
  fallbackMessage: string,
): RuntimeDeliveryManifestError {
  if (error instanceof RuntimeDeliveryManifestError) {
    const mapped = {
      body_too_large: 'authority_body_too_large',
      invalid_signature: 'authority_invalid_signature',
      unknown_key: 'authority_unknown_key',
    }[error.code] as
      | 'authority_body_too_large'
      | 'authority_invalid_signature'
      | 'authority_unknown_key'
      | undefined;
    if (mapped) return new RuntimeDeliveryManifestError(mapped, error.message, { cause: error });
  }
  return new RuntimeDeliveryManifestError('authority_invalid', fallbackMessage, { cause: error });
}

export async function verifyRuntimeDeliveryAuthorityLease(
  serializedJws: string,
  expectedManifestOrigin: string,
  publicKeys: Record<string, RuntimeDeliveryPublicKey>,
  now = Date.now(),
): Promise<RuntimeDeliveryAuthorityLease | RuntimeDeliveryAuthorityLeaseV1> {
  let payloadValue: string;
  try {
    payloadValue = await verifyRuntimeDeliverySignedPayload(
      serializedJws,
      RUNTIME_DELIVERY_AUTHORITY_LEASE_JWS_TYPE,
      publicKeys,
    );
  } catch (error) {
    throw authorityError(error, 'Runtime delivery authority lease signature is invalid');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64UrlUtf8(payloadValue));
  } catch (error) {
    throw authorityError(error, 'Runtime delivery authority lease payload is invalid');
  }
  const schemaVersion = isRecord(payload) ? payload.schemaVersion : undefined;
  const expectedKeys = schemaVersion === 2
    ? ['clientAuthority', 'expiresAt', 'generatedAt', 'manifestOrigin', 'schemaVersion', 'type']
    : ['expiresAt', 'generatedAt', 'manifestOrigin', 'schemaVersion', 'type'];
  if (
    !isRecord(payload) ||
    Object.keys(payload).sort().join(',') !== expectedKeys.join(',') ||
    (payload.schemaVersion !== 1 && payload.schemaVersion !== 2) ||
    payload.type !== 'publisher-lease' ||
    typeof payload.manifestOrigin !== 'string' ||
    typeof payload.generatedAt !== 'string' ||
    typeof payload.expiresAt !== 'string' ||
    (payload.schemaVersion === 2 &&
      payload.clientAuthority !== 'enabled' &&
      payload.clientAuthority !== 'disabled')
  ) {
    throw new RuntimeDeliveryManifestError(
      'authority_invalid',
      'Runtime delivery authority lease payload is invalid',
    );
  }

  const manifestOrigin = normalizeManifestOrigin(payload.manifestOrigin);
  const expectedOrigin = normalizeManifestOrigin(expectedManifestOrigin);
  if (!manifestOrigin || !expectedOrigin || manifestOrigin !== expectedOrigin) {
    throw new RuntimeDeliveryManifestError(
      'authority_origin_mismatch',
      'Runtime delivery authority lease manifest origin mismatch',
    );
  }
  const generatedAt = Date.parse(payload.generatedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  if (
    !Number.isFinite(generatedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= generatedAt ||
    expiresAt - generatedAt > MAX_RUNTIME_DELIVERY_AUTHORITY_LEASE_MS ||
    generatedAt > now + MAX_CLOCK_SKEW_MS
  ) {
    throw new RuntimeDeliveryManifestError(
      'authority_invalid',
      'Runtime delivery authority lease validity window is invalid',
    );
  }
  if (expiresAt <= now) {
    throw new RuntimeDeliveryManifestError(
      'authority_expired',
      'Runtime delivery authority lease is expired',
    );
  }
  if (payload.schemaVersion === 2 && payload.clientAuthority === 'disabled') {
    throw new RuntimeDeliveryManifestError(
      'authority_disabled',
      'Runtime delivery client authority is disabled by the operator',
    );
  }
  return payload as RuntimeDeliveryAuthorityLease | RuntimeDeliveryAuthorityLeaseV1;
}
