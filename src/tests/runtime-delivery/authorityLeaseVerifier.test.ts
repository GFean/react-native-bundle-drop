jest.mock('../../native/fs', () => require('../mocks/native/fs'));

import {
  MAX_RUNTIME_DELIVERY_AUTHORITY_LEASE_MS,
  verifyRuntimeDeliveryAuthorityLease,
} from '../../runtime-delivery/authorityLeaseVerifier';
import type { RuntimeDeliveryJws } from '../../runtime-delivery/types';
import type { RuntimeDeliveryPublicKey } from '../../runtime-delivery/types';
import {
  mockVerifyEs256Signature,
  resetNativeFsMocks,
} from '../mocks/native/fs';

const PUBLIC_KEY = {
  kty: 'EC' as const,
  crv: 'P-256' as const,
  x: 'a'.repeat(43),
  y: 'b'.repeat(43),
};
const NOW = Date.parse('2026-08-19T00:00:10.000Z');

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const serialize = (
  payload: Record<string, unknown>,
  header: Record<string, unknown> = {
    alg: 'ES256',
    kid: 'lease-key',
    typ: 'bundledrop-authority-lease+jws',
  },
  overrides: Partial<RuntimeDeliveryJws> = {},
) => JSON.stringify({
  protected: encode(header),
  payload: encode(payload),
  signature: Buffer.alloc(64, 1).toString('base64url'),
  ...overrides,
});

const validPayload = (): Record<string, unknown> => ({
  schemaVersion: 1,
  type: 'publisher-lease',
  manifestOrigin: 'https://manifests.example.com',
  generatedAt: '2026-08-19T00:00:00.000Z',
  expiresAt: '2026-08-19T00:00:15.000Z',
});
const validV2Payload = (clientAuthority: 'enabled' | 'disabled'): Record<string, unknown> => ({
  ...validPayload(),
  schemaVersion: 2,
  clientAuthority,
});

describe('runtime-delivery/authorityLeaseVerifier', () => {
  beforeEach(() => {
    resetNativeFsMocks();
    mockVerifyEs256Signature.mockResolvedValue(true);
  });

  it('accepts a valid signed lease for the configured manifest origin', async () => {
    await expect(verifyRuntimeDeliveryAuthorityLease(
      serialize(validPayload()),
      'HTTPS://MANIFESTS.EXAMPLE.COM:443/',
      { 'lease-key': PUBLIC_KEY },
      NOW,
    )).resolves.toEqual(validPayload());
  });

  it('accepts enabled schema v2 leases and rejects a signed disabled lease', async () => {
    await expect(verifyRuntimeDeliveryAuthorityLease(
      serialize(validV2Payload('enabled')),
      'https://manifests.example.com',
      { 'lease-key': PUBLIC_KEY },
      NOW,
    )).resolves.toEqual(validV2Payload('enabled'));

    await expect(verifyRuntimeDeliveryAuthorityLease(
      serialize(validV2Payload('disabled')),
      'https://manifests.example.com',
      { 'lease-key': PUBLIC_KEY },
      NOW,
    )).rejects.toMatchObject({ code: 'authority_disabled' });
  });

  it('rejects malformed schema v2 authority states and schema mixing', async () => {
    for (const payload of [
      { ...validV2Payload('enabled'), clientAuthority: 'shadow' },
      { ...validPayload(), clientAuthority: 'enabled' },
      { ...validV2Payload('enabled'), extra: true },
    ]) {
      await expect(verifyRuntimeDeliveryAuthorityLease(
        serialize(payload),
        'https://manifests.example.com',
        { 'lease-key': PUBLIC_KEY },
        NOW,
      )).rejects.toMatchObject({ code: 'authority_invalid' });
    }
  });

  it('does not depend on a global URL implementation', async () => {
    const runtime = globalThis as unknown as { URL?: typeof URL };
    const originalUrl = runtime.URL;
    delete runtime.URL;

    try {
      expect(runtime.URL).toBeUndefined();
      await expect(verifyRuntimeDeliveryAuthorityLease(
        serialize(validPayload()),
        'https://manifests.example.com',
        { 'lease-key': PUBLIC_KEY },
        NOW,
      )).resolves.toEqual(validPayload());

      for (const manifestOrigin of [
        'https://manifests.example.com/runtime',
        'https://manifests.example.com%2fruntime',
        'https://user@manifests.example.com',
      ]) {
        await expect(verifyRuntimeDeliveryAuthorityLease(
          serialize({ ...validPayload(), manifestOrigin }),
          'https://manifests.example.com',
          { 'lease-key': PUBLIC_KEY },
          NOW,
        )).rejects.toMatchObject({ code: 'authority_origin_mismatch' });
      }
    } finally {
      runtime.URL = originalUrl;
    }
  });

  it.each([
    'http://manifests.example.com',
    'https://user@manifests.example.com',
    'https://user:password@manifests.example.com',
    'https://manifests.example.com/runtime',
    'https://manifests.example.com//',
    'https://manifests.example.com?environment=staging',
    'https://manifests.example.com#authority',
    'https://manifests.example.com\\evil.example.com',
    'https://manifests.example.com%2fruntime',
    'https://manifests.example.com%3fenvironment=staging',
    'https://manifests.example.com\u0000',
    'https://manifests.example.com:0',
    'https://manifests.example.com:65536',
    'https://manifests.example.com:abc',
    'https://:443',
    `https://${'a'.repeat(254)}`,
    'https://bad_host.example.com',
    'https://bad..example.com',
    `https://${'a'.repeat(64)}.example.com`,
    'https://-bad.example.com',
    'https://bad-.example.com',
    'https://127.0.0',
    'https://256.0.0.1',
    ' https://manifests.example.com',
    'https://manifests.example.com ',
  ])('rejects unsafe manifest origin %s', async manifestOrigin => {
    await expect(verifyRuntimeDeliveryAuthorityLease(
      serialize({ ...validPayload(), manifestOrigin }),
      'https://manifests.example.com',
      { 'lease-key': PUBLIC_KEY },
      NOW,
    )).rejects.toMatchObject({ code: 'authority_origin_mismatch' });
  });

  it('requires an exact host and non-default port while normalizing origin syntax', async () => {
    await expect(verifyRuntimeDeliveryAuthorityLease(
      serialize({
        ...validPayload(),
        manifestOrigin: 'HTTPS://MANIFESTS.EXAMPLE.COM:8443/',
      }),
      'https://manifests.example.com:8443',
      { 'lease-key': PUBLIC_KEY },
      NOW,
    )).resolves.toMatchObject({
      manifestOrigin: 'HTTPS://MANIFESTS.EXAMPLE.COM:8443/',
    });

    await expect(verifyRuntimeDeliveryAuthorityLease(
      serialize(validPayload()),
      'https://manifests.example.com.evil.example',
      { 'lease-key': PUBLIC_KEY },
      NOW,
    )).rejects.toMatchObject({ code: 'authority_origin_mismatch' });

    await expect(verifyRuntimeDeliveryAuthorityLease(
      serialize({
        ...validPayload(),
        manifestOrigin: 'https://manifests.example.com:8443',
      }),
      'https://manifests.example.com:9443',
      { 'lease-key': PUBLIC_KEY },
      NOW,
    )).rejects.toMatchObject({ code: 'authority_origin_mismatch' });
  });

  it('rejects expired, overlong, future-issued, and cross-origin leases', async () => {
    const verify = (payload: Record<string, unknown>, now = NOW) =>
      verifyRuntimeDeliveryAuthorityLease(
        serialize(payload),
        'https://manifests.example.com',
        { 'lease-key': PUBLIC_KEY },
        now,
      );

    await expect(verify(validPayload(), Date.parse('2026-08-19T00:00:15.000Z')))
      .rejects.toMatchObject({ code: 'authority_expired' });
    await expect(verify({
      ...validPayload(),
      expiresAt: new Date(
        Date.parse(String(validPayload().generatedAt)) +
          MAX_RUNTIME_DELIVERY_AUTHORITY_LEASE_MS + 1,
      ).toISOString(),
    })).rejects.toMatchObject({ code: 'authority_invalid' });
    await expect(verify({
      ...validPayload(),
      generatedAt: '2026-08-19T00:00:15.001Z',
      expiresAt: '2026-08-19T00:00:20.000Z',
    })).rejects.toMatchObject({ code: 'authority_invalid' });
    await expect(verify({
      ...validPayload(),
      manifestOrigin: 'https://other.example.com',
    })).rejects.toMatchObject({ code: 'authority_origin_mismatch' });
  });

  it('rejects malformed payloads, wrong JWS types, unknown keys, and bad signatures', async () => {
    const verify = (
      serialized: string,
      keys: Record<string, RuntimeDeliveryPublicKey> = { 'lease-key': PUBLIC_KEY },
    ) => verifyRuntimeDeliveryAuthorityLease(
      serialized,
      'https://manifests.example.com',
      keys,
      NOW,
    );

    await expect(verify(serialize({ ...validPayload(), extra: true })))
      .rejects.toMatchObject({ code: 'authority_invalid' });
    const malformedPayloadEnvelope = JSON.parse(serialize(validPayload())) as RuntimeDeliveryJws;
    malformedPayloadEnvelope.payload = Buffer.from('{', 'utf8').toString('base64url');
    await expect(verify(JSON.stringify(malformedPayloadEnvelope)))
      .rejects.toMatchObject({ code: 'authority_invalid' });
    await expect(verify(serialize({
      ...validPayload(),
      manifestOrigin: 'ftp://manifests.example.com/root',
    }))).rejects.toMatchObject({ code: 'authority_origin_mismatch' });
    await expect(verifyRuntimeDeliveryAuthorityLease(
      serialize(validPayload()),
      'not a URL',
      { 'lease-key': PUBLIC_KEY },
      NOW,
    )).rejects.toMatchObject({ code: 'authority_origin_mismatch' });
    await expect(verify(serialize(validPayload(), {
      alg: 'ES256',
      kid: 'lease-key',
      typ: 'bundledrop-manifest+jws',
    }))).rejects.toMatchObject({ code: 'authority_invalid' });
    await expect(verify(serialize(validPayload()), {}))
      .rejects.toMatchObject({ code: 'authority_unknown_key' });
    mockVerifyEs256Signature.mockResolvedValueOnce(false);
    await expect(verify(serialize(validPayload())))
      .rejects.toMatchObject({ code: 'authority_invalid_signature' });
  });
});
