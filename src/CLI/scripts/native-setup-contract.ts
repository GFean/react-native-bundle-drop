export const ANDROID_BUNDLE_DROP_MODULE = 'com.bundledrop.BundleDropModule';
export const ANDROID_BUNDLE_DROP_PATHS = 'com.bundledrop.BundleDropNativePaths';
export const IOS_BUNDLE_DROP_MODULE = 'BundleDrop';
export const IOS_BUNDLE_DROP_LOCATOR_HEADER = 'BundleDrop/BundleDropLocator.h';

export const stripCommentsAndStrings = (content: string) => {
  let code = '';
  let state: 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template' = 'code';
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    const nextCharacter = content[index + 1];
    if (state === 'line-comment') {
      if (character === '\n') {
        state = 'code';
        code += character;
      }
      continue;
    }
    if (state === 'block-comment') {
      if (character === '*' && nextCharacter === '/') {
        state = 'code';
        index += 1;
      }
      continue;
    }
    if (state !== 'code') {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      const closesState =
        (state === 'single' && character === "'") ||
        (state === 'double' && character === '"') ||
        (state === 'template' && character === '`');
      if (closesState) state = 'code';
      continue;
    }
    if (character === '/' && nextCharacter === '/') {
      state = 'line-comment';
      index += 1;
      continue;
    }
    if (character === '/' && nextCharacter === '*') {
      state = 'block-comment';
      index += 1;
      continue;
    }
    if (character === "'") {
      state = 'single';
      continue;
    }
    if (character === '"') {
      state = 'double';
      continue;
    }
    if (character === '`') {
      state = 'template';
      continue;
    }
    code += character;
  }

  return code;
};

const hasJavaOrKotlinReference = (
  code: string,
  qualifiedName: string,
  member: string,
) => {
  const escapedName = qualifiedName.replace(/\./g, '\\.');
  return (
    new RegExp(`\\bimport\\s+${escapedName}\\s*;?`).test(code) ||
    code.includes(`${qualifiedName}.${member}`)
  );
};

export const hasBareAndroidStartupIntegration = (code: string) => {
  const nativeCode = stripCommentsAndStrings(code);
  const usesModuleResolver =
    nativeCode.includes('getJSBundleFile') &&
    nativeCode.includes('BundleDropModule.resolveJSBundleFile') &&
    hasJavaOrKotlinReference(
      nativeCode,
      ANDROID_BUNDLE_DROP_MODULE,
      'resolveJSBundleFile',
    );
  const usesNativePaths =
    nativeCode.includes('BundleDropNativePaths.getDownloadedBundlePath') &&
    hasJavaOrKotlinReference(
      nativeCode,
      ANDROID_BUNDLE_DROP_PATHS,
      'getDownloadedBundlePath',
    );
  return usesModuleResolver || usesNativePaths;
};

export const hasBareIosStartupIntegration = (
  filePath: string,
  code: string,
) => {
  const nativeCode = stripCommentsAndStrings(code);
  if (filePath.endsWith('.swift')) {
    const usesLocator =
      nativeCode.includes('bundleURL') &&
      nativeCode.includes('BundleDropLocator.bundleURL()');
    return usesLocator &&
      new RegExp(`\\bimport\\s+${IOS_BUNDLE_DROP_MODULE}\\b`).test(nativeCode);
  }

  const usesLocator =
    (nativeCode.includes('sourceURLForBridge') || nativeCode.includes('bundleURL')) &&
    nativeCode.includes('[BundleDropLocator bundleURL]');
  const escapedHeader = IOS_BUNDLE_DROP_LOCATOR_HEADER.replace(/[/.]/g, '\\$&');
  return usesLocator &&
    new RegExp(`#import\\s*[<\"]${escapedHeader}[>\"]`).test(nativeCode);
};
