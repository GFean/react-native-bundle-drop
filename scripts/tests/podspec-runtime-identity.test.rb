require 'cocoapods'
require 'fileutils'
require 'json'
require 'minitest/autorun'
require 'open3'
require 'tmpdir'

class PodspecRuntimeIdentityTest < Minitest::Test
  SDK_ROOT = File.expand_path('../..', __dir__)

  def setup
    @temporary = Dir.mktmpdir("Bundle Drop ' $ podspec ")
    @previous_installation_root = Pod::Config.instance.installation_root
  end

  def teardown
    Pod::Config.instance.installation_root = @previous_installation_root
    FileUtils.remove_entry(@temporary)
  end

  def package_at(workspace)
    package = File.join(workspace, 'node_modules', '@gfean', 'bundle drop SDK')
    writer = File.join(package, 'lib/CLI/scripts/native/write-runtime-identity.js')
    FileUtils.mkdir_p(File.dirname(writer))
    FileUtils.cp(File.join(SDK_ROOT, 'BundleDrop.podspec'), package)
    FileUtils.cp(File.join(SDK_ROOT, 'package.json'), package)
    # Exercise the podspec's argument/path boundary with a deterministic writer.
    # Real writer/selector/fingerprint behavior has separate SDK tests and QA gates.
    File.write(writer, <<~JS)
      const fs = require('node:fs');
      const path = require('node:path');
      const args = Object.fromEntries(Array.from({length: (process.argv.length - 2) / 2}, (_, i) => process.argv.slice(2 + i * 2, 4 + i * 2)));
      const root = fs.realpathSync(args['--project-root']);
      const config = require(path.join(root, 'bundle.drop.config.js'));
      fs.mkdirSync(path.dirname(args['--output']), {recursive: true});
      fs.writeFileSync(args['--output'], JSON.stringify({schemaVersion: 1, platform: 'ios',
        source: config.projectType === 'expo' ? 'expo' : 'bundle-drop',
        runtimeVersion: config.runtimeVersion.ios, seenProjectRoot: root}));
    JS
    package
  end

  def app_at(workspace, name, runtime = 'manual-one', kind = 'bare')
    app = File.join(workspace, 'apps', name)
    FileUtils.mkdir_p(File.join(app, 'ios'))
    configure(app, runtime, kind) if runtime
    app
  end

  def configure(app, runtime, kind = 'bare')
    File.write(File.join(app, 'bundle.drop.config.js'),
      "module.exports = #{JSON.generate({projectType: kind, runtimeVersion: {ios: runtime}})};\n")
  end

  def evaluate(package, app)
    Pod::Config.instance.installation_root = Pathname.new(File.join(app, 'ios'))
    Pod::Spec.from_file(File.join(package, 'BundleDrop.podspec'))
  end

  def output_path(package, spec)
    File.join(package, spec.attributes_hash.fetch('resources'))
  end

  def regenerate(spec, package, node = ENV.fetch('NODE_BINARY', 'node'))
    Open3.capture3({'PODS_TARGET_SRCROOT' => package, 'NODE_BINARY' => node},
      '/bin/sh', '-c', spec.consumer(:ios).script_phases.fetch(0).fetch(:script))
  end

  def test_equivalent_relocated_layouts_have_identical_evaluated_specs
    specs = ['first checkout', 'relocated checkout'].map do |location|
      workspace = File.join(@temporary, location)
      package = package_at(workspace)
      app = app_at(workspace, "consumer ' $ app")
      spec = evaluate(package, app)
      refute_includes spec.to_pretty_json, @temporary
      spec.to_pretty_json
    end
    assert_equal specs.first, specs.last
  end

  def test_shared_sdk_consumers_keep_separate_resources_and_regenerate_independently
    package = package_at(@temporary)
    first = app_at(@temporary, "first ' $ app", 'manual-first')
    second = app_at(@temporary, 'second app', 'manual-second')
    first_spec = evaluate(package, first)
    second_spec = evaluate(package, second)
    first_output, second_output = [first_spec, second_spec].map { |spec| output_path(package, spec) }
    refute_equal first_output, second_output
    configure(first, 'bdfp1-new-config')
    _, stderr, status = regenerate(first_spec, package)
    assert status.success?, stderr
    assert_equal 'bdfp1-new-config', JSON.parse(File.read(first_output)).fetch('runtimeVersion')
    assert_equal 'manual-second', JSON.parse(File.read(second_output)).fetch('runtimeVersion')
  end

  def test_symlink_aliases_keep_metadata_and_quoted_build_arguments_stable
    package = package_at(@temporary)
    app = app_at(@temporary, "consumer ' $ app")
    original = evaluate(package, app)
    package_alias = File.join(@temporary, "SDK ' alias")
    app_alias = File.join(@temporary, 'app alias')
    File.symlink(package, package_alias)
    File.symlink(app, app_alias)
    aliased = evaluate(package_alias, app_alias)
    assert_equal original.to_pretty_json, aliased.to_pretty_json
    _, stderr, status = regenerate(aliased, package_alias)
    assert status.success?, stderr
    assert_equal File.realpath(app), JSON.parse(File.read(output_path(package, original))).fetch('seenProjectRoot')
  end

  def test_unconfigured_placeholder_supports_setup_then_build_without_pod_reinstallation
    package = package_at(@temporary)
    app = app_at(@temporary, 'fresh app', nil)
    spec = evaluate(package, app)
    output = output_path(package, spec)
    assert_equal 'unconfigured', JSON.parse(File.read(output)).fetch('source')
    configure(app, 'manual-after-setup')
    _, stderr, status = regenerate(spec, package)
    assert status.success?, stderr
    assert_equal 'manual-after-setup', JSON.parse(File.read(output)).fetch('runtimeVersion')
    refute spec.consumer(:ios).script_phases.first.key?(:output_files)
  end

  def test_expo_omits_bare_resource_and_script_phase
    package = package_at(@temporary)
    app = app_at(@temporary, 'expo app', 'expo-policy', 'expo')
    spec = evaluate(package, app)
    assert_nil spec.attributes_hash['resources']
    assert_empty spec.consumer(:ios).script_phases
  end

  def test_missing_writer_and_build_environment_fail_closed
    package = package_at(@temporary)
    app = app_at(@temporary, 'bare app')
    spec = evaluate(package, app)
    _, _, status = regenerate(spec, '')
    refute status.success?
    _, _, status = regenerate(spec, package, '/usr/bin/false')
    refute status.success?
    FileUtils.rm(File.join(package, 'lib/CLI/scripts/native/write-runtime-identity.js'))
    assert_raises(Pod::Informative) { evaluate(package, app) }
  end
end
