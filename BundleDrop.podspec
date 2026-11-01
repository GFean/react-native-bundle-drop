require "digest"
require "fileutils"
require "json"
require "open3"
require "pathname"
require "shellwords"

bundle_drop_native_runtime_identity_resource = lambda do
  return nil unless defined?(Pod::Config)

  project_root = File.realpath(File.expand_path("..", Pod::Config.instance.installation_root.to_s))
  package_root = File.realpath(__dir__)
  # Relocation must not change the podspec checksum. Relative consumer paths also
  # keep different apps using one shared SDK package in separate resource slots.
  project_relative_root = Pathname.new(project_root).relative_path_from(Pathname.new(package_root)).to_s
  config_path = File.join(project_root, "bundle.drop.config.js")
  writer_path = File.join(
    package_root,
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
    Digest::SHA256.hexdigest(project_relative_root)[0, 16],
    "bundle-drop-build-identity.json"
  )
  output_path = File.join(package_root, resource_path)

  if File.file?(config_path)
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
  else
    # CocoaPods evaluates the podspec before `bundle-drop login` in the documented
    # fresh-install flow. Keep the resource and build phase in the Pods project so
    # the first native build can replace this inert placeholder after setup.
    FileUtils.mkdir_p(File.dirname(output_path))
    File.write(
      output_path,
      JSON.generate({
        "schemaVersion" => 1,
        "platform" => "ios",
        "source" => "unconfigured"
      }) + "\n"
    )
  end
  { :resource_path => resource_path, :project_relative_root => project_relative_root }
end

package = JSON.parse(File.read(File.join(__dir__, "package.json")))
native_version = package["nativeVersion"] || package["version"]
native_runtime_identity = bundle_drop_native_runtime_identity_resource.call

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
  s.resources = native_runtime_identity[:resource_path] if native_runtime_identity
  if native_runtime_identity
    # Intentionally omit output files so Xcode reruns this when a bare app builds,
    # even when CocoaPods has not been reinstalled since its config changed.
    s.script_phase = {
      :name => "Regenerate Bundle Drop runtime identity",
      :execution_position => :before_compile,
      :show_env_vars_in_log => "0",
      :script => <<-SCRIPT
set -e
package_root="$(cd "${PODS_TARGET_SRCROOT:?CocoaPods package root is missing}" && pwd -P)"
"${NODE_BINARY:-node}" \
  "$package_root/lib/CLI/scripts/native/write-runtime-identity.js" \
  --project-root "$package_root"/#{Shellwords.escape(native_runtime_identity[:project_relative_root])} \
  --platform ios \
  --output "$package_root"/#{Shellwords.escape(native_runtime_identity[:resource_path])}
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
