require "digest"
require "json"
require "open3"
require "shellwords"

bundle_drop_native_runtime_identity_resource = lambda do
  return nil unless defined?(Pod::Config)

  project_root = File.expand_path("..", Pod::Config.instance.installation_root.to_s)
  config_path = File.join(project_root, "bundle.drop.config.js")
  return nil unless File.file?(config_path)

  writer_path = File.join(
    __dir__,
    "lib",
    "CLI",
    "scripts",
    "native",
    "write-runtime-identity.js"
  )
  unless File.file?(writer_path)
    raise Pod::Informative,
      "Bundle Drop native runtime identity writer is missing: #{writer_path}"
  end

  resource_path = File.join(
    "ios",
    "build",
    "generated",
    "runtime-identity",
    Digest::SHA256.hexdigest(project_root)[0, 16],
    "bundle-drop-build-identity.json"
  )
  output_path = File.join(__dir__, resource_path)
  stdout, stderr, status = Open3.capture3(
    ENV.fetch("NODE_BINARY", "node"),
    writer_path,
    "--project-root", project_root,
    "--platform", "ios",
    "--output", output_path
  )
  unless status.success?
    detail = stderr.strip.empty? ? stdout.strip : stderr.strip
    raise Pod::Informative,
      "Bundle Drop could not generate the iOS runtime identity: #{detail}"
  end

  identity = JSON.parse(File.read(output_path))
  return nil if identity["source"] == "expo"
  unless identity["runtimeVersion"].is_a?(String) && !identity["runtimeVersion"].empty?
    raise Pod::Informative, "Bundle Drop generated an invalid iOS runtime identity."
  end
  resource_path
end

package = JSON.parse(File.read(File.join(__dir__, "package.json")))
native_version = package["nativeVersion"] || package["version"]
native_runtime_identity_resource = bundle_drop_native_runtime_identity_resource.call
native_runtime_identity_project_root = if native_runtime_identity_resource
  File.expand_path("..", Pod::Config.instance.installation_root.to_s)
end
native_runtime_identity_writer = if native_runtime_identity_resource
  File.join(__dir__, "lib", "CLI", "scripts", "native", "write-runtime-identity.js")
end
native_runtime_identity_output = if native_runtime_identity_resource
  File.join(__dir__, native_runtime_identity_resource)
end

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
  s.resources = native_runtime_identity_resource if native_runtime_identity_resource
  if native_runtime_identity_resource
    # Intentionally omit output files so Xcode reruns this when a bare app builds,
    # even when CocoaPods has not been reinstalled since its config changed.
    s.script_phase = {
      :name => "Regenerate Bundle Drop runtime identity",
      :execution_position => :before_compile,
      :show_env_vars_in_log => "0",
      :script => <<-SCRIPT
set -e
"${NODE_BINARY:-node}" \
  #{Shellwords.escape(native_runtime_identity_writer)} \
  --project-root #{Shellwords.escape(native_runtime_identity_project_root)} \
  --platform ios \
  --output #{Shellwords.escape(native_runtime_identity_output)}
SCRIPT
    }
  end
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
