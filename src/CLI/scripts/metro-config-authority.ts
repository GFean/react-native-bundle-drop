import path from 'path';

import { stripCommentsAndStrings } from './native-setup-contract';
import { inspectProjectFile } from './safe-file-transaction';

export const METRO_CONFIG_FILES = [
  'metro.config.js',
  'metro.config.cjs',
  'metro.config.mjs',
  'metro.config.ts',
] as const;

export type MetroWrapper = 'withBundleDrop' | 'withBundleDropExpo';

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const stripJavaScriptComments = (source: string) => {
  let output = '';
  let quote = '';
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (quote) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      output += character;
      continue;
    }
    if (character === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      output += '\n';
      continue;
    }
    if (character === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') output += '\n';
        index += 1;
      }
      index += 1;
      continue;
    }
    output += character;
  }
  return output;
};

const javascriptStringRanges = (source: string) => {
  const ranges: Array<{ start: number; end: number }> = [];
  let quote = '';
  let start = -1;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (!quote && (character === '"' || character === "'" || character === '`')) {
      quote = character;
      start = index;
      continue;
    }
    if (!quote) continue;
    if (escaped) escaped = false;
    else if (character === '\\') escaped = true;
    else if (character === quote) {
      ranges.push({ start, end: index + 1 });
      quote = '';
      start = -1;
    }
  }
  if (quote) ranges.push({ start, end: source.length });
  return ranges;
};

const executableMatches = (source: string, pattern: RegExp) => {
  const ranges = javascriptStringRanges(source);
  return [...source.matchAll(pattern)].filter(match => {
    const position = match.index || 0;
    return ranges.every(range => position < range.start || position >= range.end);
  });
};

const structuralSource = (source: string) => {
  const characters = [...source];
  for (const range of javascriptStringRanges(source)) {
    for (let index = range.start; index < range.end; index += 1) {
      if (characters[index] !== '\n') characters[index] = ' ';
    }
  }
  return characters.join('');
};

const isUnconditionalTopLevel = (source: string, position: number) => {
  const structure = structuralSource(source);
  const prefix = structure.slice(0, position);
  const depth = [...prefix].reduce((value, character) => {
    if ('{[('.includes(character)) return value + 1;
    if ('}])'.includes(character)) return value - 1;
    return value;
  }, 0);
  if (depth !== 0) return false;
  const statementPrefix = prefix.slice(Math.max(
    prefix.lastIndexOf('\n'),
    prefix.lastIndexOf(';'),
    prefix.lastIndexOf('}'),
  ) + 1);
  return !/\b(?:if|for|while|switch|catch)\s*\(|=>/.test(statementPrefix);
};

const hasExactBindingEntry = (bindingBody: string, name: string) =>
  bindingBody.split(',').map(entry => entry.trim()).includes(name);

const topLevelNamedBindingCount = (
  source: string,
  name: string,
  moduleNames: string[],
) => {
  const withoutComments = stripJavaScriptComments(source);
  let count = 0;
  for (const moduleName of moduleNames) {
    const escapedModule = escapeRegExp(moduleName);
    const commonJs = new RegExp(
      `\\b(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*` +
        `require\\(\\s*(['"])${escapedModule}\\2\\s*\\)`,
      'g',
    );
    const moduleImport = new RegExp(
      `\\bimport\\s*\\{([^}]*)\\}\\s*from\\s*(['"])${escapedModule}\\2`,
      'g',
    );
    for (const match of [
      ...executableMatches(withoutComments, commonJs),
      ...executableMatches(withoutComments, moduleImport),
    ]) {
      if (
        isUnconditionalTopLevel(withoutComments, match.index || 0) &&
        hasExactBindingEntry(match[1], name)
      ) {
        count += 1;
      }
    }
  }
  return count;
};

const hasPackageWrapperBinding = (source: string, wrapper: MetroWrapper) =>
  topLevelNamedBindingCount(
    source,
    wrapper,
    ['@gfean/react-native-bundle-drop/metro'],
  ) === 1;

export const hasExecutableMetroWrapperReference = (
  source: string,
  wrapper: MetroWrapper,
) => new RegExp(`\\b${escapeRegExp(wrapper)}\\b`).test(stripCommentsAndStrings(source));

export const hasExecutableMetroModuleReference = (source: string, moduleName: string) => {
  const withoutComments = stripJavaScriptComments(source);
  const escapedModule = escapeRegExp(moduleName);
  return executableMatches(
    withoutComments,
    new RegExp(
      `\\brequire\\(\\s*(['"])${escapedModule}\\1\\s*\\)|` +
        `\\bfrom\\s*(['"])${escapedModule}\\2`,
      'g',
    ),
  ).some(match => isUnconditionalTopLevel(withoutComments, match.index || 0));
};

const findBalancedParenthesis = (source: string, opening: number) => {
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === '(') depth += 1;
    if (source[index] === ')') depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
};

const splitTopLevelArguments = (source: string) => {
  const argumentsList: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    if ('{[('.includes(source[index])) depth += 1;
    else if ('}])'.includes(source[index])) depth -= 1;
    else if (source[index] === ',' && depth === 0) {
      argumentsList.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  argumentsList.push(source.slice(start).trim());
  return argumentsList;
};

const expressionEnd = (source: string, start: number) => {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if ('{[('.includes(character)) depth += 1;
    else if ('}])'.includes(character)) depth -= 1;
    else if ((character === ';' || character === '\n') && depth === 0) return index;
  }
  return source.length;
};

const topLevelVariableInitializer = (source: string, name: string, before: number) => {
  const structure = structuralSource(source);
  const pattern = new RegExp(`\\b(?:const|let|var)\\s+${escapeRegExp(name)}\\s*=`, 'g');
  const declarations = [...structure.matchAll(pattern)].filter(match =>
    (match.index || 0) < before && isUnconditionalTopLevel(structure, match.index || 0)
  );
  if (declarations.length !== 1) return null;
  const initializerStart = (declarations[0].index || 0) + declarations[0][0].length;
  return structure.slice(initializerStart, expressionEnd(structure, initializerStart)).trim();
};

const hasSupportedMetroExpression = (
  source: string,
  expression: string,
  before: number,
  visited = new Set<string>(),
): boolean => {
  const value = expression.trim();
  if (!value || /^(?:null|undefined|false|true)$/.test(value)) return false;
  if (/^\{[\s\S]*\}$/.test(value)) return true;
  if (/^getDefaultConfig\s*\([^)]*\)$/.test(value)) {
    return topLevelNamedBindingCount(
      source,
      'getDefaultConfig',
      ['@react-native/metro-config', 'expo/metro-config'],
    ) === 1;
  }
  if (/^mergeConfig\s*\([\s\S]*\)$/.test(value)) {
    if (topLevelNamedBindingCount(
      source,
      'mergeConfig',
      ['@react-native/metro-config'],
    ) !== 1) return false;
    const opening = value.indexOf('(');
    const closing = findBalancedParenthesis(value, opening);
    if (opening < 0 || closing !== value.length - 1) return false;
    const argumentsList = splitTopLevelArguments(value.slice(opening + 1, closing));
    return Boolean(argumentsList[0]) && hasSupportedMetroExpression(
      source,
      argumentsList[0],
      before,
      visited,
    );
  }
  if (/^[A-Za-z_$][\w$]*$/.test(value)) {
    if (visited.has(value)) return false;
    const initializer = topLevelVariableInitializer(source, value, before);
    return initializer !== null && hasSupportedMetroExpression(
      source,
      initializer,
      before,
      new Set([...visited, value]),
    );
  }
  return false;
};

const hasSupportedEarlierExport = (source: string, before: number) => {
  const structure = structuralSource(source);
  const exports = [...structure.matchAll(/\bmodule\s*\.\s*exports\s*=\s*/g)].filter(match =>
    (match.index || 0) < before && isUnconditionalTopLevel(structure, match.index || 0)
  );
  if (exports.length !== 1) return false;
  const expressionStart = (exports[0].index || 0) + exports[0][0].length;
  const expression = structure.slice(
    expressionStart,
    expressionEnd(structure, expressionStart),
  );
  return hasSupportedMetroExpression(source, expression, exports[0].index || 0);
};

const hasSupportedMetroBase = (
  source: string,
  base: string,
  exportPosition: number,
) => {
  if (/^module\s*\.\s*exports\s*\|\|\s*\{\s*\}$/.test(base)) return true;
  if (/^module\s*\.\s*exports$/.test(base)) {
    return hasSupportedEarlierExport(source, exportPosition);
  }
  return hasSupportedMetroExpression(source, base, exportPosition);
};

export const hasAuthoritativeMetroWrapper = (
  source: string,
  wrapper: MetroWrapper,
) => {
  if (!hasPackageWrapperBinding(source, wrapper)) return false;
  const executable = stripJavaScriptComments(source);
  const structure = structuralSource(executable);
  const exports = [
    ...structure.matchAll(/\bmodule\s*\.\s*exports\s*=\s*/g),
    ...structure.matchAll(/\bexport\s+default\s+/g),
  ].filter(match => isUnconditionalTopLevel(structure, match.index || 0))
    .sort((left, right) => (left.index || 0) - (right.index || 0));
  const wrapperExports = exports.filter(match => {
    const expressionStart = (match.index || 0) + match[0].length;
    return new RegExp(`^\\s*${escapeRegExp(wrapper)}\\s*\\(`).test(
      structure.slice(expressionStart),
    );
  });
  if (wrapperExports.length !== 1 || wrapperExports[0] !== exports[exports.length - 1]) {
    return false;
  }
  const wrapperExport = wrapperExports[0];
  const expressionStart = (wrapperExport.index || 0) + wrapperExport[0].length;
  const opening = structure.indexOf('(', expressionStart + wrapper.length);
  const closing = opening < 0 ? -1 : findBalancedParenthesis(structure, opening);
  if (closing < 0) return false;
  if (!/^\s*;?\s*$/.test(structure.slice(closing + 1))) return false;
  const argumentsList = splitTopLevelArguments(structure.slice(opening + 1, closing));
  if (!argumentsList[0]) return false;
  return hasSupportedMetroBase(
    executable,
    argumentsList[0],
    wrapperExport.index || 0,
  );
};

export const findSingleMetroConfig = (projectRoot: string) => {
  const existing = METRO_CONFIG_FILES.filter(file => inspectProjectFile(projectRoot, file).exists);
  if (existing.length > 1) {
    throw new Error(
      `Multiple Metro config files were found (${existing.join(', ')}). ` +
        'Keep one authoritative Metro config before running Bundle Drop setup.',
    );
  }
  return existing[0];
};

const packageUsesEsm = (projectRoot: string) => {
  const packageFile = inspectProjectFile(projectRoot, 'package.json');
  if (!packageFile.exists) return false;
  const manifest = JSON.parse(packageFile.content) as { type?: unknown };
  return manifest.type === 'module';
};

export const newCommonJsMetroConfigFile = (projectRoot: string) =>
  packageUsesEsm(projectRoot) ? 'metro.config.cjs' : 'metro.config.js';

export const assertCommonJsMetroConfig = (projectRoot: string, relativePath: string) => {
  const extension = path.extname(relativePath);
  if (
    extension === '.mjs' ||
    extension === '.ts' ||
    (extension === '.js' && packageUsesEsm(projectRoot))
  ) {
    throw new Error(
      `${relativePath} uses ESM or TypeScript syntax. Bundle Drop will not append CommonJS ` +
        'to it automatically; wrap its exported config manually, then rerun setup.',
    );
  }
};
