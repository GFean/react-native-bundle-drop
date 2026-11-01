import Foundation
import React
import UIKit

/// Checks rendered views against the registry owned by one React runtime.
enum BundleDropReactContent {
  static func ownsRoot(_ object: AnyObject, in registry: RCTUIManager) -> Bool {
    guard let root = object as? UIView,
          rootClasses.contains(where: { root.isKind(of: $0) }),
          let view = registeredView(root, in: registry),
          !view.subviews.isEmpty else { return false }
    // Fabric reports its component; legacy reports the enclosing RCTRootView.
    return view === root || view.superview === root
  }

  static func currentRoot(in registry: RCTUIManager) -> UIView? {
    dispatchPrecondition(condition: .onQueue(.main))
    // Lazy routes can import the SDK after the root's one-time content event.
    // Require both a mounted root and a child registered to this same runtime.
    var windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
    if windows.isEmpty { windows = UIApplication.shared.windows }
    var pending: [UIView] = windows
    while let view = pending.popLast() {
      if view.window != nil,
         rootClasses.contains(where: { view.isKind(of: $0) }),
         registeredView(view, in: registry) === view,
         hasRegisteredChild(view, in: registry) {
        return view
      }
      pending.append(contentsOf: view.subviews)
    }
    return nil
  }

  private static var rootClasses: [AnyClass] {
    ["RCTRootComponentView", "RCTRootContentView", "RCTRootView"].compactMap(NSClassFromString)
  }

  private static func hasRegisteredChild(_ root: UIView, in registry: RCTUIManager) -> Bool {
    var pending = root.subviews
    while let view = pending.popLast() {
      if registeredView(view, in: registry) === view { return true }
      pending.append(contentsOf: view.subviews)
    }
    return false
  }

  private static func registeredView(_ view: UIView, in registry: RCTUIManager) -> UIView? {
    guard let tag = view.reactTag ?? (view.tag > 0 ? NSNumber(value: view.tag) : nil) else { return nil }
    return registry.view(forReactTag: tag)
  }
}
