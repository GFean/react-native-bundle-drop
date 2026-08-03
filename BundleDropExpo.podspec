require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))
native_version = package["nativeVersion"] || package["version"]

Pod::Spec.new do |s|
  s.name = "BundleDropExpo"
  s.version = native_version
  s.summary = "Expo startup adapter for Bundle Drop"
  s.homepage = package["homepage"]
  s.license = package["license"]
  s.authors = package["author"]
  s.source = { :git => ".git", :tag => "#{s.version}" }

  s.platforms = { :ios => "15.1" }
  s.source_files = "expo/ios/Sources/**/*.{h,m,mm,swift}"
  s.static_framework = true
  s.swift_version = "5.9"
  s.dependency "BundleDrop"
  s.dependency "ExpoModulesCore"
end
