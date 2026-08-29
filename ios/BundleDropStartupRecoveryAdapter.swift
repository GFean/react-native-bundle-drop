import Foundation
import ObjectiveC.runtime

/// Process-level integration between the startup ledger and React Native's
/// lifecycle. The controller itself remains Foundation-only and directly testable.
enum BundleDropStartupRecoveryAdapter {
  static let protocolVersion = BundleDropStartupRecoveryController.protocolVersion

  private static let lock = NSRecursiveLock()
  private static let processToken = UUID().uuidString.lowercased()
  private static var recoveryController: BundleDropStartupRecoveryController?
  private static var activeAttemptHash: String?
  private static var activeAttemptId: String?
  private static var selectedHash: String?
  private static var observersInstalled = false
  private static let contentBindings = BundleDropStartupContentBindings()

  static func selectStartupBundle(bundleDropRoot: URL) -> URL? {
    installReactLifecycleObservers()
    let selection = controller(bundleDropRoot: bundleDropRoot).selectStartupBundle()
    captureStartupSelection(selection)
    return selection.bundleURL
  }

  static func downloadedBundleURL() -> URL? {
    guard BundleDropLocatorCore.hasRuntimeIdentityForOta(),
          BundleDropLocatorCore.isOtaEnabled(),
          let root = defaultRoot() else {
      return nil
    }
    return controller(bundleDropRoot: root).passiveCurrentBundle()
  }

  static func activateCandidate(
    hash: String,
    maxCrashCount: Int,
    healthCheckMode: String,
    healthyAfterSec: Double
  ) throws -> BundleDropStartupActivationResult {
    try requireDefaultController().activateCandidate(
      hash: hash,
      maxCrashCount: maxCrashCount,
      healthCheckMode: healthCheckMode,
      healthyAfterSec: healthyAfterSec
    )
  }

  static func beginReload() -> URL? {
    guard let controller = defaultController() else { return nil }
    installReactLifecycleObservers()
    let selection = controller.selectStartupBundle(beginReload: true)
    captureStartupSelection(selection)
    return selection.bundleURL
  }

  static func markHealthy(hash: String, attemptId: String) -> Bool {
    guard let controller = defaultController() else { return false }
    let marked = controller.markHealthy(hash: hash, attemptId: attemptId)
    if marked { clearCapturedAttempt() }
    return marked
  }

  static func snapshot() throws -> [String: Any] {
    try requireDefaultController().snapshot()
  }

  static func setRevokedHashes(_ hashes: [String]) throws -> Bool {
    try requireDefaultController().setRevokedHashes(hashes)
    return true
  }

  static func acknowledgeRecovery(eventId: String) throws -> Bool {
    try requireDefaultController().acknowledgeRecovery(eventId: eventId)
  }

  static func rollback(forceEmbedded: Bool) throws -> BundleDropStartupRollbackResult {
    let result = try requireDefaultController().rollback(forceEmbedded: forceEmbedded)
    clearCapturedAttempt()
    return result
  }

  static func capturedAttempt() -> (hash: String?, attemptId: String?) {
    lock.lock()
    defer { lock.unlock() }
    return (activeAttemptHash, activeAttemptId)
  }

  static func clearCapturedAttempt() {
    captureAttempt(hash: nil, attemptId: nil)
  }

  static func capturedSelectedHash() -> String? {
    lock.lock()
    defer { lock.unlock() }
    return selectedHash
  }

  static func clearCapturedSelection() {
    lock.lock()
    activeAttemptHash = nil
    activeAttemptId = nil
    selectedHash = nil
    contentBindings.capture(hash: nil, attemptId: nil, bundleURL: nil)
    lock.unlock()
  }

  static func captureStartupSelection(_ selection: BundleDropStartupSelection) {
    lock.lock()
    activeAttemptHash = selection.attemptHash
    activeAttemptId = selection.attemptId
    let bundleHash = selection.bundleURL?
      .deletingLastPathComponent()
      .lastPathComponent
    selectedHash = bundleHash?.range(
      of: "^[a-f0-9]{64}$",
      options: .regularExpression
    ) == nil ? nil : bundleHash
    contentBindings.capture(
      hash: selection.attemptHash,
      attemptId: selection.attemptId,
      bundleURL: selection.bundleURL
    )
    lock.unlock()
  }

  private static func defaultRoot() -> URL? {
    FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first?
      .appendingPathComponent("bundle-drop", isDirectory: true)
  }

  private static func defaultController() -> BundleDropStartupRecoveryController? {
    defaultRoot().map(controller)
  }

  private static func requireDefaultController() throws -> BundleDropStartupRecoveryController {
    guard let controller = defaultController() else {
      throw BundleDropStartupRecoveryError.storageUnavailable
    }
    return controller
  }

  private static func controller(bundleDropRoot: URL) -> BundleDropStartupRecoveryController {
    lock.lock()
    defer { lock.unlock() }
    if let recoveryController { return recoveryController }
    let created = BundleDropStartupRecoveryController(
      bundleDropRoot: bundleDropRoot,
      expectedRuntimeVersion: BundleDropLocatorCore.getRuntimeVersion(),
      expectedBinaryIdentity: BundleDropLocatorCore.getBinaryVersionKey(),
      processToken: processToken
    )
    recoveryController = created
    return created
  }

  private static func captureAttempt(hash: String?, attemptId: String?) {
    lock.lock()
    activeAttemptHash = hash
    activeAttemptId = attemptId
    lock.unlock()
  }

  private static func installReactLifecycleObservers() {
    lock.lock()
    guard !observersInstalled else {
      lock.unlock()
      return
    }
    observersInstalled = true
    lock.unlock()

    NotificationCenter.default.addObserver(
      forName: Notification.Name("RCTJavaScriptDidLoadNotification"),
      object: nil,
      queue: nil
    ) { notification in
      contentBindings.runtimeDidLoad(bundleURL: bundleURL(from: notification))
    }

    NotificationCenter.default.addObserver(
      forName: Notification.Name("RCTContentDidAppearNotification"),
      object: nil,
      queue: nil
    ) { notification in
      guard let attempt = contentBindings.binding(for: notification.object) else { return }
      let hash = attempt.hash
      let attemptId = attempt.attemptId
      guard let delay = defaultController()?.markContentAppeared(
        hash: hash,
        attemptId: attemptId
      ) else { return }
      let markHealthy = {
        _ = BundleDropStartupRecoveryAdapter.markHealthy(hash: hash, attemptId: attemptId)
      }
      if delay <= 0 {
        markHealthy()
      } else {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: markHealthy)
      }
    }
  }

  static func bundleURL(from notification: Notification) -> URL? {
    let selector = NSSelectorFromString("bundleURL")
    let providers = [notification.userInfo?["bridge"], notification.object].compactMap { $0 }
    for provider in providers {
      let object = provider as AnyObject
      // RCTBridgeProxy forwards -bundleURL but reports responds(to:) as false.
      // Checking the concrete Objective-C implementation keeps URL identity
      // available in bridgeless RN without accepting an anonymous global event.
      guard object.responds(to: selector) ||
              class_getInstanceMethod(type(of: object), selector) != nil else {
        continue
      }
      if let url = object.perform(selector)?.takeUnretainedValue() as? URL {
        return url
      }
    }
    return nil
  }
}

/// Associates each React root with the startup attempt that selected its runtime.
/// Legacy and Fabric both post `RCTContentDidAppearNotification` with their root
/// object, so a notification arriving late from an older root remains bound to
/// the older attempt instead of blessing the newest reload.
final class BundleDropStartupContentBindings {
  struct Binding: Equatable {
    let generation: UInt64
    let hash: String
    let attemptId: String
    let bundlePath: String
  }

  private final class RootEntry {
    weak var root: AnyObject?
    let binding: Binding

    init(root: AnyObject, binding: Binding) {
      self.root = root
      self.binding = binding
    }
  }

  private let lock = NSLock()
  private var generation: UInt64 = 0
  private var activeBinding: Binding?
  private var activeRuntimeLoaded = false
  private var roots: [ObjectIdentifier: RootEntry] = [:]

  func capture(hash: String?, attemptId: String?, bundleURL: URL?) {
    lock.lock()
    defer { lock.unlock() }
    generation &+= 1
    if let hash, let attemptId, let bundleURL {
      activeBinding = Binding(
        generation: generation,
        hash: hash,
        attemptId: attemptId,
        bundlePath: Self.normalizedPath(bundleURL)
      )
    } else {
      activeBinding = nil
    }
    activeRuntimeLoaded = false
    roots = roots.filter { $0.value.root != nil }
  }

  func runtimeDidLoad(bundleURL: URL?) {
    lock.lock()
    defer { lock.unlock() }
    guard let activeBinding,
          let bundleURL,
          Self.normalizedPath(bundleURL) == activeBinding.bundlePath else {
      return
    }
    activeRuntimeLoaded = true
    // React may reuse an RCTRootView across legacy reloads. Once the selected
    // runtime has loaded, roots belong to the new generation when they next
    // report content appearance.
    roots.removeAll()
  }

  func binding(for root: Any?) -> Binding? {
    guard let root else { return nil }
    let rootObject = root as AnyObject
    lock.lock()
    defer { lock.unlock() }
    let identifier = ObjectIdentifier(rootObject)
    if let existing = roots[identifier], existing.root === rootObject {
      return existing.binding
    }
    guard activeRuntimeLoaded, let activeBinding else { return nil }
    roots[identifier] = RootEntry(root: rootObject, binding: activeBinding)
    return activeBinding
  }

  private static func normalizedPath(_ url: URL) -> String {
    url.standardizedFileURL.resolvingSymlinksInPath().path
  }
}
