import Foundation
import XCTest
@testable import BundleDropIOSCore

final class BundleDropStartupContentBindingsTests: XCTestCase {
  func testLateRegistrationChecksAlreadyRenderedOwnedContent() throws {
    let bindings = BundleDropStartupContentBindings()
    let center = NotificationCenter()
    let root = NSObject()
    let url = URL(fileURLWithPath: "/tmp/rendered/main.jsbundle")
    bindings.capture(hash: "candidate", attemptId: "late", bundleURL: url)
    let appeared = expectation(description: "Previously rendered owned root")
    let observer = try XCTUnwrap(bindings.observeRuntimeContent(
      bundleURL: url, notificationCenter: center,
      currentContentRoot: { root }, ownsRoot: { $0 === root },
      contentAppeared: { binding in
        XCTAssertEqual(binding.attemptId, "late")
        appeared.fulfill()
      }
    ))
    defer { center.removeObserver(observer) }
    wait(for: [appeared], timeout: 1)
  }

  func testLateProbeStillRequiresRuntimeRootOwnership() throws {
    let bindings = BundleDropStartupContentBindings()
    let center = NotificationCenter()
    let root = NSObject()
    let foreignRoot = NSObject()
    let url = URL(fileURLWithPath: "/tmp/runtime/main.jsbundle")
    bindings.capture(hash: "candidate", attemptId: "attempt", bundleURL: url)
    let observer = try XCTUnwrap(bindings.observeRuntimeContent(
      bundleURL: url, notificationCenter: center,
      currentContentRoot: { foreignRoot }, ownsRoot: { $0 === root },
      contentAppeared: { _ in XCTFail("A foreign root acknowledged health") }
    ))
    defer { center.removeObserver(observer) }
    let drained = expectation(description: "Probe completed")
    DispatchQueue.main.async { drained.fulfill() }
    wait(for: [drained], timeout: 1)
  }

  func testDelayedProbeKeepsTheAttemptCapturedBeforeReload() throws {
    let bindings = BundleDropStartupContentBindings()
    let center = NotificationCenter()
    let root = NSObject()
    let url = URL(fileURLWithPath: "/tmp/same/main.jsbundle")
    bindings.capture(hash: "candidate", attemptId: "old", bundleURL: url)
    let appeared = expectation(description: "Old probe keeps its old attempt")
    let observer = try XCTUnwrap(bindings.observeRuntimeContent(
      bundleURL: url, notificationCenter: center,
      currentContentRoot: { root }, ownsRoot: { $0 === root },
      contentAppeared: { binding in
        XCTAssertEqual(binding.attemptId, "old")
        appeared.fulfill()
      }
    ))
    defer { center.removeObserver(observer) }
    bindings.capture(hash: "candidate", attemptId: "new", bundleURL: url)
    wait(for: [appeared], timeout: 1)
  }

  func testOwnedContentAcknowledgesItsRuntimeWithoutLegacyLoadNotification() throws {
    let bindings = BundleDropStartupContentBindings()
    let center = NotificationCenter()
    let root = NSObject()
    let unrelatedRoot = NSObject()
    let url = URL(fileURLWithPath: "/tmp/runtime/main.jsbundle")
    bindings.capture(hash: "candidate", attemptId: "attempt", bundleURL: url)
    var appeared: [BundleDropStartupContentBindings.Binding] = []
    let observer = try XCTUnwrap(bindings.observeRuntimeContent(
      bundleURL: url,
      notificationCenter: center,
      ownsRoot: { $0 === root },
      contentAppeared: { appeared.append($0) }
    ))
    defer { center.removeObserver(observer) }

    center.post(name: Notification.Name("RCTInstanceDidLoadBundle"), object: nil)
    center.post(name: Notification.Name("RCTContentDidAppearNotification"), object: nil)
    center.post(name: Notification.Name("RCTContentDidAppearNotification"), object: unrelatedRoot)
    XCTAssertTrue(appeared.isEmpty)
    center.post(name: Notification.Name("RCTContentDidAppearNotification"), object: root)
    XCTAssertEqual(appeared.map(\.attemptId), ["attempt"])
    XCTAssertEqual(appeared.map(\.bundlePath), [url.path])

    // A legacy/global notification cannot bypass the module's root registry.
    bindings.runtimeDidLoad(bundleURL: url)
    XCTAssertNil(bindings.binding(for: unrelatedRoot))
    XCTAssertNil(bindings.binding(for: root))
  }

  func testUnrelatedRuntimeCannotInstallAnOwnedContentObserver() {
    let bindings = BundleDropStartupContentBindings()
    bindings.capture(
      hash: "candidate", attemptId: "attempt",
      bundleURL: URL(fileURLWithPath: "/tmp/selected/main.jsbundle")
    )
    XCTAssertNil(bindings.observeRuntimeContent(
      bundleURL: URL(fileURLWithPath: "/tmp/other/main.jsbundle"),
      notificationCenter: NotificationCenter(),
      ownsRoot: { _ in true },
      contentAppeared: { _ in XCTFail("Unrelated runtime acknowledged content") }
    ))
    XCTAssertNil(bindings.binding(for: NSObject()))
  }

  func testOldObserverKeepsItsAttemptWhenTheSameBundleReloads() throws {
    let bindings = BundleDropStartupContentBindings()
    let center = NotificationCenter()
    let oldRoot = NSObject()
    let newRoot = NSObject()
    let url = URL(fileURLWithPath: "/tmp/same-candidate/main.jsbundle")
    var appeared: [String] = []
    bindings.capture(hash: "candidate", attemptId: "old", bundleURL: url)
    let oldObserver = try XCTUnwrap(bindings.observeRuntimeContent(
      bundleURL: url, notificationCenter: center,
      ownsRoot: { $0 === oldRoot }, contentAppeared: { appeared.append($0.attemptId) }
    ))
    defer { center.removeObserver(oldObserver) }
    bindings.capture(hash: "candidate", attemptId: "new", bundleURL: url)
    let newObserver = try XCTUnwrap(bindings.observeRuntimeContent(
      bundleURL: url, notificationCenter: center,
      ownsRoot: { $0 === newRoot }, contentAppeared: { appeared.append($0.attemptId) }
    ))
    defer { center.removeObserver(newObserver) }

    center.post(name: Notification.Name("RCTContentDidAppearNotification"), object: oldRoot)
    XCTAssertEqual(appeared, ["old"])
    center.post(name: Notification.Name("RCTContentDidAppearNotification"), object: newRoot)
    XCTAssertEqual(appeared, ["old", "new"])
  }
}
