import { useSyncExternalStore } from 'react';

import type { BundleInfo } from './bundleInfo';
import type { AvailableBundlesPage, GetAvailableBundlesOptions } from './manager/updateCheck';
import type { DownloadUpdateResult } from './manager/downloadAndInstall';
import type { ApplyUpdateResult } from './manager/updateState';
import type { UpdateCheckResponse, BundleListItem } from './api/types';
import { getBundleDropRuntimeConfigOrWarn } from './runtime/initState';
import {
  applyDownloadedUpdate,
  checkLatest,
  downloadAndStage,
  fetchAvailableBundles,
  fetchAvailableChannels,
  getBundleDropSnapshot,
  installBundleFromListItem,
  reportHealthy as reportRuntimeHealthy,
  setChannel as setRuntimeChannel,
  subscribeBundleDropState,
} from './runtime/service';

/**
 * Live BundleDrop runtime state plus UI-facing actions for manual OTA flows.
 */
export type UseBundleDropReturn = {
  /** Last human-readable status message (downloads, checks, applies). */
  status: string;
  /** Whether BundleDrop is active for this runtime. */
  isEnabled: boolean;
  /** True while any bundle-drop action is running; use to disable UI. */
  isBusy: boolean;
  /** Active runtime channel used by singleton OTA actions. */
  channelName: string;
  /** Locally stored bundle metadata (bundleVersion, hash, etc.), if any. */
  installedInfo: BundleInfo | null;
  /** True when a downloaded bundle is waiting to be applied. */
  pendingApply: boolean;
  /** True when a bundle file exists on disk (downloaded). */
  hasBundle: boolean;
  /** Check server for updates; updates status only. */
  checkLatest: () => Promise<{ response: UpdateCheckResponse | null; status?: string }>;
  /** Download and stage update (will apply on next launch or when applyUpdate is called). */
  downloadUpdate: () => Promise<{ result: DownloadUpdateResult; status?: string }>;
  /** Apply a staged update (reload). */
  applyUpdate: () => Promise<{ result: ApplyUpdateResult; status?: string }>;
  /** Mark the current OTA candidate healthy for this device. */
  reportHealthy: () => Promise<void>;
  /** Fetch available channel names from the server (API key auth). */
  fetchAvailableChannels: () => Promise<string[]>;
  /** Last fetched list of channel names. */
  availableChannels: string[];
  /** Update the active runtime channel for singleton OTA actions. */
  setChannel: (channelName: string) => void;
  /** Fetch a paginated list of downloadable bundles for a channel. */
  fetchBundles: (options?: GetAvailableBundlesOptions) => Promise<AvailableBundlesPage>;
  /** Download and stage a specific bundle by its metadata from fetchBundles. */
  installBundle: (bundle: BundleListItem) => Promise<{ result: DownloadUpdateResult; status?: string }>;
};

/**
 * React hook for subscribing to the singleton BundleDrop runtime.
 *
 * It is safe to call even before `BundleDrop.init(...)` runs. In that case the hook
 * warns once and exposes a disabled no-op snapshot until runtime init happens.
 */
export function useBundleDrop(): UseBundleDropReturn {
  getBundleDropRuntimeConfigOrWarn();
  const state = useSyncExternalStore(
    subscribeBundleDropState,
    getBundleDropSnapshot,
    getBundleDropSnapshot,
  );

  return {
    status: state.status,
    isEnabled: state.isEnabled,
    isBusy: state.isBusy,
    channelName: state.channelName,
    installedInfo: state.installedInfo as BundleInfo | null,
    pendingApply: state.pendingApply,
    hasBundle: state.hasBundle,
    checkLatest,
    downloadUpdate: downloadAndStage,
    applyUpdate: applyDownloadedUpdate,
    reportHealthy: reportRuntimeHealthy,
    fetchAvailableChannels,
    availableChannels: state.availableChannels,
    setChannel: setRuntimeChannel,
    fetchBundles: fetchAvailableBundles,
    installBundle: installBundleFromListItem,
  };
}
