jest.mock('../../context', () => require('../mocks/context'));

import { NativeModules } from 'react-native';

const mockVerifyRuntimeDeliveryManifest = jest.fn();
jest.mock('../../runtime-delivery/manifestVerifier', () => ({
  MAX_RUNTIME_MANIFEST_BYTES: 1024 * 1024,
  RuntimeDeliveryManifestError: class RuntimeDeliveryManifestError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      options?: { status?: number },
    ) {
      super(message);
      this.status = options?.status;
    }

    public readonly status?: number;
  },
  verifyRuntimeDeliveryManifest: (...args: unknown[]) => mockVerifyRuntimeDeliveryManifest(...args),
}));

const mockVerifyRuntimeDeliveryAuthorityLease = jest.fn();
jest.mock('../../runtime-delivery/authorityLeaseVerifier', () => ({
  verifyRuntimeDeliveryAuthorityLease: (...args: unknown[]) =>
    mockVerifyRuntimeDeliveryAuthorityLease(...args),
}));

const mockResolveRuntimeDeliveryLane = jest.fn();
jest.mock('../../runtime-delivery/localResolver', () => ({
  resolveRuntimeDeliveryLane: (...args: unknown[]) => mockResolveRuntimeDeliveryLane(...args),
}));

const mockReadVerifiedLaneState = jest.fn();
jest.mock('../../runtime-delivery/manifestState', () => ({
  readVerifiedLaneState: (...args: unknown[]) => mockReadVerifiedLaneState(...args),
}));

const mockReportActiveInstallWhenDue = jest.fn();
jest.mock('../../runtime-delivery/heartbeat', () => ({
  reportActiveInstallWhenDue: (...args: unknown[]) => mockReportActiveInstallWhenDue(...args),
}));

import {
  getRuntimeDeliveryDiagnosticCounters,
  resetRuntimeDeliveryDiagnosticsForTests,
} from '../../runtime-delivery/diagnostics';
import {
  RuntimeDeliveryManifestError,
  type RuntimeDeliveryManifestFailureCode,
} from '../../runtime-delivery/manifestVerifier';
import {
  fetchRuntimeDeliveryManifest,
  reportActiveInstall,
  resolveFromRuntimeDeliveryManifest,
  runtimeDeliveryAuthorityLeaseUrl,
  runtimeDeliveryManifestUrl,
  shouldRollbackFromLastKnownRevocations,
  type RuntimeDeliveryResolveContext,
} from '../../runtime-delivery/runtimeDelivery';
import type { RuntimeDeliveryLaneManifest } from '../../runtime-delivery/types';
import {
  resetContextMocks,
  setMockConfig,
  setMockRuntimeVersion,
} from '../mocks/context';
import {
  initializeBundleDropRuntime,
  resetBundleDropRuntimeForTests,
} from '../../runtime/initState';

const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function useReactNativeRuntime(): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { product: 'ReactNative' },
  });
}

function restoreNavigator(): void {
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor);
    return;
  }
  delete (globalThis as { navigator?: Navigator }).navigator;
}

const hash = (character: string) => character.repeat(64);
const identity = {
  projectSlug: 'bundle-drop-app',
  channelName: 'Production / β',
  platform: 'android',
  runtimeVersion: '1.0.0',
};
const context: RuntimeDeliveryResolveContext = {
  channelName: identity.channelName,
  currentHash: hash('0'),
  rejectedHashes: [hash('f')],
  installId: 'install-1',
  patchAlgorithms: ['xdelta3-vcdiff'],
  supportsContentAddressedAssets: true,
  environment: 'production',
  userProperties: { beta: true },
};
const manifest = {
  ...identity,
  schemaVersion: 3,
  type: 'lane',
  generation: 7,
  generatedAt: '2026-08-17T00:00:00.000Z',
  resolutionMode: 'local',
  publishingMode: 'automatic',
  rolloutAlgorithm: 'sha256-install-id-uint32be-mod100-v1',
  revokedHashes: [],
  releases: [],
  publishedRollouts: [],
  patchPolicy: { enabled: true, maxPatchToFullRatio: 0.7 },
  patchEdges: [],
  candidateSetComplete: true,
} satisfies RuntimeDeliveryLaneManifest;

const enableV2 = () => setMockConfig({
  runtimeDelivery: {
    mode: 'v2',
    manifestBaseUrl: 'https://cdn.example.com/root///',
    manifestAccessId: 'access/id',
    publicKeys: {
      key: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    },
  },
});

const authorityResponse = () => new Response('{"protected":"lease"}', {
  status: 200,
  headers: { 'content-length': '256' },
});

function mockManifestFetch(
  implementation: (url: string, options?: RequestInit) => Promise<Response>,
): jest.SpyInstance {
  return jest.spyOn(global, 'fetch').mockImplementation((input, options) => {
    const url = String(input);
    return url.includes('/v2/_authority/publisher-lease.json')
      ? Promise.resolve(authorityResponse()) as never
      : implementation(url, options) as never;
  });
}

describe('runtime-delivery/runtimeDelivery', () => {
  beforeEach(() => {
    resetContextMocks();
    jest.clearAllMocks();
    enableV2();
    mockReadVerifiedLaneState.mockResolvedValue(null);
    mockVerifyRuntimeDeliveryAuthorityLease.mockResolvedValue({
      schemaVersion: 1,
      type: 'publisher-lease',
      manifestOrigin: 'https://cdn.example.com/root',
      generatedAt: '2026-08-17T00:00:00.000Z',
      expiresAt: '2026-08-17T00:00:15.000Z',
    });
    resetRuntimeDeliveryDiagnosticsForTests();
    resetBundleDropRuntimeForTests();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    restoreNavigator();
    resetBundleDropRuntimeForTests();
  });

  it('constructs the opaque lane URL and rejects missing configuration', () => {
    expect(runtimeDeliveryManifestUrl(identity)).toBe(
      'https://cdn.example.com/root/v2/access%2Fid/lanes/UHJvZHVjdGlvbiAvIM6y/android/MS4wLjA/current.json',
    );
    expect(runtimeDeliveryAuthorityLeaseUrl()).toBe(
      'https://cdn.example.com/root/v2/_authority/publisher-lease.json',
    );
    setMockConfig({ runtimeDelivery: undefined });
    expect(() => runtimeDeliveryManifestUrl(identity)).toThrow('not configured');
    expect(() => runtimeDeliveryAuthorityLeaseUrl()).toThrow('not configured');
  });

  it('fetches and verifies a bounded manifest with the exact lane identity', async () => {
    const response = new Response('{"protected":"..."}', {
      status: 200,
      headers: { 'content-length': '512' },
    });
    mockManifestFetch(async () => response);
    mockVerifyRuntimeDeliveryManifest.mockResolvedValue(manifest);

    await expect(fetchRuntimeDeliveryManifest(identity.channelName)).resolves.toBe(manifest);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/lanes/UHJvZHVjdGlvbiAvIM6y/android/MS4wLjA/current.json'),
      expect.objectContaining({
        method: 'GET',
        headers: { Accept: 'application/jose+json, application/json' },
      }),
    );
    expect(mockVerifyRuntimeDeliveryManifest).toHaveBeenCalledWith(
      '{"protected":"..."}',
      identity,
      expect.objectContaining({ key: expect.any(Object) }),
    );
    expect(mockVerifyRuntimeDeliveryAuthorityLease).toHaveBeenCalledWith(
      '{"protected":"lease"}',
      'https://cdn.example.com/root///',
      expect.objectContaining({ key: expect.any(Object) }),
    );
    expect(getRuntimeDeliveryDiagnosticCounters().manifest_hit).toBe(1);
  });

  it('starts the authority-lease and lane-manifest requests in parallel', async () => {
    const starts: string[] = [];
    let releaseLease!: (response: Response) => void;
    let releaseManifest!: (response: Response) => void;
    jest.spyOn(global, 'fetch').mockImplementation(input => {
      const url = String(input);
      starts.push(url);
      return new Promise<Response>(resolve => {
        if (url.includes('/v2/_authority/')) releaseLease = resolve;
        else releaseManifest = resolve;
      }) as never;
    });
    mockVerifyRuntimeDeliveryManifest.mockResolvedValue(manifest);

    const request = fetchRuntimeDeliveryManifest(identity.channelName);
    await Promise.resolve();
    expect(starts).toHaveLength(2);
    expect(starts.some(url => url.includes('/v2/_authority/publisher-lease.json'))).toBe(true);
    expect(starts.some(url => url.includes('/current.json'))).toBe(true);

    releaseLease(authorityResponse());
    releaseManifest(new Response('{"protected":"manifest"}'));
    await expect(request).resolves.toBe(manifest);
  });

  it('fails closed on an invalid authority lease before persisting the manifest', async () => {
    mockManifestFetch(async () => new Response('{"protected":"manifest"}'));
    mockVerifyRuntimeDeliveryAuthorityLease.mockRejectedValueOnce(
      new RuntimeDeliveryManifestError('authority_expired', 'authority expired'),
    );

    await expect(fetchRuntimeDeliveryManifest(identity.channelName))
      .rejects.toThrow('authority expired');

    expect(mockVerifyRuntimeDeliveryManifest).not.toHaveBeenCalled();
    expect(getRuntimeDeliveryDiagnosticCounters().authority_lease_expired).toBe(1);
    expect(getRuntimeDeliveryDiagnosticCounters().manifest_hit).toBe(0);
  });

  it('reports a signed global authority disable separately before reading the manifest', async () => {
    mockManifestFetch(async () => new Response('{"protected":"manifest"}'));
    mockVerifyRuntimeDeliveryAuthorityLease.mockRejectedValueOnce(
      new RuntimeDeliveryManifestError('authority_disabled', 'authority disabled'),
    );

    await expect(fetchRuntimeDeliveryManifest(identity.channelName))
      .rejects.toThrow('authority disabled');
    expect(mockVerifyRuntimeDeliveryManifest).not.toHaveBeenCalled();
    expect(getRuntimeDeliveryDiagnosticCounters().authority_lease_disabled).toBe(1);
  });

  it('reports authority transport failures separately from manifest failures', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(input => Promise.resolve(
      String(input).includes('/v2/_authority/')
        ? new Response('unavailable', { status: 503 })
        : new Response('{"protected":"manifest"}'),
    ) as never);

    await expect(fetchRuntimeDeliveryManifest(identity.channelName)).rejects.toThrow('HTTP 503');

    expect(getRuntimeDeliveryDiagnosticCounters().authority_lease_http_error).toBe(1);
    expect(getRuntimeDeliveryDiagnosticCounters().manifest_http_error).toBe(0);
    expect(mockVerifyRuntimeDeliveryManifest).not.toHaveBeenCalled();
  });

  it('rejects disabled, identity-less, failed, and oversized manifest requests', async () => {
    setMockConfig({ runtimeDelivery: undefined });
    await expect(fetchRuntimeDeliveryManifest('General')).rejects.toThrow('not enabled');
    setMockConfig({
      runtimeDelivery: {
        mode: 'v1',
        manifestBaseUrl: 'https://cdn.example.com',
        manifestAccessId: 'id',
        publicKeys: {},
      },
    });
    await expect(fetchRuntimeDeliveryManifest('General')).rejects.toThrow('not enabled');

    enableV2();
    setMockRuntimeVersion(undefined);
    await expect(fetchRuntimeDeliveryManifest('General')).rejects.toThrow('Runtime version');
    setMockRuntimeVersion('1.0.0');

    const manifestFetch = jest.fn();
    mockManifestFetch((url, options) => manifestFetch(url, options));
    manifestFetch.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    await expect(fetchRuntimeDeliveryManifest('General')).rejects.toThrow('HTTP 503');

    manifestFetch.mockResolvedValueOnce(new Response('not-read', {
      status: 200,
      headers: { 'content-length': String(1024 * 1024 + 1) },
    }));
    await expect(fetchRuntimeDeliveryManifest('General')).rejects.toThrow('1 MB');
    expect(getRuntimeDeliveryDiagnosticCounters()).toEqual(expect.objectContaining({
      manifest_http_error: 1,
      manifest_too_large: 1,
    }));
  });

  it('enforces the byte limit while streaming chunked bodies and cancels immediately', async () => {
    const cancel = jest.fn().mockRejectedValue(new Error('synthetic cancel failure'));
    const releaseLock = jest.fn();
    const chunks = [
      new Uint8Array(700_000),
      new Uint8Array(400_000),
      new Uint8Array(64),
    ];
    const read = jest.fn()
      .mockResolvedValueOnce({ done: false, value: chunks[0] })
      .mockResolvedValueOnce({ done: false, value: chunks[1] })
      .mockResolvedValueOnce({ done: false, value: chunks[2] });
    mockManifestFetch(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    } as never));

    await expect(fetchRuntimeDeliveryManifest('General')).rejects.toThrow('1 MB');
    expect(read).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(mockVerifyRuntimeDeliveryManifest).not.toHaveBeenCalled();
    expect(getRuntimeDeliveryDiagnosticCounters().manifest_too_large).toBe(1);
  });

  it('aborts and cancels a declared oversized response before reading its body', async () => {
    const cancel = jest.fn().mockRejectedValue(new Error('synthetic cancel failure'));
    const read = jest.fn();
    const releaseLock = jest.fn();
    let signal: AbortSignal | null | undefined;
    mockManifestFetch(async (_url, options) => {
      signal = options?.signal;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': String(1024 * 1024 + 1) }),
        body: { getReader: () => ({ read, cancel, releaseLock }) },
      } as never;
    });

    await expect(fetchRuntimeDeliveryManifest('General')).rejects.toThrow('1 MB');

    expect(signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledWith('Runtime manifest exceeds the 1 MB safety limit');
    expect(read).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(getRuntimeDeliveryDiagnosticCounters().manifest_too_large).toBe(1);
  });

  it('fails closed when the fetch implementation cannot expose a response stream', async () => {
    mockManifestFetch(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: null,
      text: jest.fn(),
    } as never));

    await expect(fetchRuntimeDeliveryManifest('General')).rejects.toThrow('readable byte stream');
    expect(mockVerifyRuntimeDeliveryManifest).not.toHaveBeenCalled();
    expect(getRuntimeDeliveryDiagnosticCounters().manifest_stream_unavailable).toBe(1);
  });

  it('uses a bounded native download on React Native when fetch has no Response.body', async () => {
    useReactNativeRuntime();
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: null,
    } as never);
    const serialized = '{"protected":"native"}';
    NativeModules.BundleDrop.fsReadFile.mockResolvedValue(
      Buffer.from(serialized, 'utf8').toString('base64'),
    );
    NativeModules.BundleDrop.fsUnlink.mockRejectedValue(new Error('synthetic cleanup failure'));
    mockVerifyRuntimeDeliveryManifest.mockResolvedValue(manifest);

    await expect(fetchRuntimeDeliveryManifest(identity.channelName)).resolves.toBe(manifest);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(NativeModules.BundleDrop.fsDownloadFileBounded).toHaveBeenCalledTimes(2);
    expect(NativeModules.BundleDrop.fsDownloadFileBounded).toHaveBeenCalledWith(
      expect.stringContaining('/current.json'),
      expect.stringMatching(/^\/mock\/lib\/bundle-drop\/runtime-delivery\/manifest-.+\.jws$/),
      1024 * 1024,
      5000,
    );
    const manifestDownload = NativeModules.BundleDrop.fsDownloadFileBounded.mock.calls.find(
      ([url]: [string]) => url.includes('/current.json'),
    );
    const tempPath = manifestDownload?.[1];
    expect(NativeModules.BundleDrop.fsReadFile).toHaveBeenCalledWith(tempPath, 'base64');
    expect(NativeModules.BundleDrop.fsUnlink).toHaveBeenCalledWith(tempPath);
    expect(mockVerifyRuntimeDeliveryManifest).toHaveBeenCalledWith(
      serialized,
      identity,
      expect.objectContaining({ key: expect.any(Object) }),
    );
    expect(getRuntimeDeliveryDiagnosticCounters().manifest_hit).toBe(1);
  });

  it('maps native temp-file read failures to network errors and still cleans up', async () => {
    useReactNativeRuntime();
    NativeModules.BundleDrop.fsReadFile.mockImplementation((path: string) =>
      path.includes('authority-lease-')
        ? Promise.resolve(Buffer.from('lease', 'utf8').toString('base64'))
        : Promise.reject(new Error('read failed')),
    );

    const failure = await fetchRuntimeDeliveryManifest('General').catch(error => error);

    expect(failure).toMatchObject({ code: 'network_error' });
    expect(failure.message).toContain('body read failed');
    expect(NativeModules.BundleDrop.fsUnlink).toHaveBeenCalledTimes(2);
    expect(mockVerifyRuntimeDeliveryManifest).not.toHaveBeenCalled();
  });

  it('rejects malformed UTF-8 from a bounded native manifest and cleans up', async () => {
    useReactNativeRuntime();
    NativeModules.BundleDrop.fsReadFile.mockImplementation((path: string) => Promise.resolve(
      path.includes('authority-lease-')
        ? Buffer.from('lease', 'utf8').toString('base64')
        : Buffer.from([0xc2, 0x41]).toString('base64'),
      ),
    );

    const failure = await fetchRuntimeDeliveryManifest('General').catch(error => error);

    expect(failure).toMatchObject({ code: 'invalid_manifest' });
    expect(failure.message).toContain('valid UTF-8');
    expect(NativeModules.BundleDrop.fsUnlink).toHaveBeenCalledTimes(2);
    expect(mockVerifyRuntimeDeliveryManifest).not.toHaveBeenCalled();
  });

  it.each([
    ['ERR_DOWNLOAD_TOO_LARGE', 'Download exceeds 1 MB limit', 'body_too_large', '1 MB', 'manifest_too_large', undefined],
    ['ERR_DOWNLOAD_TIMEOUT', 'The request timed out', 'timeout', 'timed out', 'manifest_timeout', undefined],
    ['ERR_DOWNLOAD_HTTP', 'HTTP 503: Service Unavailable', 'http_error', 'HTTP 503', 'manifest_http_error', 503],
    ['ERR_DOWNLOAD_HTTP', 'HTTP request rejected', 'http_error', 'an HTTP error', 'manifest_http_error', undefined],
    ['ERR_DOWNLOAD_NETWORK', 'Connection reset', 'network_error', 'request failed', 'manifest_network_error', undefined],
  ] as const)(
    'maps the native %s failure without reading a partial manifest',
    async (code, message, expectedCode, expectedMessage, diagnosticName, status) => {
      useReactNativeRuntime();
      NativeModules.BundleDrop.fsDownloadFileBounded.mockImplementation((url: string) =>
        url.includes('/v2/_authority/')
          ? Promise.resolve(undefined)
          : Promise.reject(Object.assign(new Error(message), { code })),
      );
      NativeModules.BundleDrop.fsReadFile.mockResolvedValue(
        Buffer.from('lease', 'utf8').toString('base64'),
      );

      const failure = await fetchRuntimeDeliveryManifest('General').catch(error => error);

      expect(failure).toMatchObject({
        code: expectedCode,
        ...(status === undefined ? {} : { status }),
      });
      expect(failure.message).toContain(expectedMessage);
      expect(NativeModules.BundleDrop.fsReadFile).toHaveBeenCalledTimes(1);
      expect(NativeModules.BundleDrop.fsReadFile.mock.calls[0][0]).toContain(
        'authority-lease-',
      );
      expect(NativeModules.BundleDrop.fsUnlink).toHaveBeenCalledTimes(2);
      expect(getRuntimeDeliveryDiagnosticCounters()[diagnosticName]).toBe(1);
    },
  );

  it('maps an unstructured native rejection to the network failure fallback', async () => {
    useReactNativeRuntime();
    NativeModules.BundleDrop.fsDownloadFileBounded.mockImplementation((url: string) =>
      url.includes('/v2/_authority/') ? Promise.resolve(undefined) : Promise.reject({}),
    );
    NativeModules.BundleDrop.fsReadFile.mockResolvedValue(
      Buffer.from('lease', 'utf8').toString('base64'),
    );

    const failure = await fetchRuntimeDeliveryManifest('General').catch(error => error);

    expect(failure).toMatchObject({ code: 'network_error' });
    expect(failure.message).toContain('request failed');
    expect(NativeModules.BundleDrop.fsUnlink).toHaveBeenCalledTimes(2);
    expect(getRuntimeDeliveryDiagnosticCounters().manifest_network_error).toBe(1);
  });

  it('defensively rejects and cleans a native manifest that exceeds the bounded bridge contract', async () => {
    useReactNativeRuntime();
    NativeModules.BundleDrop.fsReadFile.mockImplementation((path: string) => Promise.resolve(
      path.includes('authority-lease-')
        ? Buffer.from('lease', 'utf8').toString('base64')
        : Buffer.alloc(1024 * 1024 + 1).toString('base64'),
      ),
    );

    await expect(fetchRuntimeDeliveryManifest('General')).rejects.toThrow('1 MB');

    expect(NativeModules.BundleDrop.fsUnlink).toHaveBeenCalledTimes(2);
    expect(mockVerifyRuntimeDeliveryManifest).not.toHaveBeenCalled();
    expect(getRuntimeDeliveryDiagnosticCounters().manifest_too_large).toBe(1);
  });

  it('rejects non-byte stream chunks and malformed streamed UTF-8', async () => {
    const manifestFetch = jest.fn();
    mockManifestFetch((url, options) => manifestFetch(url, options));
    manifestFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: jest.fn().mockResolvedValueOnce({ done: false, value: 'not bytes' }),
          releaseLock: jest.fn(),
        }),
      },
    } as never);
    await expect(fetchRuntimeDeliveryManifest('General')).rejects.toThrow('non-byte chunk');

    manifestFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: jest.fn()
            .mockResolvedValueOnce({ done: false, value: new Uint8Array([0xc2, 0x41]) })
            .mockResolvedValueOnce({ done: true }),
          releaseLock: jest.fn(),
        }),
      },
    } as never);
    await expect(fetchRuntimeDeliveryManifest('General')).rejects.toThrow('valid UTF-8');
    expect(getRuntimeDeliveryDiagnosticCounters().manifest_invalid).toBe(2);
    expect(mockVerifyRuntimeDeliveryManifest).not.toHaveBeenCalled();
  });

  it('aborts manifest requests that exceed the bounded fetch timeout', async () => {
    jest.useFakeTimers();
    mockManifestFetch((_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }) as never,
    );

    const request = fetchRuntimeDeliveryManifest('General');
    jest.advanceTimersByTime(5000);
    await expect(request).rejects.toThrow('timed out');
    expect(getRuntimeDeliveryDiagnosticCounters().manifest_timeout).toBe(1);
  });

  it('maps a reader rejection caused by the fetch deadline to a timeout', async () => {
    jest.useFakeTimers();
    const releaseLock = jest.fn();
    mockManifestFetch((_url, options) => Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: () => new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('aborted read')));
          }),
          releaseLock,
        }),
      },
    }) as never);

    const request = fetchRuntimeDeliveryManifest('General');
    await Promise.resolve();
    jest.advanceTimersByTime(5000);

    await expect(request).rejects.toThrow('timed out');
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(getRuntimeDeliveryDiagnosticCounters().manifest_timeout).toBe(1);
    expect(getRuntimeDeliveryDiagnosticCounters().manifest_network_error).toBe(0);
  });

  it.each([
    ['invalid_signature', 'invalid_signature'],
    ['unknown_key', 'unknown_key'],
    ['lane_mismatch', 'lane_mismatch'],
    ['generation_regression', 'generation_regression'],
    ['generation_equivocation', 'generation_equivocation'],
    ['invalid_manifest', 'manifest_invalid'],
    ['network_error', 'manifest_network_error'],
  ] as Array<[
    RuntimeDeliveryManifestFailureCode,
    keyof ReturnType<typeof getRuntimeDeliveryDiagnosticCounters>,
  ]>)('counts %s manifest failures as %s', async (failureCode, diagnosticName) => {
    mockManifestFetch(async () => new Response('{}'));
    mockVerifyRuntimeDeliveryManifest.mockRejectedValueOnce(
      new RuntimeDeliveryManifestError(failureCode, `failure: ${failureCode}`),
    );

    await expect(fetchRuntimeDeliveryManifest('General')).rejects.toThrow(`failure: ${failureCode}`);
    expect(getRuntimeDeliveryDiagnosticCounters()[diagnosticName]).toBe(1);
  });

  it('maps local NOOP, incompatibility, rollback, full, and patch decisions', async () => {
    mockResolveRuntimeDeliveryLane.mockResolvedValueOnce({ action: 'NOOP', reason: 'UP_TO_DATE' });
    await expect(resolveFromRuntimeDeliveryManifest(manifest, context)).resolves.toEqual(
      expect.objectContaining({ action: 'NOOP', upToDate: true, incompatible: undefined }),
    );

    mockResolveRuntimeDeliveryLane.mockResolvedValueOnce({
      action: 'NOOP',
      reason: 'NO_COMPATIBLE_BUNDLE',
    });
    await expect(resolveFromRuntimeDeliveryManifest(manifest, context)).resolves.toEqual(
      expect.objectContaining({
        action: 'NOOP',
        upToDate: false,
        incompatible: true,
        requestedRuntimeVersion: '1.0.0',
      }),
    );

    mockResolveRuntimeDeliveryLane.mockResolvedValueOnce({ action: 'ROLLBACK', reason: 'revoked' });
    await expect(resolveFromRuntimeDeliveryManifest(manifest, context)).resolves.toEqual({
      action: 'ROLLBACK',
      channelName: identity.channelName,
      reason: 'revoked',
      runtimeVersion: '1.0.0',
    });

    const target = {
      releaseRef: 'release-7',
      bundleHash: hash('a'),
      bundleVersion: 7,
      version: '1.0.7',
      runtimeVersion: '1.0.0',
      manifestHash: hash('b'),
      jsBundleHash: hash('c'),
      fullBundleHash: hash('d'),
      fullBundleSizeBytes: 1000,
      available: true,
    };
    mockResolveRuntimeDeliveryLane.mockResolvedValueOnce({ action: 'INSTALL', target, mode: 'full' });
    await expect(resolveFromRuntimeDeliveryManifest(manifest, context)).resolves.toEqual(
      expect.objectContaining({
        action: 'INSTALL',
        mode: 'full',
        baseHash: undefined,
        runtimeDelivery: expect.objectContaining({ selectedMode: 'full', patchArtifactRef: undefined }),
      }),
    );

    const patchEdge = {
      baseHash: hash('0'),
      targetHash: hash('a'),
      algorithm: 'xdelta3-vcdiff',
      patchSetHash: hash('e'),
      patchArtifactRef: 'patch-7',
      patchSizeBytes: 100,
      fullBundleSizeBytes: 1000,
      missingAssetsHash: hash('f'),
    };
    mockResolveRuntimeDeliveryLane.mockResolvedValueOnce({
      action: 'INSTALL', target, mode: 'patch', patchEdge,
    });
    await expect(resolveFromRuntimeDeliveryManifest(manifest, context)).resolves.toEqual(
      expect.objectContaining({
        mode: 'patch',
        baseHash: hash('0'),
        runtimeDelivery: expect.objectContaining({
          patchAlgorithm: 'xdelta3-vcdiff',
          patchArtifactRef: 'patch-7',
          missingAssetsHash: hash('f'),
        }),
      }),
    );
    expect(mockResolveRuntimeDeliveryLane).toHaveBeenCalledWith(manifest, expect.objectContaining({
      supportsContentAddressedAssets: true,
    }));
  });

  it('sends optional heartbeat context only when runtime identity is available', () => {
    reportActiveInstall(context);
    expect(mockReportActiveInstallWhenDue).toHaveBeenCalledWith('bundle-drop-app', {
      channelName: identity.channelName,
      platform: 'android',
      runtimeVersion: '1.0.0',
      installId: 'install-1',
      currentHash: hash('0'),
      environment: 'production',
      userProperties: { beta: true },
    });

    reportActiveInstall({ ...context, environment: null, userProperties: {} });
    expect(mockReportActiveInstallWhenDue).toHaveBeenLastCalledWith(
      'bundle-drop-app',
      expect.objectContaining({ environment: undefined, userProperties: undefined }),
    );
    setMockRuntimeVersion(undefined);
    reportActiveInstall(context);
    expect(mockReportActiveInstallWhenDue).toHaveBeenCalledTimes(2);
  });

  it('checks last-known revocations without treating absent identity or state as revoked', async () => {
    await expect(shouldRollbackFromLastKnownRevocations('General', null)).resolves.toBe(false);
    setMockRuntimeVersion(undefined);
    await expect(shouldRollbackFromLastKnownRevocations('General', hash('a'))).resolves.toBe(false);
    setMockRuntimeVersion('1.0.0');
    await expect(shouldRollbackFromLastKnownRevocations('General', hash('a'))).resolves.toBe(false);
    mockReadVerifiedLaneState.mockResolvedValueOnce({
      highestGeneration: 1,
      payloadSha256: hash('b'),
      revokedHashes: [hash('a')],
      verifiedAt: '2026-08-17T00:00:00.000Z',
    });
    await expect(shouldRollbackFromLastKnownRevocations('General', hash('a'))).resolves.toBe(true);
    mockReadVerifiedLaneState.mockResolvedValueOnce({
      highestGeneration: 1,
      payloadSha256: hash('b'),
      revokedHashes: [hash('c')],
      verifiedAt: '2026-08-17T00:00:00.000Z',
    });
    await expect(shouldRollbackFromLastKnownRevocations('General', hash('a'))).resolves.toBe(false);
  });

});
