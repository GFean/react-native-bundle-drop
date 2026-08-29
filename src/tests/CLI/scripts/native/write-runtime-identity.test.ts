import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import {
  parseNativeRuntimeIdentityArguments,
  resolveNativeRuntimeIdentity,
  writeNativeRuntimeIdentity,
} from '../../../../CLI/scripts/native/write-runtime-identity';

describe('native runtime identity writer', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-drop-native-identity-'));
  });

  afterEach(() => {
    fs.removeSync(projectRoot);
  });

  const writeConfig = (runtimeVersion: string) => {
    fs.writeFileSync(
      path.join(projectRoot, 'bundle.drop.config.js'),
      `module.exports = { runtimeVersion: ${runtimeVersion} };\n`,
    );
  };

  it('resolves platform literals and writes deterministic native identity JSON', () => {
    writeConfig("{ ios: 'ios-runtime', android: 'android-runtime' }");
    const outputPath = path.join(projectRoot, 'generated', 'bundle-drop', 'build-identity.json');

    expect(writeNativeRuntimeIdentity({ projectRoot, platform: 'android', outputPath })).toEqual({
      schemaVersion: 1,
      platform: 'android',
      source: 'bundle-drop',
      runtimeVersion: 'android-runtime',
    });
    expect(fs.readFileSync(outputPath, 'utf8')).toBe(
      '{"schemaVersion":1,"platform":"android","source":"bundle-drop","runtimeVersion":"android-runtime"}\n',
    );
    expect(fs.readdirSync(path.dirname(outputPath))).toEqual(['build-identity.json']);
  });

  it('reports Expo authority without inventing a literal', () => {
    writeConfig("{ source: 'expo' }");
    expect(writeNativeRuntimeIdentity({ projectRoot, platform: 'ios' })).toEqual({
      schemaVersion: 1,
      platform: 'ios',
      source: 'expo',
    });
  });

  it('fails closed for missing platform literals', () => {
    writeConfig("{ ios: 'ios-only' }");
    expect(() => resolveNativeRuntimeIdentity(projectRoot, 'android')).toThrow(
      'runtimeVersion.android',
    );
  });

  it('parses the executable arguments and rejects malformed input', () => {
    expect(parseNativeRuntimeIdentityArguments([
      '--project-root', projectRoot,
      '--platform', 'ios',
      '--output', '/tmp/identity.json',
    ])).toEqual({
      projectRoot,
      platform: 'ios',
      outputPath: '/tmp/identity.json',
    });
    expect(() => parseNativeRuntimeIdentityArguments(['--platform', 'windows'])).toThrow(
      'Usage: write-runtime-identity',
    );
    expect(() => parseNativeRuntimeIdentityArguments(['--unknown', 'value'])).toThrow(
      'Usage: write-runtime-identity',
    );
    expect(() => parseNativeRuntimeIdentityArguments(['--platform'])).toThrow(
      'Usage: write-runtime-identity',
    );
    expect(() => parseNativeRuntimeIdentityArguments([
      '--project-root', projectRoot,
      '--platform', 'android',
    ])).not.toThrow();
    expect(() => parseNativeRuntimeIdentityArguments([
      '--project-root', projectRoot,
      '--project-root', projectRoot,
      '--platform', 'ios',
    ])).toThrow('Duplicate argument --project-root');
  });

  it('removes a temporary file when the atomic rename fails', () => {
    writeConfig("{ ios: 'ios-runtime', android: 'android-runtime' }");
    const outputPath = path.join(projectRoot, 'generated', 'identity.json');
    const rename = jest.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('rename failed');
    });

    expect(() => writeNativeRuntimeIdentity({
      projectRoot,
      platform: 'android',
      outputPath,
    })).toThrow('rename failed');
    expect(fs.readdirSync(path.dirname(outputPath))).toEqual([]);
    rename.mockRestore();
  });
});
