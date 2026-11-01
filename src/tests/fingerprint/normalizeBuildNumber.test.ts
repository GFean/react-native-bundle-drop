import { normalizeAndroidBuildNumber } from '../../fingerprint/normalizeBuildNumber';

describe('scheme-1 Android metadata normalization', () => {
  it.each(['versionCode 1', 'versionCode = 1'])('normalizes the recognized form %s', statement => {
    const source = `android {\n defaultConfig {\n ${statement}\n versionName "1.0"\n }\n}`;
    expect(normalizeAndroidBuildNumber(source)).toBe(source.replace(statement, statement.replace('1', '<bundle-drop-build-number>')));
    expect(normalizeAndroidBuildNumber(source.replace(statement, statement.replace('1', '42'))))
      .toBe(normalizeAndroidBuildNumber(source));
  });

  it('handles CRLF, flavor overrides, comments and semicolons without changing other bytes', () => {
    const source = 'android {\r\n productFlavors {\r\n demo {\r\n versionCode = 9; // build 9\r\n targetSdk 35\r\n }\r\n }\r\n}';
    expect(normalizeAndroidBuildNumber(source)).toBe(source.replace('= 9;', '= <bundle-drop-build-number>;'));
  });

  it.each([
    'versionCode = compute(1)', 'versionCode project.versionCode', 'versionCode = 1 + 2',
    'versionCode = 1_000', 'versionCode = 1L', 'other.versionCode = 1',
    'val versionCode = 1', 'versionCode(1)',
    'versionCode = 1\n + computeNativeVersion()',
    'versionCode = 1\r\n .coerceAtLeast(2)',
  ])('preserves ambiguous or unsupported expressions: %s', statement => {
    const source = `android { defaultConfig {\n ${statement}\n } }`;
    expect(normalizeAndroidBuildNumber(source)).toBe(source);
  });

  it('does not rewrite comments, quoted content, or statements outside recognized scopes', () => {
    const source = `// versionCode 2\n/* defaultConfig {\n versionCode 4\n} */\ndef example = """defaultConfig {\nversionCode 7\n}"""\nversionCode = 8\nandroid { defaultConfig {\n targetSdk 35\n } }`;
    expect(normalizeAndroidBuildNumber(source)).toBe(source);
  });

  it.each(['def pattern = /\n versionCode 3\n/', 'def broken = "\n versionCode 3'])('preserves unrecognized lexical forms', expression => {
    const source = `android { defaultConfig {\n ${expression}\n versionCode 2\n } }`;
    expect(normalizeAndroidBuildNumber(source)).toBe(source);
  });
  it('preserves incomplete statements and handles an anonymous outer scope', () => {
    expect(normalizeAndroidBuildNumber('{ defaultConfig {\n versionCode')).toBe('{ defaultConfig {\n versionCode');
    expect(normalizeAndroidBuildNumber('defaultConfig {\n versionCode 3'))
      .toBe('defaultConfig {\n versionCode <bundle-drop-build-number>');
  });
});
