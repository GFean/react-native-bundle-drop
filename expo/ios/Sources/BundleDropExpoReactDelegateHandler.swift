import ExpoModulesCore
import Foundation
import BundleDrop

public final class BundleDropExpoReactDelegateHandler: ExpoReactDelegateHandler {
  private static let enabledInfoPlistKey = "BundleDropExpoEnabled"

  public override func bundleURL(reactDelegate: ExpoReactDelegate) -> URL? {
    guard Self.isEnabled else { return nil }
    guard !Self.isDeveloperSupportBuild else { return nil }
    return BundleDropLocatorCore.bundleURL()
  }

  private static var isEnabled: Bool {
    Bundle.main.object(forInfoDictionaryKey: enabledInfoPlistKey) as? Bool == true
  }

  private static var isDeveloperSupportBuild: Bool {
    // Use the same signal as Expo's dev-launcher and dev-menu handlers. A
    // production app may link expo-dev-client without enabling developer
    // support, so class presence is not a reliable ownership signal.
    EXAppDefines.APP_DEBUG
  }
}
