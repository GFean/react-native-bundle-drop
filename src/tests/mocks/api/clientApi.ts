import type { AxiosResponse } from 'axios';

import type {
  BundleListResponse,
  OtaResolveResponse,
  OtaResolveRequest,
  PublicChannelsParams,
  ReportInstalledPayload,
  ReportPatchApplyFailurePayload,
  ReportLocalRollbackPayload,
  BundleListParams,
  OtaArtifactAuthorizationRequest,
  OtaActiveInstallHeartbeat,
} from '../../../api/types';

export const mockPostOtaResolve = jest.fn<
  Promise<AxiosResponse<OtaResolveResponse>>,
  [string, OtaResolveRequest]
>();

export const mockPostOtaArtifactAuthorization = jest.fn<
  Promise<AxiosResponse<OtaResolveResponse>>,
  [string, OtaArtifactAuthorizationRequest]
>();

export const mockPostOtaActiveInstallHeartbeat = jest.fn<
  Promise<AxiosResponse<void>>,
  [string, OtaActiveInstallHeartbeat]
>();

export const mockGetPublicChannels = jest.fn<
  Promise<AxiosResponse<string[]>>,
  [PublicChannelsParams]
>();

export const mockReportInstalled = jest.fn<
  Promise<AxiosResponse<void>>,
  [string, string, ReportInstalledPayload]
>();

export const mockReportLocalRollback = jest.fn<
  Promise<AxiosResponse<void>>,
  [string, string, ReportLocalRollbackPayload]
>();

export const mockReportPatchApplyFailure = jest.fn<
  Promise<AxiosResponse<void>>,
  [string, ReportPatchApplyFailurePayload]
>();

export const mockGetBundleList = jest.fn<
  Promise<AxiosResponse<BundleListResponse>>,
  [string, BundleListParams]
>();

export const resetClientApiMocks = () => {
  mockPostOtaResolve.mockReset();
  mockPostOtaArtifactAuthorization.mockReset();
  mockPostOtaActiveInstallHeartbeat.mockReset();
  mockGetPublicChannels.mockReset();
  mockReportInstalled.mockReset();
  mockReportLocalRollback.mockReset();
  mockReportPatchApplyFailure.mockReset();
  mockGetBundleList.mockReset();
};

export const postOtaResolve = (...args: [string, OtaResolveRequest]) => mockPostOtaResolve(...args);

export const postOtaArtifactAuthorization = (...args: [string, OtaArtifactAuthorizationRequest]) =>
  mockPostOtaArtifactAuthorization(...args);

export const postOtaActiveInstallHeartbeat = (...args: [string, OtaActiveInstallHeartbeat]) =>
  mockPostOtaActiveInstallHeartbeat(...args);

export const getPublicChannels = (...args: [PublicChannelsParams]) => mockGetPublicChannels(...args);

export const reportInstalled = (...args: [string, string, ReportInstalledPayload]) =>
  mockReportInstalled(...args);

export const reportLocalRollback = (...args: [string, string, ReportLocalRollbackPayload]) =>
  mockReportLocalRollback(...args);

export const reportPatchApplyFailure = (...args: [string, ReportPatchApplyFailurePayload]) =>
  mockReportPatchApplyFailure(...args);

export const getBundleList = (...args: [string, BundleListParams]) => mockGetBundleList(...args);
