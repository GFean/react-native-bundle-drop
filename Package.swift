// swift-tools-version: 5.9

import PackageDescription

let package = Package(
  name: "BundleDropNative",
  platforms: [
    .macOS(.v13),
  ],
  targets: [
    .target(
      name: "BundleDropXdeltaNative",
      path: "third_party/xdelta",
      exclude: [
        "NOTICE",
        "PROVENANCE.md",
        "README.md",
        "xdelta3/README.md",
        "xdelta3/LICENSE",
      ],
      sources: [
        "bundle_drop_xdelta.c",
        "xdelta3/xdelta3.c",
      ],
      publicHeadersPath: ".",
      cSettings: [
        .define("HAVE_CONFIG_H", to: "1"),
        .unsafeFlags(["-std=c11"]),
      ]
    ),
    .target(
      name: "BundleDropZipExtractorObjC",
      path: "ios",
      exclude: [
        "BundleDropBridge.m",
        "BundleDropBundleVerifier.swift",
        "BundleDropFileOps.swift",
        "BundleDropLocator.h",
        "BundleDropLocator.m",
        "BundleDropLocator.swift",
        "BundleDropModule.swift",
        "BundleDropOtaResolver.swift",
      ],
      sources: [
        "BundleDropZipExtractor.m",
      ],
      publicHeadersPath: ".",
      cSettings: [
        .unsafeFlags([
          "-fprofile-instr-generate",
          "-fcoverage-mapping",
        ]),
      ],
      linkerSettings: [
        .linkedLibrary("z"),
      ]
    ),
    .target(
      name: "BundleDropIOSCore",
      dependencies: [
        "BundleDropXdeltaNative",
      ],
      path: "ios",
      exclude: [
        "BundleDropBridge.m",
        "BundleDropLocator.h",
        "BundleDropLocator.m",
        "BundleDropModule.swift",
        "BundleDropZipExtractor.h",
        "BundleDropZipExtractor.m",
      ],
      sources: [
        "BundleDropFileOps.swift",
        "BundleDropBundleVerifier.swift",
        "BundleDropLocator.swift",
        "BundleDropOtaResolver.swift",
      ]
    ),
    .testTarget(
      name: "BundleDropIOSTests",
      dependencies: [
        "BundleDropIOSCore",
        "BundleDropZipExtractorObjC",
      ],
      path: "ios-tests"
    ),
  ]
)
