import './bootstrap';

import { getChannelName, initBundleDrop, reportHealthy, setChannel } from './runtime/service';

export { getAvailableChannels, checkForUpdate, getInstalledBundleInfo, getObservabilityContext, getAvailableBundles } from './runtime/service';
export type { ObservabilityContext } from './runtime/service';
export type { AvailableBundlesPage, GetAvailableBundlesOptions } from './manager/updateCheck';
export {
  downloadUpdate,
  installBundle,
  getRuntimeUpdateState as getUpdateState,
  applyUpdate,
  setChannel,
  getChannelName,
  reportHealthy,
} from './runtime/service';
export { BundleDropError, isBundleDropError } from './errors';
export {
  getCurrentUserProperties,
  getUserProperties,
  setUserProperty,
  removeUserProperty,
  resetUserProperties,
} from './fs/userProperties';
export type { UserProperties, UserPropertyValue } from './fs/userProperties';

export type { BundleInfo } from './bundleInfo';
export type { UpdatePolicy } from './types';
export type { BundleListItem } from './api/types';
export type { BundleDropProjectConfig } from './loadConfig';
export type { BundleDropConfig } from './context';
export type { BundleDropInitOptions, BundleDropRuntimeConfig } from './runtime/initState';
export { getRuntimeDeliveryDiagnosticCounters } from './runtime-delivery/diagnostics';
export type {
  RuntimeDeliveryDiagnosticCounters,
  RuntimeDeliveryDiagnosticDetails,
  RuntimeDeliveryDiagnosticEvent,
  RuntimeDeliveryDiagnosticName,
} from './runtime-delivery/diagnostics';
export { useBundleDrop } from './useBundleDrop';
export type { UseBundleDropReturn } from './useBundleDrop';
export { bundleDropConfig } from './context';

/**
 * Top-level BundleDrop runtime controller.
 */
export const BundleDrop = {
  /** Initialize BundleDrop for the current app process. `enabled` defaults to `true` when omitted. */
  init: initBundleDrop,
  /** Change the active runtime channel used by singleton OTA actions. */
  setChannel,
  /** Read the currently active runtime channel. */
  getChannelName,
  /** Mark the currently running OTA candidate healthy for this device. */
  reportHealthy,
} as const;
