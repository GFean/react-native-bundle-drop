import {
  assertMatchingServerOrigin,
  DEFAULT_SERVER_URL,
  normalizeServerUrl,
} from '../../CLI/serverUrl';

describe('CLI/serverUrl', () => {
  it('uses the production API by default and removes trailing slashes', () => {
    expect(normalizeServerUrl()).toBe(DEFAULT_SERVER_URL);
    expect(normalizeServerUrl('https://api.example.com///')).toBe(
      'https://api.example.com',
    );
  });

  it.each([
    'ftp://api.example.com',
    'file:///tmp/api',
    'https://username:password@api.example.com',
    'not-a-url',
  ])('rejects unsafe server URL %s', serverUrl => {
    expect(() => normalizeServerUrl(serverUrl)).toThrow(
      'Bundle Drop serverUrl must be an HTTP(S) URL without embedded credentials.',
    );
  });

  it('accepts matching normalized origins', () => {
    expect(() =>
      assertMatchingServerOrigin(
        'https://api.example.com/v1/',
        'https://api.example.com/login',
      ),
    ).not.toThrow();
  });

  it.each([
    ['https://api.example.com', 'http://api.example.com'],
    ['https://api.example.com', 'https://other.example.com'],
    ['https://api.example.com', 'https://api.example.com:8443'],
  ])('rejects a stored login from a different origin', (requestUrl, loginUrl) => {
    expect(() => assertMatchingServerOrigin(requestUrl, loginUrl)).toThrow(
      /stored CLI login belongs to/,
    );
  });

  it('rejects legacy stored credentials without a server binding', () => {
    expect(() => assertMatchingServerOrigin('https://api.example.com', undefined)).toThrow(
      /not bound to a server/,
    );
  });
});
