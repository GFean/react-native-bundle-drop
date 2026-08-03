package com.bundledrop.gradle

import javax.inject.Inject
import org.gradle.api.DefaultTask
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import org.gradle.process.ExecOperations

abstract class GenerateBundleDropBuildIdentityTask extends DefaultTask {
  @Input
  abstract Property<String> getAppVersion()

  @Input
  abstract Property<String> getNativeBuildVersion()

  @Input
  abstract Property<String> getNodeBinary()

  @InputFile
  @PathSensitive(PathSensitivity.NONE)
  abstract RegularFileProperty getReceiptWriter()

  @Internal
  abstract DirectoryProperty getExpoProjectRoot()

  @OutputDirectory
  abstract DirectoryProperty getOutputDirectory()

  @Inject
  abstract ExecOperations getExecOperations()

  @TaskAction
  void generateIdentity() {
    def projectRoot = expoProjectRoot.get().asFile
    def outputFile = outputDirectory.file('bundle-drop/build-identity.json').get().asFile

    execOperations.exec { spec ->
      spec.workingDir projectRoot
      spec.executable nodeBinary.get()
      spec.args([
        receiptWriter.get().asFile.path,
        '--project-root', projectRoot.path,
        '--candidate-output', outputFile.path,
        '--app-version', appVersion.get(),
        '--native-build-version', nativeBuildVersion.get()
      ])
    }.assertNormalExitValue()
  }
}
