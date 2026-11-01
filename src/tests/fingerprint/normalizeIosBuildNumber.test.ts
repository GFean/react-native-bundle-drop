import { normalizeIosProjectBuildNumber } from '../../fingerprint/normalizeIosBuildNumber';

describe('scheme-1 Xcode build-number normalization', () => {
  it.each(['1', '1.2.3', '"1"', '"1.2.3"'])('normalizes only the recognized literal %s', value => {
    const source = `{ objects = { ID = { buildSettings = {\n CURRENT_PROJECT_VERSION = ${value};\n MARKETING_VERSION = 1.0; }; }; }; }`;
    const marker = value.startsWith('"') ? '"<bundle-drop-build-number>"' : '<bundle-drop-build-number>';
    expect(normalizeIosProjectBuildNumber(source)).toBe(source.replace(`= ${value};`, `= ${marker};`));
    expect(normalizeIosProjectBuildNumber(source.replace(`= ${value};`, `= ${value.startsWith('"') ? '"42"' : '42'};`)))
      .toBe(normalizeIosProjectBuildNumber(source));
  });

  it('retains comments, quoted content, paths and fields outside buildSettings', () => {
    const source = `// CURRENT_PROJECT_VERSION = 2;\n{ /* buildSettings = { CURRENT_PROJECT_VERSION = 3; } */\n CURRENT_PROJECT_VERSION = 4;\n text = "buildSettings = { CURRENT_PROJECT_VERSION = 5; }";\n path = ../some/path;\n buildSettings = { Nested = { CURRENT_PROJECT_VERSION = 6; };\n CURRENT_PROJECT_VERSION /* counter */ = 7; }; } // final comment`;
    expect(normalizeIosProjectBuildNumber(source)).toBe(source.replace('= 7;', '= <bundle-drop-build-number>;'));
  });

  it.each(['$(VERSION_NUMBER)', '1 + 2', '"$(VERSION_NUMBER)"', '1_000', 'version()'])('preserves the expression %s', expression => {
    const source = `{ buildSettings = { CURRENT_PROJECT_VERSION = ${expression}; }; }`;
    expect(normalizeIosProjectBuildNumber(source)).toBe(source);
  });

  it('preserves conditional fields, missing terminators and unrelated dictionaries', () => {
    const source = 'buildSettings = { CURRENT_PROJECT_VERSION[sdk=iphoneos*] = 1; CURRENT_PROJECT_VERSION = 2 }';
    expect(normalizeIosProjectBuildNumber(source)).toBe(source);
    expect(normalizeIosProjectBuildNumber('')).toBe('');
    expect(normalizeIosProjectBuildNumber('CURRENT_PROJECT_VERSION = 1;')).toBe('CURRENT_PROJECT_VERSION = 1;');
  });

  it.each(['/* unfinished\n buildSettings = { CURRENT_PROJECT_VERSION = 1; }', 'text = "unfinished\n buildSettings = { CURRENT_PROJECT_VERSION = 1; }'])('retains unsupported lexical input', source => {
    expect(normalizeIosProjectBuildNumber(source)).toBe(source);
  });
});
