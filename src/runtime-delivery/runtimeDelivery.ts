import type { UpdateCheckResponse } from '../api/types';
import { config, platform, runtimeVersion } from '../context';
import type { UserProperties } from '../fs/userProperties';
import { isRuntimeDeliveryConfigured } from '../loadConfig';
import RNFS from '../native/fs';
import {
  decodeBase64UrlBytes,
  decodeUtf8Bytes,
  encodeBase64UrlUtf8,
} from './encoding';
import { verifyRuntimeDeliveryAuthorityLease } from './authorityLeaseVerifier';
import {
  recordRuntimeDeliveryDiagnostic,
  type RuntimeDeliveryDiagnosticName,
} from './diagnostics';
import { reportActiveInstallWhenDue } from './heartbeat';
import { resolveRuntimeDeliveryLane } from './localResolver';
import { readVerifiedLaneState } from './manifestState';
import {
  MAX_RUNTIME_MANIFEST_BYTES,
  RuntimeDeliveryManifestError,
  type RuntimeDeliveryManifestFailureCode,
  verifyRuntimeDeliveryManifest,
} from './manifestVerifier';
import type { RuntimeDeliveryLaneIdentity, RuntimeDeliveryLaneManifest } from './types';

export type RuntimeDeliveryResolveContext = {
  channelName: string;
  currentHash: string | null;
  rejectedHashes: string[];
  installId: string;
  patchAlgorithms: string[];
  supportsContentAddressedAssets: boolean;
  environment: string | null;
  userProperties: UserProperties;
};

const diagnosticNameByFailureCode: Record<
  RuntimeDeliveryManifestFailureCode,
  RuntimeDeliveryDiagnosticName
> = {
  body_too_large: 'manifest_too_large',
  http_error: 'manifest_http_error',
  network_error: 'manifest_network_error',
  timeout: 'manifest_timeout',
  stream_unavailable: 'manifest_stream_unavailable',
  invalid_manifest: 'manifest_invalid',
  invalid_signature: 'invalid_signature',
  unknown_key: 'unknown_key',
  lane_mismatch: 'lane_mismatch',
  generation_regression: 'generation_regression',
  generation_equivocation: 'generation_equivocation',
  authority_body_too_large: 'authority_lease_too_large',
  authority_http_error: 'authority_lease_http_error',
  authority_network_error: 'authority_lease_network_error',
  authority_timeout: 'authority_lease_timeout',
  authority_stream_unavailable: 'authority_lease_invalid',
  authority_invalid: 'authority_lease_invalid',
  authority_invalid_signature: 'authority_lease_invalid_signature',
  authority_unknown_key: 'authority_lease_unknown_key',
  authority_expired: 'authority_lease_expired',
  authority_origin_mismatch: 'authority_lease_origin_mismatch',
  authority_disabled: 'authority_lease_disabled',
};

const RUNTIME_MANIFEST_TIMEOUT_MS = 5000;
const RUNTIME_MANIFEST_TOO_LARGE_MESSAGE =
  'Runtime manifest exceeds the 1 MB safety limit';

function normalizeManifestError(
  error: unknown,
  fallbackCode: RuntimeDeliveryManifestFailureCode,
  fallbackMessage: string,
): RuntimeDeliveryManifestError {
  return error instanceof RuntimeDeliveryManifestError
    ? error
    : new RuntimeDeliveryManifestError(fallbackCode, fallbackMessage, { cause: error });
}

async function readBoundedManifestBody(
  response: Response,
  abortTransfer?: () => void,
): Promise<string> {
  const reader = response.body?.getReader?.();
  const rawContentLength = response.headers?.get?.('content-length');
  if (rawContentLength && /^\d+$/.test(rawContentLength)) {
    const contentLength = Number(rawContentLength);
    if (contentLength > MAX_RUNTIME_MANIFEST_BYTES) {
      abortTransfer?.();
      try {
        await reader?.cancel(RUNTIME_MANIFEST_TOO_LARGE_MESSAGE).catch(() => undefined);
      } finally {
        reader?.releaseLock?.();
      }
      throw new RuntimeDeliveryManifestError(
        'body_too_large',
        RUNTIME_MANIFEST_TOO_LARGE_MESSAGE,
      );
    }
  }

  if (!reader) {
    throw new RuntimeDeliveryManifestError(
      'stream_unavailable',
      'Runtime manifest response does not expose a readable byte stream',
    );
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new RuntimeDeliveryManifestError(
          'invalid_manifest',
          'Runtime manifest stream returned a non-byte chunk',
        );
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RUNTIME_MANIFEST_BYTES) {
        await reader.cancel(RUNTIME_MANIFEST_TOO_LARGE_MESSAGE).catch(() => undefined);
        throw new RuntimeDeliveryManifestError(
          'body_too_large',
          RUNTIME_MANIFEST_TOO_LARGE_MESSAGE,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return decodeUtf8Bytes(bytes);
  } catch (error) {
    throw new RuntimeDeliveryManifestError(
      'invalid_manifest',
      'Runtime manifest body is not valid UTF-8',
      { cause: error },
    );
  }
}

function isReactNativeRuntime(): boolean {
  return typeof navigator !== 'undefined' && navigator.product === 'ReactNative';
}

function nativeDownloadFailure(error: unknown): RuntimeDeliveryManifestError {
  const nativeError = error as { code?: unknown; message?: unknown };
  const code = typeof nativeError?.code === 'string' ? nativeError.code : '';
  const message = typeof nativeError?.message === 'string' ? nativeError.message : '';
  if (code === 'ERR_DOWNLOAD_TOO_LARGE') {
    return new RuntimeDeliveryManifestError(
      'body_too_large',
      RUNTIME_MANIFEST_TOO_LARGE_MESSAGE,
      { cause: error },
    );
  }
  if (code === 'ERR_DOWNLOAD_TIMEOUT') {
    return new RuntimeDeliveryManifestError(
      'timeout',
      'Runtime manifest request timed out',
      { cause: error },
    );
  }
  if (code === 'ERR_DOWNLOAD_HTTP') {
    const status = /^HTTP (\d{3})(?:\b|:)/.exec(message)?.[1];
    const numericStatus = status ? Number(status) : undefined;
    return new RuntimeDeliveryManifestError(
      'http_error',
      numericStatus === undefined
        ? 'Manifest request failed with an HTTP error'
        : `Manifest request failed with HTTP ${numericStatus}`,
      { cause: error, status: numericStatus },
    );
  }
  return new RuntimeDeliveryManifestError(
    'network_error',
    'Runtime manifest request failed',
    { cause: error },
  );
}

async function readBoundedManifestWithNativeDownload(
  url: string,
  artifactName: 'manifest' | 'authority-lease',
): Promise<string> {
  const tempPath = [
    RNFS.LibraryDirectoryPath,
    'bundle-drop',
    'runtime-delivery',
    `${artifactName}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.jws`,
  ].join('/');

  try {
    try {
      await RNFS.downloadFileBounded(
        url,
        tempPath,
        MAX_RUNTIME_MANIFEST_BYTES,
        RUNTIME_MANIFEST_TIMEOUT_MS,
      );
    } catch (error) {
      throw nativeDownloadFailure(error);
    }

    let encodedBody: string;
    try {
      encodedBody = await RNFS.readFile(tempPath, 'base64');
    } catch (error) {
      throw new RuntimeDeliveryManifestError(
        'network_error',
        'Runtime manifest body read failed',
        { cause: error },
      );
    }

    const bytes = decodeBase64UrlBytes(
      encodedBody.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    );
    if (bytes.length > MAX_RUNTIME_MANIFEST_BYTES) {
      throw new RuntimeDeliveryManifestError(
        'body_too_large',
        RUNTIME_MANIFEST_TOO_LARGE_MESSAGE,
      );
    }
    try {
      return decodeUtf8Bytes(bytes);
    } catch (error) {
      throw new RuntimeDeliveryManifestError(
        'invalid_manifest',
        'Runtime manifest body is not valid UTF-8',
        { cause: error },
      );
    }
  } finally {
    await RNFS.unlink(tempPath).catch(() => undefined);
  }
}

function mapAuthorityTransportError(error: unknown): RuntimeDeliveryManifestError {
  const normalized = normalizeManifestError(
    error,
    'network_error',
    'Runtime delivery authority lease request failed',
  );
  const code = {
    body_too_large: 'authority_body_too_large',
    http_error: 'authority_http_error',
    network_error: 'authority_network_error',
    timeout: 'authority_timeout',
    stream_unavailable: 'authority_stream_unavailable',
  }[normalized.code] as RuntimeDeliveryManifestFailureCode | undefined;
  return code
    ? new RuntimeDeliveryManifestError(code, normalized.message, {
      cause: normalized,
      status: normalized.status,
    })
    : normalized;
}

function recordManifestFailure(channelName: string, error: RuntimeDeliveryManifestError): void {
  recordRuntimeDeliveryDiagnostic(diagnosticNameByFailureCode[error.code], {
    channelName,
    reason: error.code,
    ...(error.status === undefined ? {} : { status: error.status }),
  });
}

function laneIdentity(channelName: string): RuntimeDeliveryLaneIdentity {
  if (!runtimeVersion) throw new Error('Runtime version is required for runtime delivery');
  return {
    projectSlug: config.project.slug,
    channelName,
    platform,
    runtimeVersion,
  };
}

export function runtimeDeliveryManifestUrl(identity: RuntimeDeliveryLaneIdentity): string {
  const delivery = config.runtimeDelivery;
  if (!delivery) throw new Error('Runtime delivery is not configured');
  const base = delivery.manifestBaseUrl.replace(/\/+$/, '');
  return [
    base,
    'v2',
    encodeURIComponent(delivery.manifestAccessId),
    'lanes',
    encodeBase64UrlUtf8(identity.channelName),
    encodeURIComponent(identity.platform),
    encodeBase64UrlUtf8(identity.runtimeVersion),
    'current.json',
  ].join('/');
}

export function runtimeDeliveryAuthorityLeaseUrl(): string {
  const delivery = config.runtimeDelivery;
  if (!delivery) throw new Error('Runtime delivery is not configured');
  return `${delivery.manifestBaseUrl.replace(/\/+$/, '')}/v2/_authority/publisher-lease.json`;
}

async function fetchBoundedJws(
  url: string,
  artifactName: 'manifest' | 'authority-lease',
  controller: AbortController | null,
): Promise<string> {
  if (isReactNativeRuntime()) {
    return readBoundedManifestWithNativeDownload(url, artifactName);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/jose+json, application/json' },
      signal: controller?.signal,
    });
  } catch (error) {
    throw new RuntimeDeliveryManifestError(
      controller?.signal.aborted ? 'timeout' : 'network_error',
      controller?.signal.aborted
        ? 'Runtime manifest request timed out'
        : 'Runtime manifest request failed',
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new RuntimeDeliveryManifestError(
      'http_error',
      `Manifest request failed with HTTP ${response.status}`,
      { status: response.status },
    );
  }
  try {
    return await readBoundedManifestBody(response, () => controller?.abort());
  } catch (error) {
    if (!(error instanceof RuntimeDeliveryManifestError) && controller?.signal.aborted) {
      throw new RuntimeDeliveryManifestError(
        'timeout',
        'Runtime manifest request timed out',
        { cause: error },
      );
    }
    throw normalizeManifestError(error, 'network_error', 'Runtime manifest body read failed');
  }
}

export async function fetchRuntimeDeliveryManifest(
  channelName: string,
): Promise<RuntimeDeliveryLaneManifest> {
  const delivery = config.runtimeDelivery;
  if (!isRuntimeDeliveryConfigured(delivery)) throw new Error('Runtime delivery is not enabled');
  const identity = laneIdentity(channelName);
  const manifestUrl = runtimeDeliveryManifestUrl(identity);
  const authorityLeaseUrl = runtimeDeliveryAuthorityLeaseUrl();
  const useNativeDownload = isReactNativeRuntime();
  const controller = !useNativeDownload && typeof AbortController !== 'undefined'
    ? new AbortController()
    : null;
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), RUNTIME_MANIFEST_TIMEOUT_MS)
    : null;
  try {
    try {
      const [leaseResult, manifestResult] = await Promise.allSettled([
        fetchBoundedJws(authorityLeaseUrl, 'authority-lease', controller),
        fetchBoundedJws(manifestUrl, 'manifest', controller),
      ]);
      if (leaseResult.status === 'rejected') {
        throw mapAuthorityTransportError(leaseResult.reason);
      }
      if (manifestResult.status === 'rejected') {
        throw manifestResult.reason;
      }

      await verifyRuntimeDeliveryAuthorityLease(
        leaseResult.value,
        delivery.manifestBaseUrl,
        delivery.publicKeys,
      );

      let manifest: RuntimeDeliveryLaneManifest;
      try {
        manifest = await verifyRuntimeDeliveryManifest(
          manifestResult.value,
          identity,
          delivery.publicKeys,
        );
      } catch (error) {
        throw normalizeManifestError(error, 'invalid_manifest', 'Runtime manifest validation failed');
      }
      recordRuntimeDeliveryDiagnostic('manifest_hit', { channelName });
      if (manifest.resolutionMode === 'dynamic') {
        recordRuntimeDeliveryDiagnostic('dynamic_manifest', {
          channelName,
          reason: manifest.dynamicReason,
        });
      }
      return manifest;
    } catch (error) {
      const manifestError = normalizeManifestError(
        error,
        'invalid_manifest',
        'Runtime manifest processing failed',
      );
      recordManifestFailure(channelName, manifestError);
      throw manifestError;
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function resolveFromRuntimeDeliveryManifest(
  manifest: RuntimeDeliveryLaneManifest,
  context: RuntimeDeliveryResolveContext,
): Promise<UpdateCheckResponse> {
  const decision = await resolveRuntimeDeliveryLane(manifest, {
    currentHash: context.currentHash,
    rejectedHashes: context.rejectedHashes,
    installId: context.installId,
    patchAlgorithms: context.patchAlgorithms,
    supportsContentAddressedAssets: context.supportsContentAddressedAssets,
  });
  if (decision.action === 'NOOP') {
    const incompatible = decision.reason === 'NO_COMPATIBLE_BUNDLE';
    return {
      action: 'NOOP',
      upToDate: decision.reason === 'UP_TO_DATE',
      channelName: context.channelName,
      reason: decision.reason,
      incompatible: incompatible || undefined,
      requestedRuntimeVersion: incompatible ? manifest.runtimeVersion : undefined,
      runtimeVersion: manifest.runtimeVersion,
    };
  }
  if (decision.action === 'ROLLBACK') {
    return {
      action: 'ROLLBACK',
      channelName: context.channelName,
      reason: decision.reason,
      runtimeVersion: manifest.runtimeVersion,
    };
  }
  return {
    action: 'INSTALL',
    upToDate: false,
    channelName: context.channelName,
    hash: decision.target.bundleHash,
    bundleHash: decision.target.bundleHash,
    bundleVersion: decision.target.bundleVersion,
    version: decision.target.version,
    runtimeVersion: decision.target.runtimeVersion,
    mode: decision.mode,
    baseHash: decision.patchEdge?.baseHash,
    runtimeDelivery: {
      generation: manifest.generation,
      targetReleaseRef: decision.target.releaseRef,
      selectedMode: decision.mode,
      baseHash: decision.patchEdge?.baseHash,
      patchAlgorithm: decision.patchEdge?.algorithm,
      patchSetHash: decision.patchEdge?.patchSetHash,
      patchArtifactRef: decision.patchEdge?.patchArtifactRef,
      missingAssetsHash: decision.patchEdge?.missingAssetsHash,
      manifestHash: decision.target.manifestHash,
      jsBundleHash: decision.target.jsBundleHash,
      fullBundleHash: decision.target.fullBundleHash,
    },
  };
}

export function reportActiveInstall(context: RuntimeDeliveryResolveContext): void {
  if (!runtimeVersion) return;
  reportActiveInstallWhenDue(config.project.slug, {
    channelName: context.channelName,
    platform,
    runtimeVersion,
    installId: context.installId,
    currentHash: context.currentHash,
    environment: context.environment || undefined,
    userProperties: Object.keys(context.userProperties).length ? context.userProperties : undefined,
  });
}

export async function shouldRollbackFromLastKnownRevocations(
  channelName: string,
  currentHash: string | null,
): Promise<boolean> {
  if (!currentHash || !runtimeVersion) return false;
  const state = await readVerifiedLaneState(laneIdentity(channelName));
  return !!state?.revokedHashes.includes(currentHash);
}
