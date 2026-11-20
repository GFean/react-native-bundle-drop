export const ANDROID_BUNDLE_DROP_MODULE = 'com.bundledrop.BundleDropModule';
export const ANDROID_BUNDLE_DROP_PATHS = 'com.bundledrop.BundleDropNativePaths';
export const IOS_BUNDLE_DROP_MODULE = 'BundleDrop';
export const IOS_BUNDLE_DROP_LOCATOR_HEADER = 'BundleDrop/BundleDropLocator.h';

const sanitizeSource = (content: string, preserveStrings: boolean, sourceOffsets?: number[]) => {
  let code = '';
  const append = (start: number, length = 1) => {
    const end = start + length;
    code += content.slice(start, end);
    if (sourceOffsets) {
      for (let offset = start; offset < end; offset += 1) sourceOffsets.push(offset);
    }
  };
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
        append(index);
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
        if (preserveStrings) append(index, closingDelimiter.length);
        index += closingDelimiter.length - 1;
        state = 'code';
        tripleQuoteHashes = '';
      } else if (preserveStrings) {
        append(index);
      }
      continue;
    }
    if (state !== 'code') {
      if (escaped) {
        if (preserveStrings) append(index);
        escaped = false;
        continue;
      }
      if (character === '\\') {
        if (preserveStrings) append(index);
        escaped = true;
        continue;
      }
      const closesState =
        (state === 'single' && character === "'") ||
        (state === 'double' && character === '"') ||
        (state === 'template' && character === '`');
      if (preserveStrings) append(index);
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
      if (preserveStrings) append(index, 3);
      index += 2;
      continue;
    }
    if (swiftRawTripleQuote) {
      state = 'triple-double';
      tripleQuoteHashes = swiftRawTripleQuote[1];
      if (preserveStrings) append(index, swiftRawTripleQuote[0].length);
      index += swiftRawTripleQuote[0].length - 1;
      continue;
    }
    if (character === "'") {
      state = 'single';
      if (preserveStrings) append(index);
      continue;
    }
    if (character === '"') {
      state = 'double';
      if (preserveStrings) append(index);
      continue;
    }
    if (character === '`') {
      state = 'template';
      if (preserveStrings) append(index);
      continue;
    }
    append(index);
  }

  return code;
};

export const stripCommentsAndStrings = (content: string) => sanitizeSource(content, false);
export const stripComments = (content: string) => sanitizeSource(content, true);

export const stripCommentsAndStringsWithSourceOffsets = (content: string) => {
  const sourceOffsets: number[] = [];
  const code = sanitizeSource(content, false, sourceOffsets);
  return { code, sourceOffsets };
};

export {
  findMissingBareNativeStartupStructure,
  hasBareAndroidStartupIntegration,
  hasBareIosStartupIntegration,
} from './native-startup-validator';
