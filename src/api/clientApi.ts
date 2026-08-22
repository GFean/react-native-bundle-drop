import type { AxiosResponse } from 'axios';

import { apiClient } from './client';
import {
  OtaResolveRequest,
  OtaResolveResponse,
  PublicChannelsParams,
  ReportInstalledPayload,
  ReportPatchApplyFailurePayload,
  ReportLocalRollbackPayload,
  BundleListParams,
  BundleListResponse,
  OtaArtifactAuthorizationRequest,
  OtaActiveInstallHeartbeat,
} from './types';

export function postOtaActiveInstallHeartbeat(
  projectSlug: string,
  payload: OtaActiveInstallHeartbeat,
): Promise<AxiosResponse<void>> {
  return apiClient.post(
    `/projects/${encodeURIComponent(projectSlug)}/ota/active-install`,
    payload,
    {
      headers: { Accept: 'application/json' },
      timeout: 3000,
    },
  );
}

export function postOtaArtifactAuthorization(
  projectSlug: string,
  payload: OtaArtifactAuthorizationRequest,
): Promise<AxiosResponse<OtaResolveResponse>> {
  return apiClient.post(
    `/projects/${encodeURIComponent(projectSlug)}/ota/artifacts/authorize`,
    payload,
    {
      headers: { Accept: 'application/json' },
      timeout: 15000,
    },
  );
}

export function postOtaResolve(
  projectSlug: string,
  payload: OtaResolveRequest,
): Promise<AxiosResponse<OtaResolveResponse>> {
  return apiClient.post(`/projects/${encodeURIComponent(projectSlug)}/ota/resolve`, payload, {
    headers: {
      Accept: 'application/json',
    },
    timeout: 15000,
  });
}

export function getPublicChannels(params: PublicChannelsParams): Promise<AxiosResponse<string[]>> {
  const { projectSlug } = params;
  return apiClient.get(`/projects/${encodeURIComponent(projectSlug)}/channels/public`, {
    headers: {
      Accept: 'application/json',
    },
    timeout: 15000,
  });
}

export function reportInstalled(
  projectSlug: string,
  hash: string,
  payload: ReportInstalledPayload,
): Promise<AxiosResponse<void>> {
  return apiClient.post(
    `/projects/${encodeURIComponent(projectSlug)}/bundle/${encodeURIComponent(hash)}/installed`,
    payload,
    {
      headers: {
        Accept: 'application/json',
      },
      timeout: 3000,
    },
  );
}

export function reportPatchApplyFailure(
  projectSlug: string,
  payload: ReportPatchApplyFailurePayload,
): Promise<AxiosResponse<void>> {
  return apiClient.post(
    `/projects/${encodeURIComponent(projectSlug)}/ota/patch/apply-failure`,
    payload,
    {
      headers: {
        Accept: 'application/json',
      },
      timeout: 3000,
    },
  );
}

export function reportLocalRollback(
  projectSlug: string,
  hash: string,
  payload: ReportLocalRollbackPayload,
): Promise<AxiosResponse<void>> {
  return apiClient.post(
    `/projects/${encodeURIComponent(projectSlug)}/bundle/${encodeURIComponent(hash)}/local-rollback-report`,
    payload,
    {
      headers: {
        Accept: 'application/json',
      },
      timeout: 10000,
    },
  );
}

export function getBundleList(
  projectSlug: string,
  params: BundleListParams,
): Promise<AxiosResponse<BundleListResponse>> {
  const parts: string[] = [`channelName=${encodeURIComponent(params.channelName)}`];
  if (params.platform) parts.push(`platform=${encodeURIComponent(params.platform)}`);
  if (params.limit) parts.push(`limit=${params.limit}`);
  if (params.cursor) parts.push(`cursor=${encodeURIComponent(params.cursor)}`);

  return apiClient.get(
    `/projects/${encodeURIComponent(projectSlug)}/bundle/list?${parts.join('&')}`,
    {
      headers: { Accept: 'application/json' },
      timeout: 15000,
    },
  );
}
