import type { AxiosResponse } from 'axios';

import { config } from '../context';

type ApiRequestOptions = {
  headers?: Record<string, string>;
  timeout?: number;
};

type ApiClient = {
  get<T = unknown>(path: string, options?: ApiRequestOptions): Promise<AxiosResponse<T>>;
  post<T = unknown>(
    path: string,
    payload?: unknown,
    options?: ApiRequestOptions,
  ): Promise<AxiosResponse<T>>;
};

const joinUrl = (baseUrl: string, path: string): string => {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
};

const hasHeader = (headers: Record<string, string>, name: string): boolean => {
  const normalizedName = name.toLowerCase();
  return Object.keys(headers).some(header => header.toLowerCase() === normalizedName);
};

const buildHeaders = (
  headers: Record<string, string> | undefined,
  hasPayload: boolean,
): Record<string, string> => {
  const nextHeaders = { ...(headers || {}) };
  const apiKey = config.project?.apiKey;

  if (apiKey && !hasHeader(nextHeaders, 'x-api-key')) {
    nextHeaders['x-api-key'] = apiKey;
  }

  if (!hasHeader(nextHeaders, 'Accept')) {
    nextHeaders.Accept = 'application/json';
  }

  if (hasPayload && !hasHeader(nextHeaders, 'Content-Type')) {
    nextHeaders['Content-Type'] = 'application/json';
  }

  return nextHeaders;
};

const readResponseHeaders = (headers: Headers): Record<string, string> => {
  const result: Record<string, string> = {};
  if (typeof headers.forEach !== 'function') {
    return result;
  }
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
};

const readResponseData = async <T>(response: Response): Promise<T> => {
  const text = await response.text();
  if (!text) {
    return undefined as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
};

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  payload: unknown,
  options?: ApiRequestOptions,
): Promise<AxiosResponse<T>> {
  const hasPayload = payload !== undefined;
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  const timeoutId = controller && options?.timeout
    ? setTimeout(() => controller.abort(), options.timeout)
    : null;

  try {
    const response = await fetch(joinUrl(config.serverUrl, path), {
      method,
      headers: buildHeaders(options?.headers, hasPayload),
      body: hasPayload ? JSON.stringify(payload) : undefined,
      signal: controller?.signal,
    });
    const data = await readResponseData<T>(response);
    const axiosResponse: AxiosResponse<T> = {
      data,
      status: response.status,
      statusText: response.statusText,
      headers: readResponseHeaders(response.headers),
      config: {} as never,
    };

    if (!response.ok) {
      const error = new Error(`Bundle Drop API request failed with status ${response.status}`);
      Object.assign(error, {
        response: axiosResponse,
        isAxiosError: true,
      });
      throw error;
    }

    return axiosResponse;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export const apiClient: ApiClient = {
  get: (path, options) => request('GET', path, undefined, options),
  post: (path, payload, options) => request('POST', path, payload, options),
};
