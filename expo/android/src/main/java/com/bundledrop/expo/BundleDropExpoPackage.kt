package com.bundledrop.expo

import android.content.Context
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactNativeHostHandler

class BundleDropExpoPackage : Package, ReactPackage {
  override fun createReactNativeHostHandlers(
    context: Context,
  ): List<ReactNativeHostHandler> {
    return listOf(BundleDropExpoReactNativeHostHandler(context))
  }

  override fun createNativeModules(
    reactContext: ReactApplicationContext,
  ): List<NativeModule> {
    return listOf(BundleDropExpoIdentityModule(reactContext))
  }

  override fun createViewManagers(
    reactContext: ReactApplicationContext,
  ): List<ViewManager<*, *>> {
    return emptyList()
  }
}
