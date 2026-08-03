export type ProjectType = 'expo' | 'bare';

export type MobilePlatform = 'ios' | 'android';

export type JavaScriptEngine = 'hermes' | 'jsc';

export type ExpoRuntimeVersionPolicy =
  | 'literal'
  | 'appVersion'
  | 'nativeVersion'
  | 'sdkVersion'
  | 'fingerprint';

export type ExpoBuildIdentity = {
  platform: MobilePlatform;
  runtimeVersion: string;
  runtimeVersionPolicy: ExpoRuntimeVersionPolicy;
  expoSdkVersion: string;
  reactNativeVersion: string;
  javaScriptEngine: JavaScriptEngine;
  appVersion: string;
  nativeVersion: string;
  identityHash: string;
};
