import axios from 'axios';
import {
  AiSetupPlanRequest,
  AiSetupPlanResponse,
} from './types';

const DEFAULT_AI_INIT_TIMEOUT_MS = 180000;

const resolveTimeoutMs = () => {
  const value = Number(process.env.BUNDLE_DROP_AI_INIT_TIMEOUT_MS || '');
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_AI_INIT_TIMEOUT_MS;
};

export async function requestAiSetupPlan(params: {
  serverUrl: string;
  authToken: string;
  request: AiSetupPlanRequest;
}): Promise<AiSetupPlanResponse> {
  try {
    const response = await axios.post<AiSetupPlanResponse>(
      `${params.serverUrl}/ai/setup-plan`,
      params.request,
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${params.authToken}`,
        },
        timeout: resolveTimeoutMs(),
      },
    );
    return response.data;
  } catch (error: any) {
    const raw = error?.response?.data;
    if (error?.code === 'ECONNABORTED' || /timeout/i.test(String(error?.message || ''))) {
      throw new Error(
        'AI setup planning timed out. Try again, or increase BUNDLE_DROP_AI_INIT_TIMEOUT_MS.',
      );
    }
    const message =
      raw && typeof raw === 'object'
        ? raw.error || JSON.stringify(raw)
        : raw || error?.message || 'AI setup planning failed';
    throw new Error(`AI setup planning failed: ${message}`);
  }
}
