import crypto from 'crypto';
import { inspectProjectFile } from '../safe-file-transaction';
import { findNativeEntrypointAuthorityIssue } from '../native-entrypoint-authority';
import { AiPatchPlan } from './types';
import { AiSetupProjectType } from './types';
import {
  findMissingBareNativeStartupStructure,
  hasBareAndroidStartupIntegration,
  hasBareIosStartupIntegration,
  stripComments,
  stripCommentsAndStrings,
} from '../native-setup-contract';
import { hasUnsafeTerminalControl } from './terminal-safety';

const sha256 = (content: string) => crypto.createHash('sha256').update(content).digest('hex');

export const isSafeRelativePath = (value: string) => {
  if (!value || value.startsWith('/') || value.includes('\\')) return false;
  const normalized = value.split('/').filter(Boolean).join('/');
  return normalized === value && !normalized.split('/').includes('..');
};

export const isPatchableNativeEntrypoint = (filePath: string) =>
  /(^|\/)android\/(?:.*\/)?MainApplication\.(kt|java)$/.test(filePath) ||
  /(^|\/)ios\/(?:.*\/)?AppDelegate\.(swift|m|mm)$/.test(filePath);

export const isPatchableExpoConfig = (filePath: string) =>
  filePath === 'app.json' ||
  /^app\.config\.(js|ts|cjs|mjs)$/.test(filePath) ||
  /^metro\.config\.(js|ts|cjs|mjs)$/.test(filePath);

const hasBalancedPairs = (content: string, isDynamicExpoConfig: boolean) => {
  const pairs: Record<string, string> = { ')': '(', '}': '{', ']': '[' };
  const opens = new Set(Object.values(pairs));
  const stack: string[] = [];
  const structure = isDynamicExpoConfig
    ? maskStringAndRegexLiterals(stripComments(content))
    : stripCommentsAndStrings(content);

  for (const char of structure) {
    if (opens.has(char)) stack.push(char);
    if (pairs[char] && stack.pop() !== pairs[char]) return false;
  }

  return stack.length === 0;
};

const hasAndroidBundleDropIntegration = (content: string) => {
  return hasBareAndroidStartupIntegration(content);
};

const hasIosBundleDropIntegration = (filePath: string, content: string) => {
  return hasBareIosStartupIntegration(filePath, content);
};

const findBalancedDelimiterEnd = (
  source: string,
  openingIndex: number,
  opening: string,
  closing: string,
) => {
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = openingIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === opening) depth += 1;
    if (character === closing) depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
};

const topLevelCommaRanges = (source: string, start: number, end: number) => {
  const ranges: Array<{ start: number; end: number }> = [];
  let entryStart = start;
  const stack: string[] = [];
  let quote = '';
  let escaped = false;
  for (let index = start; index < end; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if ('[({'.includes(character)) stack.push(character);
    else if (']})'.includes(character)) stack.pop();
    else if (character === ',' && !stack.length) {
      ranges.push({ start: entryStart, end: index + 1 });
      entryStart = index + 1;
    }
  }
  ranges.push({ start: entryStart, end });
  return ranges;
};

const canStartRegexLiteral = (source: string, slashIndex: number) => {
  const prefix = source.slice(0, slashIndex).trimEnd();
  if (!prefix) return true;
  const previousCharacter = prefix[prefix.length - 1];
  if (/^[=([{,:;!?&|+\-*%^~<>]$/.test(previousCharacter)) return true;
  const previousWord = prefix.match(/([A-Za-z_$][\w$]*)$/)?.[1];
  return Boolean(previousWord && [
    'await',
    'case',
    'delete',
    'do',
    'else',
    'in',
    'instanceof',
    'new',
    'of',
    'return',
    'throw',
    'typeof',
    'void',
    'yield',
  ].includes(previousWord));
};

const maskStringAndRegexLiterals = (source: string) => {
  const characters = source.split('');
  let quote = '';
  let escaped = false;
  let regexCharacterClass = false;
  let templateExpressionDepth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote === '/') {
      if (character !== '\n') characters[index] = ' ';
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '[') regexCharacterClass = true;
      else if (character === ']') regexCharacterClass = false;
      else if (character === '/' && !regexCharacterClass) quote = '';
      continue;
    }
    if (quote === '`') {
      if (character !== '\n') characters[index] = ' ';
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '`') quote = '';
      else if (character === '$' && source[index + 1] === '{') {
        characters[index + 1] = ' ';
        templateExpressionDepth += 1;
        quote = '';
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character !== '\n') characters[index] = ' ';
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (templateExpressionDepth > 0 && character === '{') {
      templateExpressionDepth += 1;
      continue;
    }
    if (templateExpressionDepth > 0 && character === '}') {
      templateExpressionDepth -= 1;
      if (templateExpressionDepth === 0) {
        characters[index] = ' ';
        quote = '`';
      }
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      characters[index] = ' ';
      continue;
    }
    if (character === '/' && canStartRegexLiteral(source, index)) {
      quote = '/';
      regexCharacterClass = false;
      characters[index] = ' ';
    }
  }
  return characters.join('');
};

const maskCommentsPreservingLength = (source: string) => {
  const characters = source.split('');
  let state: 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' |
    'template' | 'regex' = 'code';
  let escaped = false;
  let blockCommentDepth = 0;
  let regexCharacterClass = false;
  let templateExpressionDepth = 0;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];
    if (state === 'line-comment') {
      if (character === '\n') state = 'code';
      else if (character !== '\r') characters[index] = ' ';
      continue;
    }
    if (state === 'block-comment') {
      if (character !== '\n' && character !== '\r') characters[index] = ' ';
      if (character === '/' && nextCharacter === '*') {
        characters[index + 1] = ' ';
        blockCommentDepth += 1;
        index += 1;
      } else if (character === '*' && nextCharacter === '/') {
        characters[index + 1] = ' ';
        blockCommentDepth -= 1;
        index += 1;
        if (blockCommentDepth === 0) state = 'code';
      }
      continue;
    }
    if (state === 'regex') {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '[') regexCharacterClass = true;
      else if (character === ']') regexCharacterClass = false;
      else if (character === '/' && !regexCharacterClass) state = 'code';
      continue;
    }
    if (state === 'template') {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '`') state = 'code';
      else if (character === '$' && nextCharacter === '{') {
        templateExpressionDepth = 1;
        state = 'code';
        index += 1;
      }
      continue;
    }
    if (state === 'single' || state === 'double') {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (
        (state === 'single' && character === "'") ||
        (state === 'double' && character === '"')
      ) {
        state = 'code';
      }
      continue;
    }
    if (templateExpressionDepth > 0 && character === '{') {
      templateExpressionDepth += 1;
      continue;
    }
    if (templateExpressionDepth > 0 && character === '}') {
      templateExpressionDepth -= 1;
      if (templateExpressionDepth === 0) state = 'template';
      continue;
    }
    if (character === '/' && nextCharacter === '/') {
      characters[index] = ' ';
      characters[index + 1] = ' ';
      state = 'line-comment';
      index += 1;
      continue;
    }
    if (character === '/' && nextCharacter === '*') {
      characters[index] = ' ';
      characters[index + 1] = ' ';
      state = 'block-comment';
      blockCommentDepth = 1;
      index += 1;
      continue;
    }
    if (character === "'") state = 'single';
    else if (character === '"') state = 'double';
    else if (character === '`') state = 'template';
    else if (character === '/' && canStartRegexLiteral(source, index)) {
      state = 'regex';
      regexCharacterClass = false;
    }
  }

  return characters.join('');
};

const skipWhitespace = (source: string, start: number) => {
  let cursor = start;
  while (/\s/.test(source[cursor] || '')) cursor += 1;
  return cursor;
};

const CANONICAL_ARROW_FUNCTION_SIGNATURE =
  /^(?:async\s*)?(?:[A-Za-z_$][\w$]*|\([\s\S]*\))(?:\s*:\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\s*<[^;={}]*>)?)?$/;

const endsAtTerminalStatement = (structure: string, start: number) => {
  let cursor = skipWhitespace(structure, start);
  if (structure[cursor] === ';') cursor = skipWhitespace(structure, cursor + 1);
  return cursor === structure.length;
};

const isUnconditionalTopLevelExport = (
  source: string,
  structure: string,
  exportIndex: number,
) => {
  const stack: string[] = [];
  let statementStart = 0;
  for (let index = 0; index < exportIndex; index += 1) {
    const character = structure[index];
    if ('[({'.includes(character)) stack.push(character);
    else if (']})'.includes(character)) stack.pop();
    else if (character === ';' && !stack.length) statementStart = index + 1;
    else if (character === '\n' && !stack.length) {
      const statement = structure.slice(statementStart, index).trim();
      const sourceStatement = source.slice(statementStart, index).trim();
      let nextTokenIndex = index + 1;
      while (/\s/.test(source[nextTokenIndex] || '')) nextTokenIndex += 1;
      if (
        /^(?:const|let|var|import)\b/.test(statement) &&
        !/[=([{,:!?&|+\-*%^~<>.]$/.test(sourceStatement) &&
        !startsJavaScriptExpressionContinuation(source, nextTokenIndex)
      ) {
        statementStart = index + 1;
      }
    }
  }
  return !stack.length && !structure.slice(statementStart, exportIndex).trim();
};

const returnedObjectFromArrowBlock = (
  structure: string,
  blockOpening: number,
) => {
  const blockClosing = findBalancedDelimiterEnd(structure, blockOpening, '{', '}');
  if (blockClosing < 0) return null;

  const stack: string[] = [];
  const returnIndices: number[] = [];
  let statementStart = blockOpening + 1;
  for (let index = blockOpening + 1; index < blockClosing; index += 1) {
    const character = structure[index];
    if ('[({'.includes(character)) stack.push(character);
    else if (']})'.includes(character)) stack.pop();
    else if (character === ';' && !stack.length) statementStart = index + 1;
    else if (
      !stack.length &&
      structure.startsWith('return', index) &&
      !/[\w$]/.test(structure[index - 1] || '') &&
      !/[\w$]/.test(structure[index + 'return'.length] || '') &&
      !structure.slice(statementStart, index).trim()
    ) {
      returnIndices.push(index);
    }
  }
  if (returnIndices.length !== 1) return null;

  let cursor = skipWhitespace(structure, returnIndices[0] + 'return'.length);
  let parentheses = 0;
  while (structure[cursor] === '(') {
    parentheses += 1;
    cursor = skipWhitespace(structure, cursor + 1);
  }
  if (structure[cursor] !== '{') return null;
  const opening = cursor;
  const closing = findBalancedDelimiterEnd(structure, opening, '{', '}');
  if (closing < 0 || closing > blockClosing) return null;

  cursor = skipWhitespace(structure, closing + 1);
  while (parentheses > 0 && structure[cursor] === ')') {
    parentheses -= 1;
    cursor = skipWhitespace(structure, cursor + 1);
  }
  if (parentheses > 0) return null;
  if (structure[cursor] === ';') cursor = skipWhitespace(structure, cursor + 1);
  if (cursor !== blockClosing) return null;
  return { opening, closing, blockClosing };
};

const rootConfigObjectRange = (source: string) => {
  const structure = maskStringAndRegexLiterals(source);
  const exportAssignments = [...structure.matchAll(
    /\b(?:export\s+default|module\s*\.\s*exports\s*=)/g,
  )];
  if (exportAssignments.length !== 1) return null;
  const [exportAssignment] = exportAssignments;
  const exportIndex = exportAssignment.index || 0;
  if (!isUnconditionalTopLevelExport(source, structure, exportIndex)) return null;
  let cursor = (exportAssignment.index || 0) + exportAssignment[0].length;
  cursor = skipWhitespace(structure, cursor);

  if (structure[cursor] === '{') {
    const closing = findBalancedDelimiterEnd(structure, cursor, '{', '}');
    return closing >= 0 && endsAtTerminalStatement(structure, closing + 1)
      ? { opening: cursor, closing }
      : null;
  }

  const stack: string[] = [];
  let arrow = -1;
  for (let index = cursor; index < structure.length - 1; index += 1) {
    const character = structure[index];
    if ('[({'.includes(character)) stack.push(character);
    else if (']})'.includes(character)) stack.pop();
    else if (character === ';' && !stack.length) return null;
    else if (character === '=' && structure[index + 1] === '>' && !stack.length) {
      arrow = index;
      break;
    }
  }
  if (arrow < 0) return null;
  const parameters = structure.slice(cursor, arrow).trim();
  if (!CANONICAL_ARROW_FUNCTION_SIGNATURE.test(parameters)) return null;

  cursor = skipWhitespace(structure, arrow + 2);
  if (structure[cursor] === '{') {
    const returned = returnedObjectFromArrowBlock(structure, cursor);
    if (!returned || !endsAtTerminalStatement(structure, returned.blockClosing + 1)) return null;
    return { opening: returned.opening, closing: returned.closing };
  }

  let parentheses = 0;
  while (structure[cursor] === '(') {
    parentheses += 1;
    cursor = skipWhitespace(structure, cursor + 1);
  }
  if (!parentheses || structure[cursor] !== '{') return null;
  const opening = cursor;
  const closing = findBalancedDelimiterEnd(structure, opening, '{', '}');
  if (closing < 0) return null;
  cursor = skipWhitespace(structure, closing + 1);
  while (parentheses > 0 && structure[cursor] === ')') {
    parentheses -= 1;
    cursor = skipWhitespace(structure, cursor + 1);
  }
  return parentheses === 0 && endsAtTerminalStatement(structure, cursor)
    ? { opening, closing }
    : null;
};

const decodeJavaScriptStringLiteral = (expression: string) => {
  const quote = expression[0];
  if (!['"', "'", '`'].includes(quote) || expression[expression.length - 1] !== quote) {
    return null;
  }
  const body = expression.slice(1, -1);
  if (quote === '`') {
    for (let index = 0; index < body.length - 1; index += 1) {
      if (body[index] !== '$' || body[index + 1] !== '{') continue;
      let backslashes = 0;
      for (let cursor = index - 1; cursor >= 0 && body[cursor] === '\\'; cursor -= 1) {
        backslashes += 1;
      }
      if (backslashes % 2 === 0) return null;
    }
  }

  let decoded = '';
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === quote) return null;
    if (character !== '\\') {
      decoded += character;
      continue;
    }
    index += 1;
    if (index >= body.length) return null;
    const escaped = body[index];
    if (escaped === '\n') continue;
    if (escaped === '\r') {
      if (body[index + 1] === '\n') index += 1;
      continue;
    }
    if (escaped === 'u') {
      const braced = /^\{([0-9A-Fa-f]{1,6})\}/.exec(body.slice(index + 1));
      if (braced) {
        const codePoint = Number.parseInt(braced[1], 16);
        if (codePoint > 0x10ffff) return null;
        decoded += String.fromCodePoint(codePoint);
        index += braced[0].length;
        continue;
      }
      const unicode = /^[0-9A-Fa-f]{4}/.exec(body.slice(index + 1));
      if (!unicode) return null;
      decoded += String.fromCharCode(Number.parseInt(unicode[0], 16));
      index += unicode[0].length;
      continue;
    }
    if (escaped === 'x') {
      const hex = /^[0-9A-Fa-f]{2}/.exec(body.slice(index + 1));
      if (!hex) return null;
      decoded += String.fromCharCode(Number.parseInt(hex[0], 16));
      index += hex[0].length;
      continue;
    }
    if (/[0-7]/.test(escaped)) {
      const octal = new RegExp(`^${escaped}[0-7]{0,2}`).exec(body.slice(index));
      if (!octal) return null;
      decoded += String.fromCharCode(Number.parseInt(octal[0], 8));
      index += octal[0].length - 1;
      continue;
    }
    const simpleEscapes: Record<string, string> = {
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\v',
    };
    decoded += simpleEscapes[escaped] ?? escaped;
  }
  return decoded;
};

const resolveConstantStringExpression = (
  expression: string,
  bindings: Map<string, string>,
): string | null => {
  let candidate = expression.trim();
  candidate = candidate.replace(
    /\s+(?:(?:as\s+(?:const|string))|(?:satisfies\s+string))\s*$/,
    '',
  ).trim();
  while (candidate.startsWith('(')) {
    const structure = maskStringAndRegexLiterals(candidate);
    const closing = findBalancedDelimiterEnd(structure, 0, '(', ')');
    if (closing !== candidate.length - 1) break;
    candidate = candidate.slice(1, -1).trim();
  }

  const literal = decodeJavaScriptStringLiteral(candidate);
  if (literal !== null) return literal;
  if (/^[A-Za-z_$][\w$]*$/.test(candidate)) return bindings.get(candidate) ?? null;

  const structure = maskStringAndRegexLiterals(candidate);
  const ranges: Array<{ start: number; end: number }> = [];
  const stack: string[] = [];
  let start = 0;
  for (let index = 0; index < structure.length; index += 1) {
    const character = structure[index];
    if ('[({'.includes(character)) stack.push(character);
    else if (']})'.includes(character)) stack.pop();
    else if (character === '+' && !stack.length) {
      ranges.push({ start, end: index });
      start = index + 1;
    }
  }
  if (!ranges.length) return null;
  ranges.push({ start, end: candidate.length });
  const values = ranges.map(range =>
    resolveConstantStringExpression(candidate.slice(range.start, range.end), bindings)
  );
  return values.every((value): value is string => value !== null) ? values.join('') : null;
};

const startsJavaScriptExpressionContinuation = (source: string, start: number) => {
  const remainder = source.slice(start);
  if (/^(?:instanceof|in|as|satisfies)\b/.test(remainder)) return true;
  return /^(?:\?\.|\?\?|&&|\|\||\*\*|===|!==|==|!=|=>|<<|>>>?|<=|>=|[+\-*/%&|^<>=?.[(,`])/.test(
    remainder,
  );
};

const collectConstantStringBindings = (commentFreeSource: string) => {
  const structure = maskStringAndRegexLiterals(commentFreeSource);
  const values = new Map<string, string>();
  const ambiguousAuthorityNames = new Set<string>();
  for (const match of structure.matchAll(
    /\bconst\s+([A-Za-z_$][\w$]*)(?:\s*:\s*string)?\s*=/g,
  )) {
    const matchIndex = match.index || 0;
    const stack: string[] = [];
    for (let index = 0; index < matchIndex; index += 1) {
      const character = structure[index];
      if ('[({'.includes(character)) stack.push(character);
      else if (']})'.includes(character)) stack.pop();
    }
    if (stack.length) continue;

    const expressionStart = matchIndex + match[0].length;
    let expressionEnd = structure.length;
    const expressionStack: string[] = [];
    for (let index = expressionStart; index < structure.length; index += 1) {
      const character = structure[index];
      if ('[({'.includes(character)) expressionStack.push(character);
      else if (']})'.includes(character)) expressionStack.pop();
      else if (character === ';' && !expressionStack.length) {
        expressionEnd = index;
        break;
      } else if (character === '\n' && !expressionStack.length) {
        const expression = commentFreeSource.slice(expressionStart, index).trim();
        let nextTokenIndex = index + 1;
        while (/\s/.test(commentFreeSource[nextTokenIndex] || '')) nextTokenIndex += 1;
        const continuesExpression = startsJavaScriptExpressionContinuation(
          commentFreeSource,
          nextTokenIndex,
        );
        if (
          expression &&
          !/[=([{,:!?&|+\-*%^~<>.]$/.test(expression) &&
          !continuesExpression
        ) {
          expressionEnd = index;
          break;
        }
      }
    }
    const expression = commentFreeSource.slice(expressionStart, expressionEnd);
    const value = resolveConstantStringExpression(expression, values);
    if (value !== null) values.set(match[1], value);
    else if (
      decodedExpressionMayReferenceSetupAuthority(expression) ||
      [...ambiguousAuthorityNames].some(name => {
        const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(^|[^\\w$])${escapedName}([^\\w$]|$)`).test(expression);
      })
    ) {
      ambiguousAuthorityNames.add(match[1]);
    }
  }
  return { values, ambiguousAuthorityNames };
};

const pluginEntryExpression = (entry: string) => {
  if (!entry.startsWith('[')) return entry;
  const structure = maskStringAndRegexLiterals(entry);
  const closing = findBalancedDelimiterEnd(structure, 0, '[', ']');
  if (closing !== entry.length - 1) return null;
  const [firstTupleEntry] = topLevelCommaRanges(structure, 1, closing);
  return firstTupleEntry
    ? entry.slice(firstTupleEntry.start, firstTupleEntry.end).replace(/,\s*$/, '').trim()
    : null;
};

const decodedExpressionMayReferenceSetupAuthority = (expression: string) => {
  const decodedEscapes = expression
    .replace(/\\u\{([0-9A-Fa-f]{1,6})\}/g, (_match, value) =>
      String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/\\u([0-9A-Fa-f]{4})/g, (_match, value) =>
      String.fromCharCode(Number.parseInt(value, 16)))
    .replace(/\\x([0-9A-Fa-f]{2})/g, (_match, value) =>
      String.fromCharCode(Number.parseInt(value, 16)))
    .replace(/\\([0-7]{1,3})/g, (_match, value) =>
      String.fromCharCode(Number.parseInt(value, 8)));
  const compact = decodedEscapes.toLowerCase().replace(/[\s'"`+${}()[\]\\]/g, '');
  return compact.includes('expo-updates') ||
    compact.includes('@gfean/react-native-bundle-drop');
};

const resolvePluginEntry = (
  entry: string,
  bindings: ReturnType<typeof collectConstantStringBindings>,
) => {
  const expression = pluginEntryExpression(entry);
  if (!expression) return { packageName: null, ambiguousAuthority: true };
  const packageName = resolveConstantStringExpression(expression, bindings.values);
  return {
    packageName,
    ambiguousAuthority:
      packageName === null && (
        decodedExpressionMayReferenceSetupAuthority(expression) ||
        bindings.ambiguousAuthorityNames.has(expression)
      ),
  };
};

const isCanonicalExistingPluginsSpread = (entry: string) =>
  /^\.\.\.\s*\(\s*config\s*\.\s*plugins\s*(?:\|\||\?\?)\s*\[\s*\]\s*\)$/.test(entry);

const decodeJavaScriptIdentifier = (identifier: string) => {
  const decoded = identifier
    .replace(/\\u\{([0-9A-Fa-f]{1,6})\}/g, (_match, value) => {
      const codePoint = Number.parseInt(value, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '';
    })
    .replace(/\\u([0-9A-Fa-f]{4})/g, (_match, value) =>
      String.fromCharCode(Number.parseInt(value, 16)));
  return /^[A-Za-z_$][\w$]*$/.test(decoded) ? decoded : null;
};

const directPropertyDefinition = (field: string) => {
  const leadingWhitespace = field.match(/^\s*/)?.[0].length ?? 0;
  const candidate = field.slice(leadingWhitespace);
  const named = /^((?:[A-Za-z_$]|\\u(?:\{[0-9A-Fa-f]{1,6}\}|[0-9A-Fa-f]{4}))(?:[\w$]|\\u(?:\{[0-9A-Fa-f]{1,6}\}|[0-9A-Fa-f]{4}))*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')\s*:/.exec(
    candidate,
  );
  if (named) {
    const name = /^['"]/.test(named[1])
      ? decodeJavaScriptStringLiteral(named[1])
      : decodeJavaScriptIdentifier(named[1]);
    return {
      name,
      computed: false,
      valueStart: leadingWhitespace + named[0].length,
    };
  }
  if (!candidate.startsWith('[')) return null;
  const structure = maskStringAndRegexLiterals(candidate);
  const closing = findBalancedDelimiterEnd(structure, 0, '[', ']');
  if (closing < 0) return null;
  const colon = /^\s*:/.exec(candidate.slice(closing + 1));
  if (!colon) return null;
  const propertyExpression = candidate.slice(1, closing).trim();
  const staticLiteral = /^(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')$/.test(
    propertyExpression,
  );
  return {
    name: staticLiteral ? decodeJavaScriptStringLiteral(propertyExpression) : null,
    computed: true,
    valueStart: leadingWhitespace + closing + 1 + colon[0].length,
  };
};

const resolvedDirectPropertyName = (field: string) => {
  const definition = directPropertyDefinition(field);
  if (definition) return definition.name;
  const candidate = field.replace(/,\s*$/, '').trim();
  const shorthand = /^((?:[A-Za-z_$]|\\u(?:\{[0-9A-Fa-f]{1,6}\}|[0-9A-Fa-f]{4}))(?:[\w$]|\\u(?:\{[0-9A-Fa-f]{1,6}\}|[0-9A-Fa-f]{4}))*)$/.exec(
    candidate,
  );
  return shorthand ? decodeJavaScriptIdentifier(shorthand[1]) : null;
};

const directPropertyContainerRange = (
  source: string,
  structure: string,
  range: { start: number; end: number },
  expectedName: string,
  openingCharacter: '{' | '[',
  closingCharacter: '}' | ']',
) => {
  const entry = source.slice(range.start, range.end);
  const definition = directPropertyDefinition(entry);
  if (!definition || definition.name !== expectedName) return null;
  const localOpening = skipWhitespace(entry, definition.valueStart);
  if (entry[localOpening] !== openingCharacter) return null;
  const opening = range.start + localOpening;
  const closing = findBalancedDelimiterEnd(
    structure,
    opening,
    openingCharacter,
    closingCharacter,
  );
  if (closing < 0 || closing > range.end) return null;
  const remainder = source.slice(closing + 1, range.end).replace(/,\s*$/, '').trim();
  return remainder ? null : { opening, closing, computed: definition.computed };
};

const objectAccessorOrMethodDefinition = (entry: string) => {
  const candidate = entry.trimStart();
  const prefix = /^(?:(?:get|set)\s+|(?:async\s+)?\*?\s*)/.exec(candidate)?.[0] ?? '';
  const nameSource = candidate.slice(prefix.length);
  if (nameSource.startsWith('[')) {
    const structure = maskStringAndRegexLiterals(nameSource);
    const closing = findBalancedDelimiterEnd(structure, 0, '[', ']');
    if (closing < 0 || !/^\s*\(/.test(nameSource.slice(closing + 1))) return null;
    const propertyExpression = nameSource.slice(1, closing).trim();
    const staticLiteral = /^(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')$/.test(
      propertyExpression,
    );
    return {
      name: staticLiteral ? decodeJavaScriptStringLiteral(propertyExpression) : null,
    };
  }
  const method = /^((?:[A-Za-z_$]|\\u(?:\{[0-9A-Fa-f]{1,6}\}|[0-9A-Fa-f]{4}))(?:[\w$]|\\u(?:\{[0-9A-Fa-f]{1,6}\}|[0-9A-Fa-f]{4}))*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')\s*\(/.exec(
    nameSource,
  );
  if (!method) return null;
  const propertyName = /^['"]/.test(method[1])
    ? decodeJavaScriptStringLiteral(method[1])
    : decodeJavaScriptIdentifier(method[1]);
  return { name: propertyName };
};

const hasAmbiguousAuthorityAccessorOrMethod = (
  entry: string,
  authorityNames: string[],
) => {
  const method = objectAccessorOrMethodDefinition(entry);
  return Boolean(method && (!method.name || authorityNames.includes(method.name)));
};

const authoritativeExpoConfigRange = (source: string) => {
  const exportedRoot = rootConfigObjectRange(source);
  if (!exportedRoot) return null;
  const structure = maskStringAndRegexLiterals(source);
  const rootEntries = topLevelCommaRanges(
    structure,
    exportedRoot.opening + 1,
    exportedRoot.closing,
  );
  const rootEntrySources = rootEntries.map(range => source.slice(range.start, range.end));
  const rootDefinitions = rootEntrySources.map(directPropertyDefinition);
  const rootPropertyNames = rootEntrySources.map(resolvedDirectPropertyName);
  const directExpoObjects = rootEntries.flatMap((range, entryIndex) => {
    if (rootDefinitions[entryIndex]?.name !== 'expo') return [];
    const property = directPropertyContainerRange(
      source,
      structure,
      range,
      'expo',
      '{',
      '}',
    );
    return property
      ? [{ ...property, entryIndex }]
      : [];
  });
  const expoNamedPropertyCount = rootPropertyNames.filter(name => name === 'expo').length;
  if (!directExpoObjects.length) {
    return expoNamedPropertyCount ? null : exportedRoot;
  }
  if (
    directExpoObjects.length !== 1 ||
    expoNamedPropertyCount !== 1 ||
    rootEntrySources.some((entry, entryIndex) =>
      Boolean(rootDefinitions[entryIndex] && !rootPropertyNames[entryIndex]) ||
      (/^\s*\.\.\./.test(entry) && entryIndex > directExpoObjects[0].entryIndex) ||
      hasAmbiguousAuthorityAccessorOrMethod(entry, ['expo', 'plugins', 'updates']) ||
      ['plugins', 'updates'].includes(rootPropertyNames[entryIndex] || '')
    )
  ) {
    return null;
  }
  return directExpoObjects[0];
};

type SourceRange = { start: number; end: number };

const removableCommaRange = (source: string, range: SourceRange): SourceRange => {
  let end = range.end;
  while (end > range.start && /\s/.test(source[end - 1])) end -= 1;
  if (source[end - 1] === ',') return { start: range.start, end };

  let start = range.start - 1;
  while (start >= 0 && /\s/.test(source[start])) start -= 1;
  return source[start] === ','
    ? { start, end }
    : { start: range.start, end };
};

const removeSourceRanges = (source: string, ranges: SourceRange[]) => {
  const ordered = [...ranges].sort((left, right) => right.start - left.start);
  let result = source;
  for (const range of ordered) {
    result = result.slice(0, range.start) + result.slice(range.end);
  }
  return result;
};

const removeTopLevelExpoUpdatesPluginEntries = (source: string) => {
  const structuralSource = maskCommentsPreservingLength(source);
  const root = authoritativeExpoConfigRange(structuralSource);
  if (!root) return source;
  const structure = maskStringAndRegexLiterals(structuralSource);
  const bindings = collectConstantStringBindings(structuralSource);
  const rangesToRemove: SourceRange[] = [];
  const rootEntries = topLevelCommaRanges(structure, root.opening + 1, root.closing);
  for (const entryRange of rootEntries) {
    const property = directPropertyContainerRange(
      structuralSource,
      structure,
      entryRange,
      'plugins',
      '[',
      ']',
    );
    if (!property) continue;
    for (const range of topLevelCommaRanges(
      structure,
      property.opening + 1,
      property.closing,
    )) {
      const plugin = structuralSource
        .slice(range.start, range.end)
        .replace(/,\s*$/, '')
        .trim();
      if (!plugin) continue;
      if (resolvePluginEntry(plugin, bindings).packageName !== 'expo-updates') continue;
      rangesToRemove.push(removableCommaRange(source, range));
    }
  }
  return removeSourceRanges(source, rangesToRemove);
};

const removeTopLevelBundleDropRegistration = (
  source: string,
  removeNewPluginProperty: boolean,
) => {
  const structuralSource = maskCommentsPreservingLength(source);
  const root = authoritativeExpoConfigRange(structuralSource);
  if (!root) return source;
  const structure = maskStringAndRegexLiterals(structuralSource);
  const rangesToRemove: SourceRange[] = [];
  const rootEntries = topLevelCommaRanges(structure, root.opening + 1, root.closing);
  for (const entryRange of rootEntries) {
    const entry = structuralSource.slice(entryRange.start, entryRange.end);
    const property = directPropertyContainerRange(
      structuralSource,
      structure,
      entryRange,
      'plugins',
      '[',
      ']',
    );
    if (!property) continue;
    if (
      removeNewPluginProperty &&
      !/^\s*(?:plugins|"plugins"|'plugins')\s*:/.test(entry)
    ) {
      continue;
    }
    const pluginRanges = topLevelCommaRanges(
      structure,
      property.opening + 1,
      property.closing,
    );
    const substantiveRanges = pluginRanges.filter(range =>
      structuralSource.slice(range.start, range.end).replace(/[,\s]/g, '')
    );
    const bundleDropRanges = substantiveRanges.filter(range => {
      const plugin = structuralSource
        .slice(range.start, range.end)
        .replace(/,\s*$/, '')
        .trim();
      return /^(?:"@gfean\/react-native-bundle-drop"|'@gfean\/react-native-bundle-drop')$/.test(
        plugin,
      );
    });
    if (bundleDropRanges.length !== 1) continue;
    const removesWholePluginProperty = removeNewPluginProperty && substantiveRanges.length === 1;
    const authorizedRanges = removesWholePluginProperty
      ? [entryRange]
      : bundleDropRanges;
    const removesOnlyRootProperty = removesWholePluginProperty &&
      rootEntries.filter(range =>
        structuralSource.slice(range.start, range.end).replace(/[,\s]/g, '')
      ).length === 1;
    rangesToRemove.push(
      ...authorizedRanges.map(range => removesOnlyRootProperty
        ? range
        : removableCommaRange(source, range)),
    );
  }
  return removeSourceRanges(source, rangesToRemove);
};

const hasTopLevelPluginsProperty = (source: string) => {
  const structuralSource = stripComments(source);
  const root = authoritativeExpoConfigRange(structuralSource);
  if (!root) return null;
  const structure = maskStringAndRegexLiterals(structuralSource);
  return topLevelCommaRanges(structure, root.opening + 1, root.closing).some(range =>
    directPropertyDefinition(structuralSource.slice(range.start, range.end))?.name ===
      'plugins'
  );
};

const removeTopLevelExpoUpdatesFields = (source: string) => {
  const structuralSource = maskCommentsPreservingLength(source);
  const root = authoritativeExpoConfigRange(structuralSource);
  if (!root) return source;
  const structure = maskStringAndRegexLiterals(structuralSource);
  const rangesToRemove: SourceRange[] = [];
  const rootEntries = topLevelCommaRanges(structure, root.opening + 1, root.closing);
  for (const entryRange of rootEntries) {
    const property = directPropertyContainerRange(
      structuralSource,
      structure,
      entryRange,
      'updates',
      '{',
      '}',
    );
    if (!property) continue;
    const fieldRanges = topLevelCommaRanges(
      structure,
      property.opening + 1,
      property.closing,
    );
    const removable = fieldRanges.filter(range => {
      const field = structuralSource
        .slice(range.start, range.end)
        .replace(/,\s*$/, '')
        .trim();
      return ['enabled', 'url'].includes(resolvedDirectPropertyName(field) || '');
    });
    if (!removable.length) continue;
    const substantiveFields = fieldRanges.filter(range =>
      structuralSource.slice(range.start, range.end).replace(/[,\s]/g, '')
    );
    const authorizedRanges = removable.length === substantiveFields.length
      ? [entryRange]
      : removable;
    rangesToRemove.push(
      ...authorizedRanges.map(range => removableCommaRange(source, range)),
    );
  }
  return removeSourceRanges(source, rangesToRemove);
};

const inspectAuthoritativeExpoConfig = (content: string) => {
  const source = stripComments(content);
  const structure = maskStringAndRegexLiterals(source);
  const bindings = collectConstantStringBindings(source);
  const root = authoritativeExpoConfigRange(source);
  if (!root) return null;

  const rootEntries = topLevelCommaRanges(structure, root.opening + 1, root.closing);
  const rootEntrySources = rootEntries.map(range => source.slice(range.start, range.end));
  const rootDefinitions = rootEntrySources.map(directPropertyDefinition);
  if (rootEntrySources.some((entry, index) =>
    Boolean(rootDefinitions[index] && !rootDefinitions[index]?.name) ||
    hasAmbiguousAuthorityAccessorOrMethod(entry, ['plugins', 'updates']) ||
    (
      ['plugins', 'updates'].includes(resolvedDirectPropertyName(entry) || '') &&
      !rootDefinitions[index]
    )
  )) {
    return null;
  }
  const pluginProperties = rootEntries.filter((_range, index) =>
    rootDefinitions[index]?.name === 'plugins'
  );
  if (pluginProperties.length !== 1) return null;

  const pluginProperty = pluginProperties[0];
  const pluginArray = directPropertyContainerRange(
    source,
    structure,
    pluginProperty,
    'plugins',
    '[',
    ']',
  );
  if (!pluginArray) return null;
  const pluginOpening = pluginArray.opening;
  const pluginClosing = pluginArray.closing;

  const updatesProperties = rootEntries.filter((_range, index) =>
    rootDefinitions[index]?.name === 'updates'
  );
  if (updatesProperties.length > 1) return null;

  const pluginPropertyIndex = rootEntries.indexOf(pluginProperty);
  const updatesPropertyIndex = updatesProperties.length
    ? rootEntries.indexOf(updatesProperties[0])
    : -1;
  const firstAuthorityIndex = updatesPropertyIndex < 0
    ? pluginPropertyIndex
    : Math.min(pluginPropertyIndex, updatesPropertyIndex);
  if (rootEntrySources.some((entry, index) =>
    index > firstAuthorityIndex && /^\s*\.\.\./.test(entry)
  )) {
    return null;
  }

  let bundleDropPluginCount = 0;
  let expoUpdatesPluginCount = 0;
  let hasAmbiguousPluginAuthority = false;
  let hasUnresolvedPluginExpression = false;
  let supportedExistingPluginsSpreadCount = 0;
  const pluginEntries = topLevelCommaRanges(structure, pluginOpening + 1, pluginClosing);
  let bundleDropPluginIndex = -1;
  for (const [index, range] of pluginEntries.entries()) {
    const entry = source.slice(range.start, range.end).replace(/,\s*$/, '').trim();
    if (!entry) continue;
    const resolvedPlugin = resolvePluginEntry(entry, bindings);
    if (resolvedPlugin.packageName === null) {
      if (isCanonicalExistingPluginsSpread(entry)) {
        supportedExistingPluginsSpreadCount += 1;
      } else {
        hasUnresolvedPluginExpression = true;
      }
    }
    if (resolvedPlugin.packageName === '@gfean/react-native-bundle-drop') {
      bundleDropPluginCount += 1;
      bundleDropPluginIndex = index;
    }
    if (resolvedPlugin.packageName === 'expo-updates') expoUpdatesPluginCount += 1;
    if (resolvedPlugin.ambiguousAuthority) hasAmbiguousPluginAuthority = true;
    if (
      /^\.\.\./.test(entry) &&
      decodedExpressionMayReferenceSetupAuthority(entry.slice(3))
    ) {
      hasAmbiguousPluginAuthority = true;
    }
  }
  if (
    bundleDropPluginIndex >= 0 &&
    pluginEntries.some((range, index) =>
      index > bundleDropPluginIndex &&
      /^\s*\.\.\./.test(source.slice(range.start, range.end))
    )
  ) {
    expoUpdatesPluginCount += 1;
  }

  let hasActiveExpoUpdatesField = false;
  if (updatesProperties.length === 1) {
    const updatesProperty = updatesProperties[0];
    const updatesObject = directPropertyContainerRange(
      source,
      structure,
      updatesProperty,
      'updates',
      '{',
      '}',
    );
    if (!updatesObject) return null;
    const updateFields = topLevelCommaRanges(
      structure,
      updatesObject.opening + 1,
      updatesObject.closing,
    );
    for (const range of updateFields) {
      const field = source.slice(range.start, range.end).replace(/,\s*$/, '').trim();
      if (/^\.\.\./.test(field)) {
        hasActiveExpoUpdatesField = true;
        continue;
      }
      if (
        ['enabled', 'url'].includes(resolvedDirectPropertyName(field) || '') ||
        Boolean(objectAccessorOrMethodDefinition(field)) ||
        /^\[/.test(field)
      ) {
        hasActiveExpoUpdatesField = true;
      }
    }
  }

  return {
    bundleDropPluginCount,
    expoUpdatesPluginCount,
    hasAmbiguousPluginAuthority,
    hasUnresolvedPluginExpression,
    supportedExistingPluginsSpreadCount,
    hasActiveExpoUpdatesField,
  };
};

const withoutOptionalTerminalNewline = (content: string) =>
  content.endsWith('\r\n')
    ? content.slice(0, -2)
    : content.endsWith('\n')
      ? content.slice(0, -1)
      : content;

const preservesOnlyAuthorizedExpoChanges = (
  original: string,
  updated: string,
  migrateExpoUpdates: boolean,
) => {
  const originalHasPlugins = hasTopLevelPluginsProperty(original);
  if (originalHasPlugins === null) return false;
  const originalWithoutExactBundleDrop = removeTopLevelBundleDropRegistration(
    original,
    false,
  );
  const originalHasExactBundleDrop = originalWithoutExactBundleDrop !== original;
  let normalizedOriginal = original;
  if (migrateExpoUpdates) {
    normalizedOriginal = removeTopLevelExpoUpdatesFields(
      removeTopLevelExpoUpdatesPluginEntries(normalizedOriginal),
    );
  }
  const normalizedUpdated = originalHasExactBundleDrop
    ? updated
    : removeTopLevelBundleDropRegistration(updated, !originalHasPlugins);
  return withoutOptionalTerminalNewline(normalizedOriginal) ===
    withoutOptionalTerminalNewline(normalizedUpdated);
};

const validateCommonSetupChange = (
  change: AiPatchPlan,
  originals: Map<string, string>,
  seen: Set<string>,
) => {
  if (!isSafeRelativePath(change.file)) {
    throw new Error(`AI setup plan references an unsafe file path: ${change.file}`);
  }
  if (!originals.has(change.file)) {
    throw new Error(`AI setup plan references a file that was not shared: ${change.file}`);
  }
  if (seen.has(change.file)) {
    throw new Error(`AI setup plan contains multiple updates for ${change.file}`);
  }
  seen.add(change.file);
  if (sha256(originals.get(change.file)!) !== change.originalSha256) {
    throw new Error(`AI setup plan hash mismatch for ${change.file}`);
  }
  if (!change.updated.trim()) {
    throw new Error(`AI setup plan returned an empty update for ${change.file}`);
  }
  if (change.updated.includes('TODO_BUNDLEDROP') || change.updated.includes('<TODO')) {
    throw new Error(`AI setup plan returned placeholder text in ${change.file}`);
  }
  if (!hasBalancedPairs(change.updated, /^app\.config\./.test(change.file))) {
    throw new Error(`AI setup plan returned unbalanced braces or brackets in ${change.file}`);
  }
  if (
    hasUnsafeTerminalControl(change.updated) ||
    hasUnsafeTerminalControl(originals.get(change.file)!)
  ) {
    throw new Error(
      `AI setup plan contains unsafe control or JavaScript line-separator characters in ${change.file}`,
    );
  }
};

export function validateSetupChangesBeforeApply(params: {
  projectType: AiSetupProjectType;
  originals: Map<string, string>;
  changes: AiPatchPlan[];
  migrateExpoUpdates?: boolean;
}) {
  const seen = new Set<string>();
  for (const change of params.changes) {
    validateCommonSetupChange(change, params.originals, seen);
    if (params.projectType === 'expo') {
      if (!change.file.startsWith('app.config.') || !isPatchableExpoConfig(change.file)) {
        throw new Error(
          `AI Expo setup may modify only a dynamic root app.config.* file: ${change.file}`,
        );
      }
      if (change.decisionType !== 'review_only_patch') {
        throw new Error(
          `AI dynamic Expo config updates require explicit review-only approval: ${change.file}`,
        );
      }
      const expoConfig = inspectAuthoritativeExpoConfig(change.updated);
      const originalExpoConfig = inspectAuthoritativeExpoConfig(
        params.originals.get(change.file)!,
      );
      if (
        !expoConfig ||
        expoConfig.bundleDropPluginCount !== 1 ||
        expoConfig.hasAmbiguousPluginAuthority
      ) {
        throw new Error(
          `AI Expo config update must contain exactly one Bundle Drop plugin in the exported root plugins property: ${change.file}`,
        );
      }
      if (
        params.migrateExpoUpdates &&
        (
          expoConfig.expoUpdatesPluginCount > 0 ||
          expoConfig.hasActiveExpoUpdatesField ||
          expoConfig.hasUnresolvedPluginExpression ||
          expoConfig.supportedExistingPluginsSpreadCount >
            (originalExpoConfig?.supportedExistingPluginsSpreadCount ?? 0)
        )
      ) {
        throw new Error(
          `AI Expo config update did not fully remove active Expo Updates configuration: ${change.file}`,
        );
      }
      if (!preservesOnlyAuthorizedExpoChanges(
        params.originals.get(change.file)!,
        change.updated,
        Boolean(params.migrateExpoUpdates),
      )) {
        throw new Error(
          `AI dynamic Expo config update changed code outside authorized setup fields: ${change.file}`,
        );
      }
      continue;
    }

    if (!isPatchableNativeEntrypoint(change.file)) {
      throw new Error(`AI bare setup may not modify ${change.file}`);
    }
    if (change.decisionType !== 'review_only_patch') {
      throw new Error(
        `AI bare native updates require explicit review-only approval: ${change.file}`,
      );
    }
    if (change.file.includes('MainApplication.') && !hasAndroidBundleDropIntegration(change.updated)) {
      throw new Error(`AI plan Android update does not contain BundleDrop resolver: ${change.file}`);
    }
    if (
      change.file.includes('AppDelegate.') &&
      !hasIosBundleDropIntegration(change.file, change.updated)
    ) {
      throw new Error(`AI plan iOS update does not contain BundleDrop locator: ${change.file}`);
    }
    const missingStructure = findMissingBareNativeStartupStructure(
      change.file,
      params.originals.get(change.file)!,
      change.updated,
    );
    if (missingStructure.length) {
      throw new Error(
        `AI plan removed native startup structure from ${change.file}: ` +
          missingStructure.join(', '),
      );
    }
  }
}

export function validateAppliedSetupChanges(params: {
  projectRoot: string;
  projectType: AiSetupProjectType;
  changes: AiPatchPlan[];
  migrateExpoUpdates?: boolean;
  originals?: Map<string, string>;
}) {
  const appliedFiles = new Map(
    params.changes.map(change => {
      const applied = inspectProjectFile(params.projectRoot, change.file);
      if (!applied.exists) {
        throw new Error(`Applied AI setup file is missing: ${change.file}`);
      }
      return [change.file, applied.content];
    }),
  );
  const originals = params.originals || appliedFiles;
  if (params.projectType === 'bare') {
    for (const platform of ['android', 'ios'] as const) {
      const entrypoints = params.changes
        .map(change => change.file)
        .filter(file => platform === 'android'
          ? file.includes('/android/') || file.startsWith('android/')
          : file.includes('/ios/') || file.startsWith('ios/'));
      const authorityIssue = findNativeEntrypointAuthorityIssue(
        params.projectRoot,
        platform,
        entrypoints,
      );
      if (authorityIssue) {
        throw new Error(`Applied ${platform} entrypoint authority is invalid: ${authorityIssue}`);
      }
    }
  }
  validateSetupChangesBeforeApply({
    projectType: params.projectType,
    originals,
    migrateExpoUpdates: params.migrateExpoUpdates,
    changes: params.changes.map(change => ({
      ...change,
      originalSha256: sha256(originals.get(change.file)!),
      updated: appliedFiles.get(change.file)!,
    })),
  });
}
