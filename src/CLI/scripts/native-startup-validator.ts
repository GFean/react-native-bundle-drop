import {
  ANDROID_BUNDLE_DROP_MODULE,
  ANDROID_BUNDLE_DROP_PATHS,
  IOS_BUNDLE_DROP_LOCATOR_HEADER,
  IOS_BUNDLE_DROP_MODULE,
  stripCommentsAndStrings,
} from './native-setup-contract';

type DeclaredMethod = {
  declarationStart: number;
  declaration: string;
  body: string;
};

type SourceType = {
  name: string;
  declaration: string;
  declarationStart: number;
  openingBrace: number;
  closingBrace: number;
};

type ObjcImplementation = {
  name: string;
  category?: string;
  bodyStart: number;
  bodyEnd: number;
};

type NamedSourceBlock = {
  name: string;
  declaration: string;
  declarationStart: number;
  bodyStart: number;
  bodyEnd: number;
};

const findBalancedBlockEnd = (
  code: string,
  openingIndex: number,
  openingCharacter = '{',
  closingCharacter = '}',
) => {
  let depth = 0;
  for (let index = openingIndex; index < code.length; index += 1) {
    if (code[index] === openingCharacter) depth += 1;
    if (code[index] === closingCharacter) depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
};

const extractBalancedBlock = (code: string, openingBrace: number) => {
  const closingBrace = findBalancedBlockEnd(code, openingBrace);
  return closingBrace < 0 ? '' : code.slice(openingBrace + 1, closingBrace);
};

const extractExpressionBody = (code: string, equals: number, firstLineEnd: number) => {
  let expressionEnd = firstLineEnd;
  let braceDepth = [...code.slice(equals + 1, firstLineEnd)]
    .reduce((depth, character) => {
      if (character === '{') return depth + 1;
      if (character === '}') return depth - 1;
      return depth;
    }, 0);
  let nextLineStart = firstLineEnd < code.length ? firstLineEnd + 1 : code.length;
  while (nextLineStart < code.length) {
    const nextLineEnd = code.indexOf('\n', nextLineStart);
    const lineEnd = nextLineEnd < 0 ? code.length : nextLineEnd;
    const line = code.slice(nextLineStart, lineEnd).trim();
    if (
      braceDepth === 0 && (
        line === '}' ||
        /^(?:@|init\b|class\b|object\b|interface\b|companion\s+object\b)/.test(line) ||
        /^(?:(?:override|private|protected|public|internal|final|open)\s+)*(?:fun|val|var)\b/.test(line)
      )
    ) {
      break;
    }
    expressionEnd = lineEnd;
    braceDepth = [...code.slice(nextLineStart, lineEnd)]
      .reduce((depth, character) => {
        if (character === '{') return depth + 1;
        if (character === '}') return depth - 1;
        return depth;
      }, braceDepth);
    nextLineStart = nextLineEnd < 0 ? code.length : nextLineEnd + 1;
  }
  return code.slice(equals + 1, expressionEnd);
};

const findDeclaredMethods = (code: string, declarationPattern: RegExp): DeclaredMethod[] =>
  [...code.matchAll(declarationPattern)].map(match => {
    const delimiter = match[1];
    const declarationStart = match.index || 0;
    const delimiterIndex = declarationStart + match[0].lastIndexOf(delimiter);
    const lineEndIndex = code.indexOf('\n', delimiterIndex);
    const lineEnd = lineEndIndex < 0 ? code.length : lineEndIndex;
    return {
      declarationStart,
      declaration: match[0],
      body: delimiter === '{'
        ? extractBalancedBlock(code, delimiterIndex)
        : extractExpressionBody(code, delimiterIndex, lineEnd),
    };
  });

const KOTLIN_JS_BUNDLE_METHOD =
  /(?:^|\n)\s*(?:@\w+(?:\([^\n)]*\))?\s*)*(?:(?:public|private|protected|internal|override|final|open)\s+)*fun\s+getJSBundleFile\s*\(\s*\)\s*(?::\s*[^=\{\n]+)?\s*([={])/g;
const JAVA_JS_BUNDLE_METHOD =
  /(?:^|\n)\s*(?:@\w+(?:\([^\n)]*\))?\s*)*(?:(?:public|private|protected|final|synchronized)\s+)*(?:[\w$.<>\[\]?@]+\s+)+getJSBundleFile\s*\(\s*\)\s*(?:throws\s+[^\{\n]+)?\s*(\{)/g;
const ANDROID_ON_CREATE_METHOD =
  /(?:^|\n)\s*(?:@\w+(?:\([^\n)]*\))?\s*)*(?:(?:public|private|protected|internal|override|final|open)\s+)*(?:fun\s+onCreate|void\s+onCreate)\s*\(\s*\)\s*(\{)/g;
const SWIFT_BUNDLE_URL_METHOD =
  /(?:^|\n)\s*(?:@\w+(?:\([^\n)]*\))?\s*)*(?:(?:public|private|internal|fileprivate|open|override|final)\s+)*func\s+bundleURL\s*\(\s*\)\s*(?:async\s+)?(?:throws\s+)?(?:->\s*[^\{\n]+)?\s*(\{)/g;
const SWIFT_APP_LAUNCH_METHOD =
  /(?:^|\n)\s*(?:@\w+(?:\([^\n)]*\))?\s*)*(?:(?:public|private|internal|fileprivate|open|override|final)\s+)*func\s+application\s*\(\s*_\s+[A-Za-z_]\w*\s*:\s*UIApplication\s*,\s*didFinishLaunchingWithOptions\s+[A-Za-z_]\w*\s*:[\s\S]*?\)\s*(?:async\s+)?(?:throws\s+)?->\s*Bool\s*(\{)/g;
const SWIFT_SOURCE_URL_METHOD =
  /(?:^|\n)\s*(?:@\w+(?:\([^\n)]*\))?\s*)*(?:(?:public|private|internal|fileprivate|open|override|final)\s+)*func\s+sourceURL\s*\(\s*for\s+[A-Za-z_]\w*\s*:\s*RCTBridge\s*\)\s*(?:async\s+)?(?:throws\s+)?(?:->\s*[^\{\n]+)?\s*(\{)/g;
const OBJC_SOURCE_URL_METHOD =
  /(?:^|\n)\s*-\s*\([^\n)]*\)\s*sourceURLForBridge\s*:\s*\([^\n)]*\)\s*\w+\s*(\{)/g;
const OBJC_BUNDLE_URL_METHOD =
  /(?:^|\n)\s*-\s*\([^\n)]*\)\s*bundleURL\s*(\{)/g;
const OBJC_SELF_BUNDLE_URL_DELEGATION =
  /\[\s*self\s+bundleURL\s*\]|\bself\s*\.\s*bundleURL\b/;
const KOTLIN_REACT_HOST_PROPERTY =
  /(?:^|\n)\s*(?:@\w+(?:\([^\n)]*\))?\s*)*(?:(?:public|private|protected|internal|override|final|open)\s+)*val\s+(reactHost)\s*:\s*ReactHost\s+by\s+lazy\s*(\{)/g;
const KOTLIN_LEGACY_NATIVE_HOST_INITIALIZER =
  /(?:^|\n)\s*(?:@\w+(?:\([^\n)]*\))?\s*)*(?:(?:public|private|protected|internal|override|final|open)\s+)*(?:val|var)\s+([A-Za-z_]\w*)\s*:\s*ReactNativeHost\s*=\s*object\s*:\s*(?:Default)?ReactNativeHost\s*\([^\n{]*\)\s*(\{)/g;
const JAVA_LEGACY_NATIVE_HOST_INITIALIZER =
  /(?:^|\n)\s*(?:@\w+(?:\([^\n)]*\))?\s*)*(?:(?:public|private|protected|static|final|volatile|transient)\s+)*ReactNativeHost\s+([A-Za-z_]\w*)\s*=\s*new\s+(?:Default)?ReactNativeHost\s*\([^\n{]*\)\s*(\{)/g;
const JAVA_GET_REACT_NATIVE_HOST_METHOD =
  /(?:^|\n)\s*(?:@\w+(?:\([^\n)]*\))?\s*)*(?:(?:public|private|protected|final|synchronized)\s+)*ReactNativeHost\s+getReactNativeHost\s*\(\s*\)\s*(\{)/g;

const findSourceTypes = (code: string): SourceType[] =>
  [...code.matchAll(/\b(?:class|object)\s+([A-Za-z_]\w*)[^{}]*\{/g)].map(match => {
    const openingBrace = (match.index || 0) + match[0].lastIndexOf('{');
    return {
      name: match[1],
      declaration: match[0],
      declarationStart: match.index || 0,
      openingBrace,
      closingBrace: findBalancedBlockEnd(code, openingBrace),
    };
  }).filter(type => type.closingBrace >= 0);

const findContainingType = (code: string, position: number): SourceType | null =>
  findSourceTypes(code)
    .filter(type => type.openingBrace < position && position < type.closingBrace)
    .sort((left, right) =>
      (left.closingBrace - left.openingBrace) - (right.closingBrace - right.openingBrace)
    )[0] || null;

const isDirectMemberOfType = (
  code: string,
  position: number,
  owner: SourceType,
) => {
  if (position <= owner.openingBrace || position >= owner.closingBrace) return false;
  let braceDepth = 0;
  for (let index = owner.openingBrace + 1; index < position; index += 1) {
    if (code[index] === '{') braceDepth += 1;
    else if (code[index] === '}') braceDepth -= 1;
  }
  return braceDepth === 0;
};

const findNamedType = (code: string, name: string) => {
  const matches = findSourceTypes(code).filter(type => type.name === name);
  return matches.length === 1 ? matches[0] : null;
};

const findNamedSourceBlocks = (
  code: string,
  declarationPattern: RegExp,
): NamedSourceBlock[] => [...code.matchAll(declarationPattern)].flatMap(match => {
  const openingBrace = (match.index || 0) + match[0].lastIndexOf('{');
  const closingBrace = findBalancedBlockEnd(code, openingBrace);
  return closingBrace < 0 ? [] : [{
    name: match[1],
    declaration: match[0],
    declarationStart: match.index || 0,
    bodyStart: openingBrace + 1,
    bodyEnd: closingBrace,
  }];
});

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const findObjcImplementations = (code: string): ObjcImplementation[] =>
  [...code.matchAll(/@implementation\s+([A-Za-z_]\w*)(?:\s*\(([^)]*)\))?/g)]
    .flatMap(match => {
      const bodyStart = (match.index || 0) + match[0].length;
      const endPattern = /@end\b/g;
      endPattern.lastIndex = bodyStart;
      const endMatch = endPattern.exec(code);
      if (!endMatch) return [];
      return [{
        name: match[1],
        category: match[2]?.trim() || undefined,
        bodyStart,
        bodyEnd: endMatch.index,
      }];
    });

const methodBelongsToObjcImplementation = (
  method: DeclaredMethod,
  implementation: ObjcImplementation,
) => implementation.bodyStart <= method.declarationStart &&
  method.declarationStart < implementation.bodyEnd;

const findCallSites = (code: string, functionName: string) => {
  const calls: Array<{ argumentsBody: string; start: number; end: number }> = [];
  const callPattern = new RegExp(`\\b${escapeRegExp(functionName)}\\s*\\(`, 'g');
  for (const match of code.matchAll(callPattern)) {
    const openingParenthesis = (match.index || 0) + match[0].lastIndexOf('(');
    const closingParenthesis = findBalancedBlockEnd(code, openingParenthesis, '(', ')');
    if (closingParenthesis >= 0) {
      calls.push({
        argumentsBody: code.slice(openingParenthesis + 1, closingParenthesis),
        start: match.index || 0,
        end: closingParenthesis + 1,
      });
    }
  }
  return calls;
};

const hasAuthoritativeLazyHostCall = (
  body: string,
  acceptsArguments: (argumentsBody: string) => boolean,
) => findCallSites(body, 'getDefaultReactHost').some(call => {
  if (!acceptsArguments(call.argumentsBody)) return false;
  const before = body.slice(0, call.start);
  const after = body.slice(call.end);
  if (/\breturn\s*@\s*lazy\b/.test(before)) return false;
  if (!after.trim()) return true;

  const assignment = /\b(?:val|var)\s+([A-Za-z_]\w*)\s*=\s*$/.exec(before);
  return Boolean(assignment && new RegExp(
    `^\\s*;?\\s*${escapeRegExp(assignment[1])}\\s*;?\\s*$`,
  ).test(after));
});

const hasExactAndroidModuleReference = (code: string) => {
  const escapedName = ANDROID_BUNDLE_DROP_MODULE.replace(/\./g, '\\.');
  return new RegExp(`(?:^|\\n)[ \\t]*import\\s+${escapedName}[ \\t]*;?[ \\t]*(?:\\n|$)`).test(code) ||
    code.includes(`${ANDROID_BUNDLE_DROP_MODULE}.resolveJSBundleFile`);
};

const hasExactAndroidNativePathsReference = (code: string) => {
  const escapedName = ANDROID_BUNDLE_DROP_PATHS.replace(/\./g, '\\.');
  return new RegExp(`\\bimport\\s+${escapedName}\\s*;?`).test(code) ||
    code.includes(`${ANDROID_BUNDLE_DROP_PATHS}.getDownloadedBundlePath`);
};

const hasNativeCodePushResidue = (content: string) => {
  const code = stripCommentsAndStrings(content);
  return /\bCodePush\b|\bcom\.microsoft\.codepush\.react\b/i.test(code);
};

const androidStartupMethod = (nativeCode: string) => {
  const kotlinMethods = findDeclaredMethods(nativeCode, KOTLIN_JS_BUNDLE_METHOD)
    .map(method => ({ ...method, language: 'kotlin' as const }));
  const javaMethods = findDeclaredMethods(nativeCode, JAVA_JS_BUNDLE_METHOD)
    .map(method => ({ ...method, language: 'java' as const }));
  const methods = [...new Map(
    [...kotlinMethods, ...javaMethods].map(method => [method.declarationStart, method]),
  ).values()];
  if (methods.length !== 1) return null;

  const method = methods[0];
  const owner = findContainingType(nativeCode, method.declarationStart);
  if (owner?.name !== 'MainApplication') return null;
  return { method, owner };
};

const methodsOwnedBy = (
  code: string,
  declarationPattern: RegExp,
  ownerName: string,
) => {
  const owner = findNamedType(code, ownerName);
  if (!owner) return [];
  return findDeclaredMethods(code, declarationPattern).filter(method =>
    findContainingType(code, method.declarationStart)?.declarationStart ===
      owner.declarationStart &&
    isDirectMemberOfType(code, method.declarationStart, owner)
  );
};

const hasAndroidLifecycleIntegrity = (nativeCode: string, owner: SourceType) => {
  const ownerBody = nativeCode.slice(owner.openingBrace + 1, owner.closingBrace);
  const lifecycleSignals = [
    'super.onCreate',
    'loadReactNative',
    'SoLoader.init',
    'DefaultNewArchitectureEntryPoint.load',
  ].filter(signal => ownerBody.includes(signal));
  if (!lifecycleSignals.length) return true;

  const onCreateMethods = methodsOwnedBy(
    nativeCode,
    ANDROID_ON_CREATE_METHOD,
    'MainApplication',
  );
  return onCreateMethods.length === 1 &&
    lifecycleSignals.every(signal => onCreateMethods[0].body.includes(signal));
};

const authoritativeReactHostBlocks = (nativeCode: string) => {
  const mainApplication = findNamedType(nativeCode, 'MainApplication');
  if (!mainApplication) return [];
  const blocks = findNamedSourceBlocks(nativeCode, KOTLIN_REACT_HOST_PROPERTY).filter(block =>
    /\boverride\s+val\s+reactHost\b/.test(block.declaration) &&
    findContainingType(nativeCode, block.declarationStart)?.declarationStart ===
      mainApplication.declarationStart &&
    isDirectMemberOfType(nativeCode, block.declarationStart, mainApplication)
  );
  return blocks.length === 1 ? blocks : [];
};

const hasDirectReactHostConnection = (nativeCode: string) => {
  const [reactHost] = authoritativeReactHostBlocks(nativeCode);
  if (!reactHost) return false;
  const body = nativeCode.slice(reactHost.bodyStart, reactHost.bodyEnd);
  return hasAuthoritativeLazyHostCall(body, argumentsBody =>
    /\bjsBundleFilePath\s*=\s*(?:this\.)?getJSBundleFile\s*\(\s*\)/.test(argumentsBody)
  );
};

const NATIVE_PATHS_CONTEXT =
  '(?:this(?:@MainApplication)?|[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)';
const NATIVE_PATHS_CALL =
  `(?:com\\.bundledrop\\.)?BundleDropNativePaths\\s*\\.\\s*` +
  `getDownloadedBundlePath\\s*\\(\\s*${NATIVE_PATHS_CONTEXT}\\s*\\)`;

const hasDirectNativePathsHostConnection = (nativeCode: string) => {
  const [reactHost] = authoritativeReactHostBlocks(nativeCode);
  if (!reactHost) return false;
  const body = nativeCode.slice(reactHost.bodyStart, reactHost.bodyEnd);
  return hasAuthoritativeLazyHostCall(body, argumentsBody =>
    new RegExp(`\\bjsBundleFilePath\\s*=\\s*${NATIVE_PATHS_CALL}`).test(argumentsBody)
  );
};

const hasNativePathsResolverCall = (body: string) => new RegExp(`\\b${NATIVE_PATHS_CALL}`).test(body);

const isAndroidNativeOverride = (
  startup: NonNullable<ReturnType<typeof androidStartupMethod>>,
) => startup.method.language === 'kotlin'
  ? /\boverride\s+fun\b/.test(startup.method.declaration)
  : /@Override\b/.test(startup.method.declaration) ||
    /\b(?:public|protected)\b/.test(startup.method.declaration);

const legacyAndroidHostBlocks = (nativeCode: string) => [
  ...findNamedSourceBlocks(nativeCode, KOTLIN_LEGACY_NATIVE_HOST_INITIALIZER),
  ...findNamedSourceBlocks(nativeCode, JAVA_LEGACY_NATIVE_HOST_INITIALIZER),
];

const isAuthoritativeLegacyAndroidHost = (
  nativeCode: string,
  host: NamedSourceBlock,
) => {
  const mainApplication = findNamedType(nativeCode, 'MainApplication');
  if (
    !mainApplication ||
    findContainingType(nativeCode, host.declarationStart)?.declarationStart !==
      mainApplication.declarationStart ||
    !isDirectMemberOfType(nativeCode, host.declarationStart, mainApplication)
  ) {
    return false;
  }
  if (
    host.name === 'reactNativeHost' &&
    /\boverride\s+(?:val|var)\s+reactNativeHost\b/.test(host.declaration)
  ) {
    return true;
  }
  const kotlinGetters = [...nativeCode.matchAll(
    /(?:^|\n)\s*override\s+(?:val|var)\s+reactNativeHost\s*:\s*ReactNativeHost\s*\n?\s*get\s*\(\s*\)\s*=\s*(?:this\.)?([A-Za-z_]\w*)\b/g,
  )].filter(match =>
    findContainingType(nativeCode, match.index || 0)?.declarationStart ===
      mainApplication.declarationStart &&
    isDirectMemberOfType(nativeCode, match.index || 0, mainApplication)
  );
  if (kotlinGetters.length === 1 && kotlinGetters[0][1] === host.name) return true;

  const javaGetters = methodsOwnedBy(
    nativeCode,
    JAVA_GET_REACT_NATIVE_HOST_METHOD,
    'MainApplication',
  );
  if (javaGetters.length !== 1) return false;
  const returnedHosts = [...javaGetters[0].body.matchAll(
    /\breturn\s+(?:this\.)?([A-Za-z_]\w*)\s*;/g,
  )].map(match => match[1]);
  return returnedHosts.length === 1 && returnedHosts[0] === host.name;
};

const isResolverMethodConnectedToAndroidStartup = (
  nativeCode: string,
  startup: NonNullable<ReturnType<typeof androidStartupMethod>>,
) => {
  const containingLegacyHosts = legacyAndroidHostBlocks(nativeCode).filter(host =>
    host.bodyStart <= startup.method.declarationStart &&
    startup.method.declarationStart < host.bodyEnd
  );
  if (containingLegacyHosts.length) {
    const authoritativeHosts = legacyAndroidHostBlocks(nativeCode).filter(host =>
      isAuthoritativeLegacyAndroidHost(nativeCode, host)
    );
    return containingLegacyHosts.length === 1 &&
      authoritativeHosts.length === 1 &&
      authoritativeHosts[0].bodyStart === containingLegacyHosts[0].bodyStart &&
      isAndroidNativeOverride(startup);
  }
  return startup.method.language === 'kotlin' &&
    /\bprivate\s+fun\b/.test(startup.method.declaration) &&
    hasDirectReactHostConnection(nativeCode);
};

type SourceRange = { start: number; end: number };
type ResolverLanguage = 'kotlin' | 'java' | 'swift' | 'objc';

const findBuildConfigDebugOnlyRanges = (source: string): SourceRange[] => {
  const ranges: SourceRange[] = [];
  const conditions = /\bif\s*\(\s*(!\s*)?BuildConfig\.DEBUG\s*\)/g;
  for (const match of source.matchAll(conditions)) {
    const negated = Boolean(match[1]);
    const conditionEnd = (match.index || 0) + match[0].length;
    let branchStart = conditionEnd;
    while (/\s/.test(source[branchStart] || '')) branchStart += 1;

    let trueStart = branchStart;
    let trueEnd = branchStart;
    let elseStart = -1;
    let elseEnd = -1;
    if (source[branchStart] === '{') {
      const closingBrace = findBalancedBlockEnd(source, branchStart);
      if (closingBrace < 0) continue;
      trueStart = branchStart + 1;
      trueEnd = closingBrace;
      const elseMatch = /^\s*else\b/.exec(source.slice(closingBrace + 1));
      if (elseMatch) {
        let cursor = closingBrace + 1 + elseMatch[0].length;
        while (/\s/.test(source[cursor] || '')) cursor += 1;
        if (source[cursor] === '{') {
          const closingElse = findBalancedBlockEnd(source, cursor);
          if (closingElse >= 0) {
            elseStart = cursor + 1;
            elseEnd = closingElse;
          }
        } else {
          elseStart = cursor;
          const end = source.slice(cursor).search(/[;\n]/);
          elseEnd = end < 0 ? source.length : cursor + end;
        }
      }
    } else {
      const tail = source.slice(branchStart);
      const elseMatch = /\belse\b/.exec(tail);
      const statementEnd = tail.search(/[;\n]/);
      trueEnd = elseMatch
        ? branchStart + elseMatch.index
        : statementEnd < 0 ? source.length : branchStart + statementEnd;
      if (elseMatch) {
        elseStart = branchStart + elseMatch.index + elseMatch[0].length;
        const end = source.slice(elseStart).search(/[;\n]/);
        elseEnd = end < 0 ? source.length : elseStart + end;
      }
    }
    if (!negated) ranges.push({ start: trueStart, end: trueEnd });
    if (negated && elseStart >= 0) ranges.push({ start: elseStart, end: elseEnd });
  }
  return ranges;
};

const sourceWithoutDebugPreprocessorBranches = (source: string) => {
  const output: string[] = [];
  const stack: Array<{ initial: 'debug' | 'release' | 'other'; debugOnly: boolean }> = [];
  for (const line of source.split('\n')) {
    const directive = /^\s*#\s*(if|ifdef|ifndef|elseif|elif|else|endif)\b(.*)$/i.exec(line);
    const kind = directive?.[1].toLowerCase();
    const condition = directive?.[2] || '';
    const debugCondition = /\bDEBUG\b/i.test(condition)
      ? /!\s*(?:defined\s*\()?\s*DEBUG\b|\bifndef\b/i.test(`${kind} ${condition}`)
        ? 'release' as const
        : 'debug' as const
      : 'other' as const;
    if (kind === 'if' || kind === 'ifdef' || kind === 'ifndef') {
      stack.push({ initial: debugCondition, debugOnly: debugCondition === 'debug' });
      continue;
    }
    if ((kind === 'elseif' || kind === 'elif') && stack.length) {
      stack[stack.length - 1].debugOnly = debugCondition === 'debug';
      continue;
    }
    if (kind === 'else' && stack.length) {
      stack[stack.length - 1].debugOnly = stack[stack.length - 1].initial === 'release';
      continue;
    }
    if (kind === 'endif' && stack.length) {
      stack.pop();
      continue;
    }
    if (stack.every(frame => !frame.debugOnly)) {
      output.push(line);
    }
  }
  return output.join('\n');
};

const releaseSource = (body: string) => {
  const hasCompoundDebugDirective = body.split('\n').some(line => {
    const directive = /^\s*#\s*(if|ifdef|ifndef|elseif|elif)\b(.*)$/i.exec(line);
    if (!directive || !/\bDEBUG\b/i.test(directive[2])) return false;
    const condition = directive[2].trim();
    return !/^(?:!\s*)?(?:defined\s*\(\s*)?DEBUG\s*\)?$/i.test(condition);
  });
  if (hasCompoundDebugDirective) return '';
  const withoutPreprocessorDebug = sourceWithoutDebugPreprocessorBranches(body);
  const characters = [...withoutPreprocessorDebug];
  for (const condition of withoutPreprocessorDebug.matchAll(
    /\bif\s*\(\s*!?\s*BuildConfig\.DEBUG\s*\)/g,
  )) {
    const start = condition.index || 0;
    for (let index = start; index < start + condition[0].length; index += 1) {
      if (characters[index] !== '\n') characters[index] = ' ';
    }
  }
  for (const range of findBuildConfigDebugOnlyRanges(withoutPreprocessorDebug)) {
    for (let index = range.start; index < range.end; index += 1) {
      if (characters[index] !== '\n') characters[index] = ' ';
    }
  }
  const projected = characters.join('');
  return /\bBuildConfig\.DEBUG\b/.test(projected) ? '' : projected;
};

const resolverCallRanges = (source: string, resolver: string): SourceRange[] => {
  const ranges: SourceRange[] = [];
  let resolverStart = source.indexOf(resolver);
  while (resolverStart >= 0) {
    const openingParenthesis = source.indexOf('(', resolverStart + resolver.length);
    const closingParenthesis = openingParenthesis < 0
      ? -1
      : findBalancedBlockEnd(source, openingParenthesis, '(', ')');
    if (closingParenthesis >= 0) ranges.push({ start: resolverStart, end: closingParenthesis + 1 });
    resolverStart = source.indexOf(resolver, resolverStart + resolver.length);
  }
  return ranges;
};

const objcLocatorRanges = (source: string): SourceRange[] => [...source.matchAll(
  /\[\s*BundleDropLocator\s+bundleURL\s*\]/g,
)].map(match => ({ start: match.index || 0, end: (match.index || 0) + match[0].length }));

const objcSelfBundleUrlRanges = (source: string): SourceRange[] => [...source.matchAll(
  /\[\s*self\s+bundleURL\s*\]|\bself\s*\.\s*bundleURL\b/g,
)].map(match => ({ start: match.index || 0, end: (match.index || 0) + match[0].length }));

const splitTopLevelArguments = (body: string) => {
  const parts: string[] = [];
  const stack: string[] = [];
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if ('([{'.includes(character)) stack.push(character);
    else if (')]}'.includes(character)) stack.pop();
    else if (character === ',' && !stack.length) {
      parts.push(body.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(body.slice(start).trim());
  if (
    parts.length > 2 &&
    body.trimEnd().endsWith(',') &&
    parts[parts.length - 1] === ''
  ) {
    parts.pop();
  }
  return parts;
};

const hasValidAndroidModuleResolverCall = (
  nativeCode: string,
  startup: NonNullable<ReturnType<typeof androidStartupMethod>>,
) => {
  const calls = findCallSites(startup.method.body, 'BundleDropModule.resolveJSBundleFile');
  if (calls.length !== 1) return false;
  const argumentsList = splitTopLevelArguments(calls[0].argumentsBody);
  if (argumentsList.length !== 2) return false;
  if (startup.method.language === 'java') {
    return /^(?:MainApplication\.this|getApplicationContext\(\s*\))$/.test(argumentsList[0]);
  }
  const insideLegacyHost = legacyAndroidHostBlocks(nativeCode).some(host =>
    host.bodyStart <= startup.method.declarationStart &&
    startup.method.declarationStart < host.bodyEnd
  );
  return insideLegacyHost
    ? /^(?:this@MainApplication|applicationContext|getApplicationContext\(\s*\))$/.test(
      argumentsList[0],
    )
    : /^(?:this(?:@MainApplication)?|applicationContext|getApplicationContext\(\s*\))$/.test(
      argumentsList[0],
    );
};

const canContinueValueExpressionAcrossNewline = (prefix: string) => {
  if (!prefix.includes('\n')) return true;
  const completedLines = prefix.split('\n').slice(0, -1);
  const precedingLine = [...completedLines].reverse().find(line => line.trim())?.trim() || '';
  return !precedingLine ||
    /(?:\breturn|\belse|[=?:({,+\-*/.!])$/.test(precedingLine);
};

const hasCanonicalGuardedResolverFallback = (source: string, resolver: string) => {
  if (resolver === 'BundleDropLocator.bundleURL') {
    const match = /^\s*if\s+let\s+([A-Za-z_]\w*)\s*=\s*BundleDropLocator\.bundleURL\s*\(\s*\)\s*\{\s*return\s+\1\s*;?\s*\}\s*return\s+[^;{}\n]+\s*;?\s*$/.exec(source);
    return Boolean(match);
  }
  if (resolver === '[BundleDropLocator bundleURL]') {
    const match = /^\s*NSURL\s*\*\s*([A-Za-z_]\w*)\s*=\s*\[\s*BundleDropLocator\s+bundleURL\s*\]\s*;\s*if\s*\(\s*\1\s*(?:!=\s*nil)?\s*\)\s*\{\s*return\s+\1\s*;\s*\}\s*return\s+[^;{}]+;\s*$/.exec(source);
    return Boolean(match);
  }
  return false;
};

const hasCanonicalReturnedResolverSuffix = (
  afterResolver: string,
  resolver: string,
  language: ResolverLanguage,
  requiresNonNullResult: boolean,
) => {
  const suffix = afterResolver.trim().replace(/(?:\s*}\s*)+$/, '').trim();
  if (!suffix || suffix === ';') return !requiresNonNullResult;
  if (language === 'kotlin' && resolver === 'BundleDropModule.resolveJSBundleFile') {
    return /^!!\s*;?$/.test(suffix) ||
      /^\?:\s*(?:super\.getJSBundleFile\s*\(\s*\)|[A-Za-z_]\w*)\s*;?$/.test(suffix);
  }
  if (language === 'swift' && resolver === 'BundleDropLocator.bundleURL') {
    return new RegExp(
      '^\\?\\?\\s*(?:' +
        'RCTBundleURLProvider\\.sharedSettings\\s*\\(\\s*\\)' +
          '\\.jsBundleURL\\s*\\([^)]*\\)|' +
        'Bundle\\.main\\.url\\s*\\([^)]*\\)|' +
        '[A-Za-z_]\\w*' +
      ')\\s*;?$',
    ).test(suffix);
  }
  if (language === 'objc' && resolver === '[BundleDropLocator bundleURL]') {
    return /^\?:\s*(?:\[[^\]\n]+\]|[A-Za-z_]\w*)\s*;?$/.test(suffix);
  }
  return false;
};

const isSupportedJavaTernaryPart = (source: string) => {
  const expression = source.trim();
  if (!expression || /\b(?:break|continue|else|for|if|return|switch|throw|while)\b/.test(expression)) {
    return false;
  }
  const stack: string[] = [];
  for (const character of expression) {
    if ('(['.includes(character)) stack.push(character);
    else if (')]'.includes(character)) {
      const opening = stack.pop();
      if (
        (character === ')' && opening !== '(') ||
        (character === ']' && opening !== '[')
      ) {
        return false;
      }
    } else if (character === ',' && !stack.length) {
      return false;
    }
  }
  return stack.length === 0;
};

const hasCanonicalConditionalLocalFallback = (
  source: string,
  resolver: string,
  language: ResolverLanguage,
) => {
  if (resolver !== 'BundleDropModule.resolveJSBundleFile') return false;
  const calls = findCallSites(source, resolver);
  if (calls.length !== 1) return false;
  const argumentsList = splitTopLevelArguments(calls[0].argumentsBody);
  if (argumentsList.length !== 2 || !/^[A-Za-z_]\w*$/.test(argumentsList[1])) {
    return false;
  }
  const fallback = argumentsList[1];
  if (language === 'java') {
    const selection = new RegExp(
      `^\\s*(?:final\\s+)?String\\s+${escapeRegExp(fallback)}\\s*=\\s*` +
        '([^?;{}]+)\\?([^?:;{}]+):([^?:;{}]+);\\s*return\\s*$',
    ).exec(source.slice(0, calls[0].start));
    if (!selection || selection.slice(1).some(part =>
      part.includes(resolver) || !isSupportedJavaTernaryPart(part)
    )) {
      return false;
    }
    return /^\s*;?\s*$/.test(source.slice(calls[0].end));
  }
  if (language !== 'kotlin') return false;
  const assignment = new RegExp(
    `^\\s*(?:val|var)\\s+${escapeRegExp(fallback)}` +
      `(?:\\s*:\\s*[^=\\n]+)?\\s*=\\s*if\\s*\\(`,
  ).exec(source);
  if (!assignment) return false;
  const conditionOpening = assignment[0].lastIndexOf('(');
  const conditionClosing = findBalancedBlockEnd(source, conditionOpening, '(', ')');
  if (conditionClosing < 0) return false;
  let cursor = conditionClosing + 1;
  while (/\s/.test(source[cursor] || '')) cursor += 1;
  if (source[cursor] !== '{') return false;
  const trueBranchClosing = findBalancedBlockEnd(source, cursor);
  if (trueBranchClosing < 0) return false;
  const trueBranch = source.slice(cursor + 1, trueBranchClosing);
  cursor = trueBranchClosing + 1;
  while (/\s/.test(source[cursor] || '')) cursor += 1;
  if (!source.startsWith('else', cursor) || /\w/.test(source[cursor + 4] || '')) return false;
  cursor += 4;
  while (/\s/.test(source[cursor] || '')) cursor += 1;
  if (source[cursor] !== '{') return false;
  const falseBranchClosing = findBalancedBlockEnd(source, cursor);
  if (falseBranchClosing < 0) return false;
  const falseBranch = source.slice(cursor + 1, falseBranchClosing);
  const beforeResolver = source.slice(falseBranchClosing + 1, calls[0].start);
  if (!/^\s*;?\s*return\s*$/.test(beforeResolver)) return false;
  if (
    /\breturn\b/.test(trueBranch) ||
    /\breturn\b/.test(falseBranch) ||
    trueBranch.includes(resolver) ||
    falseBranch.includes(resolver)
  ) {
    return false;
  }
  return new RegExp(`^\\s*\\?:\\s*${escapeRegExp(fallback)}\\s*;?\\s*$`).test(
    source.slice(calls[0].end),
  );
};

const resolverFeedsReturnedValue = (
  body: string,
  resolver: string,
  expressionBody: boolean,
  language: ResolverLanguage,
  requiresNonNullResult = false,
) => {
  const source = releaseSource(body);
  if (hasCanonicalGuardedResolverFallback(source, resolver)) return true;
  if (hasCanonicalConditionalLocalFallback(source, resolver, language)) return true;
  const sourceWithoutFallbackOperators = source.replace(/\?\?|\?:/g, '');
  if (/\b(?:if|when|switch)\b/.test(source) || sourceWithoutFallbackOperators.includes('?')) {
    return false;
  }
  const ranges = resolver === '[BundleDropLocator bundleURL]'
    ? objcLocatorRanges(source)
    : resolver === '[self bundleURL]' || resolver === 'self.bundleURL'
      ? objcSelfBundleUrlRanges(source)
      : resolverCallRanges(source, resolver);
  const returnIndices = [...source.matchAll(/\breturn\b/g)].map(match => match.index || 0);
  const controlledReturns = new Set<number>();
  let hasValueFlow = false;
  for (const range of ranges) {
    const before = source.slice(0, range.start);
    const after = source.slice(range.end);
    const statementStart = Math.max(before.lastIndexOf(';'), before.lastIndexOf('{')) + 1;
    const statementPrefix = before.slice(statementStart);
    const returnedExpression = /\breturn\b([\s\S]*)$/.exec(statementPrefix);
    if (
      returnedExpression &&
      canContinueValueExpressionAcrossNewline(returnedExpression[1]) &&
      hasCanonicalReturnedResolverSuffix(after, resolver, language, requiresNonNullResult)
    ) {
      controlledReturns.add(statementStart + (returnedExpression.index || 0));
      hasValueFlow = true;
      continue;
    }

    const assignment = /\b(?:val|var|let|NSURL\s*\*?|URL\s*\??|String\s*\??)\s*([A-Za-z_]\w*)\s*=\s*[^;{}]*$/.exec(
      statementPrefix,
    );
    const assignedExpression = assignment?.[0].slice(assignment[0].indexOf('=') + 1) || '';
    if (
      assignment &&
      canContinueValueExpressionAcrossNewline(assignedExpression) &&
      new RegExp(`\\breturn\\s+${escapeRegExp(assignment[1])}\\b`).test(after)
    ) {
      for (const returnedVariable of after.matchAll(
        new RegExp(`\\breturn\\s+${escapeRegExp(assignment[1])}\\b`, 'g'),
      )) {
        controlledReturns.add(range.end + (returnedVariable.index || 0));
      }
      hasValueFlow = true;
      continue;
    }

    const allowsImplicitSingleExpression = expressionBody ||
      resolver === 'BundleDropLocator.bundleURL';
    if (allowsImplicitSingleExpression) {
      const prefix = statementPrefix.trim();
      const allowedQualifiedPrefix = !prefix ||
        prefix === 'else' ||
        prefix === 'com.bundledrop.' ||
        prefix === 'else com.bundledrop.';
      if (allowedQualifiedPrefix && hasCanonicalReturnedResolverSuffix(
        after,
        resolver,
        language,
        requiresNonNullResult,
      )) {
        hasValueFlow = true;
      }
      continue;
    }
  }
  return hasValueFlow && returnIndices.every(index => controlledReturns.has(index));
};

export const hasBareAndroidStartupIntegration = (code: string) => {
  if (hasNativeCodePushResidue(code)) return false;
  const nativeCode = stripCommentsAndStrings(code);
  const mainApplication = findNamedType(nativeCode, 'MainApplication');
  if (
    mainApplication &&
    hasExactAndroidNativePathsReference(nativeCode) &&
    hasDirectNativePathsHostConnection(nativeCode) &&
    hasAndroidLifecycleIntegrity(nativeCode, mainApplication)
  ) {
    return true;
  }
  const startup = androidStartupMethod(nativeCode);
  if (
    startup &&
    hasExactAndroidNativePathsReference(nativeCode) &&
    hasNativePathsResolverCall(startup.method.body) &&
    resolverFeedsReturnedValue(
      startup.method.body,
      'BundleDropNativePaths.getDownloadedBundlePath',
      startup.method.declaration.trimEnd().endsWith('='),
      startup.method.language,
    ) &&
    hasAndroidLifecycleIntegrity(nativeCode, startup.owner) &&
    isResolverMethodConnectedToAndroidStartup(nativeCode, startup)
  ) {
    return true;
  }
  if (!hasExactAndroidModuleReference(nativeCode)) return false;

  if (
    !startup ||
    !hasValidAndroidModuleResolverCall(nativeCode, startup) ||
    !resolverFeedsReturnedValue(
      startup.method.body,
      'BundleDropModule.resolveJSBundleFile',
      startup.method.declaration.trimEnd().endsWith('='),
      startup.method.language,
      startup.method.language === 'kotlin' &&
        /:\s*(?:kotlin\.)?String\s*(?=[={])/.test(startup.method.declaration),
    )
  ) {
    return false;
  }
  if (!hasAndroidLifecycleIntegrity(nativeCode, startup.owner)) return false;

  return isResolverMethodConnectedToAndroidStartup(nativeCode, startup);
};

const swiftPrincipalTypes = (nativeCode: string) => findSourceTypes(nativeCode).filter(type => {
  const prefix = nativeCode.slice(Math.max(0, type.declarationStart - 120), type.declarationStart);
  return /@(?:main|UIApplicationMain)\b[\s\n]*(?:final\s+)?$/.test(prefix);
});

const hasConnectedSwiftFactoryDelegate = (
  nativeCode: string,
  delegateType: SourceType,
) => {
  const appDelegate = findNamedType(nativeCode, 'AppDelegate');
  if (!appDelegate) return false;
  const principals = swiftPrincipalTypes(nativeCode);
  if (
    principals.length > 1 ||
    (principals.length === 1 && principals[0].declarationStart !== appDelegate.declarationStart)
  ) {
    return false;
  }
  if (!/:\s*[^\{]*(?:UIApplicationDelegate|RCTAppDelegate)\b/.test(appDelegate.declaration)) {
    return false;
  }
  const launchMethods = methodsOwnedBy(
    nativeCode,
    SWIFT_APP_LAUNCH_METHOD,
    'AppDelegate',
  );
  if (launchMethods.length !== 1) return false;
  const launchBody = launchMethods[0].body;
  const factoryCalls = [...launchBody.matchAll(/\bRCTReactNativeFactory\s*\(/g)];
  const startCalls = [...launchBody.matchAll(/\b([A-Za-z_]\w*)\s*\.\s*startReactNative\s*\(/g)];
  if (factoryCalls.length !== 1 || startCalls.length !== 1) return false;
  const startPosition = startCalls[0].index || 0;
  const nestingDepth = [...launchBody.slice(0, startPosition)].reduce((depth, character) => {
    if (character === '{') return depth + 1;
    if (character === '}') return depth - 1;
    return depth;
  }, 0);
  if (nestingDepth !== 0) return false;

  const delegateName = escapeRegExp(delegateType.name);
  const delegateDeclarations = new RegExp(
    `\\b(?:let|var)\\s+([A-Za-z_]\\w*)\\s*(?::\\s*${delegateName})?` +
      `\\s*=\\s*${delegateName}\\s*\\(\\s*\\)`,
    'g',
  );
  return [...launchBody.matchAll(delegateDeclarations)].some(delegateMatch => {
    const delegateVariable = escapeRegExp(delegateMatch[1]);
    const factoryDeclaration = new RegExp(
      `\\b(?:let|var)\\s+([A-Za-z_]\\w*)\\s*=\\s*RCTReactNativeFactory\\s*` +
        `\\(\\s*delegate\\s*:\\s*${delegateVariable}\\s*\\)`,
    ).exec(launchBody);
    if (!factoryDeclaration) return false;
    return startCalls[0][1] === factoryDeclaration[1];
  });
};

const factoryDelegateSourceUrlFeedsBundleUrl = (
  nativeCode: string,
  delegateType: SourceType,
) => {
  const sourceMethods = findDeclaredMethods(nativeCode, SWIFT_SOURCE_URL_METHOD).filter(method =>
    findContainingType(nativeCode, method.declarationStart)?.declarationStart ===
      delegateType.declarationStart
  );
  if (sourceMethods.length !== 1) return false;
  const source = releaseSource(sourceMethods[0].body).trim();
  return /^(?:return\s+)?(?:self\s*\.\s*)?bundleURL\s*\(\s*\)\s*;?$/.test(source);
};

const appDelegateSourceUrlPreservesBundleAuthority = (
  nativeCode: string,
  appDelegate: SourceType,
) => {
  const sourceMethods = findDeclaredMethods(nativeCode, SWIFT_SOURCE_URL_METHOD).filter(method =>
    findContainingType(nativeCode, method.declarationStart)?.declarationStart ===
      appDelegate.declarationStart
  );
  if (!sourceMethods.length) return true;
  if (sourceMethods.length !== 1) return false;
  const source = releaseSource(sourceMethods[0].body).trim();
  return /^(?:return\s+)?(?:self\s*\.\s*)?bundleURL\s*\(\s*\)\s*;?$/.test(source) ||
    resolverFeedsReturnedValue(
      sourceMethods[0].body,
      'BundleDropLocator.bundleURL',
      false,
      'swift',
    );
};

const swiftStartupMethod = (nativeCode: string) => {
  const methods = findDeclaredMethods(nativeCode, SWIFT_BUNDLE_URL_METHOD);
  if (methods.length !== 1) return null;
  const method = methods[0];
  const owner = findContainingType(nativeCode, method.declarationStart);
  const principals = swiftPrincipalTypes(nativeCode);
  if (principals.length > 1) return null;
  if (owner?.name === 'AppDelegate') {
    const ownsPrincipal = !principals.length ||
      principals[0].declarationStart === owner.declarationStart;
    return ownsPrincipal &&
      /:\s*[^\{]*\bRCTAppDelegate\b/.test(owner.declaration) &&
      /\boverride\s+func\s+bundleURL\b/.test(method.declaration) &&
      appDelegateSourceUrlPreservesBundleAuthority(nativeCode, owner)
      ? method
      : null;
  }

  const factoryDelegates = findSourceTypes(nativeCode).filter(type =>
    /:\s*RCTDefaultReactNativeFactoryDelegate\b/.test(type.declaration)
  );
  return factoryDelegates.length === 1 &&
    owner?.name === factoryDelegates[0].name &&
    hasConnectedSwiftFactoryDelegate(nativeCode, factoryDelegates[0]) &&
    factoryDelegateSourceUrlFeedsBundleUrl(nativeCode, factoryDelegates[0])
    ? method
    : null;
};

const objcStartupMethods = (nativeCode: string) => {
  const implementations = findObjcImplementations(nativeCode);
  const appDelegateImplementations = implementations.filter(implementation =>
    implementation.name === 'AppDelegate' && !implementation.category
  );
  if (appDelegateImplementations.length !== 1) return null;
  const appDelegate = appDelegateImplementations[0];
  const allSourceMethods = findDeclaredMethods(nativeCode, OBJC_SOURCE_URL_METHOD);
  const allBundleMethods = findDeclaredMethods(nativeCode, OBJC_BUNDLE_URL_METHOD);
  const sourceMethods = allSourceMethods.filter(method =>
    methodBelongsToObjcImplementation(method, appDelegate)
  );
  const bundleMethods = allBundleMethods.filter(method =>
    methodBelongsToObjcImplementation(method, appDelegate)
  );
  if (allSourceMethods.length !== sourceMethods.length || allBundleMethods.length !== bundleMethods.length) {
    return null;
  }
  if (sourceMethods.length > 1 || bundleMethods.length > 1) return null;
  return { sourceMethod: sourceMethods[0] || null, bundleMethod: bundleMethods[0] || null };
};

export const hasBareIosStartupIntegration = (
  filePath: string,
  code: string,
) => {
  if (hasNativeCodePushResidue(code)) return false;
  const nativeCode = stripCommentsAndStrings(code);
  if (filePath.endsWith('.swift')) {
    const startupMethod = swiftStartupMethod(nativeCode);
    return Boolean(
      startupMethod &&
      resolverFeedsReturnedValue(
        startupMethod.body,
        'BundleDropLocator.bundleURL',
        false,
        'swift',
      ) &&
      new RegExp(`\\bimport\\s+${IOS_BUNDLE_DROP_MODULE}\\b`).test(nativeCode)
    );
  }

  const escapedHeader = IOS_BUNDLE_DROP_LOCATOR_HEADER.replace(/[/.]/g, '\\$&');
  if (!new RegExp(`#import\\s*[<"]${escapedHeader}[>"]`).test(nativeCode)) return false;
  const startup = objcStartupMethods(nativeCode);
  if (!startup) return false;

  const locatorCall = '[BundleDropLocator bundleURL]';
  const bundleHasLocator = startup.bundleMethod
    ? resolverFeedsReturnedValue(startup.bundleMethod.body, locatorCall, false, 'objc')
    : false;
  if (!startup.sourceMethod) return bundleHasLocator;
  return resolverFeedsReturnedValue(startup.sourceMethod.body, locatorCall, false, 'objc') ||
    (bundleHasLocator && (
      resolverFeedsReturnedValue(startup.sourceMethod.body, '[self bundleURL]', false, 'objc') ||
      resolverFeedsReturnedValue(startup.sourceMethod.body, 'self.bundleURL', false, 'objc')
    ));
};

const preservationSignals = (
  originalBody: string,
  updatedBody: string,
  signals: Array<{ label: string; token: string }>,
) => signals
  .filter(signal => originalBody.includes(signal.token) && !updatedBody.includes(signal.token))
  .map(signal => signal.label);

const findCodePushAliases = (content: string) => {
  const aliases = new Set<string>();
  for (const match of content.matchAll(
    /^\s*import\s+com\.microsoft\.codepush\.react\.CodePush\s+as\s+([A-Za-z_]\w*)\s*;?\s*$/gim,
  )) {
    aliases.add(match[1]);
  }
  for (const match of content.matchAll(
    /^\s*#\s*define\s+([A-Za-z_]\w*)\s+CodePush\s*$/gim,
  )) {
    aliases.add(match[1]);
  }
  return [...aliases];
};

const withoutReplaceableCodePushReferences = (
  content: string,
  knownAliases: string[] = [],
) => {
  const aliases = [...new Set([...findCodePushAliases(content), ...knownAliases])];
  const resolverOwners = [
    'com\\.microsoft\\.codepush\\.react\\.CodePush',
    'CodePush',
    ...aliases.map(escapeRegExp),
  ].join('|');
  return content
    .replace(
      /^\s*import\s+(?:com\.microsoft\.codepush\.react\.CodePush(?:\s+as\s+[A-Za-z_]\w*)?|CodePush)\s*;?\s*$/gim,
      '',
    )
    .replace(/^\s*#\s*import\s*[<"][^>"\n]*CodePush[^>"\n]*[>"]\s*$/gim, '')
    .replace(/^\s*#\s*define\s+[A-Za-z_]\w*\s+CodePush\s*$/gim, '')
    .replace(
      new RegExp(
        `\\b(?:${resolverOwners})\\s*\\.\\s*getJSBundleFile\\s*\\([^)]*\\)`,
        'gi',
      ),
      '',
    )
    .replace(
      new RegExp(`\\b(?:${resolverOwners})\\s*\\.\\s*bundleURL\\s*\\([^)]*\\)`, 'gi'),
      '',
    )
    .replace(
      new RegExp(`\\[\\s*(?:${resolverOwners})\\s+bundleURL\\s*\\]`, 'gi'),
      '',
    );
};

const substantiveNativeTokens = (content: string, codePushAliases: string[] = []) => {
  const tokens: string[] = [];
  const tokenPattern =
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|@?"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_]\w*|\d+(?:\.\d+)?/g;
  for (const match of withoutReplaceableCodePushReferences(content, codePushAliases)
    .matchAll(tokenPattern)) {
    const token = match[0];
    if (token.startsWith('//') || token.startsWith('/*')) continue;
    tokens.push(token);
  }
  return tokens;
};

const preservesSubstantiveNativeTokens = (
  original: string,
  updated: string,
  originalCodePushAliases: string[] = [],
) => {
  const originalTokens = substantiveNativeTokens(original, originalCodePushAliases);
  const updatedTokens = substantiveNativeTokens(updated);
  let originalIndex = 0;
  for (const token of updatedTokens) {
    if (token === originalTokens[originalIndex]) originalIndex += 1;
  }
  return originalIndex === originalTokens.length;
};

export const findMissingBareNativeStartupStructure = (
  filePath: string,
  original: string,
  updated: string,
): string[] => {
  const originalCode = stripCommentsAndStrings(original);
  const updatedCode = stripCommentsAndStrings(updated);
  const originalCodePushAliases = findCodePushAliases(original);
  const retainedCodePushAliases = originalCodePushAliases.filter(alias =>
    new RegExp(`\\b${escapeRegExp(alias)}\\b`).test(updatedCode)
  );
  const substantiveMissing = preservesSubstantiveNativeTokens(original, updated)
    ? []
    : ['substantive native code or ordering'];
  if (retainedCodePushAliases.length) {
    substantiveMissing.push('CodePush alias residue');
  }
  if (filePath.includes('MainApplication.')) {
    const missing = [...substantiveMissing];
    const originalStartup = androidStartupMethod(originalCode);
    if (originalStartup) {
      const updatedStartup = androidStartupMethod(updatedCode);
      if (!updatedStartup) {
        missing.push('getJSBundleFile');
      } else if (!preservesSubstantiveNativeTokens(
        originalStartup.method.body,
        updatedStartup.method.body,
        originalCodePushAliases,
      )) {
        missing.push('getJSBundleFile/non-CodePush fallback');
      }
    }

    const originalOwner = findNamedType(originalCode, 'MainApplication');
    if (!originalOwner) return missing;
    const updatedOwner = findNamedType(updatedCode, 'MainApplication');
    if (!updatedOwner) return [...missing, 'MainApplication'];

    const originalOnCreate = methodsOwnedBy(
      originalCode,
      ANDROID_ON_CREATE_METHOD,
      'MainApplication',
    )[0];
    if (!originalOnCreate) return missing;
    const updatedOnCreate = methodsOwnedBy(
      updatedCode,
      ANDROID_ON_CREATE_METHOD,
      'MainApplication',
    )[0];
    if (!updatedOnCreate) return [...missing, 'onCreate'];
    if (!preservesSubstantiveNativeTokens(
      originalOnCreate.body,
      updatedOnCreate.body,
      originalCodePushAliases,
    )) {
      missing.push('onCreate/substantive behavior');
    }
    return [...missing, ...preservationSignals(originalOnCreate.body, updatedOnCreate.body, [
      { label: 'onCreate/super.onCreate', token: 'super.onCreate' },
      { label: 'onCreate/loadReactNative', token: 'loadReactNative' },
      { label: 'onCreate/SoLoader.init', token: 'SoLoader.init' },
      {
        label: 'onCreate/DefaultNewArchitectureEntryPoint.load',
        token: 'DefaultNewArchitectureEntryPoint.load',
      },
    ])];
  }

  if (filePath.endsWith('.swift')) {
    const originalMethod = swiftStartupMethod(originalCode);
    if (!originalMethod) return substantiveMissing;
    const updatedMethod = swiftStartupMethod(updatedCode);
    if (!updatedMethod) return [...substantiveMissing, 'bundleURL'];
    const missing = [...substantiveMissing];
    if (!preservesSubstantiveNativeTokens(
      originalMethod.body,
      updatedMethod.body,
      originalCodePushAliases,
    )) {
      missing.push('bundleURL/non-CodePush fallback');
    }
    return [...missing, ...preservationSignals(originalMethod.body, updatedMethod.body, [
          { label: 'bundleURL/RCTBundleURLProvider', token: 'RCTBundleURLProvider' },
          { label: 'bundleURL/Bundle.main.url', token: 'Bundle.main.url' },
        ])];
  }

  const originalStartup = objcStartupMethods(originalCode);
  if (!originalStartup) return substantiveMissing;
  const updatedStartup = objcStartupMethods(updatedCode);
  if (!updatedStartup) return [...substantiveMissing, 'sourceURLForBridge/bundleURL'];
  const originalBody = [originalStartup.sourceMethod?.body, originalStartup.bundleMethod?.body]
    .filter(Boolean)
    .join('\n');
  const updatedBody = [updatedStartup.sourceMethod?.body, updatedStartup.bundleMethod?.body]
    .filter(Boolean)
    .join('\n');
  const missing = [...substantiveMissing];
  if (!preservesSubstantiveNativeTokens(
    originalBody,
    updatedBody,
    originalCodePushAliases,
  )) {
    missing.push('sourceURLForBridge/bundleURL non-CodePush fallback');
  }
  missing.push(...preservationSignals(originalBody, updatedBody, [
    { label: 'sourceURL/RCTBundleURLProvider', token: 'RCTBundleURLProvider' },
    { label: 'sourceURL/NSBundle fallback', token: 'NSBundle mainBundle' },
  ]));
  if (
    originalStartup.sourceMethod?.body.match(OBJC_SELF_BUNDLE_URL_DELEGATION) &&
    !updatedStartup.sourceMethod?.body.match(OBJC_SELF_BUNDLE_URL_DELEGATION)
  ) {
    missing.push('sourceURLForBridge/bundleURL delegation');
  }
  return missing;
};
