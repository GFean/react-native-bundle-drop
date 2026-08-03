import type { BundleInfo } from '../bundleInfo';
import {
  readBundleInfo,
} from '../bundleInfo';
import type { BundleListItem, UpdateCheckResponse } from '../api/types';
import { BUNDLE_DROP_ROOT, config as projectConfig, defaultChannel } from '../context';
import { cleanOrphanedTempZips } from '../fs/fsUtils';
import {
  getDownloadedBundlePathNative,
  isBundleDropNativeAvailable,
  isExpoOtaStartupEnabledNative,
  restartReactNativeNative,
  setOtaEnabledNative,
} from '../native/bundleDropNative';
import { readCurrentBundlePointer } from '../fs/bundlePointer';
import type { DownloadUpdateResult } from '../manager/downloadAndInstall';
import {
  downloadUpdate as downloadUpdateInternal,
  installBundle as installBundleInternal,
} from '../manager/downloadAndInstall';
import {
  getAvailableBundles as getAvailableBundlesInternal,
  getAvailableChannels as getAvailableChannelsInternal,
  checkForUpdate as checkForUpdateInternal,
} from '../manager/updateCheck';
import {
  getRollbackPolicy,
  readRollbackState,
  reportActiveBundleHealthy,
  rollbackToPreviousIfNeeded,
  rollbackToPreviousOrNative,
} from '../manager/rollbackState';
import type { ApplyUpdateResult } from '../manager/updateState';
import {
  applyUpdate as applyUpdateInternal,
  getUpdateState as getUpdateStateInternal,
  reconcileAppliedBundleOnLaunch,
} from '../manager/updateState';
import type { AvailableBundlesPage, GetAvailableBundlesOptions } from '../manager/updateCheck';
import {
  assertBundleDropInitialized,
  getBundleDropRuntimeConfig,
  getBundleDropRuntimeConfigOrWarn,
  initializeBundleDropRuntime,
  setBundleDropChannel,
  type BundleDropInitOptions,
} from './initState';

const DEFAULT_STATUS = 'Click the button to check for updates';
const DISABLED_STATUS = 'BundleDrop is disabled';
const EXPO_DEVELOPMENT_FALLBACK_WARNING =
  '[BundleDrop] OTA startup is unavailable in this Expo runtime. ' +
  'Expo Go and standard Debug/development-client builds keep Metro priority, so OTA features are disabled. ' +
  'Use a non-Debug/Release native build to test Bundle Drop updates.';

type BundleDropRuntimeSnapshot = {
  status: string;
  isBusy: boolean;
  isEnabled: boolean;
  channelName: string;
  installedInfo: BundleInfo | null;
  pendingApply: boolean;
  hasBundle: boolean;
  availableChannels: string[];
};

type StatusHandler = (status: string) => void;
type DownloadAndStageResult = { result: DownloadUpdateResult; status?: string };
type ApplyAndRefreshResult = { result: ApplyUpdateResult; status?: string };
type CheckLatestResult = { response: UpdateCheckResponse | null; status?: string };
type LocalStartupState = {
  bundlePath: string | null;
  currentPointer: Awaited<ReturnType<typeof readCurrentBundlePointer>>;
  rollbackState: Awaited<ReturnType<typeof readRollbackState>>;
};

let updateFlowActive = false;
let startupPromise: Promise<void> | null = null;
let localStartupPromise: Promise<LocalStartupState> | null = null;
let healthTimer: ReturnType<typeof setTimeout> | null = null;
let runtimeRestartRequested = false;
let activeBundleInfoForObservability: BundleInfo | null = null;
let nativeOtaEnabledPromise: Promise<void> = Promise.resolve();
let hasWarnedAboutExpoDevelopmentFallback = false;
let snapshot: BundleDropRuntimeSnapshot = {
  status: DISABLED_STATUS,
  isBusy: false,
  isEnabled: false,
  channelName: defaultChannel,
  installedInfo: null,
  pendingApply: false,
  hasBundle: false,
  availableChannels: [],
};

const listeners = new Set<() => void>();

function emitChange() {
  listeners.forEach(listener => listener());
}

function patchSnapshot(partial: Partial<BundleDropRuntimeSnapshot>) {
  snapshot = {
    ...snapshot,
    ...partial,
  };
  emitChange();
}

function setDisabledSnapshot(channelName = snapshot.channelName) {
  patchSnapshot({
    status: DISABLED_STATUS,
    isBusy: false,
    isEnabled: false,
    channelName,
    installedInfo: null,
    pendingApply: false,
    hasBundle: false,
    availableChannels: [],
  });
}

function emitStatus(status: string, extraStatusHandler?: StatusHandler) {
  patchSnapshot({ status });
  getBundleDropRuntimeConfig()?.onStatusUpdate?.(status);
  extraStatusHandler?.(status);
}

function emitDisabledStatus(extraStatusHandler?: StatusHandler, channelName?: string): string {
  setDisabledSnapshot(channelName);
  getBundleDropRuntimeConfig()?.onStatusUpdate?.(DISABLED_STATUS);
  extraStatusHandler?.(DISABLED_STATUS);
  return DISABLED_STATUS;
}

function getConfiguredRuntime(extraStatusHandler?: StatusHandler) {
  const runtime = getBundleDropRuntimeConfigOrWarn();

  if (!runtime) {
    emitDisabledStatus(extraStatusHandler);
    return null;
  }

  return runtime;
}

function getEnabledRuntime(extraStatusHandler?: StatusHandler) {
  const runtime = getConfiguredRuntime(extraStatusHandler);

  if (!runtime?.enabled) {
    emitDisabledStatus(extraStatusHandler, runtime?.channelName);
    return null;
  }

  return runtime;
}

function isSameStatus(current: string | undefined, next: string | undefined): boolean {
  return !!current && current === next;
}

function getCheckStatus(response: UpdateCheckResponse | null): string {
  if (!response) return '⚠️ Unable to check for updates. Try again.';
  if (response.skippedFailedBundle) {
    return '✅ Current bundle retained; requested update previously failed on this device';
  }
  if (response.action === 'ROLLBACK') {
    if (!response.reason) {
      return '↩️ Rollback requested';
    }

    return `↩️ Rollback requested: ${response.reason}`;
  }
  if (response.incompatible) {
    return '⛔️ No compatible update for this binary';
  }
  if (response.action === 'NOOP') {
    return '✅ You have the latest version';
  }
  return response.bundleVersion
    ? `⬇️ Update available (v${response.bundleVersion})`
    : '⬇️ Update available';
}

function getDownloadStatus(result: DownloadUpdateResult): string | undefined {
  if (result.status === 'upToDate') {
    return result.skippedFailedBundle
      ? '✅ Current bundle retained; requested update previously failed on this device'
      : '✅ You have the latest version';
  }
  if (result.status === 'rollback') {
    if (!result.reason) {
      return '↩️ Rollback requested';
    }

    return `↩️ Rollback requested: ${result.reason}`;
  }
  if (result.status === 'incompatible') return '⛔️ No compatible update for this binary';
  return '✅ Update downloaded. Will apply on next launch or when you call applyUpdate.';
}

function getApplyStatus(result: ApplyUpdateResult): string | undefined {
  return result.status === 'applied'
    ? '✅ Update applied, reloading...'
    : result.status === 'noBundle'
      ? '⚠️ No downloaded bundle to apply'
      : result.status === 'blocked'
        ? '⚠️ Update previously failed on this device'
        : 'ℹ️ Bundle already applied';
}

function clearHealthTimer() {
  if (!healthTimer) return;
  clearTimeout(healthTimer);
  healthTimer = null;
}

function requestRuntimeRestart() {
  runtimeRestartRequested = true;
  restartReactNativeNative();
}

async function markActiveCandidateHealthy(expectedHash?: string): Promise<boolean> {
  if (runtimeRestartRequested) {
    return false;
  }

  const state = await getUpdateStateInternal();
  if (runtimeRestartRequested) {
    return false;
  }

  if (state.pendingApply) {
    return false;
  }

  const markedHealthy = await reportActiveBundleHealthy(undefined, expectedHash);
  if (markedHealthy) {
    await refreshState();
  }
  return markedHealthy;
}

function scheduleCandidateHealthMark(
  currentPointer: Awaited<ReturnType<typeof readCurrentBundlePointer>>,
  rollbackState: Awaited<ReturnType<typeof readRollbackState>>,
) {
  clearHealthTimer();

  const hash = currentPointer?.hash;
  const rollbackPolicy = getRollbackPolicy();
  if (!hash || rollbackPolicy.healthCheckMode === 'manual') return;
  if (rollbackState?.candidateHash !== hash || rollbackState.candidateCommitted === true) return;

  const delayMs = Math.max(0, rollbackPolicy.healthyAfterSec || 0) * 1000;
  healthTimer = setTimeout(() => {
    healthTimer = null;
    markActiveCandidateHealthy(hash).catch(error => {
      console.warn('⚠️ Failed to mark BundleDrop candidate healthy:', error);
    });
  }, delayMs);
}

async function refreshState(cached?: {
  bundleInfo?: BundleInfo | null;
  bundlePath?: string | null;
}) {
  const state = await getUpdateStateInternal(cached);
  patchSnapshot({
    installedInfo: state.info || null,
    pendingApply: state.pendingApply,
    hasBundle: state.hasBundle,
  });
  return state;
}

async function withBusy<T>(fn: () => Promise<T>): Promise<T> {
  if (updateFlowActive) {
    throw new Error('Another update flow is already in progress');
  }

  updateFlowActive = true;
  patchSnapshot({ isBusy: true });

  try {
    const result = await fn();
    await refreshState();
    return result;
  } finally {
    updateFlowActive = false;
    patchSnapshot({ isBusy: false });
  }
}

async function waitForStartupIfNeeded(): Promise<void> {
  await startupPromise;
}

async function waitForLocalStartupIfNeeded(): Promise<void> {
  try {
    await localStartupPromise;
  } catch {
    activeBundleInfoForObservability = null;
  }
}

async function runLocalStartupFlow(): Promise<LocalStartupState> {
  const [bundleInfo, bundlePath, currentPointer, rollbackState] = await Promise.all([
    readBundleInfo(),
    getDownloadedBundlePathNative(),
    readCurrentBundlePointer(),
    readRollbackState(),
  ]);

  await reconcileAppliedBundleOnLaunch({ bundleInfo, bundlePath });
  await refreshState({ bundleInfo, bundlePath });
  const state = await getUpdateStateInternal({ bundlePath });
  activeBundleInfoForObservability = state.hasBundle ? state.info || null : null;

  return {
    bundlePath,
    currentPointer,
    rollbackState,
  };
}

async function runStartupFlow() {
  const runtime = assertBundleDropInitialized();
  const statusCb: StatusHandler = status => emitStatus(status);

  void cleanOrphanedTempZips(`${BUNDLE_DROP_ROOT}/bundles`);

  localStartupPromise = (async () => {
    await nativeOtaEnabledPromise;
    return runLocalStartupFlow();
  })();
  const { bundlePath, currentPointer, rollbackState } = await localStartupPromise;

  const rollbackPolicy = getRollbackPolicy();
  const rollbackResult = await rollbackToPreviousIfNeeded(rollbackPolicy, {
    currentPointer,
    rollbackState,
  });

  if (rollbackResult.rolledBack) {
    clearHealthTimer();
    emitStatus('↩️ Rolled back to previous bundle');
    requestRuntimeRestart();
    return;
  }

  scheduleCandidateHealthMark(currentPointer, await readRollbackState());

  const pendingState = await refreshState({ bundlePath });

  if (pendingState.pendingApply) {
    if (runtime.policy === 'immediate') {
      emitStatus('♻️ Applying previously downloaded update...');
      const applied = await applyUpdateInternal(statusCb, () => {
        runtimeRestartRequested = true;
      });
      if (applied.status === 'applied') {
        return;
      }
    }

    if (runtime.policy === 'on-next-launch') {
      emitStatus('✅ Update downloaded; will apply on next launch.');
      return;
    }
  }

  if (runtime.policy === 'manual' && !runtime.checkOnly) {
    return;
  }

  const decision = await checkForUpdateInternal(runtime.channelName, statusCb);
  const finalStatus = getCheckStatus(decision);
  if (!isSameStatus(snapshot.status, finalStatus)) {
    emitStatus(finalStatus);
  }

  if (!decision) return;

  if (decision.action === 'ROLLBACK') {
    emitStatus('↩️ Server requested rollback...');
    await rollbackToPreviousOrNative();
    requestRuntimeRestart();
    return;
  }

  if (decision.action === 'NOOP' || runtime.policy === 'manual' || runtime.checkOnly) {
    return;
  }

  const downloadUrl = decision.mode === 'patch'
    ? decision.fallback?.downloadUrl
    : decision.downloadUrl;

  if (!downloadUrl || !decision.hash) {
    emitStatus('⚠️ Update available but missing download URL');
    return;
  }

  const resolvedTarget = {
    hash: decision.hash,
    downloadUrl,
    bundleVersion: decision.bundleVersion,
    version: decision.version,
    runtimeVersion: decision.runtimeVersion,
    manifestUrl: decision.manifestUrl,
    mode: decision.mode,
    baseHash: decision.baseHash,
    patchSet: decision.patchSet,
    fallback: decision.fallback,
  };

  const downloadResult = await downloadUpdateInternal(
    {
      channelName: runtime.channelName,
      resolvedTarget,
    },
    statusCb,
  );

  if (runtime.policy === 'on-next-launch') {
    if (downloadResult.status === 'staged') {
      emitStatus('✅ Update downloaded for next launch');
      return;
    }

    const nextStatus = getDownloadStatus(downloadResult);
    if (nextStatus) emitStatus(nextStatus);
    return;
  }

  if (downloadResult.status === 'staged') {
    await applyUpdateInternal(statusCb, () => {
      runtimeRestartRequested = true;
    });
    return;
  }

  const nextStatus = getDownloadStatus(downloadResult);
  if (nextStatus) emitStatus(nextStatus);
}

function ensureStartupFlow() {
  startupPromise = withBusy(async () => {
    await runStartupFlow();
  })
    .catch(error => {
      console.error('❌ BundleDrop startup failed:', error);
      emitStatus('⚠️ Failed to initialize BundleDrop');
    })
    .finally(() => {
      startupPromise = null;
    });

  return startupPromise;
}

/**
 * Initialize the singleton BundleDrop runtime for the current app process.
 *
 * Call this once during app startup, typically from `index.js`, before using
 * `useBundleDrop()` or any OTA runtime APIs.
 */
export function initBundleDrop(options: BundleDropInitOptions): void {
  const useExpoDevelopmentFallback =
    options.enabled !== false &&
    projectConfig.projectType === 'expo' &&
    (!isBundleDropNativeAvailable() || !isExpoOtaStartupEnabledNative());

  if (useExpoDevelopmentFallback && !hasWarnedAboutExpoDevelopmentFallback) {
    hasWarnedAboutExpoDevelopmentFallback = true;
    console.warn(EXPO_DEVELOPMENT_FALLBACK_WARNING);
  }

  const { alreadyInitialized, config } = initializeBundleDropRuntime(
    useExpoDevelopmentFallback ? { ...options, enabled: false } : options,
  );
  if (!alreadyInitialized) {
    runtimeRestartRequested = false;
    activeBundleInfoForObservability = null;
  }

  // Persist for the next cold start and for native path reads in this process.
  nativeOtaEnabledPromise = setOtaEnabledNative(config.enabled);

  patchSnapshot({
    channelName: config.channelName,
    isEnabled: config.enabled,
  });

  if (!config.enabled) {
    setDisabledSnapshot(config.channelName);
    return;
  }

  if (!alreadyInitialized) {
    patchSnapshot({ status: DEFAULT_STATUS });
    void ensureStartupFlow();
  }
}

/**
 * Change the active runtime channel used by singleton OTA actions such as checks,
 * downloads, and installs triggered through `useBundleDrop()` or named exports.
 */
export function setChannel(channelName: string): void {
  const runtime = getConfiguredRuntime();
  if (!runtime) {
    return;
  }

  if (updateFlowActive) {
    throw new Error('Another update flow is already in progress');
  }

  const nextRuntime = setBundleDropChannel(channelName);
  patchSnapshot({
    channelName: nextRuntime.channelName,
    isEnabled: nextRuntime.enabled,
    status: nextRuntime.enabled ? DEFAULT_STATUS : DISABLED_STATUS,
  });
}

/**
 * Read the current active runtime channel.
 */
export function getChannelName(): string {
  return getConfiguredRuntime()?.channelName ?? snapshot.channelName;
}

export function subscribeBundleDropState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getBundleDropSnapshot(): BundleDropRuntimeSnapshot {
  return snapshot;
}

export function isUpdateFlowActive(): boolean {
  return updateFlowActive;
}

/**
 * Resolve update metadata from the server without downloading anything.
 */
export async function checkLatest(extraStatusHandler?: StatusHandler): Promise<CheckLatestResult> {
  const runtime = getEnabledRuntime(extraStatusHandler);
  if (!runtime) {
    return { response: null, status: DISABLED_STATUS };
  }
  await waitForStartupIfNeeded();

  return withBusy(async () => {
    const response = await checkForUpdateInternal(runtime.channelName, status =>
      emitStatus(status, extraStatusHandler)
    );
    const status = getCheckStatus(response);
    if (!isSameStatus(snapshot.status, status)) {
      emitStatus(status, extraStatusHandler);
    }
    return { response, status };
  });
}

/**
 * Resolve, download, and stage the latest compatible update for the active runtime channel.
 */
export async function downloadAndStage(extraStatusHandler?: StatusHandler): Promise<DownloadAndStageResult> {
  const runtime = getEnabledRuntime(extraStatusHandler);
  if (!runtime) {
    return { result: { status: 'disabled' }, status: DISABLED_STATUS };
  }
  await waitForStartupIfNeeded();

  return withBusy(async () => {
    const result = await downloadUpdateInternal(
      { channelName: runtime.channelName },
      status => emitStatus(status, extraStatusHandler),
    );
    const status = getDownloadStatus(result);
    if (status) {
      emitStatus(status, extraStatusHandler);
    }
    return { result, status };
  });
}

/**
 * Apply a previously staged bundle immediately by restarting the React Native bridge.
 */
export async function applyDownloadedUpdate(
  extraStatusHandler?: StatusHandler,
): Promise<ApplyAndRefreshResult> {
  if (!getEnabledRuntime(extraStatusHandler)) {
    return { result: { status: 'disabled' }, status: DISABLED_STATUS };
  }
  await waitForStartupIfNeeded();
  await nativeOtaEnabledPromise;

  return withBusy(async () => {
    const result = await applyUpdateInternal(status => emitStatus(status, extraStatusHandler), () => {
      runtimeRestartRequested = true;
    });
    const status = getApplyStatus(result);
    if (status) {
      emitStatus(status, extraStatusHandler);
    }
    return { result, status };
  });
}

/**
 * Mark the currently running OTA candidate healthy for this device.
 */
export async function reportHealthy(): Promise<void> {
  const runtime = getEnabledRuntime();
  if (!runtime) {
    return;
  }
  await waitForStartupIfNeeded();
  if (runtimeRestartRequested || updateFlowActive) {
    return;
  }
  clearHealthTimer();
  await markActiveCandidateHealthy();
}

/**
 * Fetch the list of public channel names available for the configured project.
 */
export async function fetchAvailableChannels(): Promise<string[]> {
  if (!getEnabledRuntime()) {
    return [];
  }

  try {
    const availableChannels = await getAvailableChannelsInternal();
    patchSnapshot({ availableChannels });
    return availableChannels;
  } catch (error) {
    emitStatus('⚠️ Unable to fetch channels.');
    return [];
  }
}

/**
 * Fetch a paginated list of bundles for a channel. Defaults to the active runtime channel.
 */
export async function fetchAvailableBundles(
  options?: GetAvailableBundlesOptions,
): Promise<AvailableBundlesPage> {
  const runtime = getEnabledRuntime();
  if (!runtime) {
    return { items: [], nextCursor: null, hasMore: false };
  }

  try {
    return await getAvailableBundlesInternal({
      ...options,
      channelName: options?.channelName ?? runtime.channelName,
    });
  } catch (error) {
    emitStatus('⚠️ Unable to fetch bundles.');
    return { items: [], nextCursor: null, hasMore: false };
  }
}

/**
 * Download and stage a specific bundle returned by `fetchAvailableBundles()`.
 */
export async function installBundleFromListItem(
  bundle: BundleListItem,
): Promise<DownloadAndStageResult> {
  const runtime = getEnabledRuntime();
  if (!runtime) {
    return { result: { status: 'disabled' }, status: DISABLED_STATUS };
  }
  await waitForStartupIfNeeded();

  const downloadUrl = bundle.downloadUrl;
  if (!downloadUrl) {
    const status = '⚠️ Bundle is not downloadable (expired or unavailable)';
    emitStatus(status);
    return { result: { status: 'incompatible' }, status };
  }

  return withBusy(async () => {
    const resolvedDecision = await checkForUpdateInternal(runtime.channelName, emitStatus).catch(
      () => null,
    );
    const canUseResolvedTransport =
      resolvedDecision?.action === 'INSTALL' &&
      (resolvedDecision.bundleHash ?? resolvedDecision.hash) === bundle.hash;

    const result = canUseResolvedTransport
      ? await downloadUpdateInternal(
          {
            channelName: runtime.channelName,
            resolvedTarget: {
              hash: bundle.hash,
              downloadUrl:
                resolvedDecision.mode === 'patch'
                  ? resolvedDecision.fallback?.downloadUrl ?? downloadUrl
                  : resolvedDecision.downloadUrl ?? downloadUrl,
              bundleVersion: resolvedDecision.bundleVersion ?? bundle.bundleVersion,
              version: resolvedDecision.version ?? bundle.version,
              runtimeVersion: resolvedDecision.runtimeVersion ?? bundle.runtimeVersion,
              manifestUrl: resolvedDecision.manifestUrl,
              mode: resolvedDecision.mode,
              baseHash: resolvedDecision.baseHash,
              patchSet: resolvedDecision.patchSet,
              fallback: resolvedDecision.fallback,
            },
          },
          emitStatus,
        )
      : await installBundleInternal(
          bundle.hash,
          downloadUrl,
          bundle.bundleVersion,
          bundle.version,
          bundle.runtimeVersion,
          {
            channelName: runtime.channelName,
            onStatusUpdate: emitStatus,
          },
        );

    if (result.status === 'staged') {
      const status = `✅ v${bundle.bundleVersion} downloaded. Will apply on next launch or when you call applyUpdate.`;
      emitStatus(status);
      return { result, status };
    }

    const status = getDownloadStatus(result);
    if (status) emitStatus(status);
    return { result, status };
  });
}

/**
 * Read locally stored metadata for the currently downloaded or applied bundle.
 */
export async function getInstalledBundleInfo(): Promise<BundleInfo | null> {
  if (!getEnabledRuntime()) {
    return null;
  }
  const state = await refreshState();
  return state.info || null;
}

export type ObservabilityContext = {
  source: 'embedded' | 'ota';
  dist: string;
  tags: {
    bundle_drop_hash: string | null;
    bundle_drop_channel: string | null;
    bundle_drop_version: string | null;
    bundle_drop_runtime_version: string | null;
    bundle_drop_platform: string | null;
  };
  context: BundleInfo | null;
};

function getEmbeddedObservabilityContext(): ObservabilityContext {
  return {
    source: 'embedded',
    dist: 'embedded',
    tags: {
      bundle_drop_hash: null,
      bundle_drop_channel: null,
      bundle_drop_version: null,
      bundle_drop_runtime_version: null,
      bundle_drop_platform: null,
    },
    context: null,
  };
}

/**
 * Pre-formatted context for error tracking integrations.
 *
 * Returns `dist`, `tags`, and `context` shaped for direct use with
 * Sentry, Bugsnag, Datadog, or any provider. Handles the embedded
 * fallback automatically: when no OTA bundle is active, `source`
 * is `'embedded'` and `dist` is `'embedded'`.
 *
 * If the installed bundle has `pendingApply: true` it is not yet
 * executing, so the context falls back to `'embedded'`.
 */
export async function getObservabilityContext(): Promise<ObservabilityContext> {
  const runtime = getEnabledRuntime();
  if (!runtime) {
    return getEmbeddedObservabilityContext();
  }

  await waitForLocalStartupIfNeeded();
  const info = activeBundleInfoForObservability;

  if (!info || info.pendingApply || !info.hash) {
    return getEmbeddedObservabilityContext();
  }

  return {
    source: 'ota',
    dist: info.hash ?? 'embedded',
    tags: {
      bundle_drop_hash: info.hash ?? null,
      bundle_drop_channel: info.channelName ?? null,
      bundle_drop_version: info.bundleVersion != null ? `${info.bundleVersion}` : null,
      bundle_drop_runtime_version: info.runtimeVersion ?? null,
      bundle_drop_platform: info.platform ?? null,
    },
    context: info,
  };
}

/**
 * Read the current local update state from disk.
 */
export async function getRuntimeUpdateState() {
  if (!getEnabledRuntime()) {
    return {
      hasBundle: false,
      info: null,
      pendingApply: false,
    };
  }
  return refreshState();
}

/**
 * Named-export variant of `useBundleDrop().checkLatest()`.
 */
export async function checkForUpdate(onStatusUpdate?: StatusHandler): Promise<UpdateCheckResponse | null> {
  const { response } = await checkLatest(onStatusUpdate);
  return response;
}

/**
 * Named-export variant of `useBundleDrop().downloadUpdate()`.
 */
export async function downloadUpdate(
  onStatusUpdate?: StatusHandler,
): Promise<DownloadUpdateResult> {
  const { result } = await downloadAndStage(onStatusUpdate);
  return result;
}

/**
 * Named-export variant of `useBundleDrop().applyUpdate()`.
 */
export async function applyUpdate(onStatusUpdate?: StatusHandler): Promise<ApplyUpdateResult> {
  const { result } = await applyDownloadedUpdate(onStatusUpdate);
  return result;
}

/**
 * Named-export variant of `useBundleDrop().fetchAvailableChannels()`.
 */
export async function getAvailableChannels(): Promise<string[]> {
  return fetchAvailableChannels();
}

/**
 * Named-export variant of `useBundleDrop().fetchBundles()`.
 */
export async function getAvailableBundles(
  options?: GetAvailableBundlesOptions,
): Promise<AvailableBundlesPage> {
  return fetchAvailableBundles(options);
}

/**
 * Download and stage a specific bundle by hash and URL instead of browsing through `fetchBundles()`.
 */
export async function installBundle(
  hash: string,
  downloadUrl: string,
  bundleVersion?: number,
  version?: string,
  runtimeVersion?: string,
  onStatusUpdate?: StatusHandler,
): Promise<DownloadUpdateResult> {
  const runtime = getEnabledRuntime(onStatusUpdate);
  if (!runtime) {
    return { status: 'disabled' };
  }
  await waitForStartupIfNeeded();

  return withBusy(async () => {
    const result = await installBundleInternal(
      hash,
      downloadUrl,
      bundleVersion,
      version,
      runtimeVersion,
      {
        channelName: runtime.channelName,
        onStatusUpdate: status => emitStatus(status, onStatusUpdate),
      },
    );

    const status = getDownloadStatus(result);
    if (status) {
      emitStatus(status, onStatusUpdate);
    }

    return result;
  });
}

export function resetBundleDropRuntimeServiceForTests() {
  clearHealthTimer();
  updateFlowActive = false;
  startupPromise = null;
  localStartupPromise = null;
  activeBundleInfoForObservability = null;
  snapshot = {
    status: DISABLED_STATUS,
    isBusy: false,
    isEnabled: false,
    channelName: defaultChannel,
    installedInfo: null,
    pendingApply: false,
    hasBundle: false,
    availableChannels: [],
  };
  listeners.clear();
}

export async function waitForBundleDropStartupForTests(): Promise<void> {
  await startupPromise;
}
