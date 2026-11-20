import axios from 'axios';
import {
  AiSetupPlanRequest,
  AiSetupPlanRequestV2,
  AiSetupPlanResponse,
} from './types';
import { findKnownBundleDropCredential } from './credential-safety';
import { escapeTerminalControls } from './terminal-safety';

const DEFAULT_AI_INIT_TIMEOUT_MS = 180000;
const MAX_BACKEND_DIAGNOSTIC_LENGTH = 1000;

const safeBackendDiagnostic = (value: unknown) => {
  if (typeof value !== 'string') return null;
  const diagnostic = value.trim();
  if (
    !diagnostic ||
    diagnostic.length > MAX_BACKEND_DIAGNOSTIC_LENGTH ||
    findKnownBundleDropCredential(diagnostic)
  ) {
    return null;
  }
  return escapeTerminalControls(diagnostic);
};

const safeBackendDetailReason = (details: unknown) => {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(details, 'reason');
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
  return safeBackendDiagnostic(descriptor.value);
};

const resolveTimeoutMs = () => {
  const value = Number(process.env.BUNDLE_DROP_AI_INIT_TIMEOUT_MS || '');
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_AI_INIT_TIMEOUT_MS;
};

type SetupPlanRequestOptions = {
  serverUrl: string;
  authToken: string;
  request: AiSetupPlanRequest | AiSetupPlanRequestV2;
};

export async function requestAiSetupPlan(
  params: SetupPlanRequestOptions,
): Promise<AiSetupPlanResponse> {
  try {
    const response = await axios.post<AiSetupPlanResponse>(
      `${params.serverUrl}/ai/setup-plan${params.request.schemaVersion === 2 ? '/v2' : ''}`,
      params.request,
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${params.authToken}`,
        },
        ...(params.request.schemaVersion === 2 ? { maxRedirects: 0 } : {}),
        timeout: resolveTimeoutMs(),
      },
    );
    return response.data;
  } catch (error: any) {
    const raw = error?.response?.data;
    if (params.request.schemaVersion === 2 && error?.response?.status === 404 && !raw?.code) {
      throw new Error('This server does not support this CLI’s native AI setup. Try a compatible Bundle Drop backend or follow manual setup.');
    }
    if (error?.code === 'ECONNABORTED' || /timeout/i.test(String(error?.message || ''))) {
      throw new Error(
        'AI setup planning timed out. Try again, or increase BUNDLE_DROP_AI_INIT_TIMEOUT_MS.',
      );
    }
    const diagnostic = raw && typeof raw === 'object'
      ? safeBackendDetailReason(raw.details) || safeBackendDiagnostic(raw.error)
      : safeBackendDiagnostic(raw);
    const fallback = diagnostic || safeBackendDiagnostic(error?.message);
    throw new Error(fallback
      ? `AI setup planning failed: ${fallback}`
      : 'AI setup planning failed');
  }
}
