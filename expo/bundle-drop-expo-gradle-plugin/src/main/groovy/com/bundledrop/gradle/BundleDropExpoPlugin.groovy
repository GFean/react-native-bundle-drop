package com.bundledrop.gradle

import org.gradle.api.GradleException
import org.gradle.api.Plugin
import org.gradle.api.Project

class BundleDropExpoPlugin implements Plugin<Project> {
  private static final String EXPO_ADAPTER_PROJECT = ':bundledrop-expo'

  @Override
  void apply(Project project) {
    def packageRoot = resolvePackageRoot(project)
    def receiptWriter = new File(
      packageRoot,
      'lib/CLI/scripts/expo/write-build-receipt.js'
    ).canonicalFile
    if (!receiptWriter.isFile()) {
      throw new GradleException(
        "Bundle Drop receipt writer is missing from the installed package: ${receiptWriter}"
      )
    }

    def androidComponents = project.extensions.getByName('androidComponents')
    androidComponents.onVariants(
      androidComponents.selector().withBuildType('release')
    ) { variant ->
      registerIdentityAsset(project, variant, receiptWriter)
    }
  }

  private static File resolvePackageRoot(Project project) {
    def adapterProject = project.rootProject.findProject(EXPO_ADAPTER_PROJECT)
    if (adapterProject == null) {
      throw new GradleException(
        "Bundle Drop could not find the autolinked ${EXPO_ADAPTER_PROJECT} project."
      )
    }

    def packageRoot = adapterProject.projectDir.parentFile.parentFile.canonicalFile
    if (!new File(packageRoot, 'package.json').isFile()) {
      throw new GradleException(
        "Bundle Drop could not resolve its package root from ${adapterProject.projectDir}."
      )
    }
    return packageRoot
  }

  private static void registerIdentityAsset(Project project, variant, File receiptWriter) {
    if (variant.outputs.size() != 1) {
      throw new GradleException(
        "Bundle Drop requires one exact Android output for ${variant.name}."
      )
    }

    def variantOutput = variant.outputs.first()
    def capitalizedVariant = variant.name.substring(0, 1).toUpperCase() +
      variant.name.substring(1)
    def identityTask = project.tasks.register(
      "generateBundleDrop${capitalizedVariant}BuildIdentity",
      GenerateBundleDropBuildIdentityTask
    ) { task ->
      task.appVersion.set(variantOutput.versionName)
      task.nativeBuildVersion.set(variantOutput.versionCode.map { versionCode ->
        versionCode.toString()
      })
      task.nodeBinary.set(System.getenv('NODE_BINARY') ?: 'node')
      task.receiptWriter.set(receiptWriter)
      task.expoProjectRoot.set(project.rootProject.projectDir.parentFile)
      task.outputDirectory.set(
        project.layout.buildDirectory.dir(
          "generated/bundleDropIdentity/${variant.name}/assets"
        )
      )
      // Expo config and remote app-version state are resolved by the Node
      // writer, so always refresh this small deterministic build input.
      task.outputs.upToDateWhen { false }
    }

    variant.sources.assets.addGeneratedSourceDirectory(identityTask) { task ->
      task.outputDirectory
    }
  }
}
