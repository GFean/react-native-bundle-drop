export const DEFAULT_SERVER_URL = 'https://api.bundledrop.app';

export const normalizeServerUrl = (value?: string): string => {
  const serverUrl = value || DEFAULT_SERVER_URL;
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new Error('Bundle Drop serverUrl must be an HTTP(S) URL without embedded credentials.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Bundle Drop serverUrl must be an HTTP(S) URL without embedded credentials.');
  }
  return serverUrl.replace(/\/+$/, '');
};

export const assertMatchingServerOrigin = (
  requestServerUrl: string,
  authenticatedServerUrl: string | undefined,
): void => {
  if (!authenticatedServerUrl) {
    throw new Error(
      'The stored CLI login is not bound to a server. Run `bundle-drop login` again or pass --token explicitly.',
    );
  }

  const requestOrigin = new URL(normalizeServerUrl(requestServerUrl)).origin;
  const authenticatedOrigin = new URL(normalizeServerUrl(authenticatedServerUrl)).origin;
  if (requestOrigin !== authenticatedOrigin) {
    throw new Error(
      `The stored CLI login belongs to ${authenticatedOrigin}, but this project targets ${requestOrigin}. ` +
        'Run `bundle-drop login` for this server or pass --token explicitly.',
    );
  }
};
