import { defaultChannel } from '../context';
import type { UpdatePolicy } from '../types';
import type { RuntimeDeliveryDiagnosticEvent } from '../runtime-delivery/diagnostics';

export const BUNDLE_DROP_NOT_INITIALIZED_MESSAGE =
  'BundleDrop has not been initialized. Call BundleDrop.init({ environment, ... }) before using OTA APIs or useBundleDrop().';
export const BUNDLE_DROP_DISABLED_MESSAGE =
  'BundleDrop is disabled. OTA APIs are running in no-op mode because BundleDrop.init({ enabled: false, ... }) was used.';

/**
 * Runtime options for `BundleDrop.init(...)`.
 */
export type BundleDropInitOptions = {
  /** Customer app environment shown in analytics, for example `production`, `staging`, or `development`. */
  environment: string;
  /** Defaults to `true`. Set to `false` to keep BundleDrop configured but fully no-op for the current app process. */
  enabled?: boolean;
  /** Initial OTA channel for this app process. Defaults to the static `defaultChannel` from `bundle.drop.config.js`. */
  channelName?: string;
  /** Startup behavior after local state hydration. Defaults to `manual`. */
  policy?: UpdatePolicy;
  /** Optional listener for human-readable status messages emitted during checks, downloads, and apply flow. */
  onStatusUpdate?: (status: string) => void;
  /** Optional sink for structured runtime-delivery diagnostic counter events. */
  onRuntimeDeliveryDiagnostic?: (event: RuntimeDeliveryDiagnosticEvent) => void;
  /** When `true`, startup performs only a resolve/check and skips download/apply even if policy would normally do more. */
  checkOnly?: boolean;
};

/**
 * Resolved runtime configuration currently active inside the singleton service.
 */
export type BundleDropRuntimeConfig = {
  /** Customer app environment sent to BundleDrop analytics and resolve payloads. */
  environment: string;
  /** Whether BundleDrop is active or running in disabled no-op mode. */
  enabled: boolean;
  /** Current active OTA channel used by singleton update actions. */
  channelName: string;
  /** Effective startup policy after defaults are applied. */
  policy: UpdatePolicy;
  /** Optional listener receiving status messages from runtime actions. */
  onStatusUpdate?: (status: string) => void;
  /** Optional sink receiving structured runtime-delivery diagnostic counter events. */
  onRuntimeDeliveryDiagnostic?: (event: RuntimeDeliveryDiagnosticEvent) => void;
  /** Whether startup is limited to a resolve/check without downloading or applying. */
  checkOnly: boolean;
};

type BundleDropInitConfig = {
  environment: string;
  enabled: boolean;
  initialChannelName: string;
  policy: UpdatePolicy;
  onStatusUpdate?: (status: string) => void;
  onRuntimeDeliveryDiagnostic?: (event: RuntimeDeliveryDiagnosticEvent) => void;
  checkOnly: boolean;
};

let initConfig: BundleDropInitConfig | null = null;
let runtimeConfigKey: string | null = null;
let runtimeChannelName: string | null = null;
const warnedMessages = new Set<string>();

function warnOnce(message: string): void {
  if (warnedMessages.has(message)) {
    return;
  }

  warnedMessages.add(message);
  console.warn(message);
}

function normalizeRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`BundleDrop.init(...) requires a string ${fieldName}`);
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`BundleDrop.init(...) requires a non-empty ${fieldName}`);
  }

  return normalized;
}

function buildRuntimeConfigKey(config: BundleDropRuntimeConfig): string {
  return JSON.stringify({
    environment: config.environment,
    enabled: config.enabled,
    channelName: config.channelName,
    policy: config.policy,
    checkOnly: config.checkOnly,
  });
}

export function resolveBundleDropRuntimeConfig(
  options: BundleDropInitOptions,
): BundleDropRuntimeConfig {
  const environment = normalizeRequiredString(options.environment, 'environment');
  const channelName =
    typeof options.channelName === 'string' && options.channelName.trim()
      ? options.channelName.trim()
      : defaultChannel;

  return {
    environment,
    enabled: options.enabled !== false,
    channelName,
    policy: options.policy || 'manual',
    onStatusUpdate: options.onStatusUpdate,
    onRuntimeDeliveryDiagnostic: options.onRuntimeDeliveryDiagnostic,
    checkOnly: !!options.checkOnly,
  };
}

export function initializeBundleDropRuntime(options: BundleDropInitOptions): {
  config: BundleDropRuntimeConfig;
  alreadyInitialized: boolean;
} {
  const nextConfig = resolveBundleDropRuntimeConfig(options);
  const nextKey = buildRuntimeConfigKey(nextConfig);

  if (!initConfig) {
    initConfig = {
      environment: nextConfig.environment,
      enabled: nextConfig.enabled,
      initialChannelName: nextConfig.channelName,
      policy: nextConfig.policy,
      onStatusUpdate: nextConfig.onStatusUpdate,
      onRuntimeDeliveryDiagnostic: nextConfig.onRuntimeDeliveryDiagnostic,
      checkOnly: nextConfig.checkOnly,
    };
    runtimeConfigKey = nextKey;
    runtimeChannelName = nextConfig.channelName;
    return { config: nextConfig, alreadyInitialized: false };
  }

  if (runtimeConfigKey !== nextKey) {
    throw new Error(
      'BundleDrop.init(...) was called more than once with different runtime config. Keep the init config stable for the lifetime of the app process.',
    );
  }

  initConfig = {
    ...initConfig,
    onStatusUpdate: nextConfig.onStatusUpdate,
    onRuntimeDeliveryDiagnostic: nextConfig.onRuntimeDeliveryDiagnostic,
  };

  return { config: assertBundleDropInitialized(), alreadyInitialized: true };
}

export function getBundleDropRuntimeConfig(): BundleDropRuntimeConfig | null {
  if (!initConfig || !runtimeChannelName) {
    return null;
  }

  return {
    environment: initConfig.environment,
    enabled: initConfig.enabled,
    channelName: runtimeChannelName,
    policy: initConfig.policy,
    onStatusUpdate: initConfig.onStatusUpdate,
    onRuntimeDeliveryDiagnostic: initConfig.onRuntimeDeliveryDiagnostic,
    checkOnly: initConfig.checkOnly,
  };
}

export function getBundleDropRuntimeConfigOrWarn(): BundleDropRuntimeConfig | null {
  const runtimeConfig = getBundleDropRuntimeConfig();

  if (!runtimeConfig) {
    warnOnce(BUNDLE_DROP_NOT_INITIALIZED_MESSAGE);
    return null;
  }

  if (!runtimeConfig.enabled) {
    warnOnce(BUNDLE_DROP_DISABLED_MESSAGE);
  }

  return runtimeConfig;
}

export function assertBundleDropInitialized(): BundleDropRuntimeConfig {
  const runtimeConfig = getBundleDropRuntimeConfig();

  if (!runtimeConfig) {
    throw new Error(BUNDLE_DROP_NOT_INITIALIZED_MESSAGE);
  }

  return runtimeConfig;
}

export function hasBundleDropBeenInitialized(): boolean {
  return initConfig !== null;
}

export function setBundleDropChannel(channelName: string): BundleDropRuntimeConfig {
  const runtimeConfig = assertBundleDropInitialized();
  runtimeChannelName = normalizeRequiredString(channelName, 'channelName');
  return {
    ...runtimeConfig,
    channelName: runtimeChannelName,
  };
}

export function resetBundleDropRuntimeForTests(): void {
  initConfig = null;
  runtimeConfigKey = null;
  runtimeChannelName = null;
  warnedMessages.clear();
}
