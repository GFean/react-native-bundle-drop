import {
  hasBareAndroidStartupIntegration,
  hasBareIosStartupIntegration,
  stripCommentsAndStrings,
} from '../../../CLI/scripts/native-setup-contract';

describe('bare native setup contract', () => {
  it('accepts the shipped Android module import and fully qualified references', () => {
    expect(hasBareAndroidStartupIntegration([
      'import com.bundledrop.BundleDropModule',
      'fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this, null)',
    ].join('\n'))).toBe(true);
    expect(hasBareAndroidStartupIntegration(
      'fun getJSBundleFile() = com.bundledrop.BundleDropModule.resolveJSBundleFile(this, null)',
    )).toBe(true);
    expect(hasBareAndroidStartupIntegration([
      'import com.bundledrop.BundleDropNativePaths;',
      'val path = BundleDropNativePaths.getDownloadedBundlePath(this)',
    ].join('\n'))).toBe(true);
  });

  it('rejects invented Android imports and markers in comments or strings', () => {
    expect(hasBareAndroidStartupIntegration([
      'import com.gfean.reactnativebundledrop.BundleDropModule',
      'fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this, null)',
    ].join('\n'))).toBe(false);
    expect(hasBareAndroidStartupIntegration([
      '// import com.bundledrop.BundleDropModule',
      'val marker = "getJSBundleFile BundleDropModule.resolveJSBundleFile"',
    ].join('\n'))).toBe(false);
  });

  it('accepts the shipped Swift module and Objective-C header', () => {
    expect(hasBareIosStartupIntegration(
      'ios/Demo/AppDelegate.swift',
      'import BundleDrop\nfunc bundleURL() -> URL? { BundleDropLocator.bundleURL() }',
    )).toBe(true);
    expect(hasBareIosStartupIntegration(
      'ios/Demo/AppDelegate.mm',
      '#import <BundleDrop/BundleDropLocator.h>\n- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge { return [BundleDropLocator bundleURL]; }',
    )).toBe(true);
    expect(hasBareIosStartupIntegration(
      'ios/Demo/AppDelegate.m',
      '#import <BundleDrop/BundleDropLocator.h>\n- (NSURL *)bundleURL { return [BundleDropLocator bundleURL]; }',
    )).toBe(true);
  });

  it('rejects invented iOS modules and markers in comments or strings', () => {
    expect(hasBareIosStartupIntegration(
      'ios/Demo/AppDelegate.swift',
      'import ReactNativeBundleDrop\nfunc bundleURL() -> URL? { BundleDropLocator.bundleURL() }',
    )).toBe(false);
    expect(hasBareIosStartupIntegration(
      'ios/Demo/AppDelegate.swift',
      '// import BundleDrop\nlet marker = "BundleDropLocator.bundleURL()"',
    )).toBe(false);
    expect(hasBareIosStartupIntegration(
      'ios/Demo/AppDelegate.mm',
      '@implementation AppDelegate\n@end',
    )).toBe(false);
  });

  it('strips every supported comment and string form while preserving executable code', () => {
    const source = [
      '// line comment',
      'const first = "double \\\" quoted";',
      "const second = 'single \\\' quoted';",
      'const third = `template \\` quoted`;',
      '/* block comment */',
      'fun resolver() = BundleDropModule.resolveJSBundleFile(this, null)',
    ].join('\n');

    const code = stripCommentsAndStrings(source);

    expect(code).not.toContain('line comment');
    expect(code).not.toContain('double');
    expect(code).not.toContain('single');
    expect(code).not.toContain('template');
    expect(code).not.toContain('block comment');
    expect(code).toContain('BundleDropModule.resolveJSBundleFile');
  });

  it('rejects partial native references that do not own cold-start resolution', () => {
    expect(hasBareAndroidStartupIntegration(
      'import com.bundledrop.BundleDropModule\nclass MainApplication {}',
    )).toBe(false);
    expect(hasBareAndroidStartupIntegration(
      'fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this, null)',
    )).toBe(false);
    expect(hasBareIosStartupIntegration(
      'ios/Demo/AppDelegate.swift',
      'import BundleDrop\nclass AppDelegate {}',
    )).toBe(false);
    expect(hasBareIosStartupIntegration(
      'ios/Demo/AppDelegate.mm',
      '#import <BundleDrop/BundleDropLocator.h>\n@implementation AppDelegate\n@end',
    )).toBe(false);
  });
});
