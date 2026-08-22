export const ANDROID_BUNDLE_DROP_MODULE = 'com.bundledrop.BundleDropModule';
export const ANDROID_BUNDLE_DROP_PATHS = 'com.bundledrop.BundleDropNativePaths';
export const IOS_BUNDLE_DROP_MODULE = 'BundleDrop';
export const IOS_BUNDLE_DROP_LOCATOR_HEADER = 'BundleDrop/BundleDropLocator.h';

const sanitizeSource = (content: string, preserveStrings: boolean) => {
  let code = '';
  let state:
    | 'code'
    | 'line-comment'
    | 'block-comment'
    | 'single'
    | 'double'
    | 'triple-double'
    | 'template' = 'code';
  let escaped = false;
  let blockCommentDepth = 0;
  let tripleQuoteHashes = '';

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
      if (character === '/' && nextCharacter === '*') {
        blockCommentDepth += 1;
        index += 1;
        continue;
      }
      if (character === '*' && nextCharacter === '/') {
        blockCommentDepth -= 1;
        if (blockCommentDepth === 0) state = 'code';
        index += 1;
      }
      continue;
    }
    if (state === 'triple-double') {
      const closingDelimiter = `"""${tripleQuoteHashes}`;
      if (content.startsWith(closingDelimiter, index)) {
        if (preserveStrings) code += closingDelimiter;
        index += closingDelimiter.length - 1;
        state = 'code';
        tripleQuoteHashes = '';
      } else if (preserveStrings) {
        code += character;
      }
      continue;
    }
    if (state !== 'code') {
      if (escaped) {
        if (preserveStrings) code += character;
        escaped = false;
        continue;
      }
      if (character === '\\') {
        if (preserveStrings) code += character;
        escaped = true;
        continue;
      }
      const closesState =
        (state === 'single' && character === "'") ||
        (state === 'double' && character === '"') ||
        (state === 'template' && character === '`');
      if (preserveStrings) code += character;
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
      blockCommentDepth = 1;
      index += 1;
      continue;
    }
    const swiftRawTripleQuote = content.slice(index).match(/^(#+)"""/);
    if (character === '"' && content.startsWith('"""', index)) {
      state = 'triple-double';
      tripleQuoteHashes = '';
      if (preserveStrings) code += '"""';
      index += 2;
      continue;
    }
    if (swiftRawTripleQuote) {
      state = 'triple-double';
      tripleQuoteHashes = swiftRawTripleQuote[1];
      if (preserveStrings) code += swiftRawTripleQuote[0];
      index += swiftRawTripleQuote[0].length - 1;
      continue;
    }
    if (character === "'") {
      state = 'single';
      if (preserveStrings) code += character;
      continue;
    }
    if (character === '"') {
      state = 'double';
      if (preserveStrings) code += character;
      continue;
    }
    if (character === '`') {
      state = 'template';
      if (preserveStrings) code += character;
      continue;
    }
    code += character;
  }

  return code;
};

export const stripCommentsAndStrings = (content: string) => sanitizeSource(content, false);
export const stripComments = (content: string) => sanitizeSource(content, true);

export {
  findMissingBareNativeStartupStructure,
  hasBareAndroidStartupIntegration,
  hasBareIosStartupIntegration,
} from './native-startup-validator';
