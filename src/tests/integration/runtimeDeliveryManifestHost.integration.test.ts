jest.mock('../../context', () => require('../mocks/context'));
jest.mock('../../native/fs', () => require('../mocks/native/fs'));
jest.mock('../../native/bundleDropNative', () => require('../mocks/native/bundleDropNative'));
jest.mock('../../api/clientApi', () => require('../mocks/api/clientApi'));

import { checkForUpdate } from '../../manager/updateCheck';
import {
  getRuntimeDeliveryDiagnosticCounters,
  resetRuntimeDeliveryDiagnosticsForTests,
  type RuntimeDeliveryDiagnosticName,
} from '../../runtime-delivery/diagnostics';
import {
  mockPostOtaActiveInstallHeartbeat,
  mockPostOtaResolve,
} from '../mocks/api/clientApi';
import { resetBundleDropNativeMocks } from '../mocks/native/bundleDropNative';
import {
  resetContextMocks,
  setMockConfig,
  setMockPlatform,
} from '../mocks/context';
import {
  resetNativeFsMocks,
  setMockFile,
} from '../mocks/native/fs';
import { mockGetDownloadedBundlePathNative } from '../mocks/native/bundleDropNative';

const INSTALL_ID_PATH = '/mock/doc/bundle-drop/install-id.txt';
const validationWorker =
  'https://bundledrop-manifest-v2-nonprod-validation.george-fean.workers.dev';

type HostScenario = {
  name: string;
  manifestBaseUrl: string;
  expectedDiagnostic: RuntimeDeliveryDiagnosticName;
  minimumMs: number;
  maximumMs: number;
};

const scenarios: HostScenario[] = [
  {
    name: 'HTTP 503',
    manifestBaseUrl: `${validationWorker}/manifest-host/http-503`,
    expectedDiagnostic: 'manifest_http_error',
    minimumMs: 0,
    maximumMs: 3_000,
  },
  {
    name: 'chunked body over 1 MiB',
    manifestBaseUrl: `${validationWorker}/manifest-host/oversized`,
    expectedDiagnostic: 'manifest_too_large',
    minimumMs: 0,
    maximumMs: 5_000,
  },
  {
    name: 'request over five seconds',
    manifestBaseUrl: `${validationWorker}/manifest-host/slow`,
    expectedDiagnostic: 'manifest_timeout',
    minimumMs: 4_900,
    maximumMs: 7_000,
  },
  {
    name: 'DNS/network failure',
    manifestBaseUrl: 'https://does-not-exist-runtime-delivery.bundledrop.app',
    expectedDiagnostic: 'manifest_network_error',
    minimumMs: 0,
    maximumMs: 5_000,
  },
];

const describeLive = process.env.BUNDLE_DROP_RUNTIME_DELIVERY_LIVE_HOST_VALIDATION === 'true'
  ? describe
  : describe.skip;

describeLive('runtime-delivery non-production manifest-host failures', () => {
  jest.setTimeout(30_000);

  beforeEach(() => {
    resetContextMocks();
    resetNativeFsMocks();
    resetBundleDropNativeMocks();
    resetRuntimeDeliveryDiagnosticsForTests();
    setMockFile(INSTALL_ID_PATH, 'nonprod-validation-install');
    mockPostOtaActiveInstallHeartbeat.mockReset().mockResolvedValue({ data: undefined } as never);
    mockPostOtaResolve.mockReset().mockResolvedValue({
      data: { action: 'NOOP', reason: 'UP_TO_DATE' },
    } as never);
  });

  it.each(scenarios)(
    'falls back safely for $name',
    async ({ name, manifestBaseUrl, expectedDiagnostic, minimumMs, maximumMs }) => {
      setMockConfig({
        runtimeDelivery: {
          mode: 'v2',
          manifestBaseUrl,
          manifestAccessId: 'NonProdValidationAccess',
          publicKeys: {
            unused: {
              kty: 'EC',
              crv: 'P-256',
              x: 'A'.repeat(43),
              y: 'A'.repeat(43),
            },
          },
        },
      });

      const startedAt = Date.now();
      await expect(checkForUpdate('NonProd')).resolves.toEqual(expect.objectContaining({
        action: 'NOOP',
        reason: 'UP_TO_DATE',
      }));
      const elapsedMs = Date.now() - startedAt;
      const counters = getRuntimeDeliveryDiagnosticCounters();

      expect(elapsedMs).toBeGreaterThanOrEqual(minimumMs);
      expect(elapsedMs).toBeLessThan(maximumMs);
      expect(counters[expectedDiagnostic]).toBe(1);
      expect(counters.origin_fallback).toBe(1);
      expect(mockPostOtaResolve).toHaveBeenCalledTimes(1);
      console.log('[BundleDrop nonprod host validation]', JSON.stringify({
        name,
        elapsedMs,
        expectedDiagnostic,
        originFallbacks: counters.origin_fallback,
      }));
    },
  );

  it('verifies a real backend-signed manifest and applies its revocation locally', async () => {
    const publicKeysJson = process.env.BUNDLE_DROP_RUNTIME_DELIVERY_LIVE_PUBLIC_KEYS_JSON;
    if (!publicKeysJson) {
      throw new Error('BUNDLE_DROP_RUNTIME_DELIVERY_LIVE_PUBLIC_KEYS_JSON is required');
    }
    const revokedHash = 'f'.repeat(64);
    setMockPlatform('ios');
    setMockConfig({
      project: {
        name: 'Non-production validation',
        slug: 'nonprod-validation',
        apiKey: 'nonprod-validation-key',
      },
      runtimeDelivery: {
        mode: 'v2',
        manifestBaseUrl: 'https://manifests-v2-nonprod.bundledrop.app',
        manifestAccessId: 'NonProdValidation_c817c0ffee123456',
        publicKeys: JSON.parse(publicKeysJson),
      },
    });
    setMockFile('/mock/lib/bundle-drop/install-id.txt', 'nonprod-revocation-install');
    // bundlePointer.ts captures the test root when the module is loaded (Android by default).
    setMockFile('/mock/doc/bundle-drop/current.json', JSON.stringify({ hash: revokedHash }));
    mockGetDownloadedBundlePathNative.mockResolvedValue(
      `/mock/lib/bundle-drop/bundles/${revokedHash}/main.jsbundle`,
    );

    const startedAt = Date.now();
    await expect(checkForUpdate('NonProd')).resolves.toEqual(expect.objectContaining({
      action: 'ROLLBACK',
      reason: 'CURRENT_REVOKED_NO_COMPATIBLE_TARGET',
    }));
    const elapsedMs = Date.now() - startedAt;
    const counters = getRuntimeDeliveryDiagnosticCounters();

    expect(counters.manifest_hit).toBe(1);
    expect(counters.origin_fallback).toBe(0);
    expect(counters.invalid_signature).toBe(0);
    expect(counters.unknown_key).toBe(0);
    expect(mockPostOtaResolve).not.toHaveBeenCalled();
    console.log('[BundleDrop nonprod signed revocation validation]', JSON.stringify({
      elapsedMs,
      action: 'ROLLBACK',
      reason: 'CURRENT_REVOKED_NO_COMPATIBLE_TARGET',
      manifestHits: counters.manifest_hit,
      originFallbacks: counters.origin_fallback,
    }));
  });
});
