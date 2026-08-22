import { getBundleDropRuntimeConfig } from '../runtime/initState';

export const RUNTIME_DELIVERY_DIAGNOSTIC_NAMES = [
  'manifest_hit',
  'dynamic_manifest',
  'origin_fallback',
  'invalid_signature',
  'unknown_key',
  'lane_mismatch',
  'generation_regression',
  'generation_equivocation',
  'manifest_http_error',
  'manifest_network_error',
  'manifest_timeout',
  'manifest_too_large',
  'manifest_invalid',
  'manifest_stream_unavailable',
  'authority_lease_http_error',
  'authority_lease_network_error',
  'authority_lease_timeout',
  'authority_lease_too_large',
  'authority_lease_invalid',
  'authority_lease_invalid_signature',
  'authority_lease_unknown_key',
  'authority_lease_expired',
  'authority_lease_origin_mismatch',
  'authority_lease_disabled',
] as const;

export type RuntimeDeliveryDiagnosticName = typeof RUNTIME_DELIVERY_DIAGNOSTIC_NAMES[number];

export type RuntimeDeliveryDiagnosticDetails = {
  channelName?: string;
  reason?: string;
  status?: number;
};

export type RuntimeDeliveryDiagnosticEvent = {
  name: RuntimeDeliveryDiagnosticName;
  count: number;
  timestamp: string;
  details?: RuntimeDeliveryDiagnosticDetails;
};

export type RuntimeDeliveryDiagnosticCounters = Record<RuntimeDeliveryDiagnosticName, number>;

const counters = Object.fromEntries(
  RUNTIME_DELIVERY_DIAGNOSTIC_NAMES.map(name => [name, 0]),
) as RuntimeDeliveryDiagnosticCounters;

export function recordRuntimeDeliveryDiagnostic(
  name: RuntimeDeliveryDiagnosticName,
  details?: RuntimeDeliveryDiagnosticDetails,
): void {
  counters[name] += 1;
  const listener = getBundleDropRuntimeConfig()?.onRuntimeDeliveryDiagnostic;
  if (!listener) return;

  try {
    listener({
      name,
      count: counters[name],
      timestamp: new Date().toISOString(),
      ...(details ? { details } : {}),
    });
  } catch (error) {
    console.warn('[BundleDrop] runtime-delivery diagnostic listener failed:', error);
  }
}

export function getRuntimeDeliveryDiagnosticCounters(): RuntimeDeliveryDiagnosticCounters {
  return { ...counters };
}

export function resetRuntimeDeliveryDiagnosticsForTests(): void {
  for (const name of RUNTIME_DELIVERY_DIAGNOSTIC_NAMES) counters[name] = 0;
}
