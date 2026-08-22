export const RN85_SWIFT_APP_DELEGATE = `import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import BundleDrop

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    window = UIWindow(frame: UIScreen.main.bounds)

    factory.startReactNative(
      withModuleName: "BundleDropDemo",
      in: window,
      launchOptions: launchOptions
    )

    return true
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    BundleDropLocator.bundleURL() ?? RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    BundleDropLocator.bundleURL() ?? Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
`;

export const RN85_ANDROID_NATIVE_PATHS_MAIN_APPLICATION = `package app.bundledrop.harness.rn85

import android.app.Application
import com.bundledrop.BundleDropNativePaths
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          // add(MyReactNativePackage())
        },
      jsBundleFilePath = BundleDropNativePaths.getDownloadedBundlePath(applicationContext),
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
`;

export const RN71_KOTLIN_MAIN_APPLICATION = `package com.demo

import com.bundledrop.BundleDropModule
import com.facebook.react.ReactNativeHost
import com.facebook.react.defaults.DefaultReactNativeHost

class MainApplication {
  override val reactNativeHost: ReactNativeHost =
    object : DefaultReactNativeHost(this) {
      override fun getJSBundleFile(): String =
        if (BuildConfig.DEBUG) {
          "/data/local/tmp/dev.jsbundle"
        } else {
          BundleDropModule.resolveJSBundleFile(
            this@MainApplication,
            "/android_asset/index.android.bundle",
          )!!
        }
    }
}
`;

export const RN71_KOTLIN_CONDITIONAL_FALLBACK_MAIN_APPLICATION = `package com.demo

import com.bundledrop.BundleDropModule
import com.facebook.react.ReactNativeHost
import com.facebook.react.defaults.DefaultReactNativeHost

class MainApplication {
  override val reactNativeHost: ReactNativeHost =
    object : DefaultReactNativeHost(this) {
      override fun getJSBundleFile(): String? {
        val fallback = if (enterprisePolicy.enabled) {
          selectEnterpriseBundle()
        } else {
          embeddedBundlePath()
        }
        return BundleDropModule.resolveJSBundleFile(this@MainApplication, fallback) ?: fallback
      }
    }
}
`;

export const RN71_JAVA_MAIN_APPLICATION = `package com.demo;

import com.bundledrop.BundleDropModule;
import com.facebook.react.ReactNativeHost;
import com.facebook.react.defaults.DefaultReactNativeHost;

public class MainApplication {
  private final ReactNativeHost mReactNativeHost = new DefaultReactNativeHost(this) {
    @Override
    protected String getJSBundleFile() {
      if (BuildConfig.DEBUG) {
        return null;
      }
      return BundleDropModule.resolveJSBundleFile(
        MainApplication.this,
        "/android_asset/index.android.bundle"
      );
    }
  };

  @Override
  public ReactNativeHost getReactNativeHost() {
    return mReactNativeHost;
  }
}
`;

export const RN71_JAVA_LOCAL_FALLBACK_MAIN_APPLICATION = `package com.demo;

import com.bundledrop.BundleDropModule;
import com.facebook.react.ReactNativeHost;
import com.facebook.react.defaults.DefaultReactNativeHost;

public class MainApplication {
  private final ReactNativeHost mReactNativeHost = new DefaultReactNativeHost(this) {
    @Override
    protected String getJSBundleFile() {
      return BundleDropModule.resolveJSBundleFile(
        getApplicationContext(),
        super.getJSBundleFile()
      );
    }
  };

  @Override
  public ReactNativeHost getReactNativeHost() {
    return mReactNativeHost;
  }
}
`;

export const RN71_JAVA_CONDITIONAL_FALLBACK_MAIN_APPLICATION = `package com.demo;

import com.bundledrop.BundleDropModule;
import com.facebook.react.ReactNativeHost;
import com.facebook.react.defaults.DefaultReactNativeHost;

public class MainApplication {
  private final ReactNativeHost mReactNativeHost = new DefaultReactNativeHost(this) {
    @Override
    protected String getJSBundleFile() {
      String fallback = enterprisePolicy.enabled
        ? selectEnterpriseBundle()
        : embeddedBundlePath();
      return BundleDropModule.resolveJSBundleFile(
        getApplicationContext(),
        fallback
      );
    }
  };

  @Override
  public ReactNativeHost getReactNativeHost() {
    return mReactNativeHost;
  }
}
`;

export const RN71_OBJC_APP_DELEGATE = `#import "AppDelegate.h"
#import <React/RCTBundleURLProvider.h>
#import <BundleDrop/BundleDropLocator.h>

@implementation AppDelegate

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}

- (NSURL *)bundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  NSURL *otaURL = [BundleDropLocator bundleURL];
  if (otaURL != nil) { return otaURL; }
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

@end
`;

export const MODERN_KOTLIN_MAIN_APPLICATION = `package com.demo

import com.bundledrop.BundleDropModule
import com.facebook.react.ReactHost

class MainApplication {
  private fun getJSBundleFile(): String? =
    if (BuildConfig.DEBUG) null
    else BundleDropModule.resolveJSBundleFile(this, null)

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList = emptyList(),
      jsBundleFilePath = getJSBundleFile(),
    )
  }
}
`;

export const RN71_KOTLIN_NATIVE_PATHS_MAIN_APPLICATION = `package com.demo

import com.facebook.react.ReactNativeHost
import com.facebook.react.defaults.DefaultReactNativeHost

class MainApplication {
  override val reactNativeHost: ReactNativeHost =
    object : DefaultReactNativeHost(this) {
      override fun getJSBundleFile(): String? =
        com.bundledrop.BundleDropNativePaths.getDownloadedBundlePath(this@MainApplication)
    }
}
`;
