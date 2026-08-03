require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))
native_version = package["nativeVersion"] || package["version"]

Pod::Spec.new do |s|
  s.name         = "BundleDrop"
  s.version      = native_version
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => "13.0" }
  s.source       = { :git => ".git", :tag => "#{s.version}" }

  s.source_files = "ios/**/*.{h,m,mm,swift}", "third_party/xdelta/**/*.{c,h}"
  s.public_header_files = "ios/BundleDropLocator.h", "ios/BundleDropZipExtractor.h"
  s.private_header_files = "third_party/xdelta/**/*.h"
  s.pod_target_xcconfig = {
    "GCC_C_LANGUAGE_STANDARD" => "c11",
    "GCC_PREPROCESSOR_DEFINITIONS" => "$(inherited) HAVE_CONFIG_H=1",
    "HEADER_SEARCH_PATHS" => "$(inherited) \"${PODS_TARGET_SRCROOT}/third_party/xdelta\" \"${PODS_TARGET_SRCROOT}/third_party/xdelta/xdelta3\""
  }
  s.libraries    = "z"
  s.swift_version = "5.0"

  if respond_to?(:install_modules_dependencies, true)
    install_modules_dependencies(s)
  else
    s.dependency "React-Core"
  end
end
