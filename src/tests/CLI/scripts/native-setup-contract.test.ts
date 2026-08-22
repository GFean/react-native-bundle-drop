import {
  findMissingBareNativeStartupStructure,
  hasBareAndroidStartupIntegration,
  hasBareIosStartupIntegration,
  stripCommentsAndStrings,
} from '../../../CLI/scripts/native-setup-contract';
import {
  MODERN_KOTLIN_MAIN_APPLICATION,
  RN71_JAVA_CONDITIONAL_FALLBACK_MAIN_APPLICATION,
  RN71_JAVA_LOCAL_FALLBACK_MAIN_APPLICATION,
  RN71_JAVA_MAIN_APPLICATION,
  RN71_KOTLIN_CONDITIONAL_FALLBACK_MAIN_APPLICATION,
  RN71_KOTLIN_MAIN_APPLICATION,
  RN71_KOTLIN_NATIVE_PATHS_MAIN_APPLICATION,
  RN71_OBJC_APP_DELEGATE,
  RN85_ANDROID_NATIVE_PATHS_MAIN_APPLICATION,
  RN85_SWIFT_APP_DELEGATE,
} from '../../fixtures/rn85SwiftAppDelegate';

describe('bare native setup contract', () => {
  it('accepts legacy Kotlin and Java native host overrides', () => {
    expect(hasBareAndroidStartupIntegration(RN71_KOTLIN_MAIN_APPLICATION)).toBe(true);
    expect(hasBareAndroidStartupIntegration(RN71_JAVA_MAIN_APPLICATION)).toBe(true);
    expect(hasBareAndroidStartupIntegration(RN71_JAVA_LOCAL_FALLBACK_MAIN_APPLICATION))
      .toBe(true);
    expect(hasBareAndroidStartupIntegration(RN71_KOTLIN_CONDITIONAL_FALLBACK_MAIN_APPLICATION))
      .toBe(true);
    expect(hasBareAndroidStartupIntegration(RN71_JAVA_CONDITIONAL_FALLBACK_MAIN_APPLICATION))
      .toBe(true);
    expect(hasBareAndroidStartupIntegration(
      RN71_JAVA_CONDITIONAL_FALLBACK_MAIN_APPLICATION.replace(
        '        fallback\n      );',
        '        otherFallback\n      );',
      ),
    )).toBe(false);
    for (const invalidSelection of [
      ['? selectEnterpriseBundle()', '? return selectEnterpriseBundle()'],
      ['enterprisePolicy.enabled', 'if enterprisePolicy.enabled'],
      ['? selectEnterpriseBundle()', '? audit(), selectEnterpriseBundle()'],
    ]) {
      expect(hasBareAndroidStartupIntegration(
        RN71_JAVA_CONDITIONAL_FALLBACK_MAIN_APPLICATION.replace(
          invalidSelection[0],
          invalidSelection[1],
        ),
      )).toBe(false);
    }
    expect(hasBareAndroidStartupIntegration(
      RN71_JAVA_CONDITIONAL_FALLBACK_MAIN_APPLICATION.replace(
        'selectEnterpriseBundle()',
        'selectEnterpriseBundle(region, channel)',
      ),
    )).toBe(true);
  });

  it.each([
    ['method chaining', '.trim()'],
    ['string concatenation', ' + "/bad"'],
    ['comparison', ' != null'],
    ['logical transform', ' || false'],
  ])('rejects a Java resolver result with %s', (_label, suffix) => {
    const transformed = RN71_JAVA_LOCAL_FALLBACK_MAIN_APPLICATION.replace(
      '      );',
      `      )${suffix};`,
    );
    expect(hasBareAndroidStartupIntegration(transformed)).toBe(false);
  });

  it('binds resolver receiver syntax and Kotlin nullability to the parsed language', () => {
    for (const invalidJavaContext of [
      'this',
      'this@MainApplication',
      'applicationContext',
    ]) {
      expect(hasBareAndroidStartupIntegration(
        RN71_JAVA_LOCAL_FALLBACK_MAIN_APPLICATION.replace(
          'getApplicationContext(),',
          `${invalidJavaContext},`,
        ),
      )).toBe(false);
    }
    for (const invalidJavaSuffix of ['!!', ' ?: super.getJSBundleFile()']) {
      expect(hasBareAndroidStartupIntegration(
        RN71_JAVA_LOCAL_FALLBACK_MAIN_APPLICATION.replace(
          '      );',
          `      )${invalidJavaSuffix};`,
        ),
      )).toBe(false);
    }

    expect(hasBareAndroidStartupIntegration(
      RN71_KOTLIN_MAIN_APPLICATION.replace(
        'this@MainApplication,',
        'MainApplication.this,',
      ),
    )).toBe(false);
    expect(hasBareAndroidStartupIntegration(
      RN71_KOTLIN_MAIN_APPLICATION.replace('this@MainApplication,', 'this,'),
    )).toBe(false);

    const nullableDirect = RN71_KOTLIN_MAIN_APPLICATION
      .replace('override fun getJSBundleFile(): String =', 'override fun getJSBundleFile(): String? =')
      .replace('          )!!', '          )');
    expect(hasBareAndroidStartupIntegration(nullableDirect)).toBe(true);
    expect(hasBareAndroidStartupIntegration(
      nullableDirect.replace('getJSBundleFile(): String?', 'getJSBundleFile(): String'),
    )).toBe(false);
  });

  it('accepts a modern Kotlin helper only when the ReactHost consumes it', () => {
    const modernHost = MODERN_KOTLIN_MAIN_APPLICATION;
    expect(hasBareAndroidStartupIntegration(modernHost)).toBe(true);
    expect(hasBareAndroidStartupIntegration(
      modernHost.replace('jsBundleFilePath = getJSBundleFile(),', 'isHermesEnabled = true,'),
    )).toBe(false);

    const deadHostConnection = modernHost
      .replace('jsBundleFilePath = getJSBundleFile(),', 'isHermesEnabled = true,')
      .replace(
        '\n}',
        `
  fun deadHost() = getDefaultReactHost(
    context = applicationContext,
    packageList = emptyList(),
    jsBundleFilePath = getJSBundleFile(),
  )
}`,
      );
    expect(hasBareAndroidStartupIntegration(deadHostConnection)).toBe(false);

    const deadAssignedHost = modernHost.replace(
      'getDefaultReactHost(\n      context = applicationContext,',
      `val deadHost = getDefaultReactHost(
      context = applicationContext,`,
    ).replace(
      '  }\n}',
      `    deadHost
    getDefaultReactHost(
      context = applicationContext,
      packageList = emptyList(),
    )
  }
}`,
    );
    expect(hasBareAndroidStartupIntegration(deadAssignedHost)).toBe(false);
  });

  it('binds legacy resolvers to the authoritative ReactNativeHost', () => {
    expect(hasBareAndroidStartupIntegration(
      RN71_KOTLIN_MAIN_APPLICATION.replace(
        'override val reactNativeHost',
        'val unusedHost',
      ),
    )).toBe(false);
    expect(hasBareAndroidStartupIntegration(
      RN71_JAVA_MAIN_APPLICATION.replace(
        'return mReactNativeHost;',
        'return otherHost;',
      ),
    )).toBe(false);

    const nestedGetterDecoy = [
      'import com.bundledrop.BundleDropModule',
      'class MainApplication {',
      '  val deadHost: ReactNativeHost = object : DefaultReactNativeHost(this) {',
      '    override fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this@MainApplication, null)',
      '  }',
      '  val actualHost: ReactNativeHost = object : DefaultReactNativeHost(this) {}',
      '  override val reactNativeHost: ReactNativeHost get() = actualHost',
      '  class Helper {',
      '    override val reactNativeHost: ReactNativeHost get() = deadHost',
      '  }',
      '}',
    ].join('\n');
    expect(hasBareAndroidStartupIntegration(nestedGetterDecoy)).toBe(false);

    const branchedJavaGetter = RN71_JAVA_MAIN_APPLICATION.replace(
      'return mReactNativeHost;',
      'if (false) return mReactNativeHost; return actualHost;',
    );
    expect(hasBareAndroidStartupIntegration(branchedJavaGetter)).toBe(false);

    const anonymousGetterDecoy = [
      'import com.bundledrop.BundleDropModule',
      'class MainApplication {',
      '  val deadHost: ReactNativeHost = object : DefaultReactNativeHost(this) {',
      '    override fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this@MainApplication, null)',
      '  }',
      '  val deadApplication = object : ReactApplication {',
      '    override val reactNativeHost: ReactNativeHost get() = deadHost',
      '  }',
      '}',
    ].join('\n');
    expect(hasBareAndroidStartupIntegration(anonymousGetterDecoy)).toBe(false);

    const anonymousModernHostDecoy = MODERN_KOTLIN_MAIN_APPLICATION
      .replace(
        '  override val reactHost: ReactHost by lazy {',
        '  val deadApplication = object : ReactApplication {\n' +
          '    override val reactHost: ReactHost by lazy {',
      )
      .replace('\n  }\n}', '\n    }\n  }\n}');
    expect(hasBareAndroidStartupIntegration(anonymousModernHostDecoy)).toBe(false);
  });

  it('accepts only authoritative RN85 NativePaths and Swift factory connections', () => {
    expect(hasBareAndroidStartupIntegration(RN85_ANDROID_NATIVE_PATHS_MAIN_APPLICATION))
      .toBe(true);
    expect(hasBareAndroidStartupIntegration(
      RN85_ANDROID_NATIVE_PATHS_MAIN_APPLICATION.replace(
        'jsBundleFilePath = BundleDropNativePaths.getDownloadedBundlePath(applicationContext),',
        'isHermesEnabled = true,',
      ),
    )).toBe(false);
    expect(hasBareAndroidStartupIntegration(RN71_KOTLIN_NATIVE_PATHS_MAIN_APPLICATION))
      .toBe(true);
    expect(hasBareIosStartupIntegration(
      'ios/BundleDropDemo/AppDelegate.swift',
      RN85_SWIFT_APP_DELEGATE,
    )).toBe(true);
    expect(hasBareIosStartupIntegration(
      'ios/BundleDropDemo/AppDelegate.swift',
      RN85_SWIFT_APP_DELEGATE.replace(
        'RCTReactNativeFactory(delegate: delegate)',
        'RCTReactNativeFactory(delegate: ReactNativeDelegate())',
      ),
    )).toBe(false);

    const deadFactory = RN85_SWIFT_APP_DELEGATE
      .replace('    factory.startReactNative(', '    if false {\n      factory.startReactNative(')
      .replace(
        '      launchOptions: launchOptions\n    )',
        '      launchOptions: launchOptions\n      )\n    }\n    let actualFactory = RCTReactNativeFactory(delegate: OtherDelegate())\n    actualFactory.startReactNative(withModuleName: "Demo", in: window)',
      );
    expect(hasBareIosStartupIntegration('ios/Demo/AppDelegate.swift', deadFactory)).toBe(false);
  });

  it('rejects Android dead methods, nested owners, duplicates, and renamed lifecycle decoys', () => {
    const deadMethod = [
      'import com.bundledrop.BundleDropModule',
      'class MainApplication {',
      '  override fun getJSBundleFile(): String? = null',
      '  fun getJSBundleFileForTests() = BundleDropModule.resolveJSBundleFile(this, null)',
      '}',
    ].join('\n');
    const nestedOwner = [
      'import com.bundledrop.BundleDropModule',
      'class MainApplication {',
      '  class Helper {',
      '    fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this, null)',
      '  }',
      '}',
    ].join('\n');
    const duplicate = [
      'import com.bundledrop.BundleDropModule',
      'class MainApplication {',
      '  override fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this, null)',
      '  private fun getJSBundleFile(): String? = BundleDropModule.resolveJSBundleFile(this, null)',
      '}',
    ].join('\n');
    const lifecycleDecoy = [
      'import com.bundledrop.BundleDropModule',
      'class MainApplication {',
      '  override fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this, null)',
      '  override fun onCreate() {}',
      '  fun onCreateForTests() { super.onCreate(); loadReactNative(this) }',
      '}',
    ].join('\n');
    const parameterizedKotlin = [
      'import com.bundledrop.BundleDropModule',
      'class MainApplication {',
      '  override fun getJSBundleFile(test: Boolean) =',
      '    BundleDropModule.resolveJSBundleFile(this, null)',
      '}',
    ].join('\n');
    const parameterizedJava = [
      'import com.bundledrop.BundleDropModule;',
      'public class MainApplication {',
      '  public String getJSBundleFile(boolean test) {',
      '    return BundleDropModule.resolveJSBundleFile(this, null);',
      '  }',
      '}',
    ].join('\n');

    expect(hasBareAndroidStartupIntegration(deadMethod)).toBe(false);
    expect(hasBareAndroidStartupIntegration(nestedOwner)).toBe(false);
    expect(hasBareAndroidStartupIntegration(duplicate)).toBe(false);
    expect(hasBareAndroidStartupIntegration(lifecycleDecoy)).toBe(false);
    expect(hasBareAndroidStartupIntegration(parameterizedKotlin)).toBe(false);
    expect(hasBareAndroidStartupIntegration(parameterizedJava)).toBe(false);
  });

  it('does not parse native startup declarations from multiline string literals', () => {
    const kotlinRawStringDecoy = [
      'import com.bundledrop.BundleDropModule',
      'class MainApplication {',
      '  val documentation = """ "',
      '  private fun getJSBundleFile(): String? = BundleDropModule.resolveJSBundleFile(this, null)',
      '  override val reactHost: ReactHost by lazy {',
      '    getDefaultReactHost(jsBundleFilePath = getJSBundleFile())',
      '  }',
      '  " """',
      '}',
    ].join('\n');
    expect(hasBareAndroidStartupIntegration(kotlinRawStringDecoy)).toBe(false);

    const swiftMultilineStringDecoy = [
      'import BundleDrop',
      '@main class AppDelegate: RCTAppDelegate {',
      '  let documentation = #""" "',
      '  override func bundleURL() -> URL? { BundleDropLocator.bundleURL() }',
      '  " """#',
      '}',
    ].join('\n');
    expect(hasBareIosStartupIntegration(
      'ios/Demo/AppDelegate.swift',
      swiftMultilineStringDecoy,
    )).toBe(false);
  });

  it('accepts Swift and Objective-C startup methods owned by AppDelegate', () => {
    expect(hasBareIosStartupIntegration(
      'ios/Demo/AppDelegate.m',
      RN71_OBJC_APP_DELEGATE,
    )).toBe(true);
    expect(hasBareIosStartupIntegration(
      'ios/Demo/AppDelegate.swift',
      [
        'import BundleDrop',
        'class AppDelegate: RCTAppDelegate {',
        '  @objc override func bundleURL() -> URL? { BundleDropLocator.bundleURL() }',
        '}',
      ].join('\n'),
    )).toBe(true);
    expect(hasBareIosStartupIntegration(
      'ios/Demo/AppDelegate.mm',
      [
        '#import <BundleDrop/BundleDropLocator.h>',
        '@implementation AppDelegate',
        '- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge { return self.bundleURL; }',
        '- (NSURL *)bundleURL { return [BundleDropLocator bundleURL]; }',
        '@end',
      ].join('\n'),
    )).toBe(true);
    expect(hasBareIosStartupIntegration(
      'ios/Demo/AppDelegate.m',
      [
        '#import <BundleDrop/BundleDropLocator.h>',
        '@implementation AppDelegate',
        '- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge {',
        '  return [BundleDropLocator bundleURL];',
        '}',
        '@end',
      ].join('\n'),
    )).toBe(true);
  });

  it('requires the resolver result on the Release return path', () => {
    const debugOnlyKotlin = RN71_KOTLIN_MAIN_APPLICATION
      .replace('"/data/local/tmp/dev.jsbundle"', 'BundleDropModule.resolveJSBundleFile(this@MainApplication, null)!!')
      .replace(
        /BundleDropModule\.resolveJSBundleFile\(\n            this@MainApplication,\n            "\/android_asset\/index\.android\.bundle",\n          \)!!/,
        '"/android_asset/index.android.bundle"',
      );
    const debugOnlyJava = RN71_JAVA_MAIN_APPLICATION
      .replace('return null;', 'return BundleDropModule.resolveJSBundleFile(MainApplication.this, null);')
      .replace(
        /return BundleDropModule\.resolveJSBundleFile\([\s\S]*?\n      \);/,
        'return "/android_asset/index.android.bundle";',
      );
    const debugOnlySwift = [
      'import BundleDrop',
      'class AppDelegate {',
      '  override func bundleURL() -> URL? {',
      '#if DEBUG',
      '    return BundleDropLocator.bundleURL()',
      '#else',
      '    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
      '#endif',
      '  }',
      '}',
    ].join('\n');
    const debugOnlyObjc = [
      '#import <BundleDrop/BundleDropLocator.h>',
      '@implementation AppDelegate',
      '- (NSURL *)bundleURL {',
      '#if DEBUG',
      '  return [BundleDropLocator bundleURL];',
      '#else',
      '  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];',
      '#endif',
      '}',
      '@end',
    ].join('\n');

    expect(hasBareAndroidStartupIntegration(debugOnlyKotlin)).toBe(false);
    expect(hasBareAndroidStartupIntegration(debugOnlyJava)).toBe(false);
    expect(hasBareIosStartupIntegration('ios/Demo/AppDelegate.swift', debugOnlySwift)).toBe(false);
    expect(hasBareIosStartupIntegration('ios/Demo/AppDelegate.mm', debugOnlyObjc)).toBe(false);
  });

  it('rejects ignored resolver results and accepts returned local values', () => {
    const ignoredKotlin = RN71_KOTLIN_MAIN_APPLICATION.replace(
      /override fun getJSBundleFile\(\): String =[\s\S]*?\n    }\n}/,
      `override fun getJSBundleFile(): String? {
        BundleDropModule.resolveJSBundleFile(this@MainApplication, null)
        return null
      }
    }
}`,
    );
    const ignoredJava = RN71_JAVA_MAIN_APPLICATION.replace(
      /protected String getJSBundleFile\(\) \{[\s\S]*?\n    }\n  };/,
      `protected String getJSBundleFile() {
      BundleDropModule.resolveJSBundleFile(MainApplication.this, null);
      return null;
    }
  };`,
    );
    const ignoredSwift = [
      'import BundleDrop',
      'class AppDelegate: RCTAppDelegate {',
      '  override func bundleURL() -> URL? { BundleDropLocator.bundleURL(); return nil }',
      '}',
    ].join('\n');
    const ignoredObjc = [
      '#import <BundleDrop/BundleDropLocator.h>',
      '@implementation AppDelegate',
      '- (NSURL *)bundleURL { [BundleDropLocator bundleURL]; return nil; }',
      '@end',
    ].join('\n');
    const returnedSwift = ignoredSwift.replace(
      'BundleDropLocator.bundleURL(); return nil',
      'let otaURL = BundleDropLocator.bundleURL(); return otaURL',
    );
    const returnedObjc = ignoredObjc.replace(
      '[BundleDropLocator bundleURL]; return nil;',
      'NSURL *otaURL = [BundleDropLocator bundleURL]; return otaURL;',
    );

    expect(hasBareAndroidStartupIntegration(ignoredKotlin)).toBe(false);
    expect(hasBareAndroidStartupIntegration(ignoredJava)).toBe(false);
    expect(hasBareIosStartupIntegration('ios/Demo/AppDelegate.swift', ignoredSwift)).toBe(false);
    expect(hasBareIosStartupIntegration('ios/Demo/AppDelegate.mm', ignoredObjc)).toBe(false);
    expect(hasBareIosStartupIntegration('ios/Demo/AppDelegate.swift', returnedSwift)).toBe(true);
    expect(hasBareIosStartupIntegration('ios/Demo/AppDelegate.mm', returnedObjc)).toBe(true);
  });

  it('does not link resolver calls across completed return or assignment statements', () => {
    const kotlinCrossStatement = RN71_KOTLIN_MAIN_APPLICATION.replace(
      /override fun getJSBundleFile\(\): String =[\s\S]*?\n    }\n}/,
      `override fun getJSBundleFile(): String? {
        val embeddedPath: String? = null
        return embeddedPath
        BundleDropModule.resolveJSBundleFile(this@MainApplication, null)
      }
    }
}`,
    );
    const swiftReturnCrossStatement = [
      'import BundleDrop',
      'class AppDelegate {',
      '  func bundleURL() -> URL? {',
      '    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
      '    BundleDropLocator.bundleURL()',
      '  }',
      '}',
    ].join('\n');
    const swiftAssignmentCrossStatement = [
      'import BundleDrop',
      'class AppDelegate {',
      '  func bundleURL() -> URL? {',
      '    let otaURL = Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
      '    BundleDropLocator.bundleURL()',
      '    return otaURL',
      '  }',
      '}',
    ].join('\n');
    const objcCrossStatement = [
      '#import <BundleDrop/BundleDropLocator.h>',
      '@implementation AppDelegate',
      '- (NSURL *)bundleURL { return nil; [BundleDropLocator bundleURL]; }',
      '@end',
    ].join('\n');

    expect(hasBareAndroidStartupIntegration(kotlinCrossStatement)).toBe(false);
    expect(hasBareIosStartupIntegration(
      'ios/Demo/AppDelegate.swift',
      swiftReturnCrossStatement,
    )).toBe(false);
    expect(hasBareIosStartupIntegration(
      'ios/Demo/AppDelegate.swift',
      swiftAssignmentCrossStatement,
    )).toBe(false);
    expect(hasBareIosStartupIntegration('ios/Demo/AppDelegate.mm', objcCrossStatement))
      .toBe(false);
  });

  it('accepts only anchored canonical optional-locator fallback branches', () => {
    const swift = [
      'import BundleDrop',
      'class AppDelegate: RCTAppDelegate {',
      '  override func bundleURL() -> URL? {',
      '    if let otaURL = BundleDropLocator.bundleURL() { return otaURL }',
      '    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
      '  }',
      '}',
    ].join('\n');
    const objc = [
      '#import <BundleDrop/BundleDropLocator.h>',
      '@implementation AppDelegate',
      '- (NSURL *)bundleURL {',
      '  NSURL *otaURL = [BundleDropLocator bundleURL];',
      '  if (otaURL != nil) { return otaURL; }',
      '  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];',
      '}',
      '@end',
    ].join('\n');
    const deadSwift = swift.replace(
      '    if let otaURL',
      '    if false {\n      if let otaURL',
    ).replace(
      '    return Bundle.main',
      '      return Bundle.main',
    ).replace('\n  }\n}', '\n    }\n  }\n}');

    expect(hasBareIosStartupIntegration('ios/Demo/AppDelegate.swift', swift)).toBe(true);
    expect(hasBareIosStartupIntegration('ios/Demo/AppDelegate.mm', objc)).toBe(true);
    expect(hasBareIosStartupIntegration('ios/Demo/AppDelegate.swift', deadSwift)).toBe(false);
  });

  it('rejects the exact reviewer native authority bypass probes', () => {
    const modernWrapper = (resolver: string, lazyPrefix = '') => [
      'import com.bundledrop.BundleDropModule',
      'class MainApplication: Application(), ReactApplication {',
      `  ${resolver}`,
      '  override val reactHost: ReactHost by lazy {',
      `    ${lazyPrefix}`,
      '    getDefaultReactHost(',
      '      context = applicationContext,',
      '      packages = PackageList(this).packages,',
      '      jsBundleFilePath = getJSBundleFile(),',
      '    )',
      '  }',
      '}',
    ].join('\n');
    const conditionalAndroid = modernWrapper(
      'private fun getJSBundleFile(): String? { return if (useOta) BundleDropModule.resolveJSBundleFile(this, null) else "/android_asset/index.android.bundle" }',
    );
    const nearMatchAndroid = modernWrapper(
      'private fun getJSBundleFile(): String? = BundleDropModule.resolveJSBundleFileForTests(this, null)',
    );
    const wrongContextAndroid = modernWrapper(
      'private fun getJSBundleFile(): String? = BundleDropModule.resolveJSBundleFile(42, null)',
    );
    const aliasMismatchAndroid = modernWrapper(
      'private fun getJSBundleFile(): String? = BundleDropModule.resolveJSBundleFile(this, null)',
    ).replace(
      'import com.bundledrop.BundleDropModule',
      'import com.bundledrop.BundleDropModule as BDM',
    );
    const earlyLazyBypass = modernWrapper(
      'private fun getJSBundleFile(): String? = BundleDropModule.resolveJSBundleFile(this, null)',
      'if (useCustom) return@lazy customReactHost',
    );
    const swiftTernary = [
      'import BundleDrop',
      'class AppDelegate: RCTAppDelegate {',
      '  override func bundleURL() -> URL? {',
      '    return useOta ? BundleDropLocator.bundleURL() : Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
      '  }',
      '}',
    ].join('\n');
    const deadFactoryBundle = RN85_SWIFT_APP_DELEGATE.replace(
      '    self.bundleURL()',
      '    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
    );
    const bypassedAppDelegateBundle = [
      'import BundleDrop',
      'class AppDelegate: RCTAppDelegate {',
      '  override func bundleURL() -> URL? { return BundleDropLocator.bundleURL() }',
      '  override func sourceURL(for bridge: RCTBridge) -> URL? {',
      '    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
      '  }',
      '}',
    ].join('\n');
    const deadObjcDelegation = [
      '#import <BundleDrop/BundleDropLocator.h>',
      '@implementation AppDelegate',
      '- (NSURL *)bundleURL { return [BundleDropLocator bundleURL]; }',
      '- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge {',
      '  [self bundleURL];',
      '  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];',
      '}',
      '@end',
    ].join('\n');

    for (const source of [
      conditionalAndroid,
      nearMatchAndroid,
      wrongContextAndroid,
      aliasMismatchAndroid,
      earlyLazyBypass,
    ]) {
      expect(hasBareAndroidStartupIntegration(source)).toBe(false);
    }
    expect(hasBareIosStartupIntegration('ios/Demo/AppDelegate.swift', swiftTernary)).toBe(false);
    expect(hasBareIosStartupIntegration('ios/Demo/AppDelegate.swift', deadFactoryBundle)).toBe(false);
    expect(hasBareIosStartupIntegration(
      'ios/Demo/AppDelegate.swift',
      bypassedAppDelegateBundle,
    )).toBe(false);
    expect(hasBareIosStartupIntegration('ios/Demo/AppDelegate.mm', deadObjcDelegation)).toBe(false);
  });

  it('removes DEBUG-only elseif branches from mixed preprocessor chains', () => {
    const mixedSwift = [
      'import BundleDrop',
      'class AppDelegate {',
      '  func bundleURL() -> URL? {',
      '#if FEATURE_PREVIEW',
      '    return Bundle.main.url(forResource: "preview", withExtension: "jsbundle")',
      '#elseif DEBUG',
      '    return BundleDropLocator.bundleURL()',
      '#else',
      '    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
      '#endif',
      '  }',
      '}',
    ].join('\n');
    expect(hasBareIosStartupIntegration('ios/Demo/AppDelegate.swift', mixedSwift)).toBe(false);
  });

  it('rejects Objective-C class methods and compound Swift DEBUG projections', () => {
    const objcClassMethods = [
      '#import <BundleDrop/BundleDropLocator.h>',
      '@implementation AppDelegate',
      '+ (NSURL *)bundleURL { return [BundleDropLocator bundleURL]; }',
      '+ (NSURL *)sourceURLForBridge:(RCTBridge *)bridge { return [self bundleURL]; }',
      '@end',
    ].join('\n');
    const swiftCompoundDebug = (condition: string, debugBranchFirst: boolean) => [
      'import BundleDrop',
      'class AppDelegate: RCTAppDelegate {',
      '  override func bundleURL() -> URL? {',
      `#if ${condition}`,
      debugBranchFirst
        ? '    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")'
        : '    return BundleDropLocator.bundleURL()',
      '#else',
      debugBranchFirst
        ? '    return BundleDropLocator.bundleURL()'
        : '    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
      '#endif',
      '  }',
      '}',
    ].join('\n');

    expect(hasBareIosStartupIntegration('ios/Demo/AppDelegate.mm', objcClassMethods)).toBe(false);
    expect(hasBareIosStartupIntegration(
      'ios/Demo/AppDelegate.swift',
      swiftCompoundDebug('DEBUG || FEATURE_OFFLINE', true),
    )).toBe(false);
    expect(hasBareIosStartupIntegration(
      'ios/Demo/AppDelegate.swift',
      swiftCompoundDebug('!DEBUG && USE_OTA', false),
    )).toBe(false);
  });

  it('accepts safe NativePaths context references and rejects computed arguments', () => {
    for (const context of ['this', 'this@MainApplication', 'appContext', 'holder.appContext']) {
      expect(hasBareAndroidStartupIntegration(
        RN71_KOTLIN_NATIVE_PATHS_MAIN_APPLICATION.replace('this@MainApplication', context),
      )).toBe(true);
    }
    expect(hasBareAndroidStartupIntegration(
      RN71_KOTLIN_NATIVE_PATHS_MAIN_APPLICATION.replace(
        'this@MainApplication',
        'resolveContext()',
      ),
    )).toBe(false);
  });

  it('rejects Swift and Objective-C dead owners and near-match lifecycle methods', () => {
    const swiftHelper = [
      'import BundleDrop',
      'class AppDelegate { func bundleURL() -> URL? { nil } }',
      'class Helper { func bundleURL() -> URL? { BundleDropLocator.bundleURL() } }',
    ].join('\n');
    const swiftNearMatch = [
      'import BundleDrop',
      'class AppDelegate {',
      '  func bundleURL() -> URL? { nil }',
      '  func bundleURLForTests() -> URL? { BundleDropLocator.bundleURL() }',
      '}',
    ].join('\n');
    const swiftParameterized = [
      'import BundleDrop',
      'class AppDelegate {',
      '  func bundleURL(test: Bool) -> URL? { BundleDropLocator.bundleURL() }',
      '}',
    ].join('\n');
    const objcHelper = [
      '#import <BundleDrop/BundleDropLocator.h>',
      '@implementation AppDelegate',
      '- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge { return nil; }',
      '@end',
      '@implementation Helper',
      '- (NSURL *)bundleURL { return [BundleDropLocator bundleURL]; }',
      '@end',
    ].join('\n');
    const objcNearMatch = [
      '#import <BundleDrop/BundleDropLocator.h>',
      '@implementation AppDelegate',
      '- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge { return nil; }',
      '- (NSURL *)sourceURLForBridgeForTests:(RCTBridge *)bridge {',
      '  return [BundleDropLocator bundleURL];',
      '}',
      '@end',
    ].join('\n');
    const objcCategory = [
      '#import <BundleDrop/BundleDropLocator.h>',
      '@implementation AppDelegate (BundleDrop)',
      '- (NSURL *)bundleURL { return [BundleDropLocator bundleURL]; }',
      '@end',
    ].join('\n');
    const objcDuplicate = [
      '#import <BundleDrop/BundleDropLocator.h>',
      '@implementation AppDelegate',
      '- (NSURL *)bundleURL { return [BundleDropLocator bundleURL]; }',
      '@end',
      '@implementation AppDelegate',
      '@end',
    ].join('\n');
    const explicitOtherPrincipal = [
      'import BundleDrop',
      '@main class RealAppDelegate: UIResponder, UIApplicationDelegate {}',
      'class AppDelegate: RCTAppDelegate {',
      '  override func bundleURL() -> URL? { BundleDropLocator.bundleURL() }',
      '}',
    ].join('\n');

    expect(hasBareIosStartupIntegration('ios/Demo/AppDelegate.swift', swiftHelper)).toBe(false);
    expect(hasBareIosStartupIntegration('ios/Demo/AppDelegate.swift', swiftNearMatch)).toBe(false);
    expect(hasBareIosStartupIntegration('ios/Demo/AppDelegate.swift', swiftParameterized))
      .toBe(false);
    expect(hasBareIosStartupIntegration('ios/Demo/AppDelegate.mm', objcHelper)).toBe(false);
    expect(hasBareIosStartupIntegration('ios/Demo/AppDelegate.mm', objcNearMatch)).toBe(false);
    expect(hasBareIosStartupIntegration('ios/Demo/AppDelegate.mm', objcCategory)).toBe(false);
    expect(hasBareIosStartupIntegration('ios/Demo/AppDelegate.mm', objcDuplicate)).toBe(false);
    expect(hasBareIosStartupIntegration('ios/Demo/AppDelegate.swift', explicitOtherPrincipal))
      .toBe(false);
  });

  it('rejects unresolved DEBUG conditions and competing Release returns', () => {
    const compoundDebugAndroid = RN71_KOTLIN_MAIN_APPLICATION.replace(
      'if (BuildConfig.DEBUG) {',
      'if (BuildConfig.DEBUG && featureFlag) {',
    ).replace(
      '"/data/local/tmp/dev.jsbundle"',
      'BundleDropModule.resolveJSBundleFile(this@MainApplication, null)!!',
    ).replace(
      /BundleDropModule\.resolveJSBundleFile\(\n            this@MainApplication,\n            "\/android_asset\/index\.android\.bundle",\n          \)!!/,
      '"/android_asset/index.android.bundle"',
    );
    const competingAndroid = RN71_KOTLIN_MAIN_APPLICATION.replace(
      /override fun getJSBundleFile\(\): String =[\s\S]*?\n    }\n}/,
      `override fun getJSBundleFile(): String? {
        if (false) return BundleDropModule.resolveJSBundleFile(this@MainApplication, null)
        return null
      }
    }
}`,
    );
    const competingSwift = [
      'import BundleDrop',
      'class AppDelegate: RCTAppDelegate {',
      '  override func bundleURL() -> URL? {',
      '    if false { return BundleDropLocator.bundleURL() }',
      '    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
      '  }',
      '}',
    ].join('\n');

    expect(hasBareAndroidStartupIntegration(compoundDebugAndroid)).toBe(false);
    expect(hasBareAndroidStartupIntegration(competingAndroid)).toBe(false);
    expect(hasBareIosStartupIntegration('ios/Demo/AppDelegate.swift', competingSwift)).toBe(false);
  });

  it('reports lifecycle, debug-provider, fallback, and delegation removal from startup bodies', () => {
    const originalAndroid = [
      'class MainApplication {',
      '  override fun onCreate() { super.onCreate(); loadReactNative(this) }',
      '}',
    ].join('\n');
    const updatedAndroid = originalAndroid.replace(
      'override fun onCreate() { super.onCreate(); loadReactNative(this) }',
      'fun onCreateForTests() { super.onCreate(); loadReactNative(this) }',
    );
    expect(findMissingBareNativeStartupStructure(
      'android/app/src/main/kotlin/demo/MainApplication.kt',
      originalAndroid,
      updatedAndroid,
    )).toContain('onCreate');

    const originalSwift = [
      'class AppDelegate: RCTAppDelegate {',
      '  override func bundleURL() -> URL? {',
      '    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")',
      '    Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
      '  }',
      '}',
    ].join('\n');
    const updatedSwift = [
      'class AppDelegate: RCTAppDelegate {',
      '  override func bundleURL() -> URL? { BundleDropLocator.bundleURL() }',
      '  func fallbackForTests() {',
      '    RCTBundleURLProvider.sharedSettings()',
      '    Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
      '  }',
      '}',
    ].join('\n');
    expect(findMissingBareNativeStartupStructure(
      'ios/Demo/AppDelegate.swift',
      originalSwift,
      updatedSwift,
    )).toEqual(expect.arrayContaining([
      'bundleURL/RCTBundleURLProvider',
      'bundleURL/Bundle.main.url',
    ]));

    const originalObjc = [
      '@implementation AppDelegate',
      '- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge { return [self bundleURL]; }',
      '- (NSURL *)bundleURL { return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"]; }',
      '@end',
    ].join('\n');
    const updatedObjc = originalObjc.replace(
      'return [self bundleURL];',
      'return [BundleDropLocator bundleURL];',
    );
    expect(findMissingBareNativeStartupStructure(
      'ios/Demo/AppDelegate.mm',
      originalObjc,
      updatedObjc,
    )).toContain('sourceURLForBridge/bundleURL delegation');
  });

  it('rejects invented imports, NativePaths-only references, comments, and strings', () => {
    expect(hasBareAndroidStartupIntegration([
      'import com.gfean.reactnativebundledrop.BundleDropModule',
      'class MainApplication {',
      '  override fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this, null)',
      '}',
    ].join('\n'))).toBe(false);
    expect(hasBareAndroidStartupIntegration([
      'import com.bundledrop.BundleDropNativePaths',
      'class MainApplication { val path = BundleDropNativePaths.getDownloadedBundlePath(this) }',
    ].join('\n'))).toBe(false);
    expect(hasBareIosStartupIntegration(
      'ios/Demo/AppDelegate.swift',
      'import ReactNativeBundleDrop\nclass AppDelegate { func bundleURL() -> URL? { BundleDropLocator.bundleURL() } }',
    )).toBe(false);
    expect(hasBareIosStartupIntegration(
      'ios/Demo/AppDelegate.swift',
      '// import BundleDrop\nlet marker = "BundleDropLocator.bundleURL()"',
    )).toBe(false);
  });

  it('strips supported comment and string forms while preserving executable code', () => {
    const source = [
      '// line comment',
      'const first = "double \\" quoted";',
      "const second = 'single \\' quoted';",
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

  it('does not expose resolver code hidden by nested Kotlin or Swift block comments', () => {
    const nestedKotlinComment = [
      'class MainApplication {',
      '  /* outer comment',
      '    /* nested comment */',
      '    import com.bundledrop.BundleDropModule',
      '    override fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this, null)',
      '  */',
      '}',
    ].join('\n');
    const nestedSwiftComment = [
      'import BundleDrop',
      'class AppDelegate: RCTAppDelegate {',
      '  /* outer comment',
      '    /* nested comment */',
      '    override func bundleURL() -> URL? { return BundleDropLocator.bundleURL() }',
      '  */',
      '}',
    ].join('\n');

    expect(hasBareAndroidStartupIntegration(nestedKotlinComment)).toBe(false);
    expect(hasBareIosStartupIntegration(
      'ios/Demo/AppDelegate.swift',
      nestedSwiftComment,
    )).toBe(false);
  });

  it('rejects Bundle Drop and CodePush co-authority but ignores comments and strings', () => {
    const configured = RN71_KOTLIN_MAIN_APPLICATION;
    expect(hasBareAndroidStartupIntegration(configured.replace(
      '"/android_asset/index.android.bundle",',
      'CodePush.getJSBundleFile(),',
    ))).toBe(false);
    expect(hasBareAndroidStartupIntegration([
      '// CodePush.getJSBundleFile() is intentionally not used.',
      configured,
      'val migrationNote = "CodePush"',
    ].join('\n'))).toBe(true);
  });
});
